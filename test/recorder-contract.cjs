const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { test } = require("node:test");

function runRecorderContract(name, createHarness) {
  test(`${name} Recorder contract: exposes the recording timeline origin`, async () => {
    const harness = await createHarness();
    const beforeStart = Date.now();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.cancel();
      assert.equal(Number.isFinite(recording.startedAt) && recording.startedAt >= beforeStart && recording.startedAt <= Date.now(), true);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: stop commits the destination`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.stop();
      assert.equal(existsSync(harness.startOptions.destination), true);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: stop commits PCM16 mono WAV`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.stop();
      const wav = readFileSync(harness.startOptions.destination);
      assert.deepEqual(
        { riff: wav.toString("ascii", 0, 4), wave: wav.toString("ascii", 8, 12), code: wav.readUInt16LE(20), channels: wav.readUInt16LE(22), bits: wav.readUInt16LE(34) },
        { riff: "RIFF", wave: "WAVE", code: 1, channels: 1, bits: 16 }
      );
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: stop is idempotent`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.stop();
      await assert.doesNotReject(recording.stop());
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: cancel leaves no destination`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.cancel();
      assert.equal(existsSync(harness.startOptions.destination), false);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: cancel is idempotent`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.cancel();
      await assert.doesNotReject(recording.cancel());
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: cancellation wins before stop acknowledgement`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      const stopping = recording.stop().catch(() => {});
      await recording.cancel();
      await stopping;
      assert.equal(existsSync(harness.startOptions.destination), false);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: cancel after successful stop is a no-op`, async () => {
    const harness = await createHarness();
    try {
      const recording = await harness.recorder.start(harness.startOptions);
      await recording.stop();
      await recording.cancel();
      assert.equal(existsSync(harness.startOptions.destination), true);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${name} Recorder contract: startup abort is classified safely`, async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort();
    try {
      await assert.rejects(
        harness.recorder.start({ ...harness.startOptions, signal: controller.signal }),
        (error) => error.code === "cancelled"
      );
    } finally {
      await harness.cleanup();
    }
  });
}

module.exports = { runRecorderContract };
