const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const net = require("node:net");

const version = 3;
function encode(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length); pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}
function tag(secret, fields) { return createHmac("sha256", Buffer.from(secret, "base64")).update(encode(fields)).digest(); }
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
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

async function request(endpoint, credential, operation, payload, requestId = randomUUID()) {
  const socket = net.createConnection({ path: endpoint, allowHalfOpen: true });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const iterator = socket[Symbol.asyncIterator]();
  const buffered = { value: Buffer.alloc(0) };
  const challengeFrame = await readFrame(iterator, buffered);
  const challenge = Buffer.from(challengeFrame.challenge, "base64");
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const hmac = tag(credential.secret, ["request", version, challenge, credential.id, requestId, operation, payloadBytes]);
  socket.end(frame({ type: "request", version, credentialId: credential.id, requestId, operation,
    payload: payloadBytes.toString("base64"), hmac: hmac.toString("hex") }));
  const response = await readFrame(iterator, buffered);
  const responseBytes = Buffer.from(response.payload, "base64");
  const expected = tag(credential.secret, ["response", version, response.version, challenge, credential.id, requestId,
    `${operation}:${response.status}`, responseBytes]);
  const actual = Buffer.from(response.hmac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("response authentication");
  const chunks = [buffered.value];
  for await (const chunk of iterator) chunks.push(chunk);
  socket.destroy();
  return { status: response.status, payload: JSON.parse(responseBytes), body: Buffer.concat(chunks), requestId };
}

function capability() {
  return { recordingId: randomUUID(), leaseSecret: randomBytes(32).toString("base64") };
}

module.exports = { capability, request };
