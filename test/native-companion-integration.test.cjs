const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = require("node:fs");
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
  const child = spawn(executable, [], {
    env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home }, stdio: ["ignore", "ignore", "pipe"],
  });
  let companionError = "";
  child.stderr.on("data", (chunk) => { companionError += chunk; });
  const deadline = Date.now() + 10000;
  while (!require("node:fs").existsSync(socket) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (!require("node:fs").existsSync(socket)) throw new Error(`native companion did not start: ${companionError.trim()}`);
  return {
    home, socket, primary, owners, child,
    async cleanup() {
      child.kill("SIGTERM");
      await new Promise((resolveWait) => child.once("exit", resolveWait));
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
    const firstStart = await request(instance.socket, first.credential, "start", { ...firstLease, maxDurationMs: 10000 });
    const competingStart = await request(instance.socket, second.credential, "start", { ...secondLease, maxDurationMs: 10000 });
    await t.test("single-recording arbitration", () => assert.deepEqual([firstStart.status, competingStart.status], ["ok", "busy"]));

    const isolated = await request(instance.socket, second.credential, "status", firstLease);
    await t.test("owner isolation", () => assert.equal(isolated.status, "not-found"));

    const reconnects = await Promise.all([
      request(instance.socket, second.credential, "health", {}),
      request(instance.socket, second.credential, "health", {}),
    ]);
    await t.test("independent reconnect", () => assert.deepEqual(reconnects.map((value) => value.status), ["ok", "ok"]));

    await request(instance.socket, first.credential, "cancel", firstLease);
    const replacement = credential();
    privateJson(join(first.directory, "credential.next.json"), replacement);
    const replacementHealth = await request(instance.socket, replacement, "health", {});
    const retired = await request(instance.socket, first.credential, "credential-revoke-if-idle", {});
    renameSync(join(first.directory, "credential.next.json"), join(first.directory, "credential.json"));
    const committedHealth = await request(instance.socket, replacement, "health", {});
    await t.test("safe rotation", () => assert.deepEqual(
      [replacementHealth.status, retired.status, committedHealth.status], ["ok", "ok", "ok"],
    ));

    const ownedLease = capability();
    const ownedStart = await request(instance.socket, second.credential, "start", { ...ownedLease, maxDurationMs: 10000 });
    const revoked = await request(instance.socket, second.credential, "credential-revoke", {});
    const survivingOwner = await request(instance.socket, replacement, "health", {});
    await t.test("scoped revocation", () => assert.deepEqual(
      { started: ownedStart.status, revoked: revoked.payload.activeRecordingLease, survivor: survivingOwner.status },
      { started: "ok", revoked: 1, survivor: "ok" },
    ));
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
