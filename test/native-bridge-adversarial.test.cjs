const assert = require("node:assert/strict");
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const net = require("node:net");
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
  const request = options.rawFrame || Buffer.from(JSON.stringify({
    type: "request", version, credentialId: credential.id, requestId, operation,
    payload: payloadBytes.toString("base64"), hmac: hmac.toString("hex"),
  }));
  socket.end(frameBytes(request));
  let response;
  try { response = await readFrame(iterator, buffered); } catch { socket.destroy(); return { closed: true }; }
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
async function sendMalformedWire(bytes) {
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const iterator = socket[Symbol.asyncIterator]();
  await readFrame(iterator, { value: Buffer.alloc(0) });
  socket.end(bytes);
  await new Promise((resolve) => { socket.once("close", resolve); socket.once("error", resolve); });
}

// This suite drives the installed production companion. Set both variables when running it on macOS;
// ordinary cross-platform checks skip it because the native socket and two installed credentials are required.
test("production companion rejects adversarial traffic without changing an unrelated Recording lease", { skip: !enabled }, async (t) => {
  const [owner, competitor] = credentialPaths.slice(0, 2).map((path) => JSON.parse(readFileSync(path, "utf8")));
  const lease = { recordingId: randomUUID(), leaseSecret: randomBytes(32).toString("base64") };
  const foreignLease = { recordingId: randomUUID(), leaseSecret: randomBytes(32).toString("base64") };
  try {
    const start = await request(owner, "start", { ...lease, maxDurationMs: 60000 });
    await t.test("owner establishes the unrelated valid lease", () => assert.equal(start.status, "ok"));

    const crossOwnerStart = await request(competitor, "start", { ...lease, maxDurationMs: 60000 });
    const absentStart = await request(competitor, "start", { ...foreignLease, maxDurationMs: 60000 });
    await t.test("cross-owner and absent starts are indistinguishable while the owner lease is active", () => {
      assert.deepEqual([crossOwnerStart.status, absentStart.status], ["busy", "busy"]);
    });

    const unknownCredential = { id: randomUUID(), secret: randomBytes(32).toString("base64") };
    const badHmacCredential = { ...competitor, secret: randomBytes(32).toString("base64") };
    const unknownCredentialFailure = await request(unknownCredential, "health", {});
    const badHmacFailure = await request(badHmacCredential, "health", {});
    await t.test("unknown credentials and bad HMACs have the same production-socket failure", () => {
      assert.deepEqual([unknownCredentialFailure.closed, badHmacFailure.closed], [true, true]);
    });

    for (const operation of ["health", "start", "status", "levels", "stop", "fetch", "cancel", "acknowledge"]) {
      const malformed = await rawRequest(competitor, operation, Buffer.from('{"unexpected":true,"unexpected":false}'));
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

    const foreignResults = [];
    for (const operation of ["status", "levels", "stop", "fetch", "cancel", "acknowledge"]) {
      const payload = operation === "levels" ? { ...lease, afterSequence: -1 } : lease;
      foreignResults.push((await request(competitor, operation, payload)).status);
    }
    await t.test("all cross-owner lease operations collapse to not-found", () => {
      assert.deepEqual(foreignResults, Array(6).fill("not-found"));
    });
    const unknown = await request(competitor, "status", foreignLease);
    await t.test("cross-owner access is indistinguishable from an absent lease", () => assert.equal(unknown.status, "not-found"));

    const mismatch = await request(competitor, "health", {}, { version: protocolVersion - 1 });
    await t.test("authenticated version mismatch reports only both versions", () => {
      assert.deepEqual(mismatch, { status: "version-mismatch", payload: { clientVersion: 2, companionVersion: 3 } });
    });
  } finally {
    await request(owner, "cancel", lease).catch(() => {});
  }
});
