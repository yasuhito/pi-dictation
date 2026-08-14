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

function strictJson(bytes, stage = "response") {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw failure("malformed", stage, error); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw failure("malformed", stage, error); }
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === "\"") return JSON.parse(text.slice(start, index));
    }
    throw failure("malformed", stage);
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index += 1; whitespace();
      const keys = new Set();
      if (text[index] === "}") { index += 1; return; }
      while (true) {
        if (text[index] !== "\"") throw failure("malformed", stage);
        const key = string();
        if (keys.has(key)) throw failure("malformed", stage);
        keys.add(key); whitespace();
        if (text[index++] !== ":") throw failure("malformed", stage);
        value(); whitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index++] !== ",") throw failure("malformed", stage);
        whitespace();
      }
    }
    if (text[index] === "[") {
      index += 1; whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(); whitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index++] !== ",") throw failure("malformed", stage);
      }
    }
    if (text[index] === "\"") { string(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (index === start) throw failure("malformed", stage);
  };
  value(); whitespace();
  if (index !== text.length) throw failure("malformed", stage);
  return parsed;
}

function canonicalBase64(value, expectedBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw failure("malformed", "response");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw failure("malformed", "response");
  }
  return decoded;
}

function canonicalHex(value, expectedBytes) {
  if (typeof value !== "string" || value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw failure("authentication", "response");
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

function validateTiming(timing) {
  if (!exactObject(timing, ["connect", "challenge", "requestWrite", "response"])) throw new TypeError("invalid timing policy");
  for (const policy of Object.values(timing)) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("invalid timing policy");
    if (policy.kind === "absolute" && exactObject(policy, ["kind", "at"]) && Number.isFinite(policy.at)) continue;
    if (policy.kind === "no-progress" && exactObject(policy, ["kind", "timeoutMs"]) && Number.isFinite(policy.timeoutMs) && policy.timeoutMs > 0) continue;
    throw new TypeError("invalid timing policy");
  }
}

function validateInput(options) {
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
  validateTiming(options.timing);
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

function netConnection(endpoint) {
  const socket = endpoint.type === "unix"
    ? net.createConnection({ path: endpoint.path, allowHalfOpen: true })
    : net.createConnection({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true });
  return {
    connected: new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    read() {
      const available = socket.read();
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
          const chunk = socket.read();
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

class Reader {
  constructor(connection, signal, policy, stage) {
    this.connection = connection;
    this.signal = signal;
    this.policy = policy;
    this.stage = stage;
    this.buffer = Buffer.alloc(0);
  }

  async chunk() {
    try {
      return await guarded(() => this.connection.read(), this.policy, this.signal, this.stage, () => this.connection.destroy());
    } catch (error) {
      if (error instanceof BridgeProtocolFailure) throw error;
      throw failure("transport", this.stage, error);
    }
  }

  async exactly(length) {
    const pieces = [];
    let total = 0;
    if (this.buffer.length > 0) {
      pieces.push(this.buffer.subarray(0, length));
      total = Math.min(length, this.buffer.length);
      this.buffer = this.buffer.subarray(total);
    }
    while (total < length) {
      const chunk = await this.chunk();
      if (chunk === null) throw failure("transport", this.stage, new Error("unexpected EOF"));
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
    if (length < 2 || length > MAX_FRAME_BYTES) throw failure("malformed", this.stage);
    return strictJson(await this.exactly(length), this.stage);
  }

  async end() {
    if (this.buffer.length > 0) throw failure("malformed", this.stage);
    const trailing = await this.chunk();
    if (trailing !== null) throw failure("malformed", this.stage);
  }
}

export async function request(options) {
  let payloadBytes;
  try {
    validateInput(options);
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
    if (!exactObject(challengeMessage, ["type", "challenge"]) || challengeMessage.type !== "challenge") {
      throw failure("malformed", "challenge");
    }
    let challenge;
    try { challenge = canonicalBase64(challengeMessage.challenge, 32); }
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
    const responseReader = new Reader(connection, signal, timing.response, "response");
    const response = await responseReader.frame();
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || !Number.isSafeInteger(response.version) || response.version < 1 ||
        response.requestId !== requestId || !STATUSES.has(response.status) || typeof response.payload !== "string") {
      throw failure("malformed", "response");
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
          response.version === PROTOCOL_VERSION) throw failure("malformed", "response");
    } else if (response.version !== PROTOCOL_VERSION) throw failure("malformed", "response");
    await responseReader.end();
    return { status: response.status, payload: parsed };
  } finally {
    connection.destroy();
  }
}
