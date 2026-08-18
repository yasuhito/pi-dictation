const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const net = require("node:net");
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
  const config = { type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile };
  return {
    child, socket, credential, config,
    recorder: createRecorder(config),
    eventFile,
    events() { return existsSync(eventFile) ? readFileSync(eventFile, "utf8").trim().split("\n") : []; },
    startOptions: {
      destination: join(directory, "recording.wav"),
      maxDurationMs: 10000,
      signal: new AbortController().signal,
      onLevel() {},
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit").catch(() => {});
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

runRecorderContract("bridge recording", () => harness());

test("the Bridge Recorder routes all exchanges through the shared protocol seam", async (t) => {
  const instance = await harness();
  const requests = [];
  const streams = [];
  try {
    const sharedProtocol = await import(join(root, "lib", "bridge-protocol.mjs"));
    const { checkBridgeRecorder, createBridgeRecorder } = await jiti.import(join(root, "extensions", "bridge-recorder.ts"));
    const protocol = {
      request(options) {
        requests.push(options.operation);
        return sharedProtocol.request(options);
      },
      withStream(options, consumer) {
        streams.push([options.operation, options.kind]);
        return sharedProtocol.withStream(options, consumer);
      },
    };
    await checkBridgeRecorder(instance.config, 2000, protocol);
    const recorder = createBridgeRecorder(instance.config, protocol);
    const stopped = await recorder.start(instance.startOptions);
    await stopped.stop();
    const cancelled = await recorder.start(instance.startOptions);
    await cancelled.cancel();
    await t.test("routes control exchanges through request", () => {
      assert.deepEqual([...new Set(requests)].sort(), ["acknowledge", "cancel", "health", "start", "status", "stop"]);
    });
    await t.test("routes audio and Level streams through withStream", () => {
      assert.deepEqual([...new Map(streams.map((value) => [value[0], value])).values()].sort(), [
        ["fetch", "binary"], ["subscribe-levels", "authenticated-frames"],
      ]);
    });
  } finally { await instance.cleanup(); }
});

test("the Bridge health check reports an authenticated available input", async () => {
  const instance = await harness();
  try {
    const { checkBridgeRecorder } = await jiti.import(join(root, "extensions", "bridge-recorder.ts"));
    assert.equal(await checkBridgeRecorder(instance.config), true);
  } finally { await instance.cleanup(); }
});

test("the Bridge health deadline starts before authentication and spans transport retries", async (t) => {
  const instance = await harness("health-slow-drop");
  try {
    const { checkBridgeRecorder } = await jiti.import(join(root, "extensions", "bridge-recorder.ts"));
    const startedAt = Date.now();
    const available = await checkBridgeRecorder(instance.config, 250);
    const elapsed = Date.now() - startedAt;
    const requestIds = instance.events()
      .filter((event) => event.startsWith("health-request:"))
      .map((event) => event.slice("health-request:".length));
    await t.test("returns the existing unavailable outcome", () => {
      assert.equal(available, false);
    });
    await t.test("retries within the shared request budget", () => {
      assert.equal(instance.events().filter((event) => event === "health").length, 2);
    });
    await t.test("preserves the ambiguous health request identity", () => {
      assert.equal(new Set(requestIds).size, 1);
    });
    await t.test("bounds authentication and retries from the operation start", () => {
      assert.equal(elapsed >= 220 && elapsed < 450, true);
    });
  } finally { await instance.cleanup(); }
});

test("Bridge fetch and SHA-256 buffers remain fixed as WAV length grows", async (t) => {
  const measure = async (mode) => {
    const instance = await harness(mode);
    process.env.PI_DICTATION_TEST_RESOURCE_METRICS = "1";
    delete globalThis.__piDictationBridgeResourceMetrics;
    try {
      const recording = await instance.recorder.start({ ...instance.startOptions, maxDurationMs: 60 * 60 * 1000 });
      await recording.stop();
      return { ...globalThis.__piDictationBridgeResourceMetrics };
    } finally {
      delete process.env.PI_DICTATION_TEST_RESOURCE_METRICS;
      delete globalThis.__piDictationBridgeResourceMetrics;
      await instance.cleanup();
    }
  };
  const short = await measure("valid");
  const long = await measure("validation-large");
  await t.test("bounds socket buffering independently of WAV length", () => assert.equal(
    Math.max(short.socket, long.socket) <= 128 * 1024 + 4, true,
  ));
  await t.test("bounds fetch chunks independently of WAV length", () => assert.equal(
    Math.max(short.fetch, long.fetch) <= 64 * 1024, true,
  ));
  await t.test("bounds SHA-256 chunks independently of WAV length", () => assert.equal(
    Math.max(short.sha256, long.sha256) <= 64 * 1024, true,
  ));
});

test("the Recorder starts with an install or rotation credential containing creation metadata", async () => {
  const instance = await harness("valid", { createdAt: new Date().toISOString() });
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.cancel();
    assert.equal(instance.events().includes("start"), true);
  } finally { await instance.cleanup(); }
});

test("the Bridge Recorder preserves the safe audio error for trailing ordinary response bytes", async (t) => {
  const instance = await harness("extra-start-byte");
  try {
    const error = await instance.recorder.start(instance.startOptions).catch((value) => value);
    await t.test("returns the prior Recorder classification", () => {
      assert.equal(error.code, "invalid-audio");
    });
    await t.test("returns the prior safe message", () => {
      assert.equal(error.message, "The recorder did not produce a complete PCM16 mono WAV.");
    });
  } finally { await instance.cleanup(); }
});

test("the Bridge Recorder exposes storage reservation exhaustion safely", async () => {
  const instance = await harness("storage-full");
  try {
    await assert.rejects(instance.recorder.start(instance.startOptions), { code: "recorder-storage-full" });
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

test("the Bridge Level subscription rejects a malformed authenticated frame through the shared seam", async () => {
  const instance = await harness("malformed-level-authentication");
  const events = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => events.push(event) });
    const deadline = Date.now() + 3000;
    while (!events.some(({ type, state }) => type === "transport" && state === "unavailable") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    assert.equal(events.some(({ type, state }) => type === "transport" && state === "unavailable"), true);
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

test("a terminal Level frame ends the subscription loop", async (t) => {
  const instance = await harness("terminal-level");
  const events = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (event) => events.push(event) });
    const deadline = Date.now() + 500;
    while (!events.some(({ type, state }) => type === "transport" && state === "unavailable") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const subscriptionCount = instance.events().filter((event) => event === "subscribe-levels").length;
    await recording.cancel();
    await t.test("does not resubscribe", () => {
      assert.equal(subscriptionCount, 1);
    });
    await t.test("does not report the next connection as unavailable", () => {
      assert.equal(events.some(({ type, state }) => type === "transport" && state === "unavailable"), false);
    });
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

test("a lost Level subscription response retries the same request identity", async (t) => {
  const instance = await harness("drop-subscribe-levels-response");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const deadline = Date.now() + 3000;
    while (instance.events().filter((event) => event.startsWith("subscribe-levels-request:")).length < 2 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const requestIds = instance.events()
      .filter((event) => event.startsWith("subscribe-levels-request:"))
      .map((event) => event.slice("subscribe-levels-request:".length));
    await recording.cancel();
    await t.test("retries after losing the authenticated response", () => {
      assert.equal(requestIds.length >= 2, true);
    });
    await t.test("preserves the ambiguous request identity", () => {
      assert.equal(requestIds[1], requestIds[0]);
    });
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
  ["wrong-sample-rate", "invalid-audio"],
  ["pcm-over-duration", "invalid-audio"],
  ["header-over-allowance", "invalid-audio"],
  ["duplicate-fmt-wav", "invalid-audio"],
  ["duplicate-data-wav", "invalid-audio"],
  ["trailing-data", "invalid-audio"],
  ["extra-fetch-byte", "invalid-audio"],
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
  test(`the Bridge recording adapter retries an ambiguous ${operation} within one request budget`, async (t) => {
    const instance = await harness(`drop-${operation}-response`);
    try {
      const recording = await instance.recorder.start(instance.startOptions);
      if (operation === "cancel") await recording.cancel();
      else if (operation !== "start") await recording.stop();
      else await recording.cancel();
      const requestIds = instance.events()
        .filter((event) => event.startsWith(`${operation}-request:`))
        .map((event) => event.slice(`${operation}-request:`.length));
      await t.test("retries the transport failure", () => {
        assert.equal(requestIds.length >= 2, true);
      });
      await t.test("spans retries with one stable request identity", () => {
        assert.equal(new Set(requestIds).size, 1);
      });
    } finally { await instance.cleanup(); }
  });
}

test("each Bridge control operation keeps one deadline across transport retries", async (t) => {
  const characterize = async (operation) => {
    const instance = await harness(`budget-${operation}`);
    try {
      const startedAt = Date.now();
      const recording = await instance.recorder.start(instance.startOptions);
      if (operation === "start") await recording.cancel();
      else if (operation === "cancel") await recording.cancel().catch(() => {});
      else await recording.stop();
      return Date.now() - startedAt;
    } finally { await instance.cleanup(); }
  };
  const operations = ["start", "status", "stop", "acknowledge", "cancel"];
  const elapsed = Object.fromEntries(await Promise.all(operations.map(async (operation) => [operation, await characterize(operation)])));
  const expectedBounds = { start: [4500, 6000], status: [4500, 6000], stop: [4500, 6000], acknowledge: [4500, 6000], cancel: [4500, 6000] };
  const policy = {
    start: "start shares its five-second budget across retries",
    status: "status shares its five-second budget across retries",
    stop: "stop shares its five-second budget across retries inside the finalization budget",
    acknowledge: "acknowledge shares its five-second budget across retries",
    cancel: "cancel shares its five-second budget across retries",
  };
  for (const operation of operations) {
    await t.test(policy[operation], () => {
      const [minimum, maximum] = expectedBounds[operation];
      assert.equal(elapsed[operation] >= minimum && elapsed[operation] < maximum, true);
    });
  }
});

test("a stalled stop response cannot consume the finalization budget before status reconciles", async (t) => {
  const instance = await harness("stop-response-stalled");
  try {
    const startedAt = Date.now();
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    const elapsed = Date.now() - startedAt;
    await t.test("commits the reconciled result", () => {
      assert.equal(existsSync(instance.startOptions.destination), true);
    });
    await t.test("leaves the finalization budget for reconciliation", () => {
      assert.equal(elapsed < 15000, true);
    });
  } finally { await instance.cleanup(); }
});

for (const status of ["not-found", "request-conflict", "invalid-state", "failed", "busy"]) {
  test(`the Bridge Recorder does not retry authenticated start status ${status}`, async (t) => {
    const instance = await harness(`start-status-${status}`);
    try {
      const error = await instance.recorder.start(instance.startOptions).catch((value) => value);
      await t.test("maps the authenticated status to the existing safe outcome", () => {
        assert.equal(error.code, status === "busy" ? "recorder-busy" : "recording-failed");
      });
      await t.test("performs no caller retry", () => {
        assert.equal(instance.events().filter((event) => event === "start").length, 1);
      });
    } finally { await instance.cleanup(); }
  });
}

test("the Bridge Recorder does not retry an authenticated version mismatch", async () => {
  const instance = await harness("version-mismatch");
  try {
    await instance.recorder.start(instance.startOptions).catch(() => {});
    assert.equal(instance.events().filter((event) => event === "start").length, 1);
  } finally { await instance.cleanup(); }
});

test("an AbortSignal reason retains the Recorder cancellation classification", async () => {
  const instance = await harness();
  const controller = new AbortController();
  instance.startOptions.signal = controller.signal;
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    controller.abort(new Error("caller cancellation reason"));
    const error = await recording.stop().catch((value) => value);
    assert.equal(error.code, "cancelled");
  } finally { await instance.cleanup(); }
});

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

test("the Bridge fetch deadline resets when audio transfer makes progress", async (t) => {
  const instance = await harness("fetch-progress-reset");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const startedAt = Date.now();
    await recording.stop();
    await t.test("allows total transfer time to exceed one no-progress interval", () => {
      assert.equal(Date.now() - startedAt >= 11000, true);
    });
    await t.test("commits the completed WAV", () => {
      assert.equal(existsSync(instance.startOptions.destination), true);
    });
  } finally { await instance.cleanup(); }
});

test("an interrupted Bridge fetch restarts from byte zero within one recovery budget", async (t) => {
  const instance = await harness("fetch-interrupted-once");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    const requestIds = instance.events()
      .filter((event) => event.startsWith("fetch-request:"))
      .map((event) => event.slice("fetch-request:".length));
    await t.test("retries the fetch operation", () => {
      assert.equal(requestIds.length, 2);
    });
    await t.test("spans recovery with the ambiguous fetch identity", () => {
      assert.equal(new Set(requestIds).size, 1);
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

test("the Bridge recording timeline starts after authenticated startup", async () => {
  const instance = await harness("pi-start-delay");
  try {
    const requestedAt = Date.now();
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.cancel();
    assert.equal(recording.startedAt - requestedAt >= 180, true);
  } finally { await instance.cleanup(); }
});

test("Pi's duration deadline includes delayed Bridge startup", async () => {
  const instance = await harness("pi-start-delay");
  instance.startOptions.maxDurationMs = 160;
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    const error = await recording.stop().catch((value) => value);
    assert.equal(error.code, "duration-limit-reached");
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

test("Pi measures the first owner-liveness proof from the Recording lease request", async () => {
  const instance = await harness("pi-start-delay");
  instance.startOptions.maxDurationMs = 20000;
  try {
    const requestedAt = Date.now();
    const recording = await instance.recorder.start(instance.startOptions);
    const deadline = requestedAt + 5500;
    let firstStatusAt;
    while (firstStatusAt === undefined && Date.now() < deadline) {
      firstStatusAt = instance.events()
        .filter((event) => event.startsWith("status-at:"))
        .map((event) => Number(event.slice("status-at:".length)))[0];
      if (firstStatusAt === undefined) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await recording.cancel();
    assert.equal(firstStatusAt - requestedAt >= 4500 && firstStatusAt - requestedAt <= 5250, true);
  } finally { await instance.cleanup(); }
});

test("Pi proves owner liveness with fresh authenticated status requests every five seconds", async (t) => {
  const instance = await harness("slow-liveness-status");
  instance.startOptions.maxDurationMs = 20000;
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10300));
    const events = instance.events();
    const statusRequestIds = events
      .filter((event) => event.startsWith("status-request:"))
      .map((event) => event.slice("status-request:".length));
    const statusTimes = events
      .filter((event) => event.startsWith("status-at:"))
      .map((event) => Number(event.slice("status-at:".length)));
    await recording.cancel();
    await t.test("sends a liveness proof by the five-second cadence", () => {
      assert.equal(statusRequestIds.length >= 2, true);
    });
    await t.test("uses a fresh authenticated request identity", () => {
      assert.equal(new Set(statusRequestIds).size, statusRequestIds.length);
    });
    await t.test("starts proofs on the fixed five-second cadence", () => {
      assert.equal(statusTimes[1] - statusTimes[0] >= 4500 && statusTimes[1] - statusTimes[0] <= 5500, true);
    });
  } finally { await instance.cleanup(); }
});

test("owner-liveness loss remains recoverable without becoming normal success", async (t) => {
  const instance = await harness("owner-liveness-loss");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    const error = await recording.stop().catch((value) => value);
    await t.test("returns the distinct owner-liveness failure", () => {
      assert.equal(error.code, "bridge-owner-liveness-lost");
    });
    await t.test("recovers the retained WAV with the same capability", () => {
      assert.equal(instance.events().includes("fetch"), true);
    });
    await t.test("acknowledges recovered audio for deletion", () => {
      assert.equal(instance.events().includes("acknowledge"), true);
    });
    await t.test("does not expose recovered audio for transcription", () => {
      assert.equal(existsSync(instance.startOptions.destination), false);
    });
  } finally { await instance.cleanup(); }
});

for (const [reason, code] of [
  ["sleep", "bridge-sleep"],
  ["logout", "bridge-logout"],
  ["reboot", "bridge-reboot"],
  ["session-lock", "bridge-session-lock"],
  ["companion-stop", "bridge-companion-stopped"],
  ["companion-restart", "bridge-companion-restarted"],
  ["device-loss", "bridge-device-lost"],
]) {
  test(`the Recorder exposes the distinct ${reason} lifecycle failure`, async () => {
    const instance = await harness(`lifecycle-${reason}`);
    try {
      const recording = await instance.recorder.start(instance.startOptions);
      await new Promise((resolveWait) => setTimeout(resolveWait, 180));
      const error = await recording.stop().catch((value) => value);
      assert.equal(error.code, code);
    } finally { await instance.cleanup(); }
  });
}

test("a new recording fails promptly during reconnect and succeeds after authenticated service returns", async (t) => {
  const instance = await harness();
  let replacement;
  let pendingHealth;
  try {
    instance.child.kill("SIGTERM");
    await once(instance.child, "exit");
    rmSync(instance.socket, { force: true });
    pendingHealth = net.createServer((socket) => socket.destroy());
    await new Promise((resolveListen, reject) => {
      pendingHealth.once("error", reject);
      pendingHealth.listen(instance.socket, resolveListen);
    });
    chmodSync(instance.socket, 0o600);
    const startedAt = Date.now();
    const unavailable = await instance.recorder.start(instance.startOptions).catch((value) => value);
    const unavailableElapsed = Date.now() - startedAt;
    await new Promise((resolveClose) => pendingHealth.close(resolveClose));
    pendingHealth = undefined;
    rmSync(instance.socket, { force: true });
    replacement = fork(companion, [
      instance.socket, Buffer.from(JSON.stringify(instance.credential)).toString("base64"), "valid", instance.eventFile,
    ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await once(replacement, "message");
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.cancel();
    await t.test("classifies reconnect downtime as unavailable", () => {
      assert.equal(unavailable.code, "recorder-unavailable");
    });
    await t.test("fails without waiting for implicit reconnect", () => {
      assert.equal(unavailableElapsed < 1000, true);
    });
    await t.test("starts a new Recording lease after authenticated service returns", () => {
      assert.equal(instance.events().filter((event) => event === "start").length >= 1, true);
    });
  } finally {
    if (pendingHealth) await new Promise((resolveClose) => pendingHealth.close(resolveClose));
    replacement?.kill("SIGTERM");
    if (replacement) await once(replacement, "exit").catch(() => {});
    await instance.cleanup();
  }
});

test("the Bridge recording adapter refuses a Unix socket outside a private directory", async () => {
  const instance = await harness();
  try {
    require("node:fs").chmodSync(resolve(instance.startOptions.destination, "../socket"), 0o755);
    await assert.rejects(instance.recorder.start(instance.startOptions), (error) => error.code === "recording-failed");
  } finally { await instance.cleanup(); }
});
