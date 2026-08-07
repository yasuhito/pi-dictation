const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");

const endpoint = process.argv[2];
const decoded = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
const credentials = new Map((Array.isArray(decoded) ? decoded : [decoded]).map((value) => [value.id, value]));
const mode = process.argv[4] || "valid";
const eventFile = process.argv[5];
const stateFile = process.argv[6];
const protocolVersion = 2;
let persisted = {};
if (stateFile && existsSync(stateFile)) persisted = JSON.parse(readFileSync(stateFile, "utf8"));
const recordings = new Map((persisted.recordings || []).map((value) => [value.id, {
  ...value,
  leaseHash: Buffer.from(value.leaseHash, "base64"),
  audio: value.audio === undefined ? undefined : Buffer.from(value.audio, "base64"),
}]));
const replay = new Map(persisted.replay || []);
const busyStarts = new Set(persisted.busyStarts || []);
const sockets = new Set();
const droppedResponses = new Set(persisted.droppedResponses || []);
let activeId = persisted.activeId;
let unappliedStopFailures = 0;
let unappliedStopRequestId;
const retentionMs = mode === "short-retention" ? 300 : 10 * 60 * 1000;

function audioPath(recording) { return stateFile ? `${stateFile}.${recording.id}.wav` : undefined; }
function writeAudio(recording) {
  const path = audioPath(recording);
  if (path && recording.audio) writeFileSync(path, recording.audio, { mode: 0o600 });
}
function removeAudio(recording) {
  recording.audio = undefined;
  const path = audioPath(recording);
  if (path) rmSync(path, { force: true });
}
function scheduleRetention(recording) {
  if (!recording.terminalAt || !["result-ready", "acknowledged", "cancelled", "expired", "failed"].includes(recording.state)) return;
  const expectedState = recording.state;
  const delay = Math.max(0, recording.terminalAt + retentionMs - Date.now());
  const timer = setTimeout(() => {
    if (recording.state !== expectedState) return;
    if (recording.state === "result-ready") {
      recording.state = "expired";
      recording.terminalAt += retentionMs;
      removeAudio(recording);
      persistState();
      scheduleRetention(recording);
    } else {
      recordings.delete(recording.id);
      if (activeId === recording.id) activeId = undefined;
      removeAudio(recording);
      persistState();
    }
  }, delay);
  timer.unref();
}
function markResultReady(recording, completion = recording.completion) {
  recording.completion = completion;
  recording.state = "result-ready";
  recording.terminalAt = Date.now();
  if (activeId === recording.id) activeId = undefined;
  persistState();
  scheduleRetention(recording);
}

function persistState() {
  if (!stateFile) return;
  const state = {
    recordings: [...recordings.values()].map((value) => ({
      ...value,
      leaseHash: value.leaseHash.toString("base64"),
      audio: value.audio?.toString("base64"),
    })),
    replay: [...replay], busyStarts: [...busyStarts], droppedResponses: [...droppedResponses], activeId,
  };
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, stateFile);
}

for (const recording of recordings.values()) scheduleRetention(recording);

if (mode === "restart-recovery") {
  for (const recording of recordings.values()) {
    if (!["recording", "finalizing"].includes(recording.state)) continue;
    recording.state = "failed";
    recording.terminalAt = Date.now();
    removeAudio(recording);
    if (activeId === recording.id) activeId = undefined;
    scheduleRetention(recording);
  }
  persistState();
}

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

function tag(secret, fields) {
  return createHmac("sha256", Buffer.from(secret, "base64")).update(authEncoding(fields)).digest();
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function wav() {
  const dataBytes = mode === "validation-large" ? 30 * 1024 * 1024 : 3200;
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
  const sample = mode === "all-zero" ? 0 : mode === "quiet-nonzero" ? 1 : 1200;
  for (let offset = 44; offset < result.length; offset += 2) result.writeInt16LE(sample, offset);
  if (mode === "invalid-wav") result.writeUInt16LE(2, 22);
  if (mode === "trailing-data") return Buffer.concat([result, Buffer.from([1])]);
  return result;
}

function exactRequest(value) {
  return value && value.type === "request" && value.version === protocolVersion &&
    typeof value.credentialId === "string" && typeof value.requestId === "string" &&
    typeof value.operation === "string" && typeof value.payload === "string" && typeof value.hmac === "string";
}

function digestSecret(value) { return createHash("sha256").update(Buffer.from(value, "base64")).digest(); }

function owned(owner, payload) {
  const recording = recordings.get(payload.recordingId);
  const supplied = typeof payload.leaseSecret === "string" ? digestSecret(payload.leaseSecret) : Buffer.alloc(32);
  const expected = recording?.leaseHash || Buffer.alloc(32, 1);
  const matches = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  return recording && recording.owner === owner && matches ? recording : undefined;
}

function statusPayload(recording) {
  const result = { recordingId: recording.id, state: recording.state };
  if (recording.state === "result-ready") {
    result.length = recording.audio.length;
    result.sha256 = createHash("sha256").update(recording.audio).digest("hex");
    result.completion = recording.completion;
  }
  return result;
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
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
      const credential = credentials.get(request.credentialId);
      if (!credential) throw new Error("credential");
      const payloadBytes = Buffer.from(request.payload, "base64");
      const expected = tag(credential.secret, ["request", protocolVersion, challenge, credential.id, request.requestId, request.operation, payloadBytes]);
      const actual = Buffer.from(request.hmac, "hex");
      if (mode === "auth-failure" || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("auth");
      const payload = JSON.parse(payloadBytes.toString("utf8"));
      if (eventFile) require("node:fs").appendFileSync(eventFile, `${request.operation}\n`);
      if (mode === "cancel-unconfirmed" && request.operation === "cancel") return;
      if (mode === "unapplied-stop-retries" && request.operation === "stop") {
        unappliedStopRequestId ??= request.requestId;
        if (request.requestId !== unappliedStopRequestId) {
          socket.destroy();
          return;
        }
        if (unappliedStopFailures < 3) {
          unappliedStopFailures += 1;
          socket.destroy();
          return;
        }
      }
      const replayKey = `${credential.id}:${request.requestId}`;
      const content = createHash("sha256").update(request.operation).update(Buffer.from([0])).update(payloadBytes).digest("hex");
      const previous = replay.get(replayKey);
      const previousContent = typeof previous === "string" ? previous : previous?.content;
      let status = "ok";
      let responsePayload = {};
      let audio;
      if (previousContent && previousContent !== content) {
        status = "request-conflict";
      } else if (previous?.status) {
        status = previous.status;
        responsePayload = previous.payload;
        if (request.operation === "fetch" && status === "ok") audio = owned(credential.id, payload)?.audio;
      } else {
        replay.set(replayKey, content);
        if (request.operation === "start") {
          const existing = recordings.get(payload.recordingId);
          const leaseHash = typeof payload.leaseSecret === "string" ? digestSecret(payload.leaseSecret) : Buffer.alloc(0);
          if (busyStarts.has(replayKey)) {
            status = "busy";
          } else if (existing) {
            if (existing.owner !== credential.id || leaseHash.length !== existing.leaseHash.length || !timingSafeEqual(leaseHash, existing.leaseHash)) status = "not-found";
            else responsePayload = statusPayload(existing);
          } else if (activeId) {
            busyStarts.add(replayKey);
            status = "busy";
          } else if (mode === "storage-full") {
            status = "failed";
          } else if (leaseHash.length !== 32) {
            status = "failed";
          } else {
            const recording = { id: payload.recordingId, owner: credential.id, leaseHash, state: "recording", audio: wav(), completion: "stopped" };
            recordings.set(recording.id, recording);
            activeId = recording.id;
            writeAudio(recording);
            if (!["companion-duration-disabled", "pi-start-delay"].includes(mode)) {
              const companionDuration = mode === "mac-duration-early" ? Math.max(1, Math.floor(payload.maxDurationMs / 2)) : payload.maxDurationMs;
              const durationTimer = setTimeout(() => {
                if (recording.state !== "recording") return;
                markResultReady(recording, "duration-limit");
              }, companionDuration);
              durationTimer.unref();
            }
            responsePayload = statusPayload(recording);
          }
        } else {
          const recording = owned(credential.id, payload);
          if (!recording) {
            status = "not-found";
          } else if (request.operation === "levels") {
            if (recording.state !== "recording") status = "invalid-state";
            else responsePayload = { observations: [{ sequence: 0, capturedAtMs: 0, dbfs: -20 }] };
          } else if (request.operation === "status") {
            responsePayload = statusPayload(recording);
          } else if (request.operation === "stop") {
            let initiatedFinalization = false;
            if (recording.state === "recording" && mode === "ambiguous-stop") {
              recording.state = "finalizing";
              setTimeout(() => {
                if (recording.state !== "finalizing") return;
                markResultReady(recording);
              }, 50);
              throw new Error("ambiguous stop");
            }
            if (recording.state === "recording") {
              initiatedFinalization = true;
              recording.completion = "stopped";
              if (mode === "slow-finalization") {
                recording.state = "finalizing";
                const finalizer = setTimeout(() => {
                  if (recording.state !== "finalizing") return;
                  markResultReady(recording);
                }, 2000);
                finalizer.unref();
              } else {
                markResultReady(recording);
              }
            }
            if (recording.state === "finalizing" && !initiatedFinalization) status = "invalid-state";
            else if (recording.state !== "result-ready" && recording.state !== "finalizing") status = "invalid-state";
            else responsePayload = statusPayload(recording);
          } else if (request.operation === "fetch") {
            if (recording.state !== "result-ready") status = "invalid-state";
            else {
              audio = recording.audio;
              responsePayload = {
                recordingId: recording.id,
                length: mode === "oversized" ? 999999999 : audio.length,
                sha256: mode === "hash-mismatch" ? "0".repeat(64) : createHash("sha256").update(audio).digest("hex"),
                completion: recording.completion,
              };
            }
          } else if (request.operation === "acknowledge") {
            if (mode === "ack-failure") throw new Error("acknowledgement");
            if (recording.state === "result-ready" || recording.state === "acknowledged") {
              if (recording.state === "result-ready") recording.terminalAt = Date.now();
              recording.state = "acknowledged";
              removeAudio(recording);
              scheduleRetention(recording);
              if (eventFile) require("node:fs").appendFileSync(eventFile, "acknowledged\n");
              responsePayload = statusPayload(recording);
            } else status = "invalid-state";
          } else if (request.operation === "cancel") {
            if (["recording", "finalizing", "result-ready", "cancelled"].includes(recording.state)) {
              if (recording.state !== "cancelled") recording.terminalAt = Date.now();
              recording.state = "cancelled";
              removeAudio(recording);
              scheduleRetention(recording);
              if (activeId === recording.id) activeId = undefined;
              responsePayload = statusPayload(recording);
            } else status = "invalid-state";
          } else status = "failed";
        }
      }
      if (status !== "request-conflict") {
        replay.set(replayKey, { content, operation: request.operation, status, payload: responsePayload });
        const observationOperations = new Set(["health", "levels", "status"]);
        const observations = [...replay].filter(([, value]) => observationOperations.has(value.operation));
        while (observations.length > 256) replay.delete(observations.shift()[0]);
      }
      persistState();
      const responseBytes = Buffer.from(JSON.stringify(responsePayload));
      const responseTag = tag(credential.secret, ["response", protocolVersion, challenge, credential.id, request.requestId, `${request.operation}:${status}`, responseBytes]);
      const response = frame({ type: "response", version: protocolVersion, requestId: request.requestId, status, payload: responseBytes.toString("base64"), hmac: responseTag.toString("hex") });
      if (request.operation === "fetch" && mode === "early-eof" && audio) audio = audio.subarray(0, audio.length - 1);
      if (request.operation === "fetch" && mode === "fetch-stall" && audio) {
        socket.write(Buffer.concat([response, audio.subarray(0, 100)]));
        return;
      }
      const droppedOperation = mode.startsWith("drop-") && mode.endsWith("-response")
        ? mode.slice("drop-".length, -"-response".length)
        : undefined;
      if (request.operation === droppedOperation && !droppedResponses.has(request.operation)) {
        droppedResponses.add(request.operation);
        persistState();
        socket.destroy();
        return;
      }
      if (request.operation === "fetch" && mode === "fetch-interrupted-once" && audio && !droppedResponses.has("fetch")) {
        droppedResponses.add("fetch");
        persistState();
        socket.write(Buffer.concat([response, audio.subarray(0, 100)]), () => socket.destroy());
        return;
      }
      if (request.operation === "start" && mode === "pi-start-delay") {
        const delayed = setTimeout(() => socket.end(response), 220);
        delayed.unref();
        return;
      }
      if (request.operation === "acknowledge" && mode === "ack-delay") {
        const delayed = setTimeout(() => socket.end(response), 150);
        delayed.unref();
        return;
      }
      socket.end(audio ? Buffer.concat([response, audio]) : response);
    } catch { socket.destroy(); }
  });
});

server.listen(endpoint, () => {
  require("node:fs").chmodSync(endpoint, 0o600);
  if (process.send) process.send({ ready: true });
});

process.on("message", (message) => {
  const recording = recordings.get(message?.recordingId);
  if (message?.type === "force-state" && recording) {
    recording.state = message.state;
    activeId = ["recording", "finalizing"].includes(message.state) ? recording.id :
      (activeId === recording.id ? undefined : activeId);
    persistState();
    process.send?.({ forced: message.recordingId });
  } else if (message?.type === "expire" && recording) {
    recording.state = "expired";
    recording.terminalAt = Date.now();
    removeAudio(recording);
    if (activeId === recording.id) activeId = undefined;
    persistState();
    process.send?.({ expired: message.recordingId });
  } else if (message?.type === "purge" && recording) {
    recordings.delete(message.recordingId);
    if (activeId === recording.id) activeId = undefined;
    persistState();
    process.send?.({ purged: message.recordingId });
  }
});

process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  process.exit(0);
});
