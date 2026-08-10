const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");
const { runRecorderContract } = require("./recorder-contract.cjs");

const packageRoot = resolve(__dirname, "..");
const fixture = join(packageRoot, "test", "fixtures", "fake-recorder.cjs");
const jiti = createJiti(__filename, { interopDefault: true });

async function loadRecorder() {
  return jiti.import(join(packageRoot, "extensions", "recorder.ts"));
}

function environment(platform, commands) {
  return { platform, commandExists: async (command) => commands.includes(command) };
}

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test("Linux prefers pw-record when both recorders are available", async () => {
  const { defaultRecordCommand } = await loadRecorder();
  const command = await defaultRecordCommand("/tmp/voice.wav", environment("linux", ["pw-record", "arecord"]));
  assert.equal(command, "pw-record --format s16 --rate 16000 --channels 1 '/tmp/voice.wav'");
});

test("Linux falls back to arecord", async () => {
  const { defaultRecordCommand } = await loadRecorder();
  const command = await defaultRecordCommand("/tmp/voice.wav", environment("linux", ["arecord"]));
  assert.equal(command, "arecord -q -f S16_LE -r 16000 -c 1 -t wav '/tmp/voice.wav'");
});

test("recorder paths are shell quoted", async () => {
  const { defaultRecordCommand } = await loadRecorder();
  const command = await defaultRecordCommand("/tmp/user's voice.wav", environment("linux", ["pw-record"]));
  assert.equal(command, "pw-record --format s16 --rate 16000 --channels 1 '/tmp/user'\\''s voice.wav'");
});

test("missing local dependencies expose a stable safe classification", async (t) => {
  const { defaultRecordCommand } = await loadRecorder();
  const error = await defaultRecordCommand("/private/user/voice.wav", environment("linux", [])).catch((value) => value);
  await t.test("classifies the failure", () => assert.equal(error.code, "recorder-unavailable"));
  await t.test("does not expose the destination", () => assert.doesNotMatch(error.message, /private|voice\.wav/));
});

test("macOS records audio-only PCM16 mono WAV through FFmpeg AVFoundation", async () => {
  const { defaultRecordCommand } = await loadRecorder();
  const command = await defaultRecordCommand("/tmp/voice.wav", environment("darwin", ["ffmpeg"]));
  assert.equal(command, "ffmpeg -hide_banner -loglevel error -nostdin -f avfoundation -i ':default' -vn -ac 1 -ar 16000 -c:a pcm_s16le -flush_packets 1 -y '/tmp/voice.wav'");
});

test("the local Recorder commits a complete WAV only after stop succeeds", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-recorder-stop-"));
  const destination = join(directory, "recording.wav");
  const { createLocalRecorder } = await loadRecorder();
  const recorder = createLocalRecorder({ command: `${process.execPath} ${fixture} {file} --growing-wav` });
  const observations = [];
  const recording = await recorder.start({ destination, maxDurationMs: 10000, signal: new AbortController().signal, onLevel: (value) => observations.push(value) });
  try {
    await t.test("keeps the destination absent while recording", () => assert.equal(existsSync(destination), false));
    await waitFor(() => observations.length > 0);
    await t.test("reports Level observations", () => assert.equal(typeof observations[0].dbfs, "number"));
    await recording.stop();
    await t.test("commits a RIFF WAV", () => assert.equal(readFileSync(destination, "ascii").slice(0, 4), "RIFF"));
    await t.test("makes repeated stop idempotent", () => assert.doesNotReject(recording.stop()));
  } finally {
    await recording.cancel();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the local Recorder cancellation leaves no transcribable destination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-recorder-cancel-"));
  const destination = join(directory, "recording.wav");
  const { createLocalRecorder } = await loadRecorder();
  const recorder = createLocalRecorder({ command: `${process.execPath} ${fixture} {file}` });
  const recording = await recorder.start({ destination, maxDurationMs: 10000, signal: new AbortController().signal, onLevel() {} });
  await recording.cancel();
  await recording.cancel();
  assert.equal(existsSync(destination), false);
  rmSync(directory, { recursive: true, force: true });
});

for (const scenario of [
  { name: "digitally silent audio", argument: "--zero-wav" },
  { name: "trailing RIFF payload", argument: "--trailing-byte" },
]) {
  test(`the local Recorder rejects ${scenario.name} without committing it`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-dictation-recorder-invalid-"));
    const destination = join(directory, "recording.wav");
    const { createLocalRecorder } = await loadRecorder();
    const recorder = createLocalRecorder({ command: `${process.execPath} ${fixture} {file} ${scenario.argument}` });
    const recording = await recorder.start({ destination, maxDurationMs: 10000, signal: new AbortController().signal, onLevel() {} });
    try {
      const error = await recording.stop().catch((value) => value);
      await t.test("classifies invalid audio", () => assert.equal(error.code, "invalid-audio"));
      await t.test("leaves the destination absent", () => assert.equal(existsSync(destination), false));
    } finally {
      await recording.cancel();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("cancellation wins while local stop is in progress", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-recorder-race-"));
  const destination = join(directory, "recording.wav");
  const { createLocalRecorder } = await loadRecorder();
  const recorder = createLocalRecorder({ command: `${process.execPath} ${fixture} {file} --growing-wav` });
  const recording = await recorder.start({ destination, maxDurationMs: 10000, signal: new AbortController().signal, onLevel() {} });
  const stopping = recording.stop().catch(() => {});
  await recording.cancel();
  await stopping;
  assert.equal(existsSync(destination), false);
  rmSync(directory, { recursive: true, force: true });
});

test("startup abort prevents local external work", async () => {
  const { createLocalRecorder } = await loadRecorder();
  const controller = new AbortController();
  controller.abort();
  const recorder = createLocalRecorder({ command: "PRIVATE_COMMAND" });
  await assert.rejects(
    recorder.start({ destination: "/private/destination.wav", maxDurationMs: 1000, signal: controller.signal, onLevel() {} }),
    (error) => error.code === "cancelled"
  );
});

function contractHarness(recorder) {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-recorder-contract-"));
  return {
    recorder,
    startOptions: {
      destination: join(directory, "recording.wav"),
      maxDurationMs: 10000,
      signal: new AbortController().signal,
      onLevel() {},
    },
    async cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function validWav() {
  const dataBytes = 2000;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(1000, offset);
  return wav;
}

runRecorderContract("local", async () => {
  const { createLocalRecorder } = await loadRecorder();
  return contractHarness(createLocalRecorder({ command: `${process.execPath} ${fixture} {file}` }));
});

runRecorderContract("fake", async () => {
  const { RecorderError } = await loadRecorder();
  const recorder = {
    async start(options) {
      if (options.signal.aborted) throw new RecorderError("cancelled");
      let state = "active";
      return {
        startedAt: Date.now(),
        async stop() {
          if (state === "stopped") return;
          if (state === "cancelled") throw new RecorderError("cancelled");
          state = "stopping";
          await new Promise((resolvePromise) => setImmediate(resolvePromise));
          if (state === "cancelled") throw new RecorderError("cancelled");
          writeFileSync(options.destination, validWav());
          state = "stopped";
        },
        async cancel() {
          if (state === "stopped" || state === "cancelled") return;
          state = "cancelled";
        },
      };
    },
  };
  return contractHarness(recorder);
});
