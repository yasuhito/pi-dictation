const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });

async function loadRecorder() {
  return jiti.import(join(packageRoot, "extensions", "recorder.ts"));
}

function environment(platform, commands) {
  return {
    platform,
    commandExists: async (command) => commands.includes(command),
  };
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

test("Linux reports unavailable recorder dependencies", async () => {
  const { defaultRecordCommand } = await loadRecorder();
  await assert.rejects(
    defaultRecordCommand("/tmp/voice.wav", environment("linux", [])),
    /No recorder found\. Install pw-record\/arecord or set PI_DICTATION_RECORD_CMD\./
  );
});

test("unsupported platforms fail before probing recorder commands", async () => {
  const { defaultRecordCommand } = await loadRecorder();
  await assert.rejects(
    defaultRecordCommand("/tmp/voice.wav", environment("darwin", ["pw-record"])),
    /Unsupported recording platform: darwin/
  );
});
