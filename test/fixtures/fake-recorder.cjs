const { spawn } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");

const file = process.argv[2];
const ignoreInterrupt = process.argv.includes("--ignore-int");
const exitImmediately = process.argv.includes("--exit-immediately");
const spawnChild = process.argv.includes("--spawn-child");
const growingWav = process.argv.includes("--growing-wav");
const growingWavSilence = process.argv.includes("--growing-wav-silence");
const growingWavOneChunk = process.argv.includes("--growing-wav-one-chunk");
const zeroWav = process.argv.includes("--zero-wav");
const trailingByte = process.argv.includes("--trailing-byte");

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
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
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

let dataBytes = 2000;
if (growingWav || growingWavSilence || growingWavOneChunk) {
  const header = wavHeader(0xffffffff - 36);
  header.writeUInt32LE(0xffffffff, 4);
  header.writeUInt32LE(0xffffffff, 40);
  writeFileSync(file, header);
  dataBytes = 0;
  const samples = Buffer.alloc(1600);
  const amplitude = growingWavSilence ? 328 : 8000;
  for (let offset = 0; offset < samples.length; offset += 2) samples.writeInt16LE(amplitude, offset);
  if (growingWavOneChunk) {
    appendFileSync(file, samples);
    dataBytes += samples.length;
  } else {
    setInterval(() => {
      appendFileSync(file, samples);
      dataBytes += samples.length;
    }, 30);
  }
} else {
  const samples = Buffer.alloc(dataBytes);
  if (!zeroWav) {
    for (let offset = 0; offset < samples.length; offset += 2) samples.writeInt16LE(1000, offset);
  }
  const wav = Buffer.concat([wavHeader(dataBytes), samples]);
  writeFileSync(file, trailingByte ? Buffer.concat([wav, Buffer.from([1])]) : wav);
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
  if (!ignoreInterrupt) {
    if (growingWav || growingWavSilence || growingWavOneChunk) {
      const header = wavHeader(dataBytes);
      const fd = require("node:fs").openSync(file, "r+");
      require("node:fs").writeSync(fd, header, 0, header.length, 0);
      require("node:fs").closeSync(fd);
    }
    process.exit(0);
  }
});

setInterval(() => {}, 1000);
