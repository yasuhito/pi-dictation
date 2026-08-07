const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { capability, request } = require("./fixtures/bridge-protocol-client.cjs");

const root = resolve(__dirname, "..");
const source = join(root, "native", "macos-companion", "PiDictationBridge.swift");
const product = "com.yasuhito.pi-dictation.bridge";

function credential() {
  return { id: randomUUID(), secret: randomBytes(32).toString("base64"), createdAt: new Date().toISOString() };
}

function privateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function nativeHarness() {
  const home = mkdtempSync("/tmp/pd-native-");
  const support = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const runtime = join(home, "Library", "Caches", "pi-dictation", "bridge");
  const hosts = join(support, "hosts");
  const executable = join(home, "PiDictationBridge");
  mkdirSync(hosts, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const path of [support, runtime, hosts]) chmodSync(path, 0o700);
  const compiled = spawnSync("swiftc", ["-D", "PI_DICTATION_INTEGRATION_TEST", source, "-o", executable], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
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
  async function launch() {
    let companionError = "";
    child = spawn(executable, [], {
      env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home }, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { companionError += chunk; });
    const deadline = Date.now() + 10000;
    while (!existsSync(socket) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!existsSync(socket)) throw new Error(`native companion did not start: ${companionError.trim()}`);
  }
  async function stop() {
    child.kill("SIGTERM");
    await new Promise((resolveWait) => child.once("exit", resolveWait));
  }
  await launch();
  return {
    home, runtime, socket, primary, owners,
    async restart() {
      await stop();
      await launch();
    },
    stop,
    start: launch,
    async cleanup() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolveWait) => child.once("exit", resolveWait));
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const macOnly = { skip: process.platform !== "darwin" };

test("native companion coordinates concurrent host owners", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const firstLease = capability();
    const secondLease = capability();
    const starts = await Promise.all([
      request(instance.socket, first.credential, "start", { ...firstLease, maxDurationMs: 10000 }),
      request(instance.socket, second.credential, "start", { ...secondLease, maxDurationMs: 10000 }),
    ]);
    await t.test("single-recording arbitration", () => assert.deepEqual(
      starts.map((value) => value.status).sort(), ["busy", "ok"],
    ));
    const winner = starts[0].status === "ok"
      ? { owner: first, lease: firstLease }
      : { owner: second, lease: secondLease };
    const loser = starts[0].status === "busy"
      ? { owner: first, lease: firstLease }
      : { owner: second, lease: secondLease };

    const isolated = await request(instance.socket, loser.owner.credential, "status", winner.lease);
    await t.test("owner isolation", () => assert.equal(isolated.status, "not-found"));

    await request(instance.socket, winner.owner.credential, "cancel", winner.lease);
    await instance.restart();
    const reconnects = await Promise.all([
      request(instance.socket, first.credential, "health", {}),
      request(instance.socket, second.credential, "health", {}),
    ]);
    await t.test("first owner reconnects after companion disconnect", () => assert.equal(reconnects[0].status, "ok"));
    await t.test("second owner reconnects independently", () => assert.equal(reconnects[1].status, "ok"));

    const replacement = credential();
    privateJson(join(first.directory, "credential.next.json"), replacement);
    const [replacementHealth, peerDuringRotation] = await Promise.all([
      request(instance.socket, replacement, "health", {}),
      request(instance.socket, second.credential, "health", {}),
    ]);
    const retiredRequestId = randomUUID();
    const [retired, retiredReplay] = await Promise.all([
      request(instance.socket, first.credential, "credential-revoke-if-idle", {}, retiredRequestId),
      request(instance.socket, first.credential, "credential-revoke-if-idle", {}, retiredRequestId),
    ]);
    const retiredBeforeRestart = await request(
      instance.socket, first.credential, "credential-revoke-if-idle", {}, retiredRequestId,
    );
    await instance.restart();
    const retiredAfterRestart = await request(
      instance.socket, first.credential, "credential-revoke-if-idle", {}, retiredRequestId,
    );
    renameSync(join(first.directory, "credential.next.json"), join(first.directory, "credential.json"));
    const committedHealth = await request(instance.socket, replacement, "health", {});
    await t.test("replacement authenticates during peer activity", () => assert.equal(replacementHealth.status, "ok"));
    await t.test("peer remains healthy during rotation", () => assert.equal(peerDuringRotation.status, "ok"));
    await t.test("retired credential is revoked while idle", () => assert.equal(retired.status, "ok"));
    await t.test("concurrent identical revocation replays its original outcome", () => assert.deepEqual(retiredReplay.payload, retired.payload));
    await t.test("interrupted rotation retries revocation before restart", () => assert.deepEqual(retiredBeforeRestart.payload, retired.payload));
    await t.test("interrupted rotation retries revocation after restart", () => assert.deepEqual(retiredAfterRestart.payload, retired.payload));
    await t.test("replacement authenticates after commit", () => assert.equal(committedHealth.status, "ok"));

    const ownedLease = capability();
    const ownedStart = await request(instance.socket, second.credential, "start", { ...ownedLease, maxDurationMs: 10000 });
    const [revoked, survivingOwner] = await Promise.all([
      request(instance.socket, second.credential, "credential-revoke", {}),
      request(instance.socket, replacement, "health", {}),
    ]);
    await t.test("revoked owner held the recording lease", () => assert.equal(ownedStart.status, "ok"));
    await t.test("revocation reports the active lease", () => assert.equal(revoked.payload.activeRecordingLease, 1));
    await t.test("other owner survives concurrent revocation", () => assert.equal(survivingOwner.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("native companion preserves recording ownership across restart", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    const retainedLease = capability();
    const incompleteLease = capability();
    await request(instance.socket, first.credential, "start", { ...retainedLease, maxDurationMs: 10000 });
    await request(instance.socket, first.credential, "stop", retainedLease);
    await request(instance.socket, second.credential, "start", { ...incompleteLease, maxDurationMs: 10000 });
    await instance.restart();

    const [retainedEffects, incompleteEffects] = await Promise.all([
      request(instance.socket, first.credential, "credential-effects", {}),
      request(instance.socket, second.credential, "credential-effects", {}),
    ]);
    await t.test("preview restores the first owner's retained WAV", () => assert.equal(retainedEffects.payload.retainedWav, 1));
    await t.test("restart clears the second owner's incomplete WAV", () => assert.equal(incompleteEffects.payload.incompleteAudio, 0));

    const firstWav = join(instance.runtime, `recording-${retainedLease.recordingId}.wav`);
    const secondWav = join(instance.runtime, `recording-${incompleteLease.recordingId}.wav`);
    const [revoked, survivor] = await Promise.all([
      request(instance.socket, first.credential, "credential-revoke", {}),
      request(instance.socket, second.credential, "health", {}),
    ]);
    await t.test("revocation reports only the target owner's retained WAV", () => assert.equal(revoked.payload.retainedWav, 1));
    await t.test("revocation deletes the target owner's WAV", () => assert.equal(existsSync(firstWav), false));
    await t.test("restart deletes the other owner's partial WAV", () => assert.equal(existsSync(secondWav), false));
    await t.test("revocation preserves the other owner's credential", () => assert.equal(survivor.status, "ok"));
  } finally { await instance.cleanup(); }
});

test("native companion restores bounded result retention across restart", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first] = instance.owners;
    const scheduledLease = capability();
    await request(instance.socket, first.credential, "start", { ...scheduledLease, maxDurationMs: 10000 });
    await request(instance.socket, first.credential, "stop", scheduledLease);
    await instance.restart();
    const scheduledWav = join(instance.runtime, `recording-${scheduledLease.recordingId}.wav`);
    const restored = existsSync(scheduledWav);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    const removedByRestoredDeadline = !existsSync(scheduledWav);

    const expiredLease = capability();
    await request(instance.socket, first.credential, "start", { ...expiredLease, maxDurationMs: 10000 });
    await request(instance.socket, first.credential, "stop", expiredLease);
    const expiredWav = join(instance.runtime, `recording-${expiredLease.recordingId}.wav`);
    await instance.stop();
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    await instance.start();
    const removedDuringRestart = !existsSync(expiredWav);

    await t.test("restores a result before its deadline", () => assert.equal(restored, true));
    await t.test("schedules only the remaining retention", () => assert.equal(removedByRestoredDeadline, true));
    await t.test("deletes a result whose deadline passed before restart", () => assert.equal(removedDuringRestart, true));
  } finally { await instance.cleanup(); }
});

test("native companion fails closed on duplicate owner identities", macOnly, async (t) => {
  const instance = await nativeHarness();
  try {
    const [first, second] = instance.owners;
    privateJson(join(second.directory, "credential.json"), first.credential);
    const duplicateRejected = await request(instance.socket, first.credential, "health", {}).then(
      () => false,
      () => true,
    );
    await t.test("rejects the unsafe credential snapshot", () => assert.equal(duplicateRejected, true));

    privateJson(join(second.directory, "credential.json"), second.credential);
    const recovered = await request(instance.socket, first.credential, "health", {});
    await t.test("keeps distinct owners usable after correction", () => assert.equal(recovered.status, "ok"));
  } finally { await instance.cleanup(); }
});
