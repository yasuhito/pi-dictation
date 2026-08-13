import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import net, { type Socket } from "node:net";
import type { BridgeRecorderConfig } from "./config.js";
import type { LevelEvent, Recorder, RecorderStartOptions, Recording } from "./recorder.js";
import { RecorderError, validatePcm16MonoWav } from "./recorder.js";

const PROTOCOL_VERSION = 3;
const MAX_FRAME_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 5000;
const FINALIZATION_TIMEOUT_MS = 30_000;
const FETCH_NO_PROGRESS_TIMEOUT_MS = 10_000;
const RECOVERY_WINDOW_MS = 10 * 60_000;
const LEVEL_INTERVAL_MS = 50;
const OWNER_LIVENESS_INTERVAL_MS = 5000;
const RETRY_ATTEMPTS = 3;
const FINALIZATION_POLL_MS = 25;

type Credential = { id: string; secret: Buffer; createdAt?: string };
type ResponseStatus = "ok" | "busy" | "not-found" | "request-conflict" | "invalid-state" | "failed" | "version-mismatch";
type ResponseFrame = {
  status: ResponseStatus;
  payload: unknown;
  reader: SocketReader;
  socket: Socket;
  challenge: Buffer;
  requestId: string;
};

class BridgeProtocolError extends Error {}
class BridgeTransportError extends Error {
  constructor(readonly stage: "authentication" | "operation" = "operation", options?: ErrorOptions) {
    super(undefined, options);
  }
}
class BridgeOutcomeUnknownError extends Error {}
class BridgeAudioError extends Error {}
class BridgeResponseError extends Error {
  constructor(readonly status: ResponseStatus, readonly payload: unknown) { super(status); }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof BridgeOutcomeUnknownError || signal?.reason instanceof BridgeTransportError ||
      signal?.reason instanceof RecorderError) return signal.reason;
  return new RecorderError("cancelled");
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).sort().join("\0") === [...keys].sort().join("\0");
}

function decodeCanonicalBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new BridgeProtocolError();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new BridgeProtocolError();
  }
  return decoded;
}

function decodeCanonicalHex(value: unknown, expectedBytes: number): Buffer {
  if (typeof value !== "string" || value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new BridgeProtocolError();
  }
  return Buffer.from(value, "hex");
}

function parseStrictJson(bytes: Buffer): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new BridgeProtocolError(); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new BridgeProtocolError(); }
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] || "")) index += 1; };
  const string = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    throw new BridgeProtocolError();
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") {
      index += 1; whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") { index += 1; return; }
      while (true) {
        if (text[index] !== '"') throw new BridgeProtocolError();
        const key = string();
        if (keys.has(key)) throw new BridgeProtocolError();
        keys.add(key); whitespace();
        if (text[index++] !== ":") throw new BridgeProtocolError();
        value(); whitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index++] !== ",") throw new BridgeProtocolError();
        whitespace();
      }
    }
    if (text[index] === "[") {
      index += 1; whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(); whitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index++] !== ",") throw new BridgeProtocolError();
      }
    }
    if (text[index] === '"') { string(); return; }
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  };
  value(); whitespace();
  if (index !== text.length) throw new BridgeProtocolError();
  return parsed;
}

function encodeAuthFields(fields: Array<string | number | Buffer>): Buffer {
  const pieces: Buffer[] = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}

function authenticationTag(secret: Buffer, fields: Array<string | number | Buffer>): Buffer {
  return createHmac("sha256", secret).update(encodeAuthFields(fields)).digest();
}

const resourceMetricsKey = "__piDictationBridgeResourceMetrics";
function recordTestResourceMetric(name: string, bytes: number): void {
  if (process.env.PI_DICTATION_TEST_RESOURCE_METRICS !== "1") return;
  const target = globalThis as typeof globalThis & { __piDictationBridgeResourceMetrics?: Record<string, number> };
  const metrics = target[resourceMetricsKey] ??= {};
  metrics[name] = Math.max(metrics[name] ?? 0, bytes);
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 2 || payload.length > MAX_FRAME_BYTES) throw new BridgeProtocolError();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

class SocketReader {
  constructor(private readonly socket: Socket) {}

  private waitForReadable(): Promise<void> {
    return new Promise((resolveWait, reject) => {
      const cleanup = () => {
        this.socket.removeListener("readable", onReadable);
        this.socket.removeListener("end", onEnd);
        this.socket.removeListener("close", onEnd);
        this.socket.removeListener("error", onError);
      };
      const onReadable = () => { cleanup(); resolveWait(); };
      const onEnd = () => { cleanup(); resolveWait(); };
      const onError = (error: Error) => { cleanup(); reject(new BridgeTransportError(undefined, { cause: error })); };
      this.socket.once("readable", onReadable);
      this.socket.once("end", onEnd);
      this.socket.once("close", onEnd);
      this.socket.once("error", onError);
      if (this.socket.readableLength > 0) onReadable();
      else if (this.socket.readableEnded || this.socket.destroyed) onEnd();
    });
  }

  async readExactly(length: number): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const available = this.socket.readableLength;
      recordTestResourceMetric("socket", available);
      const chunk = available > 0
        ? this.socket.read(Math.min(remaining, available)) as Buffer | null
        : null;
      if (chunk) {
        pieces.push(chunk);
        remaining -= chunk.length;
        recordTestResourceMetric("socket", chunk.length);
      } else {
        if (this.socket.readableEnded || this.socket.destroyed) throw new BridgeTransportError();
        await this.waitForReadable();
      }
    }
    return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length);
  }

  async readFrame(): Promise<unknown> {
    const header = await this.readExactly(4);
    const length = header.readUInt32BE(0);
    if (length < 2 || length > MAX_FRAME_BYTES) throw new BridgeProtocolError();
    try { return parseStrictJson(await this.readExactly(length)); }
    catch (error) {
      if (error instanceof BridgeTransportError) throw error;
      throw new BridgeProtocolError();
    }
  }

  async requireEnd(): Promise<void> {
    while (!this.socket.readableEnded) {
      if (this.socket.readableLength > 0) throw new BridgeAudioError();
      if (this.socket.destroyed) throw new BridgeTransportError();
      await this.waitForReadable();
    }
    if (this.socket.readableLength > 0) throw new BridgeAudioError();
  }
}

async function inspectPrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      (process.getuid?.() !== undefined && info.uid !== process.getuid?.())) throw new BridgeProtocolError();
}

async function inspectPrivateEndpoint(config: BridgeRecorderConfig): Promise<void> {
  if (config.endpoint.type !== "unix") return;
  const parent = await lstat(dirname(config.endpoint.path));
  const socket = await lstat(config.endpoint.path);
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 ||
      !socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o777) !== 0o600 ||
      (uid !== undefined && (parent.uid !== uid || socket.uid !== uid))) throw new BridgeProtocolError();
}

async function readCredential(path: string): Promise<Credential> {
  await inspectPrivateFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        (process.getuid?.() !== undefined && info.uid !== process.getuid?.()) || info.size < 2 || info.size > 4096) {
      throw new BridgeProtocolError();
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    const credentialKeys = exactObject(value, ["id", "secret"]) || exactObject(value, ["id", "secret", "createdAt"]);
    if (!credentialKeys || typeof value.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
        typeof value.secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.secret) ||
        (value.createdAt !== undefined && (typeof value.createdAt !== "string" || value.createdAt.length > 32 || Number.isNaN(Date.parse(value.createdAt))))) {
      throw new BridgeProtocolError();
    }
    const secret = Buffer.from(value.secret, "base64");
    if (secret.length !== 32) throw new BridgeProtocolError();
    const createdAt = typeof value.createdAt === "string" ? value.createdAt : undefined;
    return { id: value.id, secret, ...(createdAt === undefined ? {} : { createdAt }) };
  } catch { throw new BridgeProtocolError(); }
  finally { await handle.close(); }
}

async function connect(config: BridgeRecorderConfig, signal?: AbortSignal): Promise<Socket> {
  await inspectPrivateEndpoint(config);
  return new Promise((resolveConnection, reject) => {
    const socket = config.endpoint.type === "unix"
      ? net.createConnection({ path: config.endpoint.path, allowHalfOpen: true })
      : net.createConnection({ host: config.endpoint.host, port: config.endpoint.port, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(new BridgeTransportError()), CONTROL_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => socket.destroy(abortError(signal));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    socket.once("connect", () => {
      cleanup();
      resolveConnection(socket);
    });
    socket.once("error", (error) => { cleanup(); reject(error); });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function authenticatedRequest(
  config: BridgeRecorderConfig,
  credential: Credential,
  requestId: string,
  operation: string,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<ResponseFrame> {
  const socket = await connect(config, signal);
  const timeout = setTimeout(() => socket.destroy(new BridgeTransportError()), timeoutMs);
  timeout.unref?.();
  const onAbort = () => socket.destroy(abortError(signal));
  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.once("close", cleanup);
  const reader = new SocketReader(socket);
  let stage: "authentication" | "operation" = "authentication";
  try {
    const challengeMessage = await reader.readFrame();
    if (!exactObject(challengeMessage, ["type", "challenge"]) ||
        challengeMessage.type !== "challenge" || typeof challengeMessage.challenge !== "string") {
      throw new BridgeProtocolError();
    }
    const challenge = decodeCanonicalBase64(challengeMessage.challenge, 32);
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const tag = authenticationTag(credential.secret, [
      "request", PROTOCOL_VERSION, challenge, credential.id, requestId, operation, payloadBytes,
    ]);
    socket.end(frame({
      type: "request", version: PROTOCOL_VERSION, credentialId: credential.id, requestId,
      operation, payload: payloadBytes.toString("base64"), hmac: tag.toString("hex"),
    }));
    stage = "operation";
    const response = await reader.readFrame();
    const statuses: ResponseStatus[] = ["ok", "busy", "not-found", "request-conflict", "invalid-state", "failed", "version-mismatch"];
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || !Number.isSafeInteger(response.version) || Number(response.version) < 1 ||
        response.requestId !== requestId || !statuses.includes(response.status as ResponseStatus) ||
        typeof response.payload !== "string" || typeof response.hmac !== "string") {
      throw new BridgeProtocolError();
    }
    const status = response.status as ResponseStatus;
    const responsePayload = decodeCanonicalBase64(response.payload);
    const expected = authenticationTag(credential.secret, [
      "response", PROTOCOL_VERSION, response.version as number, challenge, credential.id, requestId,
      `${operation}:${status}`, responsePayload,
    ]);
    const actual = decodeCanonicalHex(response.hmac, expected.length);
    if (!timingSafeEqual(actual, expected)) throw new BridgeProtocolError();
    const parsed = parseStrictJson(responsePayload);
    if (status === "version-mismatch") {
      if (!exactObject(parsed, ["clientVersion", "companionVersion"]) ||
          parsed.clientVersion !== PROTOCOL_VERSION || parsed.companionVersion !== response.version ||
          response.version === PROTOCOL_VERSION) throw new BridgeProtocolError();
    } else if (response.version !== PROTOCOL_VERSION) throw new BridgeProtocolError();
    if (operation === "fetch") {
      clearTimeout(timeout);
      socket.setTimeout(FETCH_NO_PROGRESS_TIMEOUT_MS, () => socket.destroy(new BridgeTransportError()));
    } else if (operation === "subscribe-levels") {
      clearTimeout(timeout);
      socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy(new BridgeTransportError()));
    }
    return { status, payload: parsed, reader, socket, challenge, requestId };
  } catch (error) {
    cleanup();
    socket.destroy();
    if (error instanceof BridgeTransportError && stage === "authentication") {
      throw new BridgeTransportError("authentication", { cause: error });
    }
    throw error;
  }
}

async function withTransportRetries<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < RETRY_ATTEMPTS; index += 1) {
    try { return await attempt(); }
    catch (error) {
      lastError = error;
      if (error instanceof RecorderError || error instanceof BridgeProtocolError ||
          error instanceof BridgeResponseError || error instanceof BridgeAudioError) throw error;
    }
  }
  throw lastError;
}

async function requestJson(
  config: BridgeRecorderConfig,
  credential: Credential,
  operation: string,
  payload: unknown,
  signal?: AbortSignal,
  requestId = randomUUID(),
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(new BridgeTransportError()), timeoutMs);
  timer.unref?.();
  const requestSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
  try {
    return await withTransportRetries(async () => {
      const remaining = Math.max(1, deadline - Date.now());
      const response = await authenticatedRequest(config, credential, requestId, operation, payload, requestSignal, remaining);
      try {
        await response.reader.requireEnd();
        if (response.status !== "ok") throw new BridgeResponseError(response.status, response.payload);
        return response.payload;
      } finally { response.socket.destroy(); }
    });
  } finally { clearTimeout(timer); }
}

type StreamLevelEvent = Extract<LevelEvent, { type: "observation" | "unavailable" }> |
  { type: "terminal"; state: string };

function validLevelEvent(value: unknown): value is StreamLevelEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type === "observation") {
    return exactObject(event, ["type", "sequence", "capturedAtMs", "dbfs"]) &&
      Number.isSafeInteger(event.sequence) && Number(event.sequence) >= 0 &&
      event.capturedAtMs === Number(event.sequence) * LEVEL_INTERVAL_MS &&
      (event.dbfs === "silence" || (typeof event.dbfs === "number" && Number.isFinite(event.dbfs)));
  }
  if (event.type === "unavailable") {
    return exactObject(event, ["type", "sequence", "capturedAtMs"]) &&
      Number.isSafeInteger(event.sequence) && Number(event.sequence) >= 0 &&
      event.capturedAtMs === Number(event.sequence) * LEVEL_INTERVAL_MS;
  }
  return event.type === "terminal" && exactObject(event, ["type", "state"]) &&
    ["finalizing", "result-ready", "cancelled", "failed", "expired"].includes(String(event.state));
}

function sameLevelEvent(left: LevelEvent, right: LevelEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function streamLevels(
  config: BridgeRecorderConfig,
  credential: Credential,
  owned: { recordingId: string; leaseSecret: string },
  signal: AbortSignal,
  onLevel: (event: LevelEvent) => void
): Promise<void> {
  let afterSequence = -1;
  let retryDelay = 100;
  let requestId = randomUUID();
  const confirmed = new Map<number, Extract<LevelEvent, { type: "observation" | "unavailable" }>>();
  while (!signal.aborted) {
    let response: ResponseFrame | undefined;
    let established = false;
    try {
      response = await authenticatedRequest(
        config, credential, requestId, "subscribe-levels", { ...owned, afterSequence }, signal
      );
      if (response.status === "invalid-state" || response.status === "not-found") return;
      if (response.status !== "ok") throw new BridgeResponseError(response.status, response.payload);
      const bounds = response.payload;
      if (!exactObject(bounds, ["recordingId", "intervalMs", "oldestSequence", "nextSequence"]) ||
          bounds.recordingId !== owned.recordingId || bounds.intervalMs !== LEVEL_INTERVAL_MS ||
          !Number.isSafeInteger(bounds.oldestSequence) || !Number.isSafeInteger(bounds.nextSequence) ||
          Number(bounds.oldestSequence) < 0 || Number(bounds.nextSequence) < Number(bounds.oldestSequence)) {
        throw new BridgeProtocolError();
      }
      established = true;
      onLevel({ type: "transport", state: "connected" });
      if (Number(bounds.oldestSequence) > afterSequence + 1) {
        onLevel({ type: "gap", fromSequence: afterSequence + 1, toSequence: Number(bounds.oldestSequence) - 1 });
        afterSequence = Number(bounds.oldestSequence) - 1;
      }
      let streamSequence = 0;
      while (!signal.aborted) {
        const message = await response.reader.readFrame();
        if (!exactObject(message, ["type", "version", "requestId", "streamSequence", "payload", "hmac"]) ||
            message.type !== "level-event" || message.version !== PROTOCOL_VERSION ||
            message.requestId !== response.requestId || message.streamSequence !== streamSequence ||
            typeof message.payload !== "string" || typeof message.hmac !== "string") throw new BridgeProtocolError();
        const payload = decodeCanonicalBase64(message.payload);
        const expected = authenticationTag(credential.secret, [
          "stream", PROTOCOL_VERSION, PROTOCOL_VERSION, response.challenge, credential.id,
          response.requestId, streamSequence, payload,
        ]);
        const actual = decodeCanonicalHex(message.hmac, expected.length);
        if (!timingSafeEqual(actual, expected)) throw new BridgeProtocolError();
        const event = parseStrictJson(payload);
        if (!validLevelEvent(event)) throw new BridgeProtocolError();
        streamSequence += 1;
        if (event.type === "terminal") return;
        retryDelay = 100;
        const sequence = event.sequence;
        if (sequence > afterSequence + 600) throw new BridgeProtocolError();
        const previous = confirmed.get(sequence);
        if (previous) {
          if (!sameLevelEvent(previous, event)) throw new BridgeProtocolError();
          continue;
        }
        confirmed.set(sequence, event);
        onLevel(event);
        while (confirmed.has(afterSequence + 1)) afterSequence += 1;
        for (const retained of confirmed.keys()) if (retained < afterSequence - 599) confirmed.delete(retained);
      }
    } catch (error) {
      if (signal.aborted || error instanceof RecorderError) return;
      if (established) requestId = randomUUID();
      onLevel({ type: "transport", state: "unavailable" });
      await abortableDelay(retryDelay, signal).catch(() => {});
      retryDelay = Math.min(1600, retryDelay * 2);
    } finally {
      response?.socket.destroy();
    }
  }
}

function lifecycleFailure(reason: unknown): RecorderError {
  const codes = {
    sleep: "bridge-sleep",
    logout: "bridge-logout",
    reboot: "bridge-reboot",
    "session-lock": "bridge-session-lock",
    "companion-stop": "bridge-companion-stopped",
    "companion-restart": "bridge-companion-restarted",
    "device-loss": "bridge-device-lost",
  } as const;
  const code = typeof reason === "string" ? codes[reason as keyof typeof codes] : undefined;
  return new RecorderError(code ?? "recording-failed");
}

function connectionUnavailable(error: unknown): boolean {
  if (error instanceof BridgeTransportError && error.stage === "authentication") return true;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return ["ECONNREFUSED", "ENOENT", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
}

function safeError(error: unknown): RecorderError {
  if (error instanceof RecorderError) return error;
  if (error instanceof BridgeOutcomeUnknownError) return new RecorderError("outcome-unknown", { cause: error });
  if (error instanceof BridgeResponseError && error.status === "busy") return new RecorderError("recorder-busy");
  if (error instanceof BridgeResponseError && error.status === "failed" &&
      exactObject(error.payload, ["reason"]) && error.payload.reason === "storage-full") {
    return new RecorderError("recorder-storage-full");
  }
  return new RecorderError(error instanceof BridgeAudioError ? "invalid-audio" : "recording-failed", { cause: error });
}

function leasePayload(recordingId: string, leaseSecret: string): { recordingId: string; leaseSecret: string } {
  return { recordingId, leaseSecret };
}

async function localFileOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new RecorderError("recording-failed", { cause: error }); }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

export function createBridgeRecorder(config: BridgeRecorderConfig): Recorder {
  return {
    async start(options: RecorderStartOptions): Promise<Recording> {
      if (options.signal.aborted) throw new RecorderError("cancelled");
      let credential: Credential;
      try { credential = await readCredential(config.credentialFile); }
      catch (error) { throw safeError(error); }
      const recordingId = randomUUID();
      const leaseSecret = randomBytes(32).toString("base64");
      const owned = leasePayload(recordingId, leaseSecret);
      const startRequestedAt = Date.now();
      const piDurationDeadline = startRequestedAt + options.maxDurationMs;
      let startPayload: unknown;
      const startRequestId = randomUUID();
      try {
        startPayload = await requestJson(config, credential, "start", {
          ...owned, maxDurationMs: options.maxDurationMs,
        }, options.signal, startRequestId);
      } catch (error) {
        if (error instanceof RecorderError || error instanceof BridgeProtocolError ||
            error instanceof BridgeResponseError || error instanceof BridgeAudioError) throw safeError(error);
        try { startPayload = await requestJson(config, credential, "status", owned, options.signal); }
        catch (statusError) {
          if (statusError instanceof BridgeResponseError && statusError.status === "not-found") throw safeError(error);
          if (connectionUnavailable(error) && connectionUnavailable(statusError)) {
            throw new RecorderError("recorder-unavailable");
          }
          throw safeError(new BridgeOutcomeUnknownError(undefined, { cause: statusError }));
        }
      }
      const startShape = startPayload && typeof startPayload === "object" && !Array.isArray(startPayload)
        ? startPayload as Record<string, unknown> : undefined;
      const startIsActive = exactObject(startPayload, ["recordingId", "state"]) &&
        ["recording", "finalizing"].includes(String(startShape?.state));
      const maximumBytes = Math.ceil(options.maxDurationMs * 32) + MAX_FRAME_BYTES;
      const startIsResultReady = exactObject(startPayload, ["recordingId", "state", "length", "sha256", "completion"]) &&
        startShape?.state === "result-ready" && Number.isSafeInteger(startShape.length) && Number(startShape.length) >= 44 &&
        Number(startShape.length) <= maximumBytes && typeof startShape.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(startShape.sha256) &&
        ["stopped", "duration-limit", "owner-liveness-loss"].includes(String(startShape.completion));
      if (startShape?.recordingId !== recordingId || (!startIsActive && !startIsResultReady)) {
        throw new RecorderError("recording-failed");
      }
      const recordingStartedAt = Date.now();

      let state: "active" | "stopping" | "stopped" | "cancelling" | "cancelled" | "failed" = "active";
      let stopPromise: Promise<void> | undefined;
      let cancelPromise: Promise<void> | undefined;
      let cancellationRequested = false;
      let durationReached = false;
      let acknowledgementStarted = false;
      let acknowledged = false;
      const stopController = new AbortController();
      const levelController = new AbortController();
      const livenessController = new AbortController();
      void streamLevels(config, credential, owned, levelController.signal, options.onLevel);
      void (async () => {
        let nextProofAt = startRequestedAt + OWNER_LIVENESS_INTERVAL_MS;
        while (!livenessController.signal.aborted) {
          try { await abortableDelay(Math.max(0, nextProofAt - Date.now()), livenessController.signal); }
          catch { return; }
          if (livenessController.signal.aborted || state !== "active") return;
          try {
            const status = await requestJson(config, credential, "status", owned, livenessController.signal);
            if (!status || typeof status !== "object" || Array.isArray(status) ||
                (status as Record<string, unknown>).recordingId !== recordingId) return;
            if ((status as Record<string, unknown>).state !== "recording") {
              levelController.abort();
              return;
            }
          } catch {
            // Missing proofs are intentionally not retried here: the companion's independent
            // fifteen-second owner-liveness deadline remains the source of truth.
          }
          do { nextProofAt += OWNER_LIVENESS_INTERVAL_MS; }
          while (nextProofAt <= Date.now());
        }
      })();

      const partial = `${options.destination}.partial-${randomUUID()}`;
      const ensureNotCancelled = () => {
        if (cancellationRequested) throw new RecorderError("cancelled");
      };
      const finalize = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        if (Date.now() >= piDurationDeadline) durationReached = true;
        state = "stopping";
        livenessController.abort();
        levelController.abort();
        stopPromise = (async () => {
          let resultCompletion: "stopped" | "duration-limit" | "owner-liveness-loss" = "stopped";
          try {
            ensureNotCancelled();
            const finalizationDeadline = Date.now() + FINALIZATION_TIMEOUT_MS;
            const finalizationController = new AbortController();
            const finalizationTimer = setTimeout(
              () => finalizationController.abort(new BridgeOutcomeUnknownError()), FINALIZATION_TIMEOUT_MS
            );
            finalizationTimer.unref?.();
            const finalizationSignal = AbortSignal.any([stopController.signal, finalizationController.signal]);
            const stopRequestId = randomUUID();
            let status: unknown;
            while (true) {
              ensureNotCancelled();
              if (Date.now() >= finalizationDeadline) throw new BridgeOutcomeUnknownError();
              try {
                await requestJson(config, credential, "stop", owned, finalizationSignal, stopRequestId,
                  Math.max(1, finalizationDeadline - Date.now()));
              } catch (error) {
                if (error instanceof RecorderError || error instanceof BridgeProtocolError || error instanceof BridgeAudioError) throw error;
                if (error instanceof BridgeResponseError && !["invalid-state", "not-found"].includes(error.status)) throw error;
              }
              try { status = await requestJson(config, credential, "status", owned, finalizationSignal); }
              catch (error) {
                if (error instanceof BridgeResponseError && error.status === "not-found") {
                  throw new RecorderError("recording-failed", { cause: error });
                }
                if (Date.now() >= finalizationDeadline) throw new BridgeOutcomeUnknownError(undefined, { cause: error });
                await abortableDelay(FINALIZATION_POLL_MS, finalizationSignal);
                continue;
              }
              const statusShape = status as Record<string, unknown>;
              const validKeys = exactObject(status, ["recordingId", "state"]) ||
                exactObject(status, ["recordingId", "state", "reason"]) ||
                exactObject(status, ["recordingId", "state", "length", "sha256", "completion"]);
              if (!validKeys || statusShape.recordingId !== recordingId) throw new BridgeProtocolError();
              if (statusShape.state === "failed") throw lifecycleFailure(statusShape.reason);
              if (statusShape.state === "cancelled") throw new RecorderError("cancelled");
              if (statusShape.state === "result-ready") break;
              if (!["recording", "finalizing"].includes(String(statusShape.state))) throw new RecorderError("recording-failed");
              await abortableDelay(FINALIZATION_POLL_MS, finalizationSignal);
            }
            clearTimeout(finalizationTimer);
            const statusShape = status as Record<string, unknown>;
            if (["duration-limit", "owner-liveness-loss"].includes(String(statusShape.completion))) {
              resultCompletion = statusShape.completion as "duration-limit" | "owner-liveness-loss";
            }

            const fetchRequestId = randomUUID();
            const recoveryDeadline = Date.now() + RECOVERY_WINDOW_MS;
            const recoveryController = new AbortController();
            const recoveryTimer = setTimeout(() => recoveryController.abort(new BridgeOutcomeUnknownError()), RECOVERY_WINDOW_MS);
            recoveryTimer.unref?.();
            const recoverySignal = AbortSignal.any([stopController.signal, recoveryController.signal]);
            let fetched = false;
            let lastFetchError: unknown;
            while (!fetched && Date.now() < recoveryDeadline) {
              let handle;
              let response: ResponseFrame | undefined;
              try {
                ensureNotCancelled();
                await localFileOperation(() => rm(partial, { force: true }));
                response = await authenticatedRequest(
                  config, credential, fetchRequestId, "fetch", owned, recoverySignal, FETCH_NO_PROGRESS_TIMEOUT_MS
                );
                if (response.status !== "ok") throw new BridgeResponseError(response.status, response.payload);
                const metadata = response.payload;
                const maximumBytes = options.maxDurationMs * 32 + MAX_FRAME_BYTES;
                if (!Number.isSafeInteger(maximumBytes) ||
                    !exactObject(metadata, ["recordingId", "length", "sha256", "completion"]) || metadata.recordingId !== recordingId ||
                    !Number.isSafeInteger(metadata.length) || Number(metadata.length) < 44 || Number(metadata.length) > maximumBytes ||
                    typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
                    !["stopped", "duration-limit", "owner-liveness-loss"].includes(String(metadata.completion)) ||
                    metadata.length !== statusShape.length || metadata.sha256 !== statusShape.sha256 ||
                    metadata.completion !== statusShape.completion) throw new BridgeAudioError();
                if (["duration-limit", "owner-liveness-loss"].includes(String(metadata.completion))) {
                  resultCompletion = metadata.completion as "duration-limit" | "owner-liveness-loss";
                }
                handle = await localFileOperation(() => open(partial, "wx", 0o600));
                const digest = createHash("sha256");
                let remaining = Number(metadata.length);
                while (remaining > 0) {
                  ensureNotCancelled();
                  const chunk = await response.reader.readExactly(Math.min(64 * 1024, remaining));
                  recordTestResourceMetric("fetch", chunk.length);
                  await localFileOperation(() => handle!.write(chunk));
                  digest.update(chunk);
                  recordTestResourceMetric("sha256", chunk.length);
                  remaining -= chunk.length;
                }
                await response.reader.requireEnd();
                await localFileOperation(() => handle!.sync());
                await localFileOperation(() => handle!.close());
                handle = undefined;
                if (digest.digest("hex") !== metadata.sha256) throw new BridgeAudioError();
                fetched = true;
              } catch (error) {
                lastFetchError = error;
                if (error instanceof RecorderError || error instanceof BridgeProtocolError ||
                    error instanceof BridgeResponseError || error instanceof BridgeAudioError) throw error;
              } finally {
                response?.socket.destroy();
                await handle?.close().catch(() => {});
                if (!fetched) await rm(partial, { force: true }).catch(() => {});
              }
              if (!fetched) {
                try {
                  const recoveryStatus = await requestJson(config, credential, "status", owned, recoverySignal);
                  const recoveryShape = recoveryStatus as Record<string, unknown>;
                  const recoveryKeys = exactObject(recoveryStatus, ["recordingId", "state"]) ||
                    exactObject(recoveryStatus, ["recordingId", "state", "reason"]) ||
                    exactObject(recoveryStatus, ["recordingId", "state", "length", "sha256", "completion"]);
                  if (!recoveryKeys || recoveryShape.recordingId !== recordingId) throw new BridgeProtocolError();
                  if (recoveryShape.state !== "result-ready") {
                    if (recoveryShape.state === "failed") throw lifecycleFailure(recoveryShape.reason);
                    if (["expired", "cancelled", "acknowledged"].includes(String(recoveryShape.state))) {
                      throw new RecorderError("recording-failed");
                    }
                    throw new BridgeProtocolError();
                  }
                } catch (error) {
                  if (error instanceof RecorderError || error instanceof BridgeProtocolError) throw error;
                  lastFetchError = error;
                }
                await abortableDelay(Math.min(100, Math.max(0, recoveryDeadline - Date.now())), recoverySignal);
              }
            }
            clearTimeout(recoveryTimer);
            if (!fetched) throw new BridgeOutcomeUnknownError(undefined, { cause: lastFetchError });
            await validatePcm16MonoWav(
              partial, stopController.signal, 16_000, options.maxDurationMs * 32
            );
            ensureNotCancelled();
            acknowledgementStarted = true;
            let acknowledgement: unknown;
            try {
              acknowledgement = await requestJson(config, credential, "acknowledge", owned, stopController.signal);
            } catch (error) {
              if (error instanceof RecorderError || error instanceof BridgeProtocolError ||
                  error instanceof BridgeResponseError || error instanceof BridgeAudioError) throw error;
              try { acknowledgement = await requestJson(config, credential, "status", owned, stopController.signal); }
              catch (statusError) { throw new BridgeOutcomeUnknownError(undefined, { cause: statusError }); }
            }
            if (!exactObject(acknowledgement, ["recordingId", "state"]) || acknowledgement.recordingId !== recordingId ||
                acknowledgement.state !== "acknowledged") throw new BridgeProtocolError();
            acknowledged = true;
            ensureNotCancelled();
            if (durationReached || resultCompletion === "duration-limit") {
              throw new RecorderError("duration-limit-reached");
            }
            if (resultCompletion === "owner-liveness-loss") {
              throw new RecorderError("bridge-owner-liveness-lost");
            }
            await rename(partial, options.destination);
            ensureNotCancelled();
            state = "stopped";
          } catch (error) {
            if (!cancellationRequested) state = "failed";
            throw safeError(error);
          } finally {
            clearTimeout(durationTimer);
            options.signal.removeEventListener("abort", onAbort);
            if (state !== "stopped") await rm(partial, { force: true }).catch(() => {});
          }
        })();
        return stopPromise;
      };
      const durationTimer = setTimeout(() => {
        if (state !== "active") return;
        durationReached = true;
        void finalize().catch(() => {});
      }, Math.max(0, piDurationDeadline - Date.now()));
      durationTimer.unref?.();

      const cancelRemotely = async (): Promise<void> => {
        cancellationRequested = true;
        state = "cancelling";
        livenessController.abort();
        levelController.abort();
        clearTimeout(durationTimer);
        stopController.abort();
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
        deadline.unref?.();
        try {
          let confirmed = false;
          try {
            const result = await requestJson(config, credential, "cancel", owned, controller.signal);
            confirmed = exactObject(result, ["recordingId", "state"]) && result.recordingId === recordingId && result.state === "cancelled";
          } catch (error) {
            if (error instanceof RecorderError) throw error;
            const result = await requestJson(config, credential, "status", owned, controller.signal);
            confirmed = exactObject(result, ["recordingId", "state"]) && result.recordingId === recordingId && result.state === "cancelled";
          }
          if (!confirmed) throw new BridgeProtocolError();
          state = "cancelled";
          await rm(partial, { force: true }).catch(() => {});
          await rm(options.destination, { force: true }).catch(() => {});
        } catch (error) {
          state = "failed";
          await rm(partial, { force: true }).catch(() => {});
          await rm(options.destination, { force: true }).catch(() => {});
          throw new RecorderError("cancellation-unconfirmed", { cause: error });
        } finally {
          clearTimeout(deadline);
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      const recording: Recording = {
        startedAt: recordingStartedAt,
        stop() {
          if (state === "stopped") return Promise.resolve();
          if (state === "cancelled" || state === "cancelling") return Promise.reject(new RecorderError("cancelled"));
          if (state === "failed" && !stopPromise) {
            return Promise.reject(new RecorderError(durationReached ? "duration-limit-reached" : "recording-failed"));
          }
          return finalize();
        },
        cancel() {
          if (state === "stopped" || state === "cancelled" || acknowledged) return Promise.resolve();
          if (cancelPromise) return cancelPromise;
          if (acknowledgementStarted) {
            cancelPromise = (async () => {
              try {
                await stopPromise;
                return;
              } catch {}
              await cancelRemotely();
            })();
          } else {
            cancelPromise = cancelRemotely();
          }
          return cancelPromise;
        },
      };
      const onAbort = () => { void recording.cancel().catch(() => {}); };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        await recording.cancel();
        throw new RecorderError("cancelled");
      }
      return recording;
    },
  };
}
