import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import net, { type Socket } from "node:net";
import type { BridgeRecorderConfig } from "./config.js";
import type { Recorder, RecorderStartOptions, Recording } from "./recorder.js";
import { RecorderError, validatePcm16MonoWav } from "./recorder.js";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const LEVEL_INTERVAL_MS = 50;

type Credential = { id: string; secret: Buffer };
type ResponseFrame = { payload: unknown; reader: SocketReader; socket: Socket };

class BridgeProtocolError extends Error {}
class BridgeAudioError extends Error {}

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

  constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) this.ended = true;
      else this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
    }
    if (this.buffered.length < length) throw new BridgeAudioError();
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  async readFrame(): Promise<unknown> {
    try {
      const header = await this.readExactly(4);
      const length = header.readUInt32BE(0);
      if (length < 2 || length > MAX_FRAME_BYTES) throw new BridgeProtocolError();
      return JSON.parse((await this.readExactly(length)).toString("utf8"));
    } catch {
      throw new BridgeProtocolError();
    }
  }

  async requireEnd(): Promise<void> {
    if (this.buffered.length) throw new BridgeAudioError();
    const next = await this.iterator.next();
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
        (process.getuid?.() !== undefined && info.uid !== process.getuid?.()) ||
        info.size < 2 || info.size > 4096) throw new BridgeProtocolError();
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!exactObject(value, ["id", "secret"]) || typeof value.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
        typeof value.secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.secret)) throw new BridgeProtocolError();
    const secret = Buffer.from(value.secret, "base64");
    if (secret.length !== 32) throw new BridgeProtocolError();
    return { id: value.id, secret };
  } catch {
    throw new BridgeProtocolError();
  } finally {
    await handle.close();
  }
}

async function connect(config: BridgeRecorderConfig, signal?: AbortSignal): Promise<Socket> {
  await inspectPrivateEndpoint(config);
  return new Promise((resolveConnection, reject) => {
    const socket = config.endpoint.type === "unix"
      ? net.createConnection({ path: config.endpoint.path, allowHalfOpen: true })
      : net.createConnection({ host: config.endpoint.host, port: config.endpoint.port, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(new BridgeProtocolError()), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => socket.destroy(new RecorderError("cancelled"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    socket.once("connect", () => {
      cleanup();
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new BridgeProtocolError()));
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
  operation: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<ResponseFrame> {
  const socket = await connect(config, signal);
  const timeout = setTimeout(() => socket.destroy(new BridgeProtocolError()), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => socket.destroy(new RecorderError("cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const reader = new SocketReader(socket);
  try {
    const challengeMessage = await reader.readFrame();
    if (!exactObject(challengeMessage, ["type", "version", "challenge"]) ||
        challengeMessage.type !== "challenge" || challengeMessage.version !== PROTOCOL_VERSION ||
        typeof challengeMessage.challenge !== "string") throw new BridgeProtocolError();
    const challenge = Buffer.from(challengeMessage.challenge, "base64");
    if (challenge.length !== 32) throw new BridgeProtocolError();
    const requestId = randomUUID();
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const tag = authenticationTag(credential.secret, [
      "request", PROTOCOL_VERSION, challenge, credential.id, requestId, operation, payloadBytes,
    ]);
    socket.end(frame({
      type: "request", version: PROTOCOL_VERSION, credentialId: credential.id, requestId,
      operation, payload: payloadBytes.toString("base64"), hmac: tag.toString("hex"),
    }));
    const response = await reader.readFrame();
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || response.version !== PROTOCOL_VERSION || response.requestId !== requestId ||
        response.status !== "ok" || typeof response.payload !== "string" || typeof response.hmac !== "string") {
      throw new BridgeProtocolError();
    }
    const responsePayload = Buffer.from(response.payload, "base64");
    const expected = authenticationTag(credential.secret, [
      "response", PROTOCOL_VERSION, challenge, credential.id, requestId, `${operation}:ok`, responsePayload,
    ]);
    const actual = Buffer.from(response.hmac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeProtocolError();
    let parsed: unknown;
    try { parsed = JSON.parse(responsePayload.toString("utf8")); }
    catch { throw new BridgeProtocolError(); }
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    return { payload: parsed, reader, socket };
  } catch (error) {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    socket.destroy();
    throw error;
  }
}

async function requestJson(
  config: BridgeRecorderConfig,
  credential: Credential,
  operation: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await authenticatedRequest(config, credential, operation, payload, signal);
  try {
    await response.reader.requireEnd();
    return response.payload;
  } finally {
    response.socket.destroy();
  }
}

function safeError(error: unknown): RecorderError {
  if (error instanceof RecorderError) return error;
  return new RecorderError(error instanceof BridgeAudioError ? "invalid-audio" : "recording-failed", { cause: error });
}

export function createBridgeRecorder(config: BridgeRecorderConfig): Recorder {
  return {
    async start(options: RecorderStartOptions): Promise<Recording> {
      if (options.signal.aborted) throw new RecorderError("cancelled");
      let credential: Credential;
      try { credential = await readCredential(config.credentialFile); }
      catch (error) { throw safeError(error); }
      const recordingId = randomUUID();
      let startPayload: unknown;
      try {
        startPayload = await requestJson(config, credential, "start", { recordingId, maxDurationMs: options.maxDurationMs }, options.signal);
      } catch (error) { throw safeError(error); }
      if (!exactObject(startPayload, ["recordingId", "lease"]) || startPayload.recordingId !== recordingId ||
          typeof startPayload.lease !== "string" || Buffer.from(startPayload.lease, "base64").length !== 32) {
        throw new RecorderError("recording-failed");
      }
      const lease = startPayload.lease;
      let state: "active" | "stopping" | "stopped" | "cancelled" | "failed" = "active";
      let stopPromise: Promise<void> | undefined;
      let cancelPromise: Promise<void> | undefined;
      let levelInFlight = false;
      let lastSequence = -1;
      const levelTimer = setInterval(async () => {
        if (state !== "active" || levelInFlight) return;
        levelInFlight = true;
        try {
          const value = await requestJson(config, credential, "levels", { recordingId, lease, afterSequence: lastSequence });
          if (!exactObject(value, ["observations"]) || !Array.isArray(value.observations)) return;
          for (const observation of value.observations) {
            if (!exactObject(observation, ["sequence", "capturedAtMs", "dbfs"]) ||
                !Number.isInteger(observation.sequence) || typeof observation.capturedAtMs !== "number" ||
                (observation.dbfs !== "silence" && typeof observation.dbfs !== "number") || Number(observation.sequence) <= lastSequence) continue;
            lastSequence = Number(observation.sequence);
            options.onLevel(observation as never);
          }
        } catch {} finally { levelInFlight = false; }
      }, LEVEL_INTERVAL_MS);
      levelTimer.unref?.();

      const partial = `${options.destination}.partial-${randomUUID()}`;
      const recording: Recording = {
        stop() {
          if (state === "stopped") return Promise.resolve();
          if (state === "cancelled") return Promise.reject(new RecorderError("cancelled"));
          if (state === "failed") return Promise.reject(new RecorderError("recording-failed"));
          if (stopPromise) return stopPromise;
          state = "stopping";
          clearInterval(levelTimer);
          stopPromise = (async () => {
            let handle;
            let response: ResponseFrame | undefined;
            const cancellationRequested = () => state === "cancelled";
            try {
              response = await authenticatedRequest(config, credential, "stop", { recordingId, lease });
              const metadata = response.payload;
              const maximumBytes = Math.ceil(options.maxDurationMs * 32) + MAX_FRAME_BYTES;
              if (!exactObject(metadata, ["recordingId", "length", "sha256"]) || metadata.recordingId !== recordingId ||
                  !Number.isInteger(metadata.length) || Number(metadata.length) < 44 || Number(metadata.length) > maximumBytes ||
                  typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256)) throw new BridgeAudioError();
              handle = await open(partial, "wx", 0o600);
              const digest = createHash("sha256");
              let remaining = Number(metadata.length);
              while (remaining > 0) {
                const chunk = await response.reader.readExactly(Math.min(64 * 1024, remaining));
                await handle.write(chunk);
                digest.update(chunk);
                remaining -= chunk.length;
              }
              await response.reader.requireEnd();
              response.socket.destroy();
              await handle.sync();
              await handle.close();
              handle = undefined;
              if (digest.digest("hex") !== metadata.sha256) throw new BridgeAudioError();
              await validatePcm16MonoWav(partial);
              if (cancellationRequested()) throw new RecorderError("cancelled");
              const acknowledgement = await requestJson(config, credential, "acknowledge", { recordingId, lease });
              if (!exactObject(acknowledgement, ["acknowledged"]) || acknowledgement.acknowledged !== true) throw new BridgeProtocolError();
              if (cancellationRequested()) throw new RecorderError("cancelled");
              await rename(partial, options.destination);
              state = "stopped";
            } catch (error) {
              if (!cancellationRequested()) state = "failed";
              throw safeError(error);
            } finally {
              response?.socket.destroy();
              await handle?.close().catch(() => {});
              if (state !== "stopped") await rm(partial, { force: true }).catch(() => {});
            }
          })();
          return stopPromise;
        },
        cancel() {
          if (state === "stopped" || state === "cancelled") return Promise.resolve();
          if (cancelPromise) return cancelPromise;
          state = "cancelled";
          clearInterval(levelTimer);
          cancelPromise = (async () => {
            await requestJson(config, credential, "cancel", { recordingId, lease }).catch(() => {});
            if (stopPromise) await stopPromise.catch(() => {});
            await rm(partial, { force: true }).catch(() => {});
            await rm(options.destination, { force: true }).catch(() => {});
          })();
          return cancelPromise;
        },
      };
      if (options.signal.aborted) {
        await recording.cancel();
        throw new RecorderError("cancelled");
      }
      return recording;
    },
  };
}
