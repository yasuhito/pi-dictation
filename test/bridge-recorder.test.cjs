const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
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

async function harness(mode = "valid") {
  const directory = mkdtempSync(join("/tmp", "pi-db-"));
  const socketDirectory = join(directory, "socket");
  mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentialFile = join(directory, "credential.json");
  const credential = {
    id: "77777777-7777-4777-8777-777777777777",
    secret: Buffer.alloc(32, 13).toString("base64"),
  };
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const child = fork(companion, [socket, Buffer.from(JSON.stringify(credential)).toString("base64"), mode], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message");
  const { createRecorder } = await jiti.import(join(root, "extensions", "recorder.ts"));
  return {
    recorder: createRecorder({ type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile }),
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

test("the Recorder transports authenticated Bridge recording Level observations", async () => {
  const instance = await harness();
  const observations = [];
  try {
    const recording = await instance.recorder.start({ ...instance.startOptions, onLevel: (value) => observations.push(value) });
    const deadline = Date.now() + 3000;
    while (observations.length === 0 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await recording.cancel();
    assert.deepEqual(observations[0], { sequence: 0, capturedAtMs: 0, dbfs: -20 });
  } finally { await instance.cleanup(); }
});

for (const [mode, code] of [
  ["early-eof", "invalid-audio"],
  ["oversized", "invalid-audio"],
  ["invalid-wav", "invalid-audio"],
  ["trailing-data", "invalid-audio"],
  ["hash-mismatch", "invalid-audio"],
  ["auth-failure", "recording-failed"],
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

test("the Bridge recording adapter reconciles an ambiguous stop through owner status", async () => {
  const instance = await harness("ambiguous-stop");
  try {
    const recording = await instance.recorder.start(instance.startOptions);
    await recording.stop();
    assert.equal(existsSync(instance.startOptions.destination), true);
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

test("the Bridge recording adapter refuses a Unix socket outside a private directory", async () => {
  const instance = await harness();
  try {
    require("node:fs").chmodSync(resolve(instance.startOptions.destination, "../socket"), 0o755);
    await assert.rejects(instance.recorder.start(instance.startOptions), (error) => error.code === "recording-failed");
  } finally { await instance.cleanup(); }
});
