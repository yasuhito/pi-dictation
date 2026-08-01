const { spawn } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");

const file = process.argv[2];
const ignoreInterrupt = process.argv.includes("--ignore-int");
const exitImmediately = process.argv.includes("--exit-immediately");
const spawnChild = process.argv.includes("--spawn-child");

writeFileSync(file, Buffer.alloc(2048, 1));
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
