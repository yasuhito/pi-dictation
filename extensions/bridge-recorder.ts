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
const REQUEST_TIMEOUT_MS = 5000;
const LEVEL_INTERVAL_MS = 50;
const RETRY_ATTEMPTS = 3;
const FINALIZATION_POLL_MS = 25;

type Credential = { id: string; secret: Buffer };
type ResponseStatus = "ok" | "busy" | "not-found" | "request-conflict" | "invalid-state" | "failed";
type ResponseFrame = {
  status: ResponseStatus;
  payload: unknown;
  reader: SocketReader;
  socket: Socket;
  challenge: Buffer;
  requestId: string;
};

class BridgeProtocolError extends Error {}
class BridgeTransportError extends Error {}
class BridgeAudioError extends Error {}
class BridgeResponseError extends Error {
  constructor(readonly status: ResponseStatus) { super(status); }
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).sort().join("\0") === [...keys].sort().join("\0");
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

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 2 || payload.length > MAX_FRAME_BYTES) throw new BridgeProtocolError();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

class SocketReader {
  private readonly iterator;
  private buffered = Buffer.alloc(0);
  private ended = false;

  constructor(socket: Socket) { this.iterator = socket[Symbol.asyncIterator](); }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length && !this.ended) {
      try {
        const next = await this.iterator.next();
        if (next.done) this.ended = true;
        else this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
      } catch (error) { throw new BridgeTransportError(undefined, { cause: error }); }
    }
    if (this.buffered.length < length) throw new BridgeTransportError();
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  async readFrame(): Promise<unknown> {
    const header = await this.readExactly(4);
    const length = header.readUInt32BE(0);
    if (length < 2 || length > MAX_FRAME_BYTES) throw new BridgeProtocolError();
    try { return JSON.parse((await this.readExactly(length)).toString("utf8")); }
    catch (error) {
      if (error instanceof BridgeTransportError) throw error;
      throw new BridgeProtocolError();
    }
  }

  async requireEnd(): Promise<void> {
    if (this.buffered.length) throw new BridgeAudioError();
    let next;
    try { next = await this.iterator.next(); }
    catch (error) { throw new BridgeTransportError(undefined, { cause: error }); }
    if (!next.done) throw new BridgeAudioError();
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
    if (!exactObject(value, ["id", "secret"]) || typeof value.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
        typeof value.secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.secret)) throw new BridgeProtocolError();
    const secret = Buffer.from(value.secret, "base64");
    if (secret.length !== 32) throw new BridgeProtocolError();
    return { id: value.id, secret };
  } catch { throw new BridgeProtocolError(); }
  finally { await handle.close(); }
}

async function connect(config: BridgeRecorderConfig, signal?: AbortSignal): Promise<Socket> {
  await inspectPrivateEndpoint(config);
  return new Promise((resolveConnection, reject) => {
    const socket = config.endpoint.type === "unix"
      ? net.createConnection({ path: config.endpoint.path, allowHalfOpen: true })
      : net.createConnection({ host: config.endpoint.host, port: config.endpoint.port, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(new BridgeTransportError()), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => socket.destroy(new RecorderError("cancelled"));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    socket.once("connect", () => {
      cleanup();
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new BridgeTransportError()));
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
  signal?: AbortSignal
): Promise<ResponseFrame> {
  const socket = await connect(config, signal);
  const timeout = setTimeout(() => socket.destroy(new BridgeTransportError()), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => socket.destroy(new RecorderError("cancelled"));
  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.once("close", cleanup);
  const reader = new SocketReader(socket);
  try {
    const challengeMessage = await reader.readFrame();
    if (!exactObject(challengeMessage, ["type", "version", "challenge"]) ||
        challengeMessage.type !== "challenge" || challengeMessage.version !== PROTOCOL_VERSION ||
        typeof challengeMessage.challenge !== "string") throw new BridgeProtocolError();
    const challenge = Buffer.from(challengeMessage.challenge, "base64");
    if (challenge.length !== 32) throw new BridgeProtocolError();
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const tag = authenticationTag(credential.secret, [
      "request", PROTOCOL_VERSION, challenge, credential.id, requestId, operation, payloadBytes,
    ]);
    socket.end(frame({
      type: "request", version: PROTOCOL_VERSION, credentialId: credential.id, requestId,
      operation, payload: payloadBytes.toString("base64"), hmac: tag.toString("hex"),
    }));
    const response = await reader.readFrame();
    const statuses: ResponseStatus[] = ["ok", "busy", "not-found", "request-conflict", "invalid-state", "failed"];
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || response.version !== PROTOCOL_VERSION || response.requestId !== requestId ||
        !statuses.includes(response.status as ResponseStatus) || typeof response.payload !== "string" || typeof response.hmac !== "string") {
      throw new BridgeProtocolError();
    }
    const status = response.status as ResponseStatus;
    const responsePayload = Buffer.from(response.payload, "base64");
    const expected = authenticationTag(credential.secret, [
      "response", PROTOCOL_VERSION, challenge, credential.id, requestId, `${operation}:${status}`, responsePayload,
    ]);
    const actual = Buffer.from(response.hmac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeProtocolError();
    let parsed: unknown;
    try { parsed = JSON.parse(responsePayload.toString("utf8")); }
    catch { throw new BridgeProtocolError(); }
    return { status, payload: parsed, reader, socket, challenge, requestId };
  } catch (error) {
    cleanup();
    socket.destroy();
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
  requestId = randomUUID()
): Promise<unknown> {
  return withTransportRetries(async () => {
    const response = await authenticatedRequest(config, credential, requestId, operation, payload, signal);
    try {
      await response.reader.requireEnd();
      if (response.status !== "ok") throw new BridgeResponseError(response.status);
      return response.payload;
    } finally { response.socket.destroy(); }
  });
}

type StreamLevelEvent = Extract<LevelEvent, { type: "observation" | "unavailable" }> |
  { type: "terminal"; state: string };

function validLevelEvent(value: unknown): value is StreamLevelEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type === "observation") {
    return exactObject(event, ["type", "sequence", "capturedAtMs", "dbfs"]) &&
      Number.isInteger(event.sequence) && Number(event.sequence) >= 0 &&
      event.capturedAtMs === Number(event.sequence) * LEVEL_INTERVAL_MS &&
      (event.dbfs === "silence" || (typeof event.dbfs === "number" && Number.isFinite(event.dbfs)));
  }
  if (event.type === "unavailable") {
    return exactObject(event, ["type", "sequence", "capturedAtMs"]) &&
      Number.isInteger(event.sequence) && Number(event.sequence) >= 0 &&
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
  const confirmed = new Map<number, LevelEvent>();
  while (!signal.aborted) {
    let response: ResponseFrame | undefined;
    try {
      response = await authenticatedRequest(
        config, credential, randomUUID(), "subscribe-levels", { ...owned, afterSequence }, signal
      );
      if (response.status === "invalid-state" || response.status === "not-found") return;
      if (response.status !== "ok") throw new BridgeResponseError(response.status);
      const bounds = response.payload;
      if (!exactObject(bounds, ["recordingId", "intervalMs", "oldestSequence", "nextSequence"]) ||
          bounds.recordingId !== owned.recordingId || bounds.intervalMs !== LEVEL_INTERVAL_MS ||
          !Number.isInteger(bounds.oldestSequence) || !Number.isInteger(bounds.nextSequence) ||
          Number(bounds.oldestSequence) < 0 || Number(bounds.nextSequence) < Number(bounds.oldestSequence)) {
        throw new BridgeProtocolError();
      }
      if (Number(bounds.oldestSequence) > afterSequence + 1) {
        onLevel({ type: "gap", fromSequence: afterSequence + 1, toSequence: Number(bounds.oldestSequence) - 1 });
        afterSequence = Number(bounds.oldestSequence) - 1;
      }
      onLevel({ type: "transport", state: "connected" });
      let streamSequence = 0;
      while (!signal.aborted) {
        const message = await response.reader.readFrame();
        if (!exactObject(message, ["type", "version", "requestId", "streamSequence", "payload", "hmac"]) ||
            message.type !== "level-event" || message.version !== PROTOCOL_VERSION ||
            message.requestId !== response.requestId || message.streamSequence !== streamSequence ||
            typeof message.payload !== "string" || typeof message.hmac !== "string") throw new BridgeProtocolError();
        const payload = Buffer.from(message.payload, "base64");
        const expected = authenticationTag(credential.secret, [
          "stream", PROTOCOL_VERSION, response.challenge, credential.id, response.requestId, streamSequence, payload,
        ]);
        const actual = Buffer.from(message.hmac, "hex");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeProtocolError();
        let event: unknown;
        try { event = JSON.parse(payload.toString("utf8")); }
        catch { throw new BridgeProtocolError(); }
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
        for (const retained of confirmed.keys()) if (retained <= afterSequence) confirmed.delete(retained);
      }
    } catch (error) {
      if (signal.aborted || error instanceof RecorderError) return;
      onLevel({ type: "transport", state: "unavailable" });
      await abortableDelay(retryDelay, signal).catch(() => {});
      retryDelay = Math.min(1600, retryDelay * 2);
    } finally {
      response?.socket.destroy();
    }
  }
}

function safeError(error: unknown): RecorderError {
  if (error instanceof RecorderError) return error;
  if (error instanceof BridgeResponseError && error.status === "busy") return new RecorderError("recorder-busy");
  return new RecorderError(error instanceof BridgeAudioError ? "invalid-audio" : "recording-failed", { cause: error });
}

function leasePayload(recordingId: string, leaseSecret: string): { recordingId: string; leaseSecret: string } {
  return { recordingId, leaseSecret };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(new RecorderError("cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RecorderError("cancelled"));
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
      const piDurationDeadline = Date.now() + options.maxDurationMs;
      let startPayload: unknown;
      try {
        startPayload = await requestJson(config, credential, "start", {
          recordingId, leaseSecret, maxDurationMs: options.maxDurationMs,
        }, options.signal);
      } catch (error) { throw safeError(error); }
      if (!exactObject(startPayload, ["recordingId", "state"]) || startPayload.recordingId !== recordingId ||
          !["recording", "finalizing", "result-ready"].includes(String(startPayload.state))) {
        throw new RecorderError("recording-failed");
      }

      let state: "active" | "stopping" | "stopped" | "cancelling" | "cancelled" | "failed" = "active";
      let stopPromise: Promise<void> | undefined;
      let cancelPromise: Promise<void> | undefined;
      let cancellationRequested = false;
      let durationReached = false;
      let acknowledgementStarted = false;
      let acknowledged = false;
      const owned = leasePayload(recordingId, leaseSecret);
      const stopController = new AbortController();
      const levelController = new AbortController();
      void streamLevels(config, credential, owned, levelController.signal, options.onLevel);

      const partial = `${options.destination}.partial-${randomUUID()}`;
      const ensureNotCancelled = () => {
        if (cancellationRequested) throw new RecorderError("cancelled");
      };
      const finalize = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        if (Date.now() >= piDurationDeadline) durationReached = true;
        state = "stopping";
        levelController.abort();
        stopPromise = (async () => {
          let resultCompletion: "stopped" | "duration-limit" = "stopped";
          try {
            ensureNotCancelled();
            try {
              await requestJson(config, credential, "stop", owned, stopController.signal);
            } catch (error) {
              if (!(error instanceof BridgeResponseError && error.status === "invalid-state")) throw error;
            }
            let status: unknown;
            do {
              ensureNotCancelled();
              status = await requestJson(config, credential, "status", owned, stopController.signal);
              const statusShape = status as Record<string, unknown>;
              const validKeys = exactObject(status, ["recordingId", "state"]) ||
                exactObject(status, ["recordingId", "state", "length", "sha256", "completion"]);
              if (!validKeys || statusShape.recordingId !== recordingId || statusShape.state === "failed") throw new BridgeProtocolError();
              if (statusShape.state === "finalizing") await abortableDelay(FINALIZATION_POLL_MS, stopController.signal);
            } while ((status as Record<string, unknown>).state === "finalizing");
            const statusShape = status as Record<string, unknown>;
            if (statusShape.state !== "result-ready") throw new BridgeProtocolError();
            if (statusShape.completion === "duration-limit") resultCompletion = "duration-limit";

            const fetchRequestId = randomUUID();
            let fetched = false;
            let lastFetchError: unknown;
            for (let attempt = 0; attempt < RETRY_ATTEMPTS && !fetched; attempt += 1) {
              let handle;
              let response: ResponseFrame | undefined;
              try {
                ensureNotCancelled();
                await rm(partial, { force: true });
                response = await authenticatedRequest(config, credential, fetchRequestId, "fetch", owned, stopController.signal);
                if (response.status !== "ok") throw new BridgeResponseError(response.status);
                const metadata = response.payload;
                const maximumBytes = Math.ceil(options.maxDurationMs * 32) + MAX_FRAME_BYTES;
                if (!exactObject(metadata, ["recordingId", "length", "sha256", "completion"]) || metadata.recordingId !== recordingId ||
                    !Number.isInteger(metadata.length) || Number(metadata.length) < 44 || Number(metadata.length) > maximumBytes ||
                    typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
                    !["stopped", "duration-limit"].includes(String(metadata.completion))) throw new BridgeAudioError();
                if (metadata.completion === "duration-limit") resultCompletion = "duration-limit";
                handle = await open(partial, "wx", 0o600);
                const digest = createHash("sha256");
                let remaining = Number(metadata.length);
                while (remaining > 0) {
                  ensureNotCancelled();
                  const chunk = await response.reader.readExactly(Math.min(64 * 1024, remaining));
                  await handle.write(chunk);
                  digest.update(chunk);
                  remaining -= chunk.length;
                }
                await response.reader.requireEnd();
                await handle.sync();
                await handle.close();
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
              }
            }
            if (!fetched) throw new BridgeAudioError(undefined, { cause: lastFetchError });
            await validatePcm16MonoWav(partial, stopController.signal);
            ensureNotCancelled();
            acknowledgementStarted = true;
            let acknowledgement: unknown;
            try {
              acknowledgement = await requestJson(config, credential, "acknowledge", owned, stopController.signal);
            } catch (error) {
              if (error instanceof RecorderError || error instanceof BridgeProtocolError ||
                  error instanceof BridgeResponseError || error instanceof BridgeAudioError) throw error;
              acknowledgement = await requestJson(config, credential, "status", owned, stopController.signal);
            }
            if (!exactObject(acknowledgement, ["recordingId", "state"]) || acknowledgement.recordingId !== recordingId ||
                acknowledgement.state !== "acknowledged") throw new BridgeProtocolError();
            acknowledged = true;
            ensureNotCancelled();
            if (durationReached || resultCompletion === "duration-limit") {
              throw new RecorderError("duration-limit-reached");
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
        levelController.abort();
        clearTimeout(durationTimer);
        stopController.abort();
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        deadline.unref?.();
        try {
          let confirmed = false;
          try {
            const result = await requestJson(config, credential, "cancel", owned, controller.signal);
            confirmed = exactObject(result, ["recordingId", "state"]) && result.recordingId === recordingId && result.state === "cancelled";
          } catch (error) {
            if (!(error instanceof BridgeResponseError && error.status === "invalid-state")) throw error;
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
