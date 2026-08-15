import { createHmac, timingSafeEqual } from "node:crypto";
import net from "node:net";

const PROTOCOL_VERSION = 3;
const MAX_FRAME_BYTES = 64 * 1024;
const TEST_ADAPTER = Symbol.for("pi-dictation.bridge-protocol.test-adapter");
const STATUSES = new Set([
  "ok", "busy", "not-found", "request-conflict", "invalid-state", "failed", "version-mismatch",
]);

export class BridgeProtocolFailure extends Error {
  constructor(kind, stage, cause) {
    super(`${kind} during ${stage}`, cause === undefined ? undefined : { cause });
    this.name = "BridgeProtocolFailure";
    this.kind = kind;
    this.stage = stage;
  }
}

function failure(kind, stage, cause) {
  return new BridgeProtocolFailure(kind, stage, cause);
}

function protocolDetail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function trailingBytesFailure(stage) {
  return failure("malformed", stage, protocolDetail("ERR_BRIDGE_TRAILING_BYTES", "unexpected trailing bytes"));
}

function exactObject(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError("JSON numbers must be finite");
  }
  if (typeof value !== "object") throw new TypeError("payload is not JSON-representable");
  if (seen.has(value)) throw new TypeError("payload must not be cyclic");
  seen.add(value);
  for (let prototype = value; prototype; prototype = Object.getPrototypeOf(prototype)) {
    if (Object.getOwnPropertyDescriptor(prototype, "toJSON")) throw new TypeError("payload serialization hooks are unsupported");
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) throw new TypeError("payload arrays must not be sparse");
      if (!("value" in descriptor)) throw new TypeError("payload accessors are unsupported");
      validateJson(descriptor.value, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("payload must contain only JSON objects");
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("payload accessors are unsupported");
      validateJson(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

function strictJson(bytes, stage = "response", code = "ERR_BRIDGE_MALFORMED_AUTHENTICATED_DATA") {
  const malformed = () => failure("malformed", stage, protocolDetail(code));
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw malformed(); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw malformed(); }
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === "\"") return JSON.parse(text.slice(start, index));
    }
    throw malformed();
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index += 1; whitespace();
      const keys = new Set();
      if (text[index] === "}") { index += 1; return; }
      while (true) {
        if (text[index] !== "\"") throw malformed();
        const key = string();
        if (keys.has(key)) throw malformed();
        keys.add(key); whitespace();
        if (text[index++] !== ":") throw malformed();
        value(); whitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index++] !== ",") throw malformed();
        whitespace();
      }
    }
    if (text[index] === "[") {
      index += 1; whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(); whitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index++] !== ",") throw malformed();
      }
    }
    if (text[index] === "\"") { string(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (index === start) throw malformed();
  };
  value(); whitespace();
  if (index !== text.length) throw malformed();
  return parsed;
}

function canonicalBase64(value, expectedBytes, stage = "response") {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw failure("malformed", stage, protocolDetail("ERR_BRIDGE_MALFORMED_AUTHENTICATED_DATA"));
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw failure("malformed", stage, protocolDetail("ERR_BRIDGE_MALFORMED_AUTHENTICATED_DATA"));
  }
  return decoded;
}

function canonicalHex(value, expectedBytes, stage = "response") {
  if (typeof value !== "string" || value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw failure("authentication", stage, protocolDetail("ERR_BRIDGE_NONCANONICAL_AUTHENTICATION"));
  }
  return Buffer.from(value, "hex");
}

function authEncoding(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) || field instanceof Uint8Array ? Buffer.from(field) : Buffer.from(String(field));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}

function tag(secret, fields) {
  return createHmac("sha256", secret).update(authEncoding(fields)).digest();
}

function framed(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 2 || body.length > MAX_FRAME_BYTES) throw failure("malformed", "request-write");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function validateTiming(timing, streaming = false) {
  const keys = ["connect", "challenge", "requestWrite", "response", ...(streaming ? ["stream", "end"] : [])];
  if (!exactObject(timing, keys)) throw new TypeError("invalid timing policy");
  for (const policy of Object.values(timing)) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("invalid timing policy");
    if (policy.kind === "absolute" && exactObject(policy, ["kind", "at"]) && Number.isFinite(policy.at)) continue;
    if (policy.kind === "no-progress" && exactObject(policy, ["kind", "timeoutMs"]) && Number.isFinite(policy.timeoutMs) && policy.timeoutMs > 0) continue;
    throw new TypeError("invalid timing policy");
  }
}

function validateInput(options, streaming = false) {
  if (!options || typeof options !== "object") throw new TypeError("request options are required");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (typeof options.requestId !== "string" || !uuid.test(options.requestId)) {
    throw new TypeError("requestId must be a canonical UUID");
  }
  if (typeof options.operation !== "string" || options.operation.length === 0) throw new TypeError("operation is required");
  if (!options.credential || typeof options.credential.id !== "string" || !uuid.test(options.credential.id) ||
      !(options.credential.secret instanceof Uint8Array) || options.credential.secret.byteLength !== 32) {
    throw new TypeError("invalid credential");
  }
  validateTiming(options.timing, streaming);
  if (streaming && options.kind !== "binary" && options.kind !== "authenticated-frames") {
    throw new TypeError("invalid stream kind");
  }
  if (!options.payload || typeof options.payload !== "object" || Array.isArray(options.payload)) {
    throw new TypeError("payload must be a JSON object");
  }
  validateJson(options.payload);
  if (!(options.signal instanceof AbortSignal)) throw new TypeError("signal is required");
}

function deadlineMilliseconds(policy) {
  return policy.kind === "absolute" ? Math.max(0, policy.at - Date.now()) : policy.timeoutMs;
}

async function guarded(operation, policy, signal, stage, onTimeout) {
  if (signal.aborted) throw failure("cancelled", stage, signal.reason);
  const timeout = deadlineMilliseconds(policy);
  if (timeout <= 0) throw failure("deadline", stage);
  let timer;
  let abort;
  const interruption = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(failure("deadline", stage));
      onTimeout?.();
    }, timeout);
    abort = () => {
      reject(failure("cancelled", stage, signal.reason));
      onTimeout?.();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation(), interruption]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function recordTestResourceMetric(name, bytes) {
  if (process.env.PI_DICTATION_TEST_RESOURCE_METRICS !== "1") return;
  const metrics = globalThis.__piDictationBridgeResourceMetrics ??= {};
  metrics[name] = Math.max(metrics[name] ?? 0, bytes);
}

function netConnection(endpoint) {
  const socket = endpoint.type === "unix"
    ? net.createConnection({ path: endpoint.path, allowHalfOpen: true })
    : net.createConnection({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true });
  const readAvailable = () => {
    if (socket.readableLength === 0) return null;
    const chunk = socket.read(Math.min(MAX_FRAME_BYTES, socket.readableLength));
    if (chunk) recordTestResourceMetric("socket", chunk.length);
    return chunk;
  };
  return {
    connected: new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    read() {
      const available = readAvailable();
      if (available) return Promise.resolve(Buffer.from(available));
      if (socket.readableEnded) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.removeListener("readable", readable);
          socket.removeListener("end", ended);
          socket.removeListener("close", ended);
          socket.removeListener("error", failed);
        };
        const readable = () => {
          const chunk = readAvailable();
          if (chunk === null && !socket.readableEnded) {
            socket.once("readable", readable);
            return;
          }
          cleanup();
          resolve(chunk === null ? null : Buffer.from(chunk));
        };
        const ended = () => { cleanup(); resolve(null); };
        const failed = (error) => { cleanup(); reject(error); };
        socket.once("readable", readable);
        socket.once("end", ended);
        socket.once("close", ended);
        socket.once("error", failed);
      });
    },
    write(bytes) {
      return new Promise((resolve, reject) => socket.write(bytes, (error) => error ? reject(error) : resolve()));
    },
    end() { socket.end(); },
    destroy(error) { socket.destroy(error); },
  };
}

function connectionFor(endpoint) {
  if (endpoint && typeof endpoint === "object" && endpoint[TEST_ADAPTER]) return endpoint[TEST_ADAPTER].connect();
  if (!endpoint || typeof endpoint !== "object" ||
      !(endpoint.type === "unix" && typeof endpoint.path === "string") &&
      !(endpoint.type === "tcp" && typeof endpoint.host === "string" && Number.isInteger(endpoint.port) &&
        endpoint.port >= 1 && endpoint.port <= 65_535)) {
    throw new TypeError("invalid endpoint");
  }
  return netConnection(endpoint);
}

class StreamGuard {
  constructor(policy, signal, connection) {
    this.policy = policy;
    this.signal = signal;
    this.connection = connection;
    this.interruption = new Promise((_, reject) => { this.reject = reject; });
    this.abort = () => this.interrupt(failure("cancelled", "stream", signal.reason));
    signal.addEventListener("abort", this.abort, { once: true });
    this.arm();
    if (signal.aborted) this.abort();
  }

  arm() {
    clearTimeout(this.timer);
    const timeout = deadlineMilliseconds(this.policy);
    if (timeout <= 0) {
      this.interrupt(failure("deadline", "stream"));
      return;
    }
    this.timer = setTimeout(() => this.interrupt(failure("deadline", "stream")), timeout);
  }

  interrupt(error) {
    if (this.interrupted) return;
    this.interrupted = error;
    this.reject(error);
  }

  check() {
    if (this.interrupted) throw this.interrupted;
    if (this.signal.aborted) {
      this.interrupt(failure("cancelled", "stream", this.signal.reason));
      throw this.interrupted;
    }
    if (this.policy.kind === "absolute" && this.policy.at <= Date.now()) {
      this.interrupt(failure("deadline", "stream"));
      throw this.interrupted;
    }
  }

  progress() {
    this.check();
    if (this.policy.kind === "no-progress") this.arm();
  }

  async race(operation) {
    if (this.interrupted) return this.interruption;
    try { this.check(); }
    catch { return this.interruption; }
    return Promise.race([operation(), this.interruption]);
  }

  close() {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.abort);
  }
}

class Reader {
  constructor(connection, signal, policy, stage) {
    this.connection = connection;
    this.signal = signal;
    this.policy = policy;
    this.stage = stage;
    this.buffer = Buffer.alloc(0);
    this.guard = undefined;
  }

  async chunk() {
    try {
      const chunk = this.guard
        ? await this.guard.race(() => this.connection.read())
        : await guarded(() => this.connection.read(), this.policy, this.signal, this.stage, () => this.connection.destroy());
      if (chunk !== null) this.guard?.progress();
      return chunk;
    } catch (error) {
      if (error instanceof BridgeProtocolFailure) throw error;
      throw failure("transport", this.stage, error);
    }
  }

  async exactly(length) {
    this.guard?.check();
    const pieces = [];
    let total = 0;
    if (this.buffer.length > 0) {
      pieces.push(this.buffer.subarray(0, length));
      total = Math.min(length, this.buffer.length);
      this.buffer = this.buffer.subarray(total);
      if (total > 0) this.guard?.progress();
    }
    while (total < length) {
      const chunk = await this.chunk();
      if (chunk === null) {
        throw failure("transport", this.stage, protocolDetail("ERR_BRIDGE_UNEXPECTED_EOF", "unexpected EOF"));
      }
      const needed = length - total;
      pieces.push(chunk.subarray(0, needed));
      total += Math.min(needed, chunk.length);
      if (chunk.length > needed) this.buffer = chunk.subarray(needed);
    }
    return Buffer.concat(pieces, length);
  }

  async frame() {
    const header = await this.exactly(4);
    const length = header.readUInt32BE(0);
    if (length < 2 || length > MAX_FRAME_BYTES) {
      throw failure("malformed", this.stage, protocolDetail("ERR_BRIDGE_INVALID_FRAME"));
    }
    return strictJson(await this.exactly(length), this.stage, "ERR_BRIDGE_MALFORMED_PROTOCOL_DATA");
  }

  async end() {
    if (this.policy.kind === "absolute" && this.policy.at <= Date.now()) throw failure("deadline", this.stage);
    if (this.buffer.length > 0) throw trailingBytesFailure(this.stage);
    const trailing = await this.chunk();
    if (trailing !== null) throw trailingBytesFailure(this.stage);
  }
}

async function openAuthenticated(options, streaming = false) {
  let payloadBytes;
  try {
    validateInput(options, streaming);
    payloadBytes = Buffer.from(JSON.stringify(options.payload));
  } catch (error) { throw failure("malformed", "request-write", error); }
  const { endpoint, credential, requestId, operation, timing, signal } = options;
  if (signal.aborted) throw failure("cancelled", "connect", signal.reason);
  if (timing.connect.kind === "absolute" && timing.connect.at <= Date.now()) {
    throw failure("deadline", "connect");
  }
  let connection;
  try { connection = connectionFor(endpoint); }
  catch (error) {
    if (error instanceof TypeError) throw failure("malformed", "connect", error);
    throw failure("transport", "connect", error);
  }
  try {
    try {
      await guarded(() => connection.connected, timing.connect, signal, "connect", () => connection.destroy());
    } catch (error) {
      if (error instanceof BridgeProtocolFailure) throw error;
      throw failure("transport", "connect", error);
    }
    const challengeReader = new Reader(connection, signal, timing.challenge, "challenge");
    const challengeMessage = await challengeReader.frame();
    if (challengeReader.buffer.length > 0) throw trailingBytesFailure("challenge");
    if (!exactObject(challengeMessage, ["type", "challenge"]) || challengeMessage.type !== "challenge") {
      throw failure("malformed", "challenge", protocolDetail("ERR_BRIDGE_INVALID_CHALLENGE"));
    }
    let challenge;
    try { challenge = canonicalBase64(challengeMessage.challenge, 32, "challenge"); }
    catch (error) { throw failure("malformed", "challenge", error); }
    const secret = Buffer.from(credential.secret);
    const requestTag = tag(secret, [
      "request", PROTOCOL_VERSION, challenge, credential.id, requestId, operation, payloadBytes,
    ]);
    const bytes = framed({
      type: "request", version: PROTOCOL_VERSION, credentialId: credential.id, requestId, operation,
      payload: payloadBytes.toString("base64"), hmac: requestTag.toString("hex"),
    });
    try {
      await guarded(() => connection.write(bytes), timing.requestWrite, signal, "request-write", () => connection.destroy());
      connection.end();
    } catch (error) {
      if (error instanceof BridgeProtocolFailure) throw error;
      throw failure("transport", "request-write", error);
    }
    const reader = new Reader(connection, signal, timing.response, "response");
    const response = await reader.frame();
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || !Number.isSafeInteger(response.version) || response.version < 1 ||
        response.requestId !== requestId || !STATUSES.has(response.status)) {
      throw failure("malformed", "response", protocolDetail("ERR_BRIDGE_INVALID_RESPONSE"));
    }
    const responsePayload = canonicalBase64(response.payload);
    const expected = tag(secret, [
      "response", PROTOCOL_VERSION, response.version, challenge, credential.id, requestId,
      `${operation}:${response.status}`, responsePayload,
    ]);
    const actual = canonicalHex(response.hmac, expected.length);
    if (!timingSafeEqual(actual, expected)) throw failure("authentication", "response");
    const parsed = strictJson(responsePayload);
    if (response.status === "version-mismatch") {
      if (!exactObject(parsed, ["clientVersion", "companionVersion"]) ||
          parsed.clientVersion !== PROTOCOL_VERSION || parsed.companionVersion !== response.version ||
          response.version === PROTOCOL_VERSION) {
        throw failure("malformed", "response", protocolDetail("ERR_BRIDGE_INVALID_VERSION_DATA"));
      }
    } else if (response.version !== PROTOCOL_VERSION) {
      throw failure("malformed", "response", protocolDetail("ERR_BRIDGE_INVALID_VERSION_DATA"));
    }
    return { connection, reader, challenge, secret, status: response.status, payload: parsed };
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

class BinaryByteSource {
  constructor(reader) {
    this.reader = reader;
    this.incomplete = false;
  }

  readExactly(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("length must be a non-negative safe integer");
    if (this.incomplete) throw new TypeError("an exact read is already active");
    this.incomplete = true;
    let remaining = length;
    const source = this;
    return (async function* () {
      try {
        while (remaining > 0) {
          const chunk = await source.reader.exactly(Math.min(MAX_FRAME_BYTES, remaining));
          remaining -= chunk.length;
          yield chunk;
        }
      } finally {
        if (remaining === 0) source.incomplete = false;
      }
    })();
  }

  verifyComplete() {
    if (this.incomplete) throw failure("malformed", "stream");
  }
}

class AuthenticatedFrameSource {
  constructor(reader, secret, challenge, credentialId, requestId) {
    this.reader = reader;
    this.secret = secret;
    this.challenge = challenge;
    this.credentialId = credentialId;
    this.requestId = requestId;
    this.iterated = false;
  }

  [Symbol.asyncIterator]() {
    if (this.iterated) throw new TypeError("authenticated frames can only be iterated once");
    this.iterated = true;
    let sequence = 0;
    return {
      next: async () => {
        const message = await this.reader.frame();
        if (!exactObject(message, ["type", "version", "requestId", "streamSequence", "payload", "hmac"]) ||
            message.type !== "level-event" || message.version !== PROTOCOL_VERSION ||
            message.requestId !== this.requestId || message.streamSequence !== sequence ||
            typeof message.payload !== "string" || typeof message.hmac !== "string") {
          throw failure("malformed", "stream");
        }
        const payload = canonicalBase64(message.payload, undefined, "stream");
        const expected = tag(this.secret, [
          "stream", PROTOCOL_VERSION, message.version, this.challenge, this.credentialId,
          this.requestId, sequence, payload,
        ]);
        const actual = canonicalHex(message.hmac, expected.length, "stream");
        if (!timingSafeEqual(actual, expected)) throw failure("authentication", "stream");
        sequence += 1;
        return { done: false, value: strictJson(payload, "stream") };
      },
    };
  }
}

export async function request(options) {
  const opened = await openAuthenticated(options);
  try {
    await opened.reader.end();
    return { status: opened.status, payload: opened.payload };
  } finally {
    opened.connection.destroy();
  }
}

export async function withStream(options, consumer) {
  if (typeof consumer !== "function") throw failure("malformed", "request-write", new TypeError("consumer is required"));
  const opened = await openAuthenticated(options, true);
  const { connection, reader, challenge, secret, status, payload } = opened;
  try {
    if (status !== "ok") {
      reader.policy = options.timing.end;
      reader.stage = "stream";
      await reader.end();
      return { status, payload };
    }
    const guard = new StreamGuard(options.timing.stream, options.signal, connection);
    reader.guard = guard;
    reader.stage = "stream";
    let source;
    const context = options.kind === "binary"
      ? { metadata: payload, bytes: (source = new BinaryByteSource(reader)) }
      : { metadata: payload, frames: new AuthenticatedFrameSource(
        reader, secret, challenge, options.credential.id, options.requestId,
      ) };
    let value;
    try {
      value = await guard.race(() => Promise.resolve().then(() => consumer(context)));
    } finally {
      guard.close();
      reader.guard = undefined;
    }
    if (source) {
      source.verifyComplete();
      reader.policy = options.timing.end;
      await reader.end();
    }
    return { status, payload, value };
  } finally {
    connection.destroy();
  }
}
