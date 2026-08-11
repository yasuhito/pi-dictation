const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { test } = require("node:test");
const { capability, openSlowLevelSubscription, request, subscribeLevels } = require("./fixtures/bridge-protocol-client.cjs");

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
        PI_DICTATION_PROTOCOL_TEST_LIVENESS_MS: "60000",
        PI_DICTATION_PROTOCOL_TEST_INITIAL_LIVENESS_MS: "60000",
        ...testEnvironment,
        ...(crashPoint ? { PI_DICTATION_PROTOCOL_TEST_CRASH: crashPoint } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { companionError += chunk; });
    const deadline = Date.now() + 10000;
    while (child.exitCode === null && Date.now() < deadline) {
      if (existsSync(socket) && (previousSocket === undefined || lstatSync(socket).ino !== previousSocket)) {
        const ready = await new Promise((resolveReady) => {
          const probe = net.createConnection({ path: socket });
          const timer = setTimeout(() => { probe.destroy(); resolveReady(false); }, 250);
          probe.once("data", () => { clearTimeout(timer); probe.destroy(); resolveReady(true); });
          probe.once("error", () => { clearTimeout(timer); resolveReady(false); });
        });
        if (ready) return;
      }
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
  const instance = await nativeHarness(undefined, {
    PI_DICTATION_PROTOCOL_TEST_INITIAL_LIVENESS_MS: "100",
    PI_DICTATION_PROTOCOL_TEST_LIVENESS_MS: "300",
    PI_DICTATION_PROTOCOL_TEST_FINALIZATION_DELAY_MS: "300",
  });
  try {
    const owner = instance.owners[0].credential;
    const terminalResultWithoutProof = async (lease) => {
      let terminalObservedAt;
      const terminalDeadline = Date.now() + 1500;
      while (Date.now() < terminalDeadline) {
        const observation = await request(instance.socket, owner, "levels", { ...lease, afterSequence: -1 });
        if (observation.status === "invalid-state") {
          terminalObservedAt = Date.now();
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      let result;
      const resultDeadline = Date.now() + 1500;
      while (Date.now() < resultDeadline) {
        result = await request(instance.socket, owner, "status", lease);
        if (result.payload.state === "result-ready") break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      return { result, terminalObservedAt };
    };

    const abandoned = capability();
    await request(instance.socket, owner, "start", { ...abandoned, maxDurationMs: 10000 });
    const { result: lost } = await terminalResultWithoutProof(abandoned);
    const retainedPath = join(instance.runtime, `recording-${abandoned.recordingId}.wav`);

    const live = capability();
    await request(instance.socket, owner, "start", { ...live, maxDurationMs: 10000 });
    await request(instance.socket, owner, "status", live);
    const proofAt = Date.now();
    await new Promise((resolveWait) => setTimeout(resolveWait, 160));
    const afterOriginalDeadline = await request(instance.socket, owner, "levels", { ...live, afterSequence: -1 });
    const { result: refreshed, terminalObservedAt } = await terminalResultWithoutProof(live);
    const elapsedFromProof = terminalObservedAt === undefined ? Number.POSITIVE_INFINITY : terminalObservedAt - proofAt;

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
      assert.equal(afterOriginalDeadline.status, "ok");
    });
    await t.test("records owner-liveness loss after the refreshed proof expires", () => {
      assert.equal(refreshed?.payload.completion, "owner-liveness-loss");
    });
    await t.test("does not overshoot the refreshed owner-liveness bound by a polling interval", () => {
      assert.equal(elapsedFromProof >= 280 && elapsedFromProof < 390, true);
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
    const started = await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 60 * 60 * 1000 });
    if (started.status !== "ok") throw new Error(`level start failed: ${JSON.stringify(started)} metrics=${existsSync(join(instance.runtime, "resource-metrics.json")) ? readFileSync(join(instance.runtime, "resource-metrics.json"), "utf8") : "none"}`);
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
    const reservation = join(instance.runtime, `recording-${lease.recordingId}.reserve`);
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("start disconnects at the injected boundary", () => assert.equal(interrupted, true));
    await t.test("restart attributes the interrupted lease", () => assert.equal(restored.payload.state, "failed"));
    await t.test("restart removes partial audio", () => assert.equal(existsSync(wav), false));
    await t.test("restart releases the interrupted reservation", () => assert.equal(existsSync(reservation), false));
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

test("native companion rotates three private redacted log generations", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_LOG_BYTES: "512" });
  try {
    for (let index = 0; index < 20; index += 1) await instance.restart();
    await instance.stop();
    const paths = ["companion.log", "companion.log.1", "companion.log.2"].map((name) => join(instance.runtime, name));
    const contents = paths.map((path) => readFileSync(path, "utf8")).join("");
    await t.test("keeps active plus two rotated generations", () => assert.equal(paths.every(existsSync), true));
    await t.test("keeps each generation within its configured bound", () => assert.equal(paths.every((path) => lstatSync(path).size <= 512), true));
    await t.test("keeps each generation owner-private", () => assert.equal(paths.every((path) => (lstatSync(path).mode & 0o777) === 0o600), true));
    await t.test("contains only safe structured event fields", () => assert.equal(/recordingId|leaseSecret|credential|hmac|\/Users\//i.test(contents), false));
  } finally { await instance.cleanup(); }
});

test("native companion flushes repeated request errors on normal shutdown", macOnly, async () => {
  const instance = await nativeHarness();
  try {
    for (let index = 0; index < 3; index += 1) {
      const socket = net.createConnection({ path: instance.socket });
      await new Promise((resolveWait, reject) => {
        socket.once("data", () => { socket.destroy(); resolveWait(); });
        socket.once("error", reject);
      });
    }
    await instance.stop();
    const log = readFileSync(join(instance.runtime, "companion.log"), "utf8");
    assert.match(log, /"code":"repeated","count":3/);
  } finally { await instance.cleanup(); }
});

test("native streaming buffers remain fixed as WAV length grows", macOnly, async (t) => {
  const measure = async (dataBytes) => {
    const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_WAV_DATA_BYTES: String(dataBytes) });
    try {
      const owner = instance.owners[0].credential;
      const lease = capability();
      const started = await request(instance.socket, owner, "start", {
        ...lease, maxDurationMs: Math.max(1000, Math.ceil(dataBytes / 32)),
      });
      if (started.status !== "ok") throw new Error(`streaming start failed: ${JSON.stringify(started)} metrics=${existsSync(join(instance.runtime, "resource-metrics.json")) ? readFileSync(join(instance.runtime, "resource-metrics.json"), "utf8") : "none"}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      await request(instance.socket, owner, "stop", lease);
      await request(instance.socket, owner, "fetch", lease);
      return JSON.parse(readFileSync(join(instance.runtime, "resource-metrics.json"), "utf8"));
    } finally { await instance.cleanup(); }
  };
  const short = await measure(3200);
  const long = await measure(30 * 1024 * 1024);
  await t.test("bounds capture processing independently of WAV length", () => assert.equal(
    Math.max(short.capture, long.capture) <= 64 * 1024, true,
  ));
  await t.test("bounds fetch processing independently of WAV length", () => assert.equal(
    Math.max(short.fetch, long.fetch) <= 64 * 1024, true,
  ));
  await t.test("bounds SHA-256 processing independently of WAV length", () => assert.equal(
    Math.max(short.sha256, long.sha256) <= 64 * 1024, true,
  ));
});

test("cleanup-pending audio remains inside storage admission bounds", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    writeFileSync(join(instance.runtime, "test-always-fail-audio-cleanup"), "fail\n");
    const leases = [capability(), capability(), capability()];
    for (const lease of leases.slice(0, 2)) {
      await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 1000 });
      await request(instance.socket, first.credential, "stop", lease);
      await request(instance.socket, first.credential, "cancel", lease);
    }
    const rejected = await request(instance.socket, first.credential, "start", {
      ...leases[2], maxDurationMs: 1000,
    });
    const peer = await request(instance.socket, second.credential, "health", {});
    await t.test("rejects admission while two cleanup-pending WAVs remain", () => assert.equal(rejected.payload.reason, "storage-full"));
    await t.test("keeps another credential healthy during persistent cleanup failure", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("native storage reservations reject a third unexpired result without eviction", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const leases = [capability(), capability(), capability()];
    for (const lease of leases.slice(0, 2)) {
      await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 1000 });
      await request(instance.socket, first.credential, "stop", lease);
    }
    const rejected = await request(instance.socket, first.credential, "start", { ...leases[2], maxDurationMs: 1000 });
    const retained = await request(instance.socket, first.credential, "status", leases[0]);
    const peer = await request(instance.socket, second.credential, "health", {});
    await t.test("reports the bounded storage-full failure", () => assert.deepEqual(
      { status: rejected.status, payload: rejected.payload },
      { status: "failed", payload: { reason: "storage-full" } },
    ));
    await t.test("does not evict an unexpired result", () => assert.equal(retained.payload.state, "result-ready"));
    await t.test("keeps another credential healthy", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("native start physically reserves its maximum result before capture", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    const started = await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 1000 });
    const reservation = join(instance.runtime, `recording-${lease.recordingId}.reserve`);
    const reserved = lstatSync(reservation);
    const filesystem = statfsSync(instance.runtime);
    const availableAfterAdmission = filesystem.bavail * filesystem.bsize;
    await t.test("accepts the start only after reservation succeeds", () => assert.equal(started.status, "ok"));
    await t.test("creates an exact maximum-size reservation artifact", () => assert.equal(reserved.size, 1000 * 32 + 64 * 1024));
    await t.test("physically allocates the reserved capacity", () => assert.equal(reserved.blocks * 512 >= reserved.size, true));
    await t.test("leaves capacity for the separately growing capture", () => assert.equal(availableAfterAdmission >= reserved.size, true));
    await request(instance.socket, owner, "stop", lease);
    await t.test("releases the reservation after a valid result replaces it", () => assert.equal(existsSync(reservation), false));
  } finally { await instance.cleanup(); }
});

test("native startup deletes an owned orphan reservation without touching results", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const orphan = join(instance.runtime, `recording-${randomUUID()}.reserve`);
    writeFileSync(orphan, Buffer.alloc(4096), { mode: 0o600 });
    const owner = instance.owners[0].credential;
    const retainedLease = capability();
    await request(instance.socket, owner, "start", { ...retainedLease, maxDurationMs: 1000 });
    await request(instance.socket, owner, "stop", retainedLease);
    await instance.restart();
    const retained = await request(instance.socket, owner, "status", retainedLease);
    await t.test("deletes the orphan reservation", () => assert.equal(existsSync(orphan), false));
    await t.test("preserves the unexpired completed result", () => assert.equal(retained.payload.state, "result-ready"));
  } finally { await instance.cleanup(); }
});

test("native reservation failure rejects before capture", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_FAIL_RESERVATION: "1" });
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    const rejected = await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 1000 });
    await t.test("returns storage-full when physical preallocation fails", () => assert.equal(rejected.payload.reason, "storage-full"));
    await t.test("creates no WAV after failed preallocation", () => assert.equal(existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`)), false));
    await t.test("removes the failed reservation artifact", () => assert.equal(existsSync(join(instance.runtime, `recording-${lease.recordingId}.reserve`)), false));
  } finally { await instance.cleanup(); }
});

test("native byte reservations reject before capture", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_RETAINED_BYTES: "100000" });
  try {
    const owner = instance.owners[0].credential;
    const retainedLease = capability();
    await request(instance.socket, owner, "start", { ...retainedLease, maxDurationMs: 1000 });
    await request(instance.socket, owner, "stop", retainedLease);
    const rejectedLease = capability();
    const rejected = await request(instance.socket, owner, "start", { ...rejectedLease, maxDurationMs: 1000 });
    await t.test("returns storage-full at the disk-backed byte boundary", () => assert.equal(rejected.payload.reason, "storage-full"));
    await t.test("creates no WAV for a rejected reservation", () => assert.equal(existsSync(join(instance.runtime, `recording-${rejectedLease.recordingId}.wav`)), false));
  } finally { await instance.cleanup(); }
});

test("native finalization deletes non-PCM bytes exceeding the header allowance", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_WAV_JUNK_BYTES: "100000" });
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    const stopped = await request(instance.socket, owner, "stop", lease);
    const status = await request(instance.socket, owner, "status", lease);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await t.test("rejects the oversized finalized header", () => assert.equal(stopped.status, "invalid-state"));
    await t.test("attributes the terminal state as failed", () => assert.equal(status.payload.state, "failed"));
    await t.test("deletes the oversized audio", () => assert.equal(existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`)), false));
  } finally { await instance.cleanup(); }
});

test("native finalization deletes PCM exceeding duration within the header allowance", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_WAV_DATA_BYTES: "40000" });
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 1000 });
    const stopped = await request(instance.socket, owner, "stop", lease);
    const status = await request(instance.socket, owner, "status", lease);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await t.test("rejects the oversized finalized result", () => assert.equal(stopped.status, "invalid-state"));
    await t.test("attributes the terminal state as failed", () => assert.equal(status.payload.state, "failed"));
    await t.test("deletes the oversized audio", () => assert.equal(existsSync(join(instance.runtime, `recording-${lease.recordingId}.wav`)), false));
  } finally { await instance.cleanup(); }
});

test("native companion permits only one fetch per Recording lease", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_FETCH_DELAY_MS: "250" });
  try {
    const owner = instance.owners[0].credential;
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 1000 });
    await request(instance.socket, owner, "stop", lease);
    const first = request(instance.socket, owner, "fetch", lease);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const second = await request(instance.socket, owner, "fetch", lease);
    const completed = await first;
    await t.test("rejects the overlapping fetch", () => assert.equal(second.status, "invalid-state"));
    await t.test("preserves the original fetch", () => assert.equal(completed.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("native total connection load rejects the seventeenth without interference", macOnly, async (t) => {
  const instance = await nativeHarness();
  const sockets = [];
  try {
    const lease = capability();
    await request(instance.socket, instance.owners[0].credential, "start", { ...lease, maxDurationMs: 10000 });
    for (let index = 0; index < 16; index += 1) {
      const socket = net.createConnection({ path: instance.socket });
      await new Promise((resolveWait, reject) => { socket.once("data", resolveWait); socket.once("error", reject); });
      sockets.push(socket);
    }
    const excess = net.createConnection({ path: instance.socket });
    let excessBytes = 0;
    excess.on("data", (chunk) => { excessBytes += chunk.length; });
    await new Promise((resolveWait) => excess.once("close", resolveWait));
    sockets.shift().destroy();
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const existing = await request(instance.socket, instance.owners[0].credential, "status", lease);
    const peer = await request(instance.socket, instance.owners[1].credential, "health", {});
    await t.test("rejects the seventeenth connection before disclosure", () => assert.equal(excessBytes, 0));
    await t.test("keeps the existing Recording lease healthy", () => assert.equal(existing.payload.state, "recording"));
    await t.test("keeps another credential healthy", () => assert.equal(peer.status, "ok"));
  } finally {
    for (const socket of sockets) socket.destroy();
    await instance.cleanup();
  }
});

test("native per-credential load rejects the fifth authenticated connection", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    writeFileSync(join(instance.runtime, "test-delay-start-after-register"), "delay\n");
    const leases = Array.from({ length: 5 }, capability);
    const settledStarts = await Promise.allSettled(leases.map((lease) => request(
      instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 },
    )));
    const starts = settledStarts.map((result) => result.status === "fulfilled" ? result.value.status : "closed");
    const winnerIndex = starts.indexOf("ok");
    const winner = await request(instance.socket, first.credential, "status", leases[winnerIndex]);
    const peer = await request(instance.socket, second.credential, "health", {});
    await t.test("enforces four authenticated connections per credential", () => assert.deepEqual(
      starts.sort(), ["busy", "busy", "busy", "closed", "ok"],
    ));
    await t.test("keeps the winning Recording lease healthy", () => assert.equal(winner.payload.state, "recording"));
    await t.test("does not consume another credential's allowance", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("native slow Level consumer reaches its bound without interference", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, {
    PI_DICTATION_PROTOCOL_TEST_WAV_DATA_BYTES: String(2 * 1024 * 1024),
    PI_DICTATION_PROTOCOL_TEST_SEND_BUFFER_BYTES: "1024",
    PI_DICTATION_PROTOCOL_TEST_LEVEL_WRITE_DELAY_MS: "10",
    PI_DICTATION_PROTOCOL_TEST_LEVEL_START_DELAY_MS: "250",
  });
  let subscriber;
  try {
    const [owner, peerOwner] = instance.owners;
    const lease = capability();
    await request(instance.socket, owner.credential, "start", { ...lease, maxDurationMs: 60 * 60 * 1000 });
    subscriber = await openSlowLevelSubscription(instance.socket, owner.credential, lease);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const metrics = JSON.parse(readFileSync(join(instance.runtime, "resource-metrics.json"), "utf8"));
    const diagnostic = await request(instance.socket, owner.credential, "levels", { ...lease, afterSequence: -1 });
    subscriber.destroy();
    subscriber = undefined;
    const stopped = await request(instance.socket, owner.credential, "stop", lease);
    const peer = await request(instance.socket, peerOwner.credential, "health", {});
    await t.test("fills exactly the fixed live queue", () => assert.equal(metrics.levelQueue, 64));
    await t.test("disconnects the subscriber after the queue fills", () => assert.equal(metrics.levelDisconnect, 1));
    await t.test("bounds the diagnostic Level response before framing", () => assert.equal(diagnostic.payload.observations.length, 64));
    await t.test("finalizes a valid WAV without Level backpressure", () => assert.equal(stopped.payload.state, "result-ready"));
    await t.test("keeps another credential healthy", () => assert.equal(peer.status, "ok"));
  } finally {
    subscriber?.destroy();
    await instance.cleanup();
  }
});

test("native unauthenticated deadline is absolute under slow input", macOnly, async (t) => {
  const instance = await nativeHarness(undefined, { PI_DICTATION_PROTOCOL_TEST_AUTH_DEADLINE_MS: "150" });
  try {
    const socket = net.createConnection({ path: instance.socket });
    await new Promise((resolveWait, reject) => { socket.once("connect", resolveWait); socket.once("error", reject); });
    const startedAt = Date.now();
    const drip = setInterval(() => socket.write(Buffer.from([0])), 25);
    const closed = await new Promise((resolveWait) => socket.once("close", () => resolveWait(Date.now() - startedAt)));
    clearInterval(drip);
    const peer = await request(instance.socket, instance.owners[1].credential, "health", {});
    await t.test("closes drip-fed unauthenticated traffic on the absolute deadline", () => assert.equal(closed >= 100 && closed < 500, true));
    await t.test("keeps another credential healthy after timeout", () => assert.equal(peer.status, "ok"));
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
