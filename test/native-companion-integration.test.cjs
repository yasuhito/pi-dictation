const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { capability, request } = require("./fixtures/bridge-protocol-client.cjs");

const root = resolve(__dirname, "..");
const source = join(root, "native", "macos-companion", "PiDictationBridge.swift");
const product = "com.yasuhito.pi-dictation.bridge";
const macOnly = { skip: process.platform !== "darwin" };

function credential() {
  return { id: randomUUID(), secret: randomBytes(32).toString("base64"), createdAt: new Date().toISOString() };
}

function privateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function nativeHarness(initialCrashPoint) {
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
    "-framework", "AVFoundation", "-framework", "CryptoKit", "-framework", "Security",
    "-framework", "CoreMedia", "-framework", "AudioToolbox"], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout);
  chmodSync(executable, 0o700);
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
    async startAndWaitForCrash(crashPoint) {
      child = spawn(executable, [], {
        env: { ...process.env, PI_DICTATION_PROTOCOL_TEST_ROOT: state, PI_DICTATION_PROTOCOL_TEST_CRASH: crashPoint },
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

test("native companion coordinates independent credential owners", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const lease = capability();
    const started = await request(instance.socket, first.credential, "start", { ...lease, maxDurationMs: 10000 });
    const rejectedId = randomUUID();
    const rejected = await request(instance.socket, first.credential, "credential-revoke-if-idle", {}, rejectedId);
    await request(instance.socket, first.credential, "cancel", lease);
    const replayed = await request(instance.socket, first.credential, "credential-revoke-if-idle", {}, rejectedId);
    const retried = await request(instance.socket, first.credential, "credential-revoke-if-idle", {}, randomUUID());
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("owner holds the active Recording lease", () => assert.equal(started.status, "ok"));
    await t.test("idle revocation rejects owned audio", () => assert.equal(rejected.status, "invalid-state"));
    await t.test("same request identity replays the rejection", () => assert.equal(replayed.status, "invalid-state"));
    await t.test("new request identity can revoke after cleanup", () => assert.equal(retried.status, "ok"));
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
      const peer = await request(instance.socket, second.credential, "health", {});

      await t.test("operation disconnects at the durable cleanup boundary", () => assert.equal(interrupted, true));
      await t.test("restart preserves the terminal state", () => assert.equal(restored.payload.state, scenario.operation === "cancel" ? "cancelled" : "acknowledged"));
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
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("restart completes the expired tombstone", () => assert.equal(restored.payload.state, "expired"));
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
    const peer = await request(instance.socket, second.credential, "health", {});

    await t.test("revocation disconnects at the durable cleanup boundary", () => assert.equal(interrupted, true));
    await t.test("restart replays the successful revocation", () => assert.equal(replay.status, "ok"));
    await t.test("another owner remains usable", () => assert.equal(peer.status, "ok"));
  } finally { await instance.cleanup(); }
});
