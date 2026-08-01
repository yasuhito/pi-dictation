const { spawn } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");

const file = process.argv[2];
const ignoreInterrupt = process.argv.includes("--ignore-int");
const exitImmediately = process.argv.includes("--exit-immediately");
const spawnChild = process.argv.includes("--spawn-child");
const growingWav = process.argv.includes("--growing-wav");
const growingWavSilence = process.argv.includes("--growing-wav-silence");

if (growingWav || growingWavSilence) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  writeFileSync(file, header);
  const samples = Buffer.alloc(1600);
  const amplitude = growingWavSilence ? 328 : 8000;
  for (let offset = 0; offset < samples.length; offset += 2) samples.writeInt16LE(amplitude, offset);
  setInterval(() => appendFileSync(file, samples), 30);
} else {
  writeFileSync(file, Buffer.alloc(2048, 1));
}
if (process.env.PI_DICTATION_TEST_PID_FILE) {
  appendFileSync(process.env.PI_DICTATION_TEST_PID_FILE, `${process.pid}\n`);
}
if (process.env.PI_DICTATION_TEST_RECORDING_PATH_FILE) {
  writeFileSync(process.env.PI_DICTATION_TEST_RECORDING_PATH_FILE, file);
}
if (spawnChild) {
  const child = spawn("/bin/sh", ["-c", "trap '' INT TERM HUP; exec sleep 30"], { stdio: "ignore" });
  if (process.env.PI_DICTATION_TEST_CHILD_PID_FILE) {
    writeFileSync(process.env.PI_DICTATION_TEST_CHILD_PID_FILE, String(child.pid));
  }
}

if (exitImmediately) process.exit(2);

process.on("SIGINT", () => {
  if (!ignoreInterrupt) process.exit(0);
});

setInterval(() => {}, 1000);
