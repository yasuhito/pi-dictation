import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import net, { type Socket } from "node:net";
import type { BridgeRecorderConfig } from "./config.js";
import type { Recorder, RecorderStartOptions, Recording } from "./recorder.js";
import { RecorderError, validatePcm16MonoWav } from "./recorder.js";

const PROTOCOL_VERSION = 2;
const MAX_FRAME_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 5000;
const FINALIZATION_TIMEOUT_MS = 30_000;
const FETCH_NO_PROGRESS_TIMEOUT_MS = 10_000;
const RECOVERY_WINDOW_MS = 10 * 60_000;
const LEVEL_INTERVAL_MS = 50;
const RETRY_ATTEMPTS = 3;
const FINALIZATION_POLL_MS = 25;

type Credential = { id: string; secret: Buffer };
type ResponseStatus = "ok" | "busy" | "not-found" | "request-conflict" | "invalid-state" | "failed";
type ResponseFrame = { status: ResponseStatus; payload: unknown; reader: SocketReader; socket: Socket };

class BridgeProtocolError extends Error {}
class BridgeTransportError extends Error {}
class BridgeOutcomeUnknownError extends Error {}
class BridgeAudioError extends Error {}
class BridgeResponseError extends Error {
  constructor(readonly status: ResponseStatus) { super(status); }
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
    if (operation === "fetch") {
      clearTimeout(timeout);
      socket.setTimeout(FETCH_NO_PROGRESS_TIMEOUT_MS, () => socket.destroy(new BridgeTransportError()));
    }
    return { status, payload: parsed, reader, socket };
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
        if (response.status !== "ok") throw new BridgeResponseError(response.status);
        return response.payload;
      } finally { response.socket.destroy(); }
    });
  } finally { clearTimeout(timer); }
}

function safeError(error: unknown): RecorderError {
  if (error instanceof RecorderError) return error;
  if (error instanceof BridgeOutcomeUnknownError) return new RecorderError("outcome-unknown", { cause: error });
  if (error instanceof BridgeResponseError && error.status === "busy") return new RecorderError("recorder-busy");
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
      const piDurationDeadline = Date.now() + options.maxDurationMs;
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
          throw safeError(new BridgeOutcomeUnknownError(undefined, { cause: statusError }));
        }
      }
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
      let levelInFlight = false;
      let lastSequence = -1;
      const stopController = new AbortController();
      const levelTimer = setInterval(async () => {
        if (state !== "active" || levelInFlight) return;
        levelInFlight = true;
        try {
          const value = await requestJson(config, credential, "levels", { ...owned, afterSequence: lastSequence });
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
      const ensureNotCancelled = () => {
        if (cancellationRequested) throw new RecorderError("cancelled");
      };
      const finalize = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        if (Date.now() >= piDurationDeadline) durationReached = true;
        state = "stopping";
        clearInterval(levelTimer);
        stopPromise = (async () => {
          let resultCompletion: "stopped" | "duration-limit" = "stopped";
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
                if (Date.now() >= finalizationDeadline) throw new BridgeOutcomeUnknownError(undefined, { cause: error });
                await abortableDelay(FINALIZATION_POLL_MS, finalizationSignal);
                continue;
              }
              const statusShape = status as Record<string, unknown>;
              const validKeys = exactObject(status, ["recordingId", "state"]) ||
                exactObject(status, ["recordingId", "state", "length", "sha256", "completion"]);
              if (!validKeys || statusShape.recordingId !== recordingId) throw new BridgeProtocolError();
              if (statusShape.state === "failed") throw new RecorderError("recording-failed");
              if (statusShape.state === "cancelled") throw new RecorderError("cancelled");
              if (statusShape.state === "result-ready") break;
              if (!["recording", "finalizing"].includes(String(statusShape.state))) throw new RecorderError("recording-failed");
              await abortableDelay(FINALIZATION_POLL_MS, finalizationSignal);
            }
            clearTimeout(finalizationTimer);
            const statusShape = status as Record<string, unknown>;
            if (statusShape.completion === "duration-limit") resultCompletion = "duration-limit";

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
                if (response.status !== "ok") throw new BridgeResponseError(response.status);
                const metadata = response.payload;
                const maximumBytes = Math.ceil(options.maxDurationMs * 32) + MAX_FRAME_BYTES;
                if (!exactObject(metadata, ["recordingId", "length", "sha256", "completion"]) || metadata.recordingId !== recordingId ||
                    !Number.isInteger(metadata.length) || Number(metadata.length) < 44 || Number(metadata.length) > maximumBytes ||
                    typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
                    !["stopped", "duration-limit"].includes(String(metadata.completion))) throw new BridgeAudioError();
                if (metadata.completion === "duration-limit") resultCompletion = "duration-limit";
                handle = await localFileOperation(() => open(partial, "wx", 0o600));
                const digest = createHash("sha256");
                let remaining = Number(metadata.length);
                while (remaining > 0) {
                  ensureNotCancelled();
                  const chunk = await response.reader.readExactly(Math.min(64 * 1024, remaining));
                  await localFileOperation(() => handle!.write(chunk));
                  digest.update(chunk);
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
                    exactObject(recoveryStatus, ["recordingId", "state", "length", "sha256", "completion"]);
                  if (!recoveryKeys || recoveryShape.recordingId !== recordingId) throw new BridgeProtocolError();
                  if (recoveryShape.state !== "result-ready") {
                    if (["failed", "expired", "cancelled", "acknowledged"].includes(String(recoveryShape.state))) {
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
            await validatePcm16MonoWav(partial, stopController.signal);
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
        clearInterval(levelTimer);
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
