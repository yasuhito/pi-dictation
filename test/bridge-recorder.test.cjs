const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { once } = require("node:events");
const { randomBytes, randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { createJiti } = require("jiti");
const { runRecorderContract } = require("./recorder-contract.cjs");

const root = resolve(__dirname, "..");
const companion = join(root, "test", "fixtures", "fake-bridge-companion.cjs");
const jiti = createJiti(__filename, { interopDefault: true });

async function harness(mode = "valid", credentialMetadata = {}) {
  const directory = mkdtempSync(join("/tmp", "pi-db-"));
  const socketDirectory = join(directory, "socket");
  mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentialFile = join(directory, "credential.json");
  const credential = {
    id: "77777777-7777-4777-8777-777777777777",
    secret: Buffer.alloc(32, 13).toString("base64"),
    ...credentialMetadata,
  };
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const eventFile = join(directory, "events.log");
  const child = fork(companion, [socket, Buffer.from(JSON.stringify(credential)).toString("base64"), mode, eventFile], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message");
  const { createRecorder } = await jiti.import(join(root, "extensions", "recorder.ts"));
  return {
    recorder: createRecorder({ type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile }),
    eventFile,
    events() { return existsSync(eventFile) ? readFileSync(eventFile, "utf8").trim().split("\n") : []; },
    startOptions: {
      destination: join(directory, "recording.wav"),
      maxDurationMs: 10000,
      signal: new AbortController().signal,
      onLevel() {},
    },
    async cleanup() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

runRecorderContract("bridge recording", () => harness());

test("the Recorder starts with an install or rotation credential containing creation metadata", async () => {
  const instance = await harness("valid", { createdAt: new Date().toISOString() });
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.cancel();
    assert.equal(instance.events().includes("start"), true);
  } finally { await instance.cleanup(); }
});

test("the Recorder transports authenticated Bridge recording Level observations", async () => {
  const instance = await harness();
  const observations = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (value) => observations.push(value) });
    const deadline = Date.now() + 3000;
    while (observations.length === 0 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await recording.cancel();
    assert.deepEqual(observations.find(({ type }) => type === "observation"), {
      type: "observation", sequence: 0, capturedAtMs: 0, dbfs: -20,
    });
  } finally { await instance.cleanup(); }
});

test("the Bridge Level subscription replays the fixed thirty-second history", async (t) => {
  const instance = await harness("replay-600");
  const observations = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => observations.push(event) });
    const deadline = Date.now() + 3000;
    while (observations.filter(({ type }) => type === "observation").length < 600 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    const replay = observations.filter(({ type }) => type === "observation").slice(0, 600);
    await t.test("retains exactly 600 slots", () => {
      assert.equal(replay.length, 600);
    });
    await t.test("starts replay at the oldest retained sequence", () => {
      assert.equal(replay[0]?.sequence, 0);
    });
    await t.test("ends replay at the newest retained sequence", () => {
      assert.equal(replay.at(-1)?.sequence, 599);
    });
  } finally { await instance.cleanup(); }
});

test("the Bridge Level subscription accepts in-window out-of-order observations", async () => {
  const instance = await harness("out-of-order");
  const observations = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => observations.push(event) });
    const deadline = Date.now() + 3000;
    while (observations.filter(({ type }) => type === "observation").length < 2 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    assert.deepEqual(observations.filter(({ type }) => type === "observation").slice(0, 2).map(({ sequence }) => sequence), [1, 0]);
  } finally { await instance.cleanup(); }
});

test("the Bridge rejects conflicting duplicate Level observations", async (t) => {
  const instance = await harness("conflicting-duplicate");
  const events = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => events.push(event) });
    const deadline = Date.now() + 3000;
    while (!events.some(({ type, state }) => type === "transport" && state === "unavailable") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    await t.test("diagnoses the conflicting stream as unavailable", () => {
      assert.equal(events.some(({ type, state }) => type === "transport" && state === "unavailable"), true);
    });
    await t.test("does not deliver the conflicting duplicate", () => {
      assert.equal(events.filter(({ type, sequence }) => type === "observation" && sequence === 0).length, 1);
    });
  } finally { await instance.cleanup(); }
});

test("the Bridge Level subscription reports observations lost beyond replay", async () => {
  const instance = await harness("replay-gap");
  const observations = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => observations.push(event) });
    const deadline = Date.now() + 3000;
    while (!observations.some(({ type }) => type === "gap") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    assert.deepEqual(observations.find(({ type }) => type === "gap"), { type: "gap", fromSequence: 0, toSequence: 4 });
  } finally { await instance.cleanup(); }
});

test("Level transport failure does not change Bridge recording success", async () => {
  const instance = await harness("level-disconnect");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    assert.equal(existsSync(instance.startOptions.destination), true);
  } finally { await instance.cleanup(); }
});

test("the Bridge retries a failed Level connection with bounded backoff only while recording", async (t) => {
  const instance = await harness("level-disconnect");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await new Promise((resolveWait) => setTimeout(resolveWait, 380));
    const subscriptionsWhileRecording = instance.events().filter((event) => event === "subscribe-levels").length;
    await recording.cancel();
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const subscriptionsAfterCancel = instance.events().filter((event) => event === "subscribe-levels").length;
    await t.test("retries after a disconnect", () => {
      assert.equal(subscriptionsWhileRecording >= 2, true);
    });
    await t.test("bounds retry frequency", () => {
      assert.equal(subscriptionsWhileRecording <= 4, true);
    });
    await t.test("stops retrying after cancellation", () => {
      assert.equal(subscriptionsAfterCancel, subscriptionsWhileRecording);
    });
  } finally { await instance.cleanup(); }
});

test("measurement unavailability remains explicit on the Recorder boundary", async () => {
  const instance = await harness("level-unavailable");
  const observations = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => observations.push(event) });
    const deadline = Date.now() + 3000;
    while (!observations.some(({ type }) => type === "unavailable") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    assert.equal(observations.some(({ type }) => type === "unavailable"), true);
  } finally { await instance.cleanup(); }
});

for (const [mode, code] of [
  ["oversized", "invalid-audio"],
  ["invalid-wav", "invalid-audio"],
  ["duplicate-fmt-wav", "invalid-audio"],
  ["duplicate-data-wav", "invalid-audio"],
  ["trailing-data", "invalid-audio"],
  ["hash-mismatch", "invalid-audio"],
  ["metadata-conflict", "invalid-audio"],
  ["noncanonical-base64", "recording-failed"],
  ["version-mismatch", "recording-failed"],
  ["auth-failure", "outcome-unknown"],
  ["ack-failure", "recording-failed"],
]) {
  test(`the Bridge recording adapter rejects ${mode} without committing audio`, async (t) => {
    const instance = await harness(mode);
    try {
      const error = await instance.recorder.start(instance.startOptions)
        .then((recording) => recording.stop())
        .catch((value) => value);
      await t.test("returns a stable safe Recorder classification", () => assert.equal(error.code, code));
      await t.test("leaves the destination absent", () => assert.equal(existsSync(instance.startOptions.destination), false));
      await t.test("deletes the private partial file", () => assert.equal(readdirSync(resolve(instance.startOptions.destination, "..")).some((name) => name.includes(".partial-")), false));
    } finally { await instance.cleanup(); }
  });
}

test("the Bridge recording adapter accepts result metadata when an ambiguous start retry finds a completed lease", async () => {
  const instance = await harness("ambiguous-start-result-ready");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.cancel();
    assert.equal(instance.events().filter((event) => event === "start").length, 2);
  } finally { await instance.cleanup(); }
});

test("the Bridge recording adapter recovers a result completed after a lost start response", async () => {
  const instance = await harness("lost-start-result-ready");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    assert.equal(existsSync(instance.startOptions.destination), true);
  } finally { await instance.cleanup(); }
});

test("the Bridge recording adapter rejects a null status after a lost start response", async () => {
  const instance = await harness("lost-start-null-status");
  try {
    const error = await instance.recorder.start(instance.startOptions).catch((value) => value);
    assert.equal(error.code, "recording-failed");
  } finally { await instance.cleanup(); }
});

test("the Bridge recording adapter reconciles an ambiguous stop through owner status", async () => {
  const instance = await harness("ambiguous-stop");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    assert.equal(existsSync(instance.startOptions.destination), true);
  } finally { await instance.cleanup(); }
});

test("owner-authenticated not-found during finalization is a deterministic failure", async () => {
  const instance = await harness("finalization-not-found");
  const controller = new AbortController();
  instance.startOptions.signal = controller.signal;
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const safetyDeadline = setTimeout(() => controller.abort(), 500);
    const error = await recording.stop().catch((value) => value);
    clearTimeout(safetyDeadline);
    assert.equal(error.code, "recording-failed");
  } finally { await instance.cleanup(); }
});

test("the Bridge recording adapter reapplies the same stop identity during finalization reconciliation", async () => {
  const instance = await harness("unapplied-stop-retries");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    assert.equal(existsSync(instance.startOptions.destination), true);
  } finally { await instance.cleanup(); }
});

for (const operation of ["start", "status", "stop", "acknowledge", "cancel"]) {
  test(`the Bridge recording adapter retries the same ${operation} operation after a lost response`, async () => {
    const instance = await harness(`drop-${operation}-response`);
    try {
      const recording = await instance.recorder.start(instance.startOptions);
      if (operation === "cancel") await recording.cancel();
      else if (operation !== "start") await recording.stop();
      else await recording.cancel();
      assert.equal(instance.events().filter((event) => event === operation).length >= 2, true);
    } finally { await instance.cleanup(); }
  });
}

test("a deterministic local fetch write failure does not enter transport recovery", async (t) => {
  const instance = await harness();
  instance.startOptions.destination = join(resolve(instance.startOptions.destination, ".."), "missing", "recording.wav");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const startedAt = Date.now();
    const error = await recording.stop().catch((value) => value);
    const elapsed = Date.now() - startedAt;
    await t.test("returns the deterministic recording failure classification", () => {
      assert.equal(error.code, "recording-failed");
    });
    await t.test("fails without consuming the recovery window", () => {
      assert.equal(elapsed < 1000, true);
    });
    await t.test("does not retry the successful remote fetch", () => {
      assert.equal(instance.events().filter((event) => event === "fetch").length, 1);
    });
  } finally { await instance.cleanup(); }
});

test("an interrupted Bridge fetch restarts from byte zero", async (t) => {
  const instance = await harness("fetch-interrupted-once");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    await t.test("retries the fetch operation", () => {
      assert.equal(instance.events().filter((event) => event === "fetch").length, 2);
    });
    await t.test("commits only the complete recovered WAV", () => {
      assert.equal(existsSync(instance.startOptions.destination), true);
    });
  } finally { await instance.cleanup(); }
});

test("two authenticated Bridge clients share one companion without sharing a Recording lease", async (t) => {
  const directory = mkdtempSync(join("/tmp", "pi-db-shared-"));
  const socketDirectory = join(directory, "socket");
  mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentials = [0, 1].map(() => ({ id: randomUUID(), secret: randomBytes(32).toString("base64") }));
  const credentialFiles = credentials.map((credential, index) => {
    const path = join(directory, `credential-${index}.json`);
    writeFileSync(path, JSON.stringify(credential), { mode: 0o600 });
    return path;
  });
  const child = fork(companion, [socket, Buffer.from(JSON.stringify(credentials)).toString("base64"), "valid"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message");
  try {
    const { createRecorder } = await jiti.import(join(root, "extensions", "recorder.ts"));
    const recorders = credentialFiles.map((credentialFile) => createRecorder({
      type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile,
    }));
    const options = (name) => ({
      destination: join(directory, name), maxDurationMs: 10000,
      signal: new AbortController().signal, onLevel() {},
    });
    const first = await recorders[0].start(options("first.wav"));
    const secondError = await recorders[1].start(options("second.wav")).catch((error) => error);
    await first.stop();

    await t.test("the competing client receives only the safe busy classification", () => {
      assert.equal(secondError.code, "recorder-busy");
    });
    await t.test("the owner still retrieves its result", () => {
      assert.equal(existsSync(join(directory, "first.wav")), true);
    });
    await t.test("the competing client creates no result", () => {
      assert.equal(existsSync(join(directory, "second.wav")), false);
    });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bridge cancellation after acknowledgement begins is a no-op", async (t) => {
  const instance = await harness("ack-delay");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const stopping = recording.stop();
    while (!instance.events().includes("acknowledge")) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    await recording.cancel();
    await stopping;
    await t.test("preserves the acknowledged destination", () => assert.equal(existsSync(instance.startOptions.destination), true));
    await t.test("does not send a late remote cancellation", () => assert.equal(instance.events().includes("cancel"), false));
  } finally { await instance.cleanup(); }
});

test("Bridge cancellation retries remotely when acknowledgement fails", async (t) => {
  const instance = await harness("ack-failure");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const stopping = recording.stop().catch((error) => error);
    while (!instance.events().includes("acknowledge")) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    await recording.cancel();
    const stopError = await stopping;
    await t.test("does not report the failed stop as successful", () => assert.equal(stopError.code, "recording-failed"));
    await t.test("sends authenticated cancellation after the failure", () => assert.equal(instance.events().includes("cancel"), true));
    await t.test("leaves no transcribable destination", () => assert.equal(existsSync(instance.startOptions.destination), false));
  } finally { await instance.cleanup(); }
});

test("repeated concurrent Bridge lifecycle calls are idempotent", async (t) => {
  const stoppingInstance = await harness();
  const cancellingInstance = await harness();
  try {
    const stoppingRecording = await stoppingInstance.recorder.start(stoppingInstance.startOptions);
    await Promise.all([stoppingRecording.stop(), stoppingRecording.stop(), stoppingRecording.stop()]);
    const cancellingRecording = await cancellingInstance.recorder.start(cancellingInstance.startOptions);
    await Promise.all([cancellingRecording.cancel(), cancellingRecording.cancel(), cancellingRecording.cancel()]);
    await t.test("finalizes only once", () => assert.equal(stoppingInstance.events().filter((event) => event === "stop").length, 1));
    await t.test("cancels only once", () => assert.equal(cancellingInstance.events().filter((event) => event === "cancel").length, 1));
  } finally {
    await stoppingInstance.cleanup();
    await cancellingInstance.cleanup();
  }
});

test("Bridge cancellation interrupts finalization immediately", async (t) => {
  const instance = await harness("slow-finalization");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const stopping = recording.stop().catch((error) => error);
    while (!instance.events().includes("status")) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const startedAt = Date.now();
    await recording.cancel();
    const stopError = await stopping;
    await t.test("does not wait for the finalization deadline", () => assert.equal(Date.now() - startedAt < 1000, true));
    await t.test("classifies the interrupted stop as cancelled", () => assert.equal(stopError.code, "cancelled"));
    await t.test("leaves no Pi partial file", () => assert.equal(readdirSync(resolve(instance.startOptions.destination, "..")).some((name) => name.includes(".partial-")), false));
  } finally { await instance.cleanup(); }
});

test("Bridge cancellation interrupts a stalled WAV transfer", async (t) => {
  const instance = await harness("fetch-stall");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const stopping = recording.stop().catch((error) => error);
    while (!instance.events().includes("fetch")) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const startedAt = Date.now();
    const cancelling = recording.cancel();
    const stopError = await stopping;
    const stopElapsed = Date.now() - startedAt;
    await cancelling;
    await t.test("does not wait for the transfer deadline", () => assert.equal(stopElapsed < 1000, true));
    await t.test("classifies the interrupted transfer as cancelled", () => assert.equal(stopError.code, "cancelled"));
    await t.test("leaves no transcribable destination", () => assert.equal(existsSync(instance.startOptions.destination), false));
  } finally { await instance.cleanup(); }
});

test("Bridge cancellation interrupts WAV validation", async (t) => {
  const instance = await harness("validation-large");
  instance.startOptions.maxDurationMs = 1000000;
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const stopping = recording.stop().catch((error) => error);
    const directory = resolve(instance.startOptions.destination, "..");
    let partial;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      partial = readdirSync(directory).find((name) => name.includes(".partial-"));
      if (partial && statSync(join(directory, partial)).size >= 30 * 1024 * 1024) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    await recording.cancel();
    const stopError = await stopping;
    await t.test("classifies validation interruption as cancelled", () => assert.equal(stopError.code, "cancelled"));
    await t.test("removes the validation partial", () => assert.equal(readdirSync(directory).some((name) => name.includes(".partial-")), false));
  } finally { await instance.cleanup(); }
});

test("unconfirmed Bridge cancellation is bounded and safe", async (t) => {
  const instance = await harness("cancel-unconfirmed");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const startedAt = Date.now();
    const error = await recording.cancel().catch((value) => value);
    const elapsed = Date.now() - startedAt;
    await t.test("reports the owner-liveness risk", () => assert.equal(error.code, "cancellation-unconfirmed"));
    await t.test("returns at the five-second bound", () => assert.equal(elapsed >= 4500 && elapsed < 6000, true));
    await t.test("leaves no transcribable destination", () => assert.equal(existsSync(instance.startOptions.destination), false));
  } finally { await instance.cleanup(); }
});

for (const [mode, label] of [["companion-duration-disabled", "Pi"], ["mac-duration-early", "Mac companion"]]) {
  test(`${label} independently enforces the Bridge duration limit`, async (t) => {
    const instance = await harness(mode);
    instance.startOptions.maxDurationMs = 160;
    try {
      const recording = await instance.recorder.start(instance.startOptions);
      if (mode === "mac-duration-early") await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      else await new Promise((resolveWait) => setTimeout(resolveWait, 220));
      const error = await recording.stop().catch((value) => value);
      await t.test("returns the duration-limit result", () => assert.equal(error.code, "duration-limit-reached"));
      await t.test("fetches the recoverable result", () => assert.equal(instance.events().includes("fetch"), true));
      await t.test("acknowledges retained audio for cleanup", () => assert.equal(instance.events().includes("acknowledge"), true));
      await t.test("never commits audio for transcription", () => assert.equal(existsSync(instance.startOptions.destination), false));
    } finally { await instance.cleanup(); }
  });
}

test("Pi's duration deadline includes delayed Bridge startup", async () => {
  const instance = await harness("pi-start-delay");
  instance.startOptions.maxDurationMs = 160;
  try {
    const startedAt = Date.now();
    const recording = await instance.recorder.start(instance.startOptions);
    const error = await recording.stop().catch((value) => value);
    assert.deepEqual({ code: error.code, bounded: Date.now() - startedAt < 350 }, {
      code: "duration-limit-reached", bounded: true,
    });
  } finally { await instance.cleanup(); }
});

test("Bridge WAV validation distinguishes digital silence from quiet input", async (t) => {
  const silent = await harness("all-zero");
  const quiet = await harness("quiet-nonzero");
  try {
    const silentError = await silent.recorder.start(silent.startOptions).then((recording) => recording.stop()).catch((error) => error);
    const quietRecording = await quiet.recorder.start(quiet.startOptions);
    await quietRecording.stop();
    await t.test("rejects an all-zero completed WAV", () => assert.equal(silentError.code, "invalid-audio"));
    await t.test("accepts a quiet non-zero completed WAV", () => assert.equal(existsSync(quiet.startOptions.destination), true));
  } finally {
    await silent.cleanup();
    await quiet.cleanup();
  }
});

test("the Bridge recording adapter refuses a Unix socket outside a private directory", async () => {
  const instance = await harness();
  try {
    require("node:fs").chmodSync(resolve(instance.startOptions.destination, "../socket"), 0o755);
    await assert.rejects(instance.recorder.start(instance.startOptions), (error) => error.code === "recording-failed");
  } finally { await instance.cleanup(); }
});
