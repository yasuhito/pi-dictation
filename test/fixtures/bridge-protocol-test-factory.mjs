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

function authenticatedFrame(credential, challenge, requestId, sequence, payload, overrides = {}) {
  const payloadBytes = overrides.payloadBytes ?? Buffer.from(JSON.stringify(payload));
  const version = overrides.version ?? VERSION;
  const streamTag = tag(credential.secret, [
    "stream", VERSION, version, challenge, credential.id, requestId, sequence, payloadBytes,
  ]);
  return frame({
    type: overrides.type ?? "level-event",
    version,
    requestId: overrides.requestId ?? requestId,
    streamSequence: overrides.sequence ?? sequence,
    payload: overrides.payloadEncoding ?? payloadBytes.toString("base64"),
    hmac: overrides.hmac ?? streamTag.toString("hex"),
  });
}

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
        read() {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          return new Promise((resolve) => waiters.push(resolve));
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
          let streamBytes = overrides.streamBytes ?? Buffer.alloc(0);
          if (overrides.framePayloads) {
            streamBytes = Buffer.concat(overrides.framePayloads.map((payload, sequence) => authenticatedFrame(
              credential, challenge, requestMessage.requestId, sequence, payload,
              sequence === (overrides.frameOverrideSequence ?? -1) ? overrides.frameOverrides : undefined,
            )));
          }
          const suffix = overrides.trailingBytes ?? streamBytes;
          if (overrides.separateStreamChunks) {
            enqueue(response);
            const chunks = overrides.separateStreamChunks;
            chunks.forEach((chunk, index) => setTimeout(
              () => enqueue(chunk), overrides.streamDelayMs * (index + 1),
            ));
            if (!overrides.noStreamEof) setTimeout(
              () => enqueue(null), overrides.streamDelayMs * (chunks.length + 1),
            );
          } else {
            const output = suffix.length > 0 ? Buffer.concat([response, suffix]) : response;
            const chunks = overrides.fragmentResponse ? [...output].map((byte) => Buffer.from([byte])) : [output];
            if (overrides.streamDelayMs) {
              chunks.forEach((chunk, index) => setTimeout(() => enqueue(chunk), overrides.streamDelayMs * index));
              if (!overrides.noStreamEof) setTimeout(() => enqueue(null), overrides.streamDelayMs * chunks.length);
            } else {
              for (const chunk of chunks) enqueue(chunk);
              if (!overrides.noStreamEof) enqueue(null);
            }
          }
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
  };
  const defaults = {
    endpoint, credential, requestId: randomUUID(), operation: "health", payload: {}, timing,
    signal: new AbortController().signal,
  };
  return {
    state,
    credential,
    request(options = {}) { return request({ ...defaults, ...options }); },
    withStream(kind, consumer, options = {}) {
      const streamTiming = {
        ...timing,
        stream: { kind: "no-progress", timeoutMs: 100 },
        end: { kind: "no-progress", timeoutMs: 100 },
      };
      return withStream({ ...defaults, kind, timing: streamTiming, ...options }, consumer);
    },
  };
}

export { authenticatedFrame, encode, frame, frameBody, tag };
