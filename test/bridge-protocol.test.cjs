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

test("withStream authenticates metadata before exposing a binary stream", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ responsePayload: { length: 3 }, binaryBytes: Buffer.from("wav") });
  const response = await harness.withStream({}, async ({ metadata, bytes }) => {
    for await (const _chunk of bytes.readExactly(3)) { /* consume */ }
    return metadata;
  });
  assert.deepEqual(response, { status: "ok", payload: { length: 3 }, value: { length: 3 } });
});

test("withStream handles an authenticated non-success status without consuming", async (t) => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ status: "invalid-state", responsePayload: {} });
  let invocations = 0;
  const response = await harness.withStream({}, () => { invocations += 1; });
  await t.test("returns the authenticated status", () => {
    assert.deepEqual(response, { status: "invalid-state", payload: {} });
  });
  await t.test("does not invoke the consumer", () => {
    assert.equal(invocations, 0);
  });
});

test("withStream does not invoke its consumer after initial authentication failure", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ responseHmac: "00".repeat(32) });
  let invocations = 0;
  await harness.withStream({}, () => { invocations += 1; }).catch(() => {});
  assert.equal(invocations, 0);
});

test("the binary stream survives byte-by-byte fragmentation", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ binaryBytes: Buffer.from("fragmented"), fragmentStream: true });
  const response = await harness.withStream({}, async ({ bytes }) => {
    const chunks = [];
    for await (const chunk of bytes.readExactly(10)) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  });
  assert.equal(response.value, "fragmented");
});

test("the binary stream rejects premature EOF", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ binaryBytes: Buffer.from("short") });
  const error = await harness.withStream({}, async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(6)) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "transport", stage: "stream" });
});

test("the binary stream rejects bytes trailing the exact declared read", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ binaryBytes: Buffer.from("extra") });
  const error = await harness.withStream({}, async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(4)) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("the binary stream rejects an abandoned exact declared read", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ binaryBytes: Buffer.alloc(70 * 1024) });
  const error = await harness.withStream({}, async ({ bytes }) => {
    for await (const _chunk of bytes.readExactly(70 * 1024)) break;
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("authenticated-frame streams expose individually authenticated strict JSON payloads", async () => {
  const { createRequestHarness } = await loadFactory();
  const payloads = [{ arbitrary: "caller-owned" }, [true, 2]];
  const harness = createRequestHarness({ streamPayloads: payloads });
  const response = await harness.withStream({ kind: "authenticated-frames" }, async ({ frames }) => {
    const received = [];
    for await (const value of frames) {
      received.push(value);
      if (received.length === 2) return received;
    }
  });
  assert.deepEqual(response.value, payloads);
});

test("authenticated-frame streams permit only one iterator", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamPayloads: [{ value: 1 }] });
  const response = await harness.withStream({ kind: "authenticated-frames" }, async ({ frames }) => {
    const first = frames[Symbol.asyncIterator]();
    const duplicate = Promise.resolve().then(() => frames[Symbol.asyncIterator]()).then((iterator) => iterator.next());
    const results = await Promise.allSettled([first.next(), duplicate]);
    return results.map((result) => result.status === "fulfilled"
      ? result
      : { status: result.status, reason: { name: result.reason.name, message: result.reason.message } });
  });
  assert.deepEqual(response.value, [
    { status: "fulfilled", value: { value: { value: 1 }, done: false } },
    { status: "rejected", reason: { name: "TypeError", message: "authenticated frames may be iterated once" } },
  ]);
});

test("withStream settles an abandoned authenticated-frame read before returning", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEnd: true });
  let pending;
  let readSettled = false;
  const timing = {
    connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
    requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
    stream: { kind: "no-progress", timeoutMs: 10 }, end: { kind: "no-progress", timeoutMs: 100 },
  };
  const outcome = await harness.withStream({ kind: "authenticated-frames", timing }, async ({ frames }) => {
    pending = frames[Symbol.asyncIterator]().next();
    pending.then(() => { readSettled = true; }, () => { readSettled = true; });
    return "done";
  }).then((response) => ({ status: response.status }), (error) => failureShape(error));
  const settledBeforeReturn = readSettled;
  const readOutcome = await pending.then(
    () => ({ status: "fulfilled" }),
    (error) => failureShape(error),
  );
  assert.deepEqual({ outcome, settledBeforeReturn, readOutcome }, {
    outcome: { name: "BridgeProtocolFailure", kind: "deadline", stage: "stream" },
    settledBeforeReturn: true,
    readOutcome: { name: "BridgeProtocolFailure", kind: "transport", stage: "stream" },
  });
});

test("authenticated-frame streams reject recursive duplicate payload keys", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamPayloads: [Buffer.from('{"outer":{"x":1,"x":2}}')] });
  const error = await harness.withStream({ kind: "authenticated-frames" }, async ({ frames }) => {
    for await (const _value of frames) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("authenticated-frame streams bind each frame to its sequence", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    streamPayloads: [{ value: 1 }],
    mutateStreamFrame: (message) => ({ ...message, streamSequence: 1 }),
  });
  const error = await harness.withStream({ kind: "authenticated-frames" }, async ({ frames }) => {
    for await (const _value of frames) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "malformed", stage: "stream" });
});

test("authenticated-frame streams reject altered authentication", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({
    streamPayloads: [{ value: 1 }],
    mutateStreamFrame: (message) => ({ ...message, hmac: "00".repeat(32) }),
  });
  const error = await harness.withStream({ kind: "authenticated-frames" }, async ({ frames }) => {
    for await (const _value of frames) { /* consume */ }
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "authentication", stage: "stream" });
});

test("withStream closes the connection before settling after consumer return", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamPayloads: [{ value: 1 }], noStreamEnd: true });
  await harness.withStream({ kind: "authenticated-frames" }, async () => "done");
  assert.equal(harness.state.destroyed, 1);
});

test("withStream closes the connection before settling after consumer failure", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEnd: true });
  await harness.withStream({}, async () => { throw new Error("consumer failed"); }).catch(() => {});
  assert.equal(harness.state.destroyed, 1);
});

test("withStream applies a resettable no-progress deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ streamPayloads: [{ n: 1 }, { n: 2 }, { n: 3 }], noStreamEnd: true });
  const response = await harness.withStream({
    kind: "authenticated-frames",
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 50 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }, async ({ frames }) => {
    let count = 0;
    for await (const _frame of frames) {
      count += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (count === 3) return count;
    }
  });
  assert.equal(response.value, 3);
});

test("withStream times out after no stream progress", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEnd: true });
  const error = await harness.withStream({
    kind: "authenticated-frames",
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 10 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }, async () => new Promise(() => {})).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "stream" });
});

test("withStream does not invoke its consumer after an expired stream deadline", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness();
  let invocations = 0;
  await harness.withStream({
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "absolute", at: Date.now() - 1 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }, async () => { invocations += 1; }).catch(() => {});
  assert.equal(invocations, 0);
});

test("withStream closes the connection before settling after timeout", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEnd: true });
  await harness.withStream({
    kind: "authenticated-frames",
    timing: {
      connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
      requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
      stream: { kind: "no-progress", timeoutMs: 10 }, end: { kind: "no-progress", timeoutMs: 100 },
    },
  }, async () => new Promise(() => {})).catch(() => {});
  assert.equal(harness.state.destroyed > 0, true);
});

test("withStream keeps an absolute stream deadline fixed despite progress", async () => {
  const { createRequestHarness } = await loadFactory();
  const payloads = Array.from({ length: 20 }, (_, value) => ({ value }));
  const harness = createRequestHarness({ streamPayloads: payloads, fragmentStream: true, noStreamEnd: true });
  const timing = {
    connect: { kind: "no-progress", timeoutMs: 100 }, challenge: { kind: "no-progress", timeoutMs: 100 },
    requestWrite: { kind: "no-progress", timeoutMs: 100 }, response: { kind: "no-progress", timeoutMs: 100 },
    stream: { kind: "absolute", at: Date.now() + 15 }, end: { kind: "no-progress", timeoutMs: 100 },
  };
  const error = await harness.withStream({ kind: "authenticated-frames", timing }, async ({ frames }) => {
    for await (const _value of frames) await new Promise((resolve) => setTimeout(resolve, 2));
  }).catch((value) => value);
  assert.deepEqual(failureShape(error), { name: "BridgeProtocolFailure", kind: "deadline", stage: "stream" });
});

test("withStream preserves the exact cancellation reason", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEnd: true });
  const controller = new AbortController();
  const reason = { requestedBy: "caller" };
  const pending = harness.withStream({ kind: "authenticated-frames", signal: controller.signal }, async () => new Promise(() => {}));
  setImmediate(() => controller.abort(reason));
  const error = await pending.catch((value) => value);
  assert.equal(error.cause, reason);
});

test("withStream closes the connection before settling after cancellation", async () => {
  const { createRequestHarness } = await loadFactory();
  const harness = createRequestHarness({ noStreamEnd: true });
  const controller = new AbortController();
  const pending = harness.withStream({ kind: "authenticated-frames", signal: controller.signal }, async () => new Promise(() => {}));
  setImmediate(() => controller.abort("cancel"));
  await pending.catch(() => {});
  assert.equal(harness.state.destroyed > 0, true);
});
