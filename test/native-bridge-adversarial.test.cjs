const assert = require("node:assert/strict");
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const net = require("node:net");
const { dirname, join } = require("node:path");
const { test } = require("node:test");

const socketPath = process.env.PI_DICTATION_NATIVE_COMPANION_SOCKET;
const credentialPaths = (process.env.PI_DICTATION_NATIVE_CREDENTIAL_FILES || "").split(":").filter(Boolean);
const enabled = process.platform === "darwin" && socketPath && credentialPaths.length >= 2;
const protocolVersion = 3;

function encode(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length); pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}
function tag(credential, fields) {
  return createHmac("sha256", Buffer.from(credential.secret, "base64")).update(encode(fields)).digest();
}
function frameBytes(body) {
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
async function readFrame(iterator, buffered) {
  while (buffered.value.length < 4) {
    const next = await iterator.next(); if (next.done) throw new Error("eof");
    buffered.value = Buffer.concat([buffered.value, next.value]);
  }
  const length = buffered.value.readUInt32BE(0);
  while (buffered.value.length < length + 4) {
    const next = await iterator.next(); if (next.done) throw new Error("eof");
    buffered.value = Buffer.concat([buffered.value, next.value]);
  }
  const body = buffered.value.subarray(4, length + 4);
  buffered.value = buffered.value.subarray(length + 4);
  return JSON.parse(body);
}
async function rawRequest(credential, operation, payloadBytes, options = {}) {
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const iterator = socket[Symbol.asyncIterator]();
  const buffered = { value: Buffer.alloc(0) };
  const challengeFrame = await readFrame(iterator, buffered);
  if (JSON.stringify(Object.keys(challengeFrame).sort()) !== JSON.stringify(["challenge", "type"])) {
    throw new Error("invalid challenge shape");
  }
  const challenge = Buffer.from(challengeFrame.challenge, "base64");
  const requestId = options.requestId || randomUUID();
  const version = options.version || protocolVersion;
  const hmac = tag(credential, ["request", version, challenge, credential.id, requestId, operation, payloadBytes]);
  const hmacText = options.hmacTransform ? options.hmacTransform(hmac.toString("hex")) : hmac.toString("hex");
  if (hmacText === undefined) { socket.destroy(); return { retry: true }; }
  const request = options.rawFrame || Buffer.from(JSON.stringify({
    type: "request", version, credentialId: credential.id, requestId, operation,
    payload: payloadBytes.toString("base64"), hmac: hmacText,
  }));
  socket.end(frameBytes(request));
  let response;
  try { response = await readFrame(iterator, buffered); }
  catch (error) {
    socket.destroy();
    if (options.expectClose) return { closed: true };
    throw error;
  }
  const responseBytes = Buffer.from(response.payload, "base64");
  const expected = tag(credential, ["response", version, response.version, challenge, credential.id, requestId,
    `${operation}:${response.status}`, responseBytes]);
  const actual = Buffer.from(response.hmac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("response authentication failed");
  }
  socket.destroy();
  return { status: response.status, payload: JSON.parse(responseBytes) };
}
function request(credential, operation, payload, options) {
  return rawRequest(credential, operation, Buffer.from(JSON.stringify(payload)), options);
}
async function signedPairRequest(credential, pair) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await request(credential, "health", {}, {
      expectClose: true,
      hmacTransform(hex) {
        const index = pair === "+" ? hex.search(/0[0-9a-f]/) : hex.indexOf("00");
        return index < 0 ? undefined : `${hex.slice(0, index)}${pair}${hex[index + 1]}${hex.slice(index + 2)}`;
      },
    });
    if (!result.retry) return result;
  }
  throw new Error(`could not generate an HMAC containing a ${pair} signed pair`);
}
async function sendMalformedWire(bytes) {
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const iterator = socket[Symbol.asyncIterator]();
  await readFrame(iterator, { value: Buffer.alloc(0) });
  socket.end(bytes);
  await new Promise((resolve) => { socket.once("close", resolve); socket.once("error", resolve); });
}

// This suite drives the production protocol through an isolated native companion binary. The runner sets
// both variables on macOS; ordinary cross-platform checks skip without its socket and two credentials.
test("isolated native companion rejects adversarial traffic without changing an unrelated Recording lease", { skip: !enabled }, async (t) => {
  const [owner, competitor] = credentialPaths.slice(0, 2).map((path) => JSON.parse(readFileSync(path, "utf8")));
  const lease = { recordingId: randomUUID(), leaseSecret: randomBytes(32).toString("base64") };
  const foreignLease = { recordingId: randomUUID(), leaseSecret: randomBytes(32).toString("base64") };
  try {
    const ownerStartRequestId = randomUUID();
    const ownerStartPayload = { ...lease, maxDurationMs: 60000 };
    const start = await request(owner, "start", ownerStartPayload, { requestId: ownerStartRequestId });
    await t.test("owner establishes the unrelated valid lease", () => assert.equal(start.status, "ok"));

    const crossOwnerStart = await request(competitor, "start", { ...lease, maxDurationMs: 60000 });
    const absentStart = await request(competitor, "start", { ...foreignLease, maxDurationMs: 60000 });
    await t.test("cross-owner start returns detail-free busy while the owner lease is active", () => {
      assert.equal(crossOwnerStart.status, "busy");
    });
    await t.test("absent start returns detail-free busy while the owner lease is active", () => {
      assert.equal(absentStart.status, "busy");
    });

    const unknownCredential = { id: randomUUID(), secret: randomBytes(32).toString("base64") };
    const badHmacCredential = { ...competitor, secret: randomBytes(32).toString("base64") };
    const unknownCredentialFailure = await request(unknownCredential, "health", {}, { expectClose: true });
    const badHmacFailure = await request(badHmacCredential, "health", {}, { expectClose: true });
    await t.test("unknown credential closes without a response", () => {
      assert.equal(unknownCredentialFailure.closed, true);
    });
    await t.test("bad HMAC closes without a response", () => {
      assert.equal(badHmacFailure.closed, true);
    });

    const positiveSignedHmac = await signedPairRequest(competitor, "+");
    await t.test("positive-signed hexadecimal HMAC pairs close without a response", () => {
      assert.equal(positiveSignedHmac.closed, true);
    });
    const negativeSignedHmac = await signedPairRequest(competitor, "-");
    await t.test("negative-signed hexadecimal HMAC pairs close without a response", () => {
      assert.equal(negativeSignedHmac.closed, true);
    });

    for (const operation of ["health", "start", "status", "levels", "stop", "fetch", "cancel", "acknowledge"]) {
      const malformed = await rawRequest(competitor, operation, Buffer.from('{"unexpected":true,"unexpected":false}'), { expectClose: true });
      const ownerStatus = await request(owner, "status", lease);
      await t.test(`${operation} rejects duplicate malformed payload fields`, () => assert.equal(malformed.closed, true));
      await t.test(`${operation} leaves the owner lease recording`, () => assert.equal(ownerStatus.payload.state, "recording"));
    }

    const malformedFrames = [
      ["zero length", Buffer.alloc(4)],
      ["oversized length", Buffer.from([0, 1, 0, 1])],
      ["truncated body", Buffer.from([0, 0, 0, 10, 0x7b])],
      ["extra bytes", Buffer.concat([frameBytes(Buffer.from("{}")), Buffer.from("x")])],
      ["invalid UTF-8", frameBytes(Buffer.from([0x7b, 0xff, 0x7d]))],
    ];
    for (const [name, bytes] of malformedFrames) {
      await sendMalformedWire(bytes);
      const ownerStatus = await request(owner, "status", lease);
      await t.test(`${name} frame leaves the owner lease recording`, () => assert.equal(ownerStatus.payload.state, "recording"));
    }

    const foreignResults = new Map();
    for (const operation of ["status", "levels", "stop", "fetch", "cancel", "acknowledge"]) {
      const payload = operation === "levels" ? { ...lease, afterSequence: -1 } : lease;
      foreignResults.set(operation, (await request(competitor, operation, payload)).status);
    }
    for (const operation of ["status", "levels", "stop", "fetch", "cancel", "acknowledge"]) {
      await t.test(`cross-owner ${operation} collapses to not-found`, () => {
        assert.equal(foreignResults.get(operation), "not-found");
      });
    }
    const unknown = await request(competitor, "status", foreignLease);
    await t.test("cross-owner access is indistinguishable from an absent lease", () => assert.equal(unknown.status, "not-found"));

    const mismatchRequestId = randomUUID();
    const mismatch = await request(competitor, "health", {}, { requestId: mismatchRequestId, version: protocolVersion - 1 });
    await t.test("authenticated version mismatch reports only both versions", () => {
      assert.deepEqual(mismatch, { status: "version-mismatch", payload: { clientVersion: 2, companionVersion: 3 } });
    });
    const changedMismatchReplay = await request(competitor, "health", { changed: true }, { requestId: mismatchRequestId });
    await t.test("changed-content reuse after a version mismatch returns request-conflict", () => {
      assert.equal(changedMismatchReplay.status, "request-conflict");
    });
    const versionChangeRequestId = randomUUID();
    await request(competitor, "health", {}, { requestId: versionChangeRequestId, version: protocolVersion - 1 });
    const changedVersionReplay = await request(competitor, "health", {}, { requestId: versionChangeRequestId });
    await t.test("request identity reuse under another version returns request-conflict", () => {
      assert.equal(changedVersionReplay.status, "request-conflict");
    });
    const concurrentObservationRequestId = randomUUID();
    const concurrentObservations = await Promise.all(Array.from({ length: 20 }, () =>
      request(competitor, "health", {}, { requestId: concurrentObservationRequestId })));
    await t.test("concurrent exact observation retries all complete safely", () => {
      assert.equal(concurrentObservations.every((result) => result.status === "ok"), true);
    });

    const unknownOperationRequestId = randomUUID();
    await request(competitor, "unknown", {}, { requestId: unknownOperationRequestId });
    const changedUnknownOperation = await request(competitor, "health", {}, { requestId: unknownOperationRequestId });
    await t.test("request identity reuse after an unknown operation returns request-conflict", () => {
      assert.equal(changedUnknownOperation.status, "request-conflict");
    });

    const retainedOwnerRequestId = randomUUID();
    await request(owner, "status", lease, { requestId: retainedOwnerRequestId });
    for (let index = 0; index < 300; index += 1) await request(competitor, "health", {});
    const changedOwnerObservation = await request(owner, "status", foreignLease, { requestId: retainedOwnerRequestId });
    await t.test("one credential's sustained polling cannot evict another credential's replay fingerprint", () => {
      assert.equal(changedOwnerObservation.status, "request-conflict");
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (let index = 0; index < 150; index += 1) {
      await request(owner, "levels", { ...lease, afterSequence: -1 });
    }
    const requestRegistryBytes = statSync(join(dirname(socketPath), "request-receipts.json")).size;
    await t.test("sustained Level polling keeps the durable request registry within its safe bound", () => {
      assert.equal(requestRegistryBytes <= 512 * 1024, true);
    });

    const sameCredentialRequestId = randomUUID();
    await request(owner, "status", lease, { requestId: sameCredentialRequestId });
    for (let index = 0; index < 300; index += 1) await request(owner, "health", {});
    const changedSameCredentialObservation = await request(owner, "status", foreignLease, { requestId: sameCredentialRequestId });
    await t.test("sustained polling cannot evict the same credential's live replay fingerprint", () => {
      assert.equal(changedSameCredentialObservation.status, "request-conflict");
    });

    const busyRequestId = randomUUID();
    const busyPayload = { recordingId: randomUUID(), leaseSecret: foreignLease.leaseSecret, maxDurationMs: 60000 };
    await request(competitor, "start", busyPayload, { requestId: busyRequestId });
    let floodBoundary;
    for (let index = 1; index <= 64; index += 1) {
      floodBoundary = await request(competitor, "start", {
        recordingId: randomUUID(), leaseSecret: foreignLease.leaseSecret, maxDurationMs: 60000,
      });
    }
    await t.test("unique busy starts are bounded per credential", () => {
      assert.equal(floodBoundary.status, "failed");
    });
    const retainedBusyReplay = await request(competitor, "start", busyPayload, { requestId: busyRequestId });
    await t.test("a retained busy-start identity preserves its original outcome", () => {
      assert.equal(retainedBusyReplay.status, "busy");
    });
    const ownerAfterFlood = await request(owner, "start", ownerStartPayload, { requestId: ownerStartRequestId });
    await t.test("polling and busy-start floods leave the owner lease recording", () => {
      assert.equal(ownerAfterFlood.payload.state, "recording");
    });

    let registryBoundary;
    for (let index = 0; index < 5000; index += 1) {
      registryBoundary = await request(competitor, "health", {}, { expectClose: true });
      if (registryBoundary.closed || registryBoundary.status === "failed") break;
    }
    await t.test("the durable registry rejects new identities at its configured byte bound", () => {
      assert.equal(registryBoundary.closed === true || registryBoundary.status === "failed", true);
    });
  } finally {
    await request(owner, "cancel", lease).catch(() => {});
  }
});
