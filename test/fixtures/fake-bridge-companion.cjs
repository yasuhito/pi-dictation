const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const net = require("node:net");

const endpoint = process.argv[2];
const credential = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
const mode = process.argv[4] || "valid";
const eventFile = process.argv[5];
const protocolVersion = 1;
const recordings = new Map();
const sockets = new Set();

function authEncoding(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}

function tag(fields) {
  return createHmac("sha256", Buffer.from(credential.secret, "base64")).update(authEncoding(fields)).digest();
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function wav() {
  const dataBytes = 3200;
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataBytes, 40);
  for (let offset = 44; offset < result.length; offset += 2) result.writeInt16LE(1200, offset);
  if (mode === "invalid-wav") result.writeUInt16LE(2, 22);
  if (mode === "trailing-data") return Buffer.concat([result, Buffer.from([1])]);
  return result;
}

function exactRequest(value) {
  return value && value.type === "request" && value.version === protocolVersion &&
    value.credentialId === credential.id && typeof value.requestId === "string" &&
    typeof value.operation === "string" && typeof value.payload === "string" && typeof value.hmac === "string";
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  const challenge = randomBytes(32);
  socket.write(frame({ type: "challenge", version: protocolVersion, challenge: challenge.toString("base64") }));
  let input = Buffer.alloc(0);
  socket.on("data", (chunk) => { input = Buffer.concat([input, chunk]); });
  socket.on("end", () => {
    try {
      if (input.length < 4 || input.length !== input.readUInt32BE(0) + 4) throw new Error("frame");
      const request = JSON.parse(input.subarray(4).toString("utf8"));
      if (!exactRequest(request)) throw new Error("request");
      const payloadBytes = Buffer.from(request.payload, "base64");
      const expected = tag(["request", protocolVersion, challenge, credential.id, request.requestId, request.operation, payloadBytes]);
      const actual = Buffer.from(request.hmac, "hex");
      if (mode === "auth-failure" || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("auth");
      const payload = JSON.parse(payloadBytes.toString("utf8"));
      let responsePayload;
      let audio;
      if (request.operation === "start") {
        const lease = randomBytes(32).toString("base64");
        recordings.set(payload.recordingId, { lease });
        responsePayload = { recordingId: payload.recordingId, lease };
      } else {
        const recording = recordings.get(payload.recordingId);
        if (!recording || recording.lease !== payload.lease) throw new Error("lease");
        if (request.operation === "levels") {
          responsePayload = { observations: [{ sequence: 0, capturedAtMs: 0, dbfs: -20 }] };
        } else if (request.operation === "stop") {
          audio = wav();
          responsePayload = {
            recordingId: payload.recordingId,
            length: mode === "oversized" ? 999999999 : audio.length,
            sha256: mode === "hash-mismatch" ? "0".repeat(64) : createHash("sha256").update(audio).digest("hex"),
          };
        } else if (request.operation === "acknowledge") {
          if (mode === "ack-failure") throw new Error("acknowledgement");
          recordings.delete(payload.recordingId);
          if (eventFile) require("node:fs").appendFileSync(eventFile, "acknowledged\n");
          responsePayload = { acknowledged: true };
        } else if (request.operation === "cancel") {
          recordings.delete(payload.recordingId);
          responsePayload = { cancelled: true };
        } else throw new Error("operation");
      }
      const responseBytes = Buffer.from(JSON.stringify(responsePayload));
      const responseTag = tag(["response", protocolVersion, challenge, credential.id, request.requestId, `${request.operation}:ok`, responseBytes]);
      const response = frame({ type: "response", version: protocolVersion, requestId: request.requestId, status: "ok", payload: responseBytes.toString("base64"), hmac: responseTag.toString("hex") });
      if (request.operation === "stop" && mode === "early-eof") audio = audio.subarray(0, audio.length - 1);
      socket.end(audio ? Buffer.concat([response, audio]) : response);
    } catch {
      socket.destroy();
    }
  });
});

server.listen(endpoint, () => {
  require("node:fs").chmodSync(endpoint, 0o600);
  if (process.send) process.send({ ready: true });
});

process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  process.exit(0);
});
