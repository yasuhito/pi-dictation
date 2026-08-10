const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { capability, request, subscribeLevels } = require("./fixtures/bridge-protocol-client.cjs");

const root = resolve(__dirname, "..");
const source = join(root, "native", "macos-companion", "PiDictationBridge.swift");
const watchdogSource = join(root, "native", "macos-companion", "PiDictationDurationWatchdog.swift");
const product = "com.yasuhito.pi-dictation.bridge";
const macOnly = { skip: process.platform !== "darwin" };

function credential() {
  return { id: randomUUID(), secret: randomBytes(32).toString("base64"), createdAt: new Date().toISOString() };
}

function privateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function nativeHarness(initialCrashPoint, testEnvironment = {}) {
  const home = mkdtempSync("/tmp/pdn-");
  const state = join(home, "state");
  const support = join(state, "root");
  const runtime = join(state, "runtime");
  const hosts = join(support, "hosts");
  const executable = join(home, "PiDictationBridge");
  mkdirSync(hosts, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const path of [support, runtime, hosts]) chmodSync(path, 0o700);
  const compiled = spawnSync("swiftc", ["-parse-as-library", "-D", "PROTOCOL_TESTING", source, "-o", executable,
    "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "CryptoKit", "-framework", "Security",
    "-framework", "CoreMedia", "-framework", "AudioToolbox"], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout);
  chmodSync(executable, 0o700);
  const watchdog = spawnSync("swiftc", ["-parse-as-library", watchdogSource, "-o", join(home, "PiDictationDurationWatchdog")], { encoding: "utf8" });
  if (watchdog.status !== 0) throw new Error(watchdog.stderr || watchdog.stdout);
  chmodSync(join(home, "PiDictationDurationWatchdog"), 0o700);
  const installId = randomUUID();
  privateJson(join(support, "ownership.json"), { product, installId });
  privateJson(join(support, "preflight.json"), {
    product, installId, executableSha256: createHash("sha256").update(require("node:fs").readFileSync(executable)).digest("hex"),
  });
  const primary = credential();
  privateJson(join(support, "credential.json"), primary);
  const owners = ["1111111111111111", "2222222222222222"].map((id) => {
    const directory = join(hosts, id);
    mkdirSync(directory, { mode: 0o700 });
    const value = credential();
    privateJson(join(directory, "credential.json"), value);
    return { id, directory, credential: value };
  });
  const socket = join(runtime, "companion.sock");
  let child;
  async function launch(crashPoint) {
    let companionError = "";
    const previousSocket = existsSync(socket) ? lstatSync(socket).ino : undefined;
    child = spawn(executable, [], {
      env: {
        ...process.env,
        PI_DICTATION_PROTOCOL_TEST_ROOT: state,
        ...testEnvironment,
        ...(crashPoint ? { PI_DICTATION_PROTOCOL_TEST_CRASH: crashPoint } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { companionError += chunk; });
    const deadline = Date.now() + 10000;
    while (child.exitCode === null && Date.now() < deadline) {
      if (existsSync(socket) && (previousSocket === undefined || lstatSync(socket).ino !== previousSocket)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(`native companion did not start: ${companionError.trim()}`);
  }
  async function stop() {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolveWait) => child.once("exit", resolveWait));
  }
  await launch(initialCrashPoint);
  return {
    home, runtime, socket, primary, owners,
    async restart(crashPoint) { await stop(); await launch(crashPoint); },
    stop,
    start: launch,
    signal(value) { child.kill(value); },
    async startAndWaitForCrash(crashPoint) {
      child = spawn(executable, [], {
        env: { ...process.env, PI_DICTATION_PROTOCOL_TEST_ROOT: state, ...testEnvironment, PI_DICTATION_PROTOCOL_TEST_CRASH: crashPoint },
        stdio: ["ignore", "ignore", "pipe"],
      });
      await new Promise((resolveWait) => child.once("exit", resolveWait));
    },
    async waitForExit() {
      if (child.exitCode !== null) return true;
      const exited = await Promise.race([
        new Promise((resolveWait) => child.once("exit", () => resolveWait(true))),
        new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2000)),
      ]);
      if (!exited) await stop();
      return exited;
    },
    async cleanup() { await stop(); rmSync(home, { recursive: true, force: true }); },
  };
}

async function disconnects(promise) {
  return promise.then(() => false, () => true);
}

for (const lifecycle of [
  { name: "sleep", signal: "SIGTSTP", restarts: false },
  { name: "logout", signal: "SIGHUP", restarts: true },
  { name: "reboot", signal: "SIGQUIT", restarts: true },
  { name: "session-lock", signal: "SIGUSR2", restarts: false },
  { name: "companion-stop", signal: "SIGTERM", restarts: true },
  { name: "device-loss", signal: "SIGWINCH", restarts: false },
]) {
  test(`native lifecycle fault injection reports ${lifecycle.name} without retained audio`, macOnly, async (t) => {
    const instance = await nativeHarness();
    try {
      const owner = instance.owners[0].credential;
      const lease = capability();
      await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
      instance.signal(lifecycle.signal);
      if (lifecycle.restarts) {
        await instance.waitForExit();
        await instance.start();
      } else {
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
      const result = await request(instance.socket, owner, "status", lease);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const afterRecoveryEvent = await request(instance.socket, owner, "status", lease);
      const audioPath = join(instance.runtime, `recording-${lease.recordingId}.wav`);
      await t.test("returns the distinct owner-visible failure reason", () => {
        assert.equal(result.payload.reason, lifecycle.name);
      });
      await t.test("deletes incomplete captured audio", () => {
        assert.equal(existsSync(audioPath), false);
      });
      await t.test("never resumes the interrupted Recording lease automatically", () => {
        assert.equal(afterRecoveryEvent.payload.state, "failed");
      });
    } finally { await instance.cleanup(); }
  });
}

test("capture initialization failure is attributable and leaves no audio", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_FAIL_CAPTURE: "1" });
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    const started = await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    const result = await request(instance.socket, owner, "status", lease);
    const audioPath = join(instance.runtime, `recording-${lease.recordingId}.wav`);
    await t.test("rejects the failed start", () => {
      assert.equal(started.status, "failed");
    });
    await t.test("reports capture-failure to the owner", () => {
      assert.equal(result.payload.reason, "capture-failure");
    });
    await t.test("leaves no incomplete audio", () => {
      assert.equal(existsSync(audioPath), false);
    });
  } finally { await instance.cleanup(); }
});

test("abrupt companion restart is distinctly attributed and never resumes capture", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    instance.signal("SIGKILL");
    await instance.waitForExit();
    await instance.start();
    const result = await request(instance.socket, owner, "status", lease);
    const audioPath = join(instance.runtime, `recording-${lease.recordingId}.wav`);
    await t.test("reports companion-restart distinctly", () => {
      assert.equal(result.payload.reason, "companion-restart");
    });
    await t.test("deletes interrupted audio during restart recovery", () => {
      assert.equal(existsSync(audioPath), false);
    });
    await t.test("keeps the interrupted lease terminal", () => {
      assert.equal(result.payload.state, "failed");
    });
  } finally { await instance.cleanup(); }
});

test("production companion launches its instance-bound watchdog on the capture deadline", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, {
    PI_DICTATION_PROTOCOL_TEST_USE_WATCHDOG: "1",
    PI_DICTATION_PROTOCOL_TEST_POST_CAPTURE_DELAY_MS: "350",
  });
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    const startedAt = Date.now();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 1000 });
    let result;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      result = await request(instance.socket, owner, "status", lease);
      if (result.payload.state === "result-ready") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const elapsed = Date.now() - startedAt;
    const health = await request(instance.socket, owner, "health", {});
    await t.test("enforces duration relative to capture start rather than helper launch", () => {
      assert.equal(elapsed >= 900 && elapsed < 1250, true);
    });
    await t.test("routes the instance-token request through normal duration finalization", () => {
      assert.equal(result.payload.completion, "duration-limit");
    });
    await t.test("terminates the acknowledged helper without killing the companion", () => {
      assert.equal(health.status, "ok");
    });
  } finally { await instance.cleanup(); }
});

test("native companion enforces authenticated owner liveness independently", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_LIVENESS_MS: "300" });
  try {
    const owner = instance.owners[0].credential;
    const abandoned = capability();
    await request(instance.socket, owner, "start", { ...abandoned, maxDurationMs: 10000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    const lost = await request(instance.socket, owner, "status", abandoned);
    const retainedPath = join(instance.runtime, `recording-${abandoned.recordingId}.wav`);

    const live = capability();
    await request(instance.socket, owner, "start", { ...live, maxDurationMs: 10000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 130));
    await request(instance.socket, owner, "status", live);
    const proofAt = Date.now();
    await new Promise((resolveWait) => setTimeout(resolveWait, 340));
    const refreshed = await request(instance.socket, owner, "status", live);
    const elapsedFromProof = Date.now() - proofAt;

    await t.test("ends capture after the owner-proof deadline", () => {
      assert.equal(lost.payload.state, "result-ready");
    });
    await t.test("records owner-liveness loss instead of normal success", () => {
      assert.equal(lost.payload.completion, "owner-liveness-loss");
    });
    await t.test("retains the finalized WAV under normal retention", () => {
      assert.equal(existsSync(retainedPath), true);
    });
    await t.test("reschedules exact expiry from the most recent owner proof", () => {
      assert.equal(refreshed.payload.completion, "owner-liveness-loss");
    });
    await t.test("does not overshoot the refreshed owner-liveness bound by a polling interval", () => {
      assert.equal(elapsedFromProof < 390, true);
    });
  } finally { await instance.cleanup(); }
});

test("native companion streams capture-time RMS from recorded PCM", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    const subscription = await subscribeLevels(instance.socket, owner, lease);
    const event = subscription.events[0];
    await t.test("authenticates the Level subscription", () => {
      assert.equal(subscription.status, "ok");
    });
    await t.test("reports the fixed interval", () => {
      assert.equal(subscription.bounds.intervalMs, 50);
    });
    await t.test("starts the per-recording sequence at zero", () => {
      assert.equal(event?.sequence, 0);
    });
    await t.test("uses a monotonic capture-time offset", () => {
      assert.equal(event?.capturedAtMs, 0);
    });
    await t.test("computes unmodified RMS dBFS from the recorded PCM", () => {
      assert.equal(Math.round(event?.dbfs * 1000) / 1000, -28.725);
    });
  } finally { await instance.cleanup(); }
});

test("native Level subscription receives an authenticated terminal event", macOnly, async () => {
  const instance = await nativeHarness();
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    const subscription = subscribeLevels(instance.socket, owner, lease, 100);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await request(instance.socket, owner, "cancel", lease);
    assert.deepEqual((await subscription).terminal, { type: "terminal", state: "cancelled" });
  } finally { await instance.cleanup(); }
});

test("exact Level subscription retry replaces the prior connection and replays", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    const requestId = randomUUID();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    const first = await subscribeLevels(instance.socket, owner, lease, 1, requestId);
    const replacement = await subscribeLevels(instance.socket, owner, lease, 1, requestId);
    await t.test("delivers the original authenticated subscription", () => {
      assert.equal(first.events[0]?.sequence, 0);
    });
    await t.test("replays retained observations to the exact retry", () => {
      assert.equal(replacement.events[0]?.sequence, 0);
    });
  } finally { await instance.cleanup(); }
});

test("native companion coordinates independent credential owners", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    const priorHealthId = randomUUID();
    await request(instance.socket, first.credential, "health", {}, priorHealthId);
    const started = await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
    const rejectedId = randomUUID();
    const rejected = await request(instance.socket, first.credential, "credential-revoke-if-idle", {}, rejectedId);
    await request(instance.socket, first.credential, "cancel", lease);
    const replayed = await request(instance.socket, first.credential, "credential-revoke-if-idle", {}, rejectedId);
    const retried = await request(instance.socket, first.credential, "credential-revoke-if-idle", {}, randomUUID());
    const oldHealthReplay = await request(instance.socket, first.credential, "health", {}, priorHealthId);
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("owner holds the active Recording lease", () => assert.equal(started.status, "ok"));
    await t.test("idle revocation rejects owned audio", () => assert.equal(rejected.status, "invalid-state"));
    await t.test("same request identity replays the rejection", () => assert.equal(replayed.status, "invalid-state"));
    await t.test("new request identity can revoke after cleanup", () => assert.equal(retried.status, "ok"));
    await t.test("revoked owner cannot replay an earlier health request", () => assert.equal(oldHealthReplay.status, "not-found"));
    await t.test("another owner remains usable", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("terminal cleanup failure does not block unrelated owners", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
    writeFileSync(join(instance.runtime, "test-fail-audio-cleanup"), "fail once\n");
    const cancelled = await request(instance.socket, first.credential, "cancel", lease);
    const cleanupFailureInjected = !existsSync(join(instance.runtime, "test-fail-audio-cleanup"));
    const pendingEffects = await request(instance.socket, first.credential, "credential-effects", {});
    const peer = await request(instance.socket, second.credential, "health", {});
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    const wavAbsent = !existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`));

    await t.test("injects one audio cleanup failure", () => assert.equal(cleanupFailureInjected, true));
    await t.test("accepted cancellation keeps its terminal outcome", () => assert.equal(cancelled.status, "ok"));
    await t.test("preview reports cleanup-pending audio", () => assert.equal(pendingEffects.payload.incompleteAudio, 1));
    await t.test("another owner remains usable during cleanup retry", () => assert.equal(peer.status, "ok"));
    await t.test("cleanup retry removes the WAV", () => assert.equal(wavAbsent, true));
  } finally { await instance.cleanup(); }
});

test("native companion overlaps multi-owner arbitration, reconnect, rotation, and revocation", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const firstLease = capability();
    const secondLease = capability();
    const starts = await Promise.all([
      request(instance.socket, first.credential, "start", { ...firstLease, maxDurationMs: 10000 }),
      request(instance.socket, second.credential, "start", { ...secondLease, maxDurationMs: 10000 }),
    ]);
    const winner = starts[0].status === "ok" ? { owner: first, lease: firstLease } : { owner: second, lease: secondLease };
    const loser = starts[0].status === "busy" ? { owner: first, lease: firstLease } : { owner: second, lease: secondLease };
    const isolated = await request(instance.socket, loser.owner.credential, "status", winner.lease);
    await request(instance.socket, winner.owner.credential, "cancel", winner.lease);
    await instance.restart();
    const reconnects = await Promise.all([
      request(instance.socket, first.credential, "health", {}),
      request(instance.socket, second.credential, "health", {}),
    ]);
    const retainedLease = capability();
    await request(instance.socket, second.credential, "start", { ...retainedLease, maxDurationMs: 10000 });
    await request(instance.socket, second.credential, "stop", retainedLease);
    const replacement = credential();
    privateJson(join(first.directory, "credential.next.json"), replacement);
    const [replacementHealth, peerDuringRotation] = await Promise.all([
      request(instance.socket, replacement, "health", {}),
      request(instance.socket, second.credential, "health", {}),
    ]);
    const [revoked, replacementAfterRevocation, retainedPeer] = await Promise.all([
      request(instance.socket, first.credential, "credential-revoke-if-idle", {}),
      request(instance.socket, replacement, "health", {}),
      request(instance.socket, second.credential, "status", retainedLease),
    ]);

    await t.test("concurrent starts preserve single-recording arbitration", () => assert.deepEqual(starts.map((value) => value.status).sort(), ["busy", "ok"]));
    await t.test("competing owner cannot inspect the Recording lease", () => assert.equal(isolated.status, "not-found"));
    await t.test("first owner reconnects after companion restart", () => assert.equal(reconnects[0].status, "ok"));
    await t.test("second owner reconnects independently", () => assert.equal(reconnects[1].status, "ok"));
    await t.test("replacement credential authenticates during peer activity", () => assert.equal(replacementHealth.status, "ok"));
    await t.test("peer remains healthy during rotation", () => assert.equal(peerDuringRotation.status, "ok"));
    await t.test("idle owner revocation succeeds", () => assert.equal(revoked.status, "ok"));
    await t.test("replacement remains usable after old credential revocation", () => assert.equal(replacementAfterRevocation.status, "ok"));
    await t.test("peer retained WAV survives scoped revocation", () => assert.equal(retainedPeer.payload.state, "result-ready"));
  } finally { await instance.cleanup(); }
});

test("revocation wins over a start already registered for the same owner", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    writeFileSync(join(instance.runtime, "test-delay-start-after-register"), "delay\n");
    const startPromise = request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const revoked = await request(instance.socket, first.credential, "credential-revoke", {});
    const started = await startPromise;
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("revocation commits while start dispatch is delayed", () => assert.equal(revoked.status, "ok"));
    await t.test("registered start cannot create audio after revocation", () => assert.equal(started.status, "not-found"));
    await t.test("another owner remains usable", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("start reserves partial audio ownership before WAV creation", macOnly, async (t) => {
  const instance = await nativeHarness("start-after-reservation");
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    const interrupted = await disconnects(request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 }));
    await instance.waitForExit();
    await instance.start();
    const restored = await request(instance.socket, first.credential, "status", lease);
    const wav = join(instance.runtime, `recording-${lease.recordingId}.wav`);
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("start disconnects at the injected boundary", () => assert.equal(interrupted, true));
    await t.test("restart attributes the interrupted lease", () => assert.equal(restored.payload.state, "failed"));
    await t.test("restart removes partial audio", () => assert.equal(existsSync(wav), false));
    await t.test("another owner remains usable after recovery", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

for (const scenario of [
  { name: "acknowledgement", operation: "acknowledge", crash: "acknowledge-after-audio-delete", prepare: "result" },
  { name: "cancellation", operation: "cancel", crash: "cancel-after-audio-delete", prepare: "recording" },
]) {
  test(`${scenario.name} cleanup survives a crash after WAV deletion`, macOnly, async (t) => {
    const instance = await nativeHarness();
    try {
      const [first, second] = instance.owners;
      const lease = capability();
      await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
      if (scenario.prepare === "result") await request(instance.socket, first.credential, "stop", lease);
      writeFileSync(join(instance.runtime, "test-crash-point"), `${scenario.crash}\n`);
      const interrupted = await disconnects(request(instance.socket, first.credential, scenario.operation, lease));
      await instance.waitForExit();
      await instance.start();
      const restored = await request(instance.socket, first.credential, "status", lease);
      const wavAbsent = !existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`));
      const peer = await request(instance.socket, second.credential, "health", {});

      await t.test("operation disconnects at the durable cleanup boundary", () => assert.equal(interrupted, true));
      await t.test("restart preserves the terminal state", () => assert.equal(restored.payload.state, scenario.operation === "cancel" ? "cancelled" : "acknowledged"));
      await t.test("restart preserves WAV deletion", () => assert.equal(wavAbsent, true));
      await t.test("another owner remains usable", () => assert.equal(peer.status, "ok"));
    } finally { await instance.cleanup(); }
  });
}

test("retention expiry cleanup survives a crash after WAV deletion", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
    await request(instance.socket, first.credential, "stop", lease);
    await instance.stop();
    const metadataPath = join(instance.runtime, `recording-${lease.recordingId}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    privateJson(metadataPath, { ...metadata, terminalAt: Date.now() / 1000 - 601 });
    await instance.startAndWaitForCrash("retention-after-audio-delete");
    await instance.start();
    const restored = await request(instance.socket, first.credential, "status", lease);
    const wavAbsent = !existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`));
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("restart completes the expired tombstone", () => assert.equal(restored.payload.state, "expired"));
    await t.test("restart preserves expired WAV deletion", () => assert.equal(wavAbsent, true));
    await t.test("another owner remains usable", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("owner revocation cleanup survives a crash after WAV deletion", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
    await request(instance.socket, first.credential, "stop", lease);
    writeFileSync(join(instance.runtime, "test-crash-point"), "revoke-after-audio-delete\n");
    const requestId = randomUUID();
    const interrupted = await disconnects(request(instance.socket, first.credential, "credential-revoke", {}, requestId));
    await instance.waitForExit();
    await instance.start();
    const replay = await request(instance.socket, first.credential, "credential-revoke", {}, requestId);
    const wavAbsent = !existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`));
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("revocation disconnects at the durable cleanup boundary", () => assert.equal(interrupted, true));
    await t.test("restart replays the successful revocation", () => assert.equal(replay.status, "ok"));
    await t.test("restart preserves revoked WAV deletion", () => assert.equal(wavAbsent, true));
    await t.test("another owner remains usable", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});
