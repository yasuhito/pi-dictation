const assert = require("node:assert/strict");
const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });

function wavHeader({ format = 1, channels = 1, sampleRate = 16000, bits = 16 } = {}) {
  const blockAlign = channels * (bits / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

function pcm(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

test("the fixed level scale keeps silence gated and preserves speech bands", async () => {
  const { levelForDb } = await jiti.import(join(packageRoot, "extensions", "live-level.ts"));
  assert.deepEqual(
    [-Infinity, -41, -40, -37, -34, -31, -28, -25, -21, -17, -10].map(levelForDb),
    [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7]
  );
});

test("incomplete and unsupported audio input stays on the truthful silent-line fallback", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-fallback-"));
  const file = join(dir, "recording.wav");
  try {
    const { GrowingPcm16WavInput } = await jiti.import(
      join(packageRoot, "extensions", "live-level.ts")
    );
    writeFileSync(file, wavHeader().subarray(0, 24));
    const input = new GrowingPcm16WavInput(file);
    const incompleteSamples = Array.from(await input.readNewestInterval(50));
    await t.test("incomplete input produces no visual samples", () => {
      assert.deepEqual(incompleteSamples, []);
    });
    await t.test("incomplete input remains pending", () => {
      assert.equal(input.state, "pending");
    });

    writeFileSync(file, Buffer.concat([wavHeader({ channels: 2 }), pcm(Array(1600).fill(8000))]));
    const unsupportedSamples = Array.from(await input.readNewestInterval(50));
    await t.test("unsupported input produces no visual samples", () => {
      assert.deepEqual(unsupportedSamples, []);
    });
    await t.test("unsupported input is identified", () => {
      assert.equal(input.state, "unsupported");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("implausible WAV sample rates are rejected before they can amplify allocations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-sample-rate-"));
  const file = join(dir, "recording.wav");
  try {
    const { GrowingPcm16WavInput } = await jiti.import(
      join(packageRoot, "extensions", "live-level.ts")
    );
    writeFileSync(file, Buffer.concat([
      wavHeader({ sampleRate: 1_000_000 }),
      pcm(Array(1000).fill(1000)),
    ]));
    const input = new GrowingPcm16WavInput(file);
    const samples = Array.from(await input.readNewestInterval(50));
    await t.test("implausible input produces no visual samples", () => {
      assert.deepEqual(samples, []);
    });
    await t.test("implausible input is identified as unsupported", () => {
      assert.equal(input.state, "unsupported");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("growing PCM16 mono WAV input drops stale visualization backlog and reads the newest interval", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-level-"));
  const file = join(dir, "recording.wav");
  try {
    const { GrowingPcm16WavInput } = await jiti.import(
      join(packageRoot, "extensions", "live-level.ts")
    );
    writeFileSync(file, Buffer.concat([
      wavHeader(),
      pcm([
        ...Array(800).fill(1000),
        ...Array(800).fill(2000),
        ...Array(800).fill(3000),
      ]),
    ]));

    const input = new GrowingPcm16WavInput(file);
    const newestInitialSamples = Array.from(await input.readNewestInterval(50));
    await t.test("initial read drops stale intervals", () => {
      assert.deepEqual(newestInitialSamples, Array(800).fill(3000));
    });

    appendFileSync(file, pcm(Array(800).fill(4000)));
    const appendedSamples = Array.from(await input.readNewestInterval(50));
    await t.test("next read returns the appended interval", () => {
      assert.deepEqual(appendedSamples, Array(800).fill(4000));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
