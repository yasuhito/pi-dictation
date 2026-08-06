const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { once } = require("node:events");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { capability, request } = require("./fixtures/bridge-protocol-client.cjs");
const { RecordingLeaseReference } = require("./fixtures/recording-lease-reference.cjs");

const companion = resolve(__dirname, "fixtures", "fake-bridge-companion.cjs");
function credential() { return { id: randomUUID(), secret: randomBytes(32).toString("base64") }; }
function normalized(result) {
  return result.payload?.state === undefined ? { status: result.status } : { status: result.status, state: result.payload.state };
}

async function setup(mode = "valid") {
  const directory = mkdtempSync("/tmp/pi-lease-");
  const socketDirectory = join(directory, "socket");
  mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentials = [credential(), credential()];
  const child = fork(companion, [socket, Buffer.from(JSON.stringify(credentials)).toString("base64"), mode], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message");
  return { directory, socket, credentials, child };
}

async function cleanup(instance) {
  instance.child.kill("SIGTERM");
  await once(instance.child, "exit").catch(() => {});
  rmSync(instance.directory, { recursive: true, force: true });
}

async function restart(instance, mode = "valid") {
  instance.child.kill("SIGTERM");
  await once(instance.child, "exit");
  rmSync(instance.socket, { force: true });
  instance.child = fork(companion, [
    instance.socket, Buffer.from(JSON.stringify(instance.credentials)).toString("base64"), mode, "", instance.stateFile,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(instance.child, "message");
}

async function persistentSetup() {
  const instance = await setup();
  instance.stateFile = join(instance.directory, "leases.json");
  await restart(instance);
  return instance;
}

test("two authenticated clients agree with the Recording lease reference model", async (t) => {
  const instance = await setup();
  const model = new RecordingLeaseReference();
  const [owner, competitor] = instance.credentials;
  const first = capability();
  const second = capability();
  const compare = async (credentialValue, operation, payload, requestId = randomUUID()) => {
    const expected = model.apply(credentialValue.id, requestId, operation, payload);
    const actual = await request(instance.socket, credentialValue, operation, payload, requestId);
    return { expected, actual };
  };
  try {
    const start = await compare(owner, "start", { ...first, maxDurationMs: 10000 });
    const busyRequestId = randomUUID();
    const busy = await compare(competitor, "start", { ...second, maxDurationMs: 10000 }, busyRequestId);
    const foreign = await request(instance.socket, competitor, "status", first);
    const foreignOperations = await Promise.all(["levels", "stop", "cancel", "fetch", "acknowledge"].map((operation) =>
      request(instance.socket, competitor, operation, first)));
    const ownerAfterForeignOperations = await request(instance.socket, owner, "status", first);
    const unknown = await request(instance.socket, competitor, "status", capability());
    const wrong = await request(instance.socket, owner, "status", { ...first, leaseSecret: randomBytes(32).toString("base64") });
    const replayId = randomUUID();
    const replayOne = await compare(owner, "status", first, replayId);
    const replayTwo = await compare(owner, "status", first, replayId);
    const conflict = await request(instance.socket, owner, "cancel", first, replayId);
    const stop = await compare(owner, "stop", first);
    const duplicateStop = await compare(owner, "stop", first);
    const busyReplay = await compare(competitor, "start", { ...second, maxDurationMs: 10000 }, busyRequestId);
    const fetch = await compare(owner, "fetch", first);
    const acknowledge = await compare(owner, "acknowledge", first);
    const duplicateAcknowledge = await compare(owner, "acknowledge", first);
    const acknowledgedStatus = await compare(owner, "status", first);
    const nextStart = await compare(competitor, "start", { ...second, maxDurationMs: 10000 });
    const cancel = await compare(competitor, "cancel", second);
    const duplicateCancel = await compare(competitor, "cancel", second);

    await t.test("start creates the reference recording state", () => {
      assert.deepEqual(normalized(start.actual), start.expected);
    });
    await t.test("a competing start returns detail-free busy", () => {
      assert.deepEqual(normalized(busy.actual), busy.expected);
    });
    await t.test("cross-owner access is indistinguishable from an unknown identity", () => {
      assert.deepEqual({ status: foreign.status, payload: foreign.payload }, { status: unknown.status, payload: unknown.payload });
    });
    await t.test("a wrong secret is indistinguishable from an unknown identity", () => {
      assert.deepEqual({ status: wrong.status, payload: wrong.payload }, { status: unknown.status, payload: unknown.payload });
    });
    await t.test("the competing client cannot stop, cancel, fetch, or acknowledge the owner's lease", () => {
      assert.deepEqual({ foreign: foreignOperations.map((result) => result.status), ownerState: ownerAfterForeignOperations.payload.state },
        { foreign: ["not-found", "not-found", "not-found", "not-found", "not-found"], ownerState: "recording" });
    });
    await t.test("same-content request replay preserves the outcome", () => {
      assert.deepEqual(normalized(replayTwo.actual), replayOne.expected);
    });
    await t.test("changed-content request replay is rejected", () => {
      assert.equal(conflict.status, "request-conflict");
    });
    await t.test("stop reaches the reference result-ready state", () => {
      assert.deepEqual(normalized(stop.actual), stop.expected);
    });
    await t.test("duplicate stop is idempotent", () => {
      assert.deepEqual(normalized(duplicateStop.actual), duplicateStop.expected);
    });
    await t.test("a busy request replay cannot later acquire the released slot", () => {
      assert.equal(busyReplay.actual.status, "busy");
    });
    await t.test("fetch is valid only for the reference result-ready state", () => {
      assert.equal(fetch.actual.status, fetch.expected.status);
    });
    await t.test("acknowledgement reaches the reference terminal state", () => {
      assert.deepEqual(normalized(acknowledge.actual), acknowledge.expected);
    });
    await t.test("duplicate acknowledgement is idempotent", () => {
      assert.deepEqual(normalized(duplicateAcknowledge.actual), duplicateAcknowledge.expected);
    });
    await t.test("owner status reports the acknowledged tombstone", () => {
      assert.deepEqual(normalized(acknowledgedStatus.actual), acknowledgedStatus.expected);
    });
    await t.test("result-ready releases the active slot for a reservable start", () => {
      assert.deepEqual(normalized(nextStart.actual), nextStart.expected);
    });
    await t.test("cancel reaches the reference cancelled state", () => {
      assert.deepEqual(normalized(cancel.actual), cancel.expected);
    });
    await t.test("duplicate cancel is idempotent", () => {
      assert.deepEqual(normalized(duplicateCancel.actual), duplicateCancel.expected);
    });
  } finally { await cleanup(instance); }
});

test("concurrent stop and cancel leave the Recording lease cancelled before acknowledgement", async () => {
  const instance = await setup("slow-finalization");
  try {
    const owner = instance.credentials[0];
    const lease = capability();
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    await Promise.all([
      request(instance.socket, owner, "stop", lease),
      request(instance.socket, owner, "cancel", lease),
    ]);
    const status = await request(instance.socket, owner, "status", lease);
    assert.equal(status.payload.state, "cancelled");
  } finally { await cleanup(instance); }
});

test("the simulated companion matches every Recording lease transition row", async (t) => {
  const instance = await setup();
  const owner = instance.credentials[0];
  const states = ["recording", "finalizing", "result-ready", "acknowledged", "cancelled", "expired", "failed"];
  const operations = ["status", "levels", "stop", "fetch", "cancel", "acknowledge"];
  const forceState = (recordingId, state) => new Promise((resolveForce) => {
    const onMessage = (message) => {
      if (message?.forced !== recordingId) return;
      instance.child.off("message", onMessage);
      resolveForce();
    };
    instance.child.on("message", onMessage);
    instance.child.send({ type: "force-state", recordingId, state });
  });
  let previous;
  try {
    for (const state of states) {
      await t.test(`${state} transition row`, async () => {
        const actual = [];
        const expected = [];
        for (const operation of operations) {
          if (previous) await forceState(previous.recordingId, "cancelled");
          const lease = capability();
          await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
          await forceState(lease.recordingId, state);
          const model = new RecordingLeaseReference();
          model.apply(owner.id, randomUUID(), "start", { ...lease, maxDurationMs: 10000 });
          model.force(lease.recordingId, state);
          expected.push(model.apply(owner.id, randomUUID(), operation, lease).status);
          actual.push((await request(instance.socket, owner, operation,
            operation === "levels" ? { ...lease, afterSequence: -1 } : lease)).status);
          previous = lease;
        }
        assert.deepEqual(actual, expected);
      });
    }
  } finally { await cleanup(instance); }
});

test("the Mac duration limit releases the active Recording lease slot", async () => {
  const instance = await setup("mac-duration-early");
  try {
    const owner = instance.credentials[0];
    await request(instance.socket, owner, "start", { ...capability(), maxDurationMs: 100 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    const next = await request(instance.socket, owner, "start", { ...capability(), maxDurationMs: 100 });
    assert.equal(next.status, "ok");
  } finally { await cleanup(instance); }
});

test("storage arbitration agrees with an unreservable reference start", async () => {
  const instance = await setup("storage-full");
  try {
    const owner = instance.credentials[0];
    const lease = capability();
    const model = new RecordingLeaseReference();
    const expected = model.apply(owner.id, randomUUID(), "start", { ...lease, maxDurationMs: 10000 }, { reservable: false });
    const actual = await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    assert.equal(actual.status, expected.status);
  } finally { await cleanup(instance); }
});

test("an unacknowledged completed WAV remains owner-recoverable across companion restart", async (t) => {
  const instance = await persistentSetup();
  const owner = instance.credentials[0];
  const competitor = instance.credentials[1];
  const lease = capability();
  try {
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    await request(instance.socket, owner, "stop", lease);
    await restart(instance);
    const status = await request(instance.socket, owner, "status", lease);
    const fetched = await request(instance.socket, owner, "fetch", lease);
    const foreign = await request(instance.socket, competitor, "fetch", lease);
    await request(instance.socket, owner, "acknowledge", lease);
    await restart(instance);
    const acknowledged = await request(instance.socket, owner, "status", lease);

    await t.test("restores result-ready metadata", () => assert.equal(status.payload.state, "result-ready"));
    await t.test("restores the complete WAV bytes", () => assert.equal(fetched.body.length, fetched.payload.length));
    await t.test("does not disclose the restored lease to another credential", () => assert.equal(foreign.status, "not-found"));
    await t.test("preserves the acknowledgement tombstone", () => assert.equal(acknowledged.payload.state, "acknowledged"));
  } finally { await cleanup(instance); }
});

test("startup converts interrupted active work to an attributable failed tombstone", async (t) => {
  const instance = await persistentSetup();
  const owner = instance.credentials[0];
  const lease = capability();
  try {
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    await restart(instance, "restart-recovery");
    const failed = await request(instance.socket, owner, "status", lease);
    const next = await request(instance.socket, owner, "start", { ...capability(), maxDurationMs: 10000 });
    await t.test("attributes the failed terminal result to its owner", () => assert.equal(failed.payload.state, "failed"));
    await t.test("releases the active slot", () => assert.equal(next.status, "ok"));
  } finally { await cleanup(instance); }
});

test("expiry keeps only an owner-authenticated tombstone before deterministic purge", async (t) => {
  const instance = await persistentSetup();
  const owner = instance.credentials[0];
  const competitor = instance.credentials[1];
  const lease = capability();
  const sendAndWait = (type) => new Promise((resolveMessage) => {
    instance.child.once("message", resolveMessage);
    instance.child.send({ type, recordingId: lease.recordingId });
  });
  try {
    await request(instance.socket, owner, "start", { ...lease, maxDurationMs: 10000 });
    await request(instance.socket, owner, "stop", lease);
    await sendAndWait("expire");
    const expired = await request(instance.socket, owner, "status", lease);
    const foreign = await request(instance.socket, competitor, "status", lease);
    await sendAndWait("purge");
    const purged = await request(instance.socket, owner, "status", lease);
    await t.test("reports expiry only to the owner", () => assert.equal(expired.payload.state, "expired"));
    await t.test("keeps expiry indistinguishable from not-found cross-owner", () => assert.equal(foreign.status, "not-found"));
    await t.test("removes recoverability after tombstone retention", () => assert.equal(purged.status, "not-found"));
  } finally { await cleanup(instance); }
});
