const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

let factory;
async function loadFactory() {
  factory ??= await import("./fixtures/bridge-protocol-test-factory.mjs");
  return factory;
}

function failureShape(error) {
  return { name: error.name, kind: error.kind, stage: error.stage };
}

test("the native ESM Bridge protocol request returns an authenticated JSON response", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ responsePayload: { ready: true } });
  assert.deepEqual(await harness.request(), { status: "ok", payload: { ready: true } });
});

test("the Bridge protocol request survives byte-by-byte frame fragmentation", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ fragmentChallenge: true, fragmentResponse: true });
  assert.equal((await harness.request()).status, "ok");
});

for (const status of ["busy", "not-found", "request-conflict", "invalid-state", "failed"]) {
  test(`the Bridge protocol returns the authenticated ${status} status without interpretation`, async () => {
    const { createRequestHarness } = await loadFactory();
    const harness = createRequestHarness({ status, responsePayload: {} });
    assert.equal((await harness.request()).status, status);
  });
}

test("the Bridge protocol returns an authenticated version mismatch", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    status: "version-mismatch", responseVersion: 4,
    responsePayload: { clientVersion: 3, companionVersion: 4 },
  });
  assert.equal((await harness.request()).status, "version-mismatch");
});

test("the Bridge protocol transmits the caller-supplied request identity", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const requestId = randomUUID();
  await harness.request({ requestId });
  assert.equal(harness.state.request.requestId, requestId);
});

test("the Bridge protocol binds the request HMAC to the complete transcript", async () => {
  const { createRequestHarness, tag } = await loadFactory();
  const harness = createRequestHarness();
  await harness.request({ payload: { nested: [true, null, "value"] } });
  const sent = harness.state.request;
  const expected = tag(harness.credential.secret, [
    "request", 3, Buffer.alloc(32, 23), harness.credential.id, sent.requestId, sent.operation, harness.state.payloadBytes,
  ]).toString("hex");
  assert.equal(sent.hmac, expected);
});

for (const [label, payload] of [
  ["undefined", undefined],
  ["a non-finite number", Number.POSITIVE_INFINITY],
  ["a function", () => {}],
  ["a symbol", Symbol("value")],
  ["a bigint", 1n],
  ["an unsupported object", new Date()],
]) {
  test(`the Bridge protocol rejects ${label} before connecting`, async () => {
    const { createRequestHarness } = await loadFactory();
    const harness = createRequestHarness();
    const error = await harness.request({ payload: { value: payload } }).catch((value) => value);
    assert.deepEqual(
      { kind: error.kind, stage: error.stage, connects: harness.state.connects },
      { kind: "malformed", stage: "request-write", connects: 0 },
    );
  });
}

test("the Bridge protocol rejects a non-object payload before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({ payload: [] }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol rejects sparse nested arrays before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({ payload: { values: Array(1) } }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol rejects a cyclic payload before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const payload = {};
  payload.self = payload;
  const error = await harness.request({ payload }).catch((value) => value);
  assert.deepEqual(
    { kind: error.kind, stage: error.stage, connects: harness.state.connects },
    { kind: "malformed", stage: "request-write", connects: 0 },
  );
});

test("the Bridge protocol rejects payload accessors before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const payload = {};
  Object.defineProperty(payload, "value", { enumerable: true, get: () => 1 });
  const error = await harness.request({ payload }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol rejects array accessors before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const values = [1];
  Object.defineProperty(values, "0", { enumerable: true, get: () => 1 });
  const error = await harness.request({ payload: { values } }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol rejects JSON serialization hooks before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const payload = {};
  Object.defineProperty(payload, "toJSON", { value: () => ({ value: Number.POSITIVE_INFINITY }) });
  const error = await harness.request({ payload }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol preserves an exact cancellation reason before connection", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const controller = new AbortController();
  const reason = { requestedBy: "caller" };
  controller.abort(reason);
  const error = await harness.request({ signal: controller.signal }).catch((value) => value);
  assert.equal(error.cause, reason);
});

test("the Bridge protocol classifies connection failures", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ connect: Promise.reject(new Error("offline")) });
  const error = await harness.request().catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "connect" });
});

test("the Bridge protocol never retries a failed connection", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ connect: Promise.reject(new Error("offline")) });
  await harness.request().catch(() => {});
  assert.equal(harness.state.connects, 1);
});

test("the Bridge protocol requires a caller-supplied request identity before connecting", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({ requestId: undefined }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol requires a canonical lowercase request identity", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({ requestId: randomUUID().toUpperCase() }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol requires a canonical credential identity", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const credential = { ...harness.credential, id: harness.credential.id.toUpperCase() };
  const error = await harness.request({ credential }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, connects: harness.state.connects }, { kind: "malformed", connects: 0 });
});

test("the Bridge protocol rejects an invalid TCP port as malformed input", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({ endpoint: { type: "tcp", host: "127.0.0.1", port: 0 } })
    .catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "connect" });
});

test("an expired absolute connection deadline cannot connect", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({
    timing: {
      connect: { kind: "absolute", at: 0 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, stage: error.stage, connects: harness.state.connects },
    { kind: "deadline", stage: "connect", connects: 0 });
});

test("an expired absolute challenge deadline cannot write a request", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "absolute", at: 0 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, stage: error.stage, wrote: harness.state.request },
    { kind: "deadline", stage: "challenge", wrote: undefined });
});

test("an expired absolute request-write deadline cannot write a request", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "absolute", at: 0 }, response: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, stage: error.stage, wrote: harness.state.request },
    { kind: "deadline", stage: "request-write", wrote: undefined });
});

test("an expired absolute response deadline cannot accept a buffered response", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const error = await harness.request({
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "absolute", at: 0 },
    },
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "response" });
});

test("the Bridge protocol classifies a challenge deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ challengeBytes: Buffer.alloc(0) });
  const error = await harness.request({
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "absolute", at: Date.now() + 10 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "challenge" });
});

test("the Bridge protocol classifies request-write transport failures", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ write: () => Promise.reject(new Error("write failed")) });
  const error = await harness.request().catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "request-write" });
});

test("the Bridge protocol classifies a response deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noResponse: true });
  const error = await harness.request().catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "response" });
});

test("the Bridge protocol preserves an exact cancellation reason while awaiting a response", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noResponse: true });
  const controller = new AbortController();
  const reason = new Error("stop now");
  const pending = harness.request({ signal: controller.signal });
  setImmediate(() => controller.abort(reason));
  const error = await pending.catch((value) => value);
  assert.equal(error.cause, reason);
});

for (const [label, challengeBytes] of [
  ["an oversized challenge frame", (() => { const value = Buffer.alloc(4); value.writeUInt32BE(64 * 1024 + 1); return value; })()],
  ["invalid challenge UTF-8", (() => { const body = Buffer.from([0xff, 0xff]); const header = Buffer.alloc(4); header.writeUInt32BE(2); return Buffer.concat([header, body]); })()],
  ["recursive duplicate challenge keys", (() => { const body = Buffer.from('{"type":"challenge","challenge":"AA==","nested":{"x":1,"x":2}}'); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); })()],
  ["a noncanonical challenge encoding", (() => { const body = Buffer.from(JSON.stringify({ type: "challenge", challenge: "AB==" })); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); })()],
]) {
  test(`the Bridge protocol rejects ${label}`, async () => {
    const { createRequestHarness } = await loadFactory();
    const error = await createRequestHarness({ challengeBytes }).request().catch((value) => value);
    assert.equal(error.kind, "malformed");
  });
}

test("the Bridge protocol rejects bytes coalesced after the challenge frame", async () => {
  const { createRequestHarness, frame } = await loadFactory();
  const challenge = frame({ type: "challenge", challenge: Buffer.alloc(32, 23).toString("base64") });
  const error = await createRequestHarness({ challengeBytes: Buffer.concat([challenge, Buffer.from([0])]) })
    .request().catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "challenge" });
});

test("the Bridge protocol distinguishes early challenge EOF as transport failure", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ challengeBytes: Buffer.from([0, 0]), challengeEof: true })
    .request().catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "challenge" });
});

test("the Bridge protocol distinguishes early response EOF as transport failure", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ responseBytes: Buffer.from([0, 0]) }).request().catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "response" });
});

test("the production Unix transport classifies EOF from a real socket", async () => {
  const { createRequestHarness } = await loadFactory();
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-protocol-"));
  const socketDirectory = join(directory, "socket");
  mkdirSync(socketDirectory, { mode: 0o700 });
  const socketPath = join(socketDirectory, "listener.sock");
  const server = net.createServer((socket) => socket.end(Buffer.from([0, 0])));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const harness = createRequestHarness();
    const error = await harness.request({ endpoint: { type: "unix", path: socketPath } }).catch((value) => value);
    assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "challenge" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Bridge protocol rejects a noncanonical response Base64 encoding", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ responsePayloadEncoding: "e30" }).request().catch((value) => value);
  assert.equal(error.kind, "malformed");
});

test("the Bridge protocol rejects noncanonical response hexadecimal authentication", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ responseHmac: "AA".repeat(32) }).request().catch((value) => value);
  assert.equal(error.kind, "authentication");
});

test("the Bridge protocol rejects an altered response HMAC", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ responseHmac: "00".repeat(32) }).request().catch((value) => value);
  assert.equal(error.kind, "authentication");
});

test("the Bridge protocol rejects a changed response request identity", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ responseRequestId: randomUUID() }).request().catch((value) => value);
  assert.equal(error.kind, "malformed");
});

test("the Bridge protocol rejects an unknown authenticated status envelope", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ status: "surprise" }).request().catch((value) => value);
  assert.equal(error.kind, "malformed");
});

test("the Bridge protocol rejects recursively duplicated response payload fields", async () => {
  const { createRequestHarness } = await loadFactory();
  const bytes = Buffer.from('{"outer":{"value":1,"value":2}}');
  const error = await createRequestHarness({ responsePayloadBytes: bytes }).request().catch((value) => value);
  assert.equal(error.kind, "malformed");
});

test("the Bridge protocol rejects trailing response bytes", async () => {
  const { createRequestHarness } = await loadFactory();
  const error = await createRequestHarness({ trailingBytes: Buffer.from([1]) }).request().catch((value) => value);
  assert.equal(error.kind, "malformed");
});

test("the Bridge protocol closes the connection after success", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  await harness.request();
  assert.equal(harness.state.destroyed, 1);
});

test("the Bridge protocol closes the connection after authentication failure", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ responseHmac: "00".repeat(32) });
  await harness.request().catch(() => {});
  assert.equal(harness.state.destroyed, 1);
});

test("withStream authenticates the initial response before invoking its consumer", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ responseHmac: "00".repeat(32) });
  let invoked = false;
  await harness.withStream("binary", () => { invoked = true; }).catch(() => {});
  assert.equal(invoked, false);
});

test("withStream returns an authenticated non-success response", async (t) => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ status: "not-found", responsePayload: { retained: false } });
  let invoked = false;
  const response = await harness.withStream("binary", () => { invoked = true; });
  await t.test("without invoking the consumer", () => {
    assert.equal(invoked, false);
  });
  await t.test("without interpreting its payload", () => {
    assert.deepEqual(response, { status: "not-found", payload: { retained: false } });
  });
});

test("a binary stream exposes authenticated metadata before bounded bytes", async (t) => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ responsePayload: { declared: 3 }, streamBytes: Buffer.from("abc") });
  const chunks = [];
  let exposedMetadata;
  const response = await harness.withStream("binary", async ({ metadata, bytes }) => {
    exposedMetadata = metadata;
    for await (const chunk of bytes.readExactly(3)) chunks.push(chunk);
    return "stored";
  });
  await t.test("with generic metadata", () => {
    assert.deepEqual(exposedMetadata, { declared: 3 });
  });
  await t.test("with the exact requested bytes", () => {
    assert.equal(Buffer.concat(chunks).toString(), "abc");
  });
  await t.test("with the consumer result", () => {
    assert.deepEqual(response, { status: "ok", payload: { declared: 3 }, value: "stored" });
  });
});

test("binary reads remain bounded when the declared transfer is large", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamBytes: Buffer.alloc(64 * 1024 + 1) });
  let largest = 0;
  await harness.withStream("binary", async ({ bytes }) => {
    for await (const chunk of bytes.readExactly(64 * 1024 + 1)) largest = Math.max(largest, chunk.length);
  });
  assert.equal(largest, 64 * 1024);
});

test("a binary stream rejects premature EOF", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamBytes: Buffer.from("ab") });
  const error = await harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(3)) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "stream" });
});

test("a binary stream rejects bytes trailing its exact read", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamBytes: Buffer.from("abc") });
  const error = await harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(2)) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("a binary stream rejects an abandoned exact read", async () => {
  const { createRequestHarness } = await loadFactory();
  const length = 64 * 1024 + 1;
  const harness = createRequestHarness({ streamBytes: Buffer.alloc(length) });
  const error = await harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(length)) break;
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("an authenticated-frame stream exposes strictly parsed generic payloads", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ framePayloads: [{ arbitrary: [true, null] }, "terminal meaning stays outside"] });
  const observed = [];
  await harness.withStream("authenticated-frames", async ({ frames }) => {
    for await (const payload of frames) {
      observed.push(payload);
      if (observed.length === 2) break;
    }
  });
  assert.deepEqual(observed, [{ arbitrary: [true, null] }, "terminal meaning stays outside"]);
});

test("an authenticated-frame stream survives byte-by-byte fragmentation", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ framePayloads: [{ sequence: "payload" }], fragmentResponse: true });
  let observed;
  await harness.withStream("authenticated-frames", async ({ frames }) => {
    for await (const payload of frames) { observed = payload; break; }
  });
  assert.deepEqual(observed, { sequence: "payload" });
});

test("an authenticated-frame stream rejects recursive duplicate payload keys", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    framePayloads: [{}], frameOverrideSequence: 0,
    frameOverrides: { payloadBytes: Buffer.from('{"outer":{"x":1,"x":2}}') },
  });
  const error = await harness.withStream("authenticated-frames", async ({ frames }) => {
    for await (const _payload of frames) break;
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("an authenticated-frame stream rejects altered authentication", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    framePayloads: [{}], frameOverrideSequence: 0, frameOverrides: { hmac: "00".repeat(32) },
  });
  const error = await harness.withStream("authenticated-frames", async ({ frames }) => {
    for await (const _payload of frames) break;
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "authentication", stage: "stream" });
});

test("an authenticated-frame stream enforces its bound sequence", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    framePayloads: [{}], frameOverrideSequence: 0, frameOverrides: { sequence: 1 },
  });
  const error = await harness.withStream("authenticated-frames", async ({ frames }) => {
    for await (const _payload of frames) break;
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("an authenticated-frame stream distinguishes early frame EOF", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamBytes: Buffer.from([0, 0]) });
  const error = await harness.withStream("authenticated-frames", async ({ frames }) => {
    for await (const _payload of frames) break;
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "stream" });
});

test("a stream no-progress deadline interrupts its consumer", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEof: true });
  const error = await harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(1)) { /* consume */ }
  }, {
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 10 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "stream" });
});

test("stream progress resets a no-progress deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    separateStreamChunks: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")], streamDelayMs: 10,
  });
  let received = "";
  await harness.withStream("binary", async ({ bytes }) => {
    for await (const chunk of bytes.readExactly(3)) received += chunk.toString();
  }, {
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 50 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  });
  assert.equal(received, "abc");
});

test("withStream cleans up after a stream deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEof: true });
  await harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(1)) { /* consume */ }
  }, {
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 10 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch(() => {});
  assert.equal(harness.state.destroyed, 1);
});

test("an expired absolute stream deadline prevents consumer invocation", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  let invoked = false;
  const error = await harness.withStream("binary", () => { invoked = true; }, {
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "absolute", at: 0 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }).catch((value) => value);
  assert.deepEqual({ kind: error.kind, stage: error.stage, invoked }, { kind: "deadline", stage: "stream", invoked: false });
});

test("a binary stream applies a distinct end-of-stream deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamBytes: Buffer.from("a"), noStreamEof: true });
  const error = await harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(1)) { /* consume */ }
  }, {
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 100 }, end: { kind: "no-progress", timeoutMs: 10 },
    },
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "stream" });
});

test("withStream preserves a consumer exception after cleaning up", async (t) => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  const reason = new Error("consumer failed");
  const error = await harness.withStream("authenticated-frames", () => { throw reason; }).catch((value) => value);
  await t.test("as the exact thrown value", () => {
    assert.equal(error, reason);
  });
  await t.test("after destroying the connection", () => {
    assert.equal(harness.state.destroyed, 1);
  });
});

test("withStream preserves an exact cancellation reason while consuming", async (t) => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEof: true });
  const controller = new AbortController();
  const reason = { requestedBy: "stream caller" };
  const pending = harness.withStream("binary", async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(1)) { /* consume */ }
  }, { signal: controller.signal });
  setImmediate(() => controller.abort(reason));
  const error = await pending.catch((value) => value);
  await t.test("in the structured failure", () => {
    assert.equal(error.cause, reason);
  });
  await t.test("after destroying the connection", () => {
    assert.equal(harness.state.destroyed, 1);
  });
});

test("withStream destroys the connection before successful settlement", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  await harness.withStream("authenticated-frames", () => {});
  assert.equal(harness.state.destroyed, 1);
});
