import { createHmac, randomUUID } from "node:crypto";
import { request, withStream } from "../../lib/bridge-protocol.mjs";

const TEST_ADAPTER = Symbol.for("pi-dictation.bridge-protocol.test-adapter");
const VERSION = 3;

function encode(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) || field instanceof Uint8Array ? Buffer.from(field) : Buffer.from(String(field));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}
function tag(secret, fields) { return createHmac("sha256", secret).update(encode(fields)).digest(); }
function frameBody(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function frame(value) { return frameBody(Buffer.from(JSON.stringify(value))); }

export function createRequestHarness(overrides = {}) {
  const credential = { id: randomUUID(), secret: Buffer.alloc(32, 19) };
  const challenge = Buffer.alloc(32, 23);
  const state = { connects: 0, destroyed: 0, request: undefined };
  const adapter = {
    connect() {
      state.connects += 1;
      const queue = [];
      const waiters = [];
      let requestBytes = Buffer.alloc(0);
      const enqueue = (chunk) => {
        const waiter = waiters.shift();
        if (waiter) waiter(chunk);
        else queue.push(chunk);
      };
      const challengeBytes = overrides.challengeBytes ?? frame({ type: "challenge", challenge: challenge.toString("base64") });
      for (const chunk of overrides.fragmentChallenge ? [...challengeBytes].map((byte) => Buffer.from([byte])) : [challengeBytes]) enqueue(chunk);
      if (overrides.challengeEof) enqueue(null);
      const connection = {
        connected: overrides.connect ?? Promise.resolve(),
        read(maxBytes) {
          if (queue.length > 0) {
            const chunk = queue.shift();
            if (chunk !== null && maxBytes !== undefined && chunk.length > maxBytes) {
              queue.unshift(chunk.subarray(maxBytes));
              return Promise.resolve(chunk.subarray(0, maxBytes));
            }
            return Promise.resolve(chunk);
          }
          return new Promise((resolve) => waiters.push((chunk) => {
            if (chunk !== null && maxBytes !== undefined && chunk.length > maxBytes) {
              queue.unshift(chunk.subarray(maxBytes));
              resolve(chunk.subarray(0, maxBytes));
            } else resolve(chunk);
          }));
        },
        write(bytes) {
          if (overrides.write) return overrides.write(bytes);
          requestBytes = Buffer.concat([requestBytes, bytes]);
          return Promise.resolve();
        },
        end() {
          if (overrides.noResponse) return;
          const length = requestBytes.readUInt32BE(0);
          const requestMessage = JSON.parse(requestBytes.subarray(4, length + 4));
          state.request = requestMessage;
          const payloadBytes = Buffer.from(requestMessage.payload, "base64");
          const status = overrides.status ?? "ok";
          const responseVersion = overrides.responseVersion ?? VERSION;
          const responsePayload = overrides.responsePayloadBytes ?? Buffer.from(JSON.stringify(overrides.responsePayload ?? { accepted: true }));
          const responseRequestId = overrides.responseRequestId ?? requestMessage.requestId;
          const responseTag = tag(credential.secret, [
            "response", VERSION, responseVersion, challenge, credential.id, requestMessage.requestId,
            `${requestMessage.operation}:${status}`, responsePayload,
          ]);
          const response = overrides.responseBytes ?? frame({
            type: "response", version: responseVersion, requestId: responseRequestId, status,
            payload: overrides.responsePayloadEncoding ?? responsePayload.toString("base64"),
            hmac: overrides.responseHmac ?? responseTag.toString("hex"),
          });
          let streamBytes = overrides.binaryBytes ?? Buffer.alloc(0);
          if (overrides.streamPayloads) {
            streamBytes = Buffer.concat(overrides.streamPayloads.map((value, streamSequence) => {
              const eventBytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
              const eventTag = tag(credential.secret, [
                "stream", VERSION, responseVersion, challenge, credential.id,
                requestMessage.requestId, streamSequence, eventBytes,
              ]);
              const message = {
                type: "level-event", version: responseVersion, requestId: requestMessage.requestId,
                streamSequence, payload: eventBytes.toString("base64"), hmac: eventTag.toString("hex"),
              };
              return frame(overrides.mutateStreamFrame?.(message, streamSequence) ?? message);
            }));
          }
          if (overrides.streamBytes) streamBytes = overrides.streamBytes;
          const trailing = overrides.trailingBytes ?? Buffer.alloc(0);
          const output = Buffer.concat([response, streamBytes, trailing]);
          const chunks = overrides.fragmentResponse || overrides.fragmentStream
            ? [...output].map((byte) => Buffer.from([byte]))
            : [output];
          for (const chunk of chunks) enqueue(chunk);
          if (!overrides.noStreamEnd) enqueue(null);
          state.payloadBytes = payloadBytes;
        },
        destroy() {
          state.destroyed += 1;
          while (waiters.length > 0) waiters.shift()(null);
        },
      };
      return connection;
    },
  };
  const endpoint = { [TEST_ADAPTER]: adapter };
  const timing = {
    connect: { kind: "no-progress", timeoutMs: 100 },
    challenge: { kind: "no-progress", timeoutMs: 100 },
    requestWrite: { kind: "no-progress", timeoutMs: 100 },
    response: { kind: "no-progress", timeoutMs: 100 },
    stream: { kind: "no-progress", timeoutMs: 100 },
    end: { kind: "no-progress", timeoutMs: 100 },
  };
  const defaults = {
    endpoint, credential, requestId: randomUUID(), operation: "health", payload: {}, timing,
    signal: new AbortController().signal,
  };
  return {
    state,
    credential,
    request(options = {}) {
      const merged = { ...defaults, ...options };
      const { stream: _stream, end: _end, ...requestTiming } = merged.timing;
      return request({ ...merged, timing: requestTiming });
    },
    withStream(options = {}, consumer = async () => undefined) {
      return withStream({ ...defaults, kind: "binary", ...options }, consumer);
    },
  };
}

export { encode, frame, frameBody, tag };
