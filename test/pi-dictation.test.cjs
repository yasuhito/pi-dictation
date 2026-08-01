const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");
const recorderPath = join(packageRoot, "test", "fixtures", "fake-recorder.cjs");
const abruptPiPath = join(packageRoot, "test", "fixtures", "abrupt-pi.cjs");
const extensionPath = join(packageRoot, "extensions", "pi-dictation.ts");
const testHome = mkdtempSync(join(tmpdir(), "pi-dictation-home-"));
process.env.HOME = testHome;

const jiti = createJiti(__filename, { interopDefault: true });
let extensionPromise;

function loadExtension() {
  extensionPromise ??= jiti.import(extensionPath, { default: true });
  return extensionPromise;
}

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for test condition"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function readPids(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunning(pid) {
  if (!isAlive(pid)) return false;
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").match(/^\d+ \(.+\) (\S)/)?.[1];
    return state !== "Z";
  } catch {
    return false;
  }
}

async function createRuntime({
  recorderArgs = "",
  transcribeCommand = "cat {file} >/dev/null; printf voice-ok",
  timeoutMs,
  maxRecordingMs = 10000,
} = {}) {
  const extension = await loadExtension();
  const commands = {};
  const notifications = [];
  let shortcut;
  let shutdown;
  let pasted = "";

  process.env.PI_DICTATION_RECORD_CMD = `${process.execPath} ${recorderPath} {file} ${recorderArgs}`.trim();
  if (transcribeCommand === null) delete process.env.PI_DICTATION_TRANSCRIBE_CMD;
  else process.env.PI_DICTATION_TRANSCRIBE_CMD = transcribeCommand;
  process.env.PI_DICTATION_MAX_RECORDING_MS = String(maxRecordingMs);
  if (timeoutMs === undefined) delete process.env.PI_DICTATION_TIMEOUT_MS;
  else process.env.PI_DICTATION_TIMEOUT_MS = String(timeoutMs);

  const pi = {
    registerShortcut(_key, definition) {
      shortcut = definition.handler;
    },
    registerCommand(name, definition) {
      commands[name] = definition.handler;
    },
    on(event, handler) {
      if (event === "session_shutdown") shutdown = handler;
    },
  };
  const ctx = {
    mode: "tui",
    cwd: packageRoot,
    ui: {
      custom(factory) {
        factory({ requestRender() {} }, {}, {}, () => {});
        return Promise.resolve();
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      pasteToEditor(text) {
        pasted = text;
      },
      setStatus() {},
    },
  };

  extension(pi);
  return {
    commands,
    ctx,
    notifications,
    shortcut,
    shutdown: () => shutdown({}, ctx),
    pasted: () => pasted,
  };
}

function testPaths(name) {
  const dir = mkdtempSync(join(tmpdir(), `pi-dictation-${name}-`));
  return { dir, marker: join(dir, "marker"), pidFile: join(dir, "pids") };
}

test("normal dictation pastes the transcription", async () => {
  const paths = testPaths("normal");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const [pid] = readPids(paths.pidFile);
    await runtime.shortcut(runtime.ctx);
    assert.equal(runtime.pasted(), "voice-ok");
    assert.equal(isRunning(pid), false);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("recordings are created in a private temporary directory", async () => {
  const paths = testPaths("private-temp");
  const recordingPathFile = join(paths.dir, "recording-path");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  process.env.PI_DICTATION_TEST_RECORDING_PATH_FILE = recordingPathFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => existsSync(recordingPathFile));
    const recordingPath = readFileSync(recordingPathFile, "utf8");
    assert.equal(statSync(resolve(recordingPath, "..")).mode & 0o777, 0o700);
  } finally {
    await runtime.shutdown();
    delete process.env.PI_DICTATION_TEST_RECORDING_PATH_FILE;
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("valid JSON with a non-object root reports a configuration error", async () => {
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, "null");
  try {
    const runtime = await createRuntime();
    await runtime.shortcut(runtime.ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /configuration.*object/i);
    await runtime.shutdown();
  } finally {
    rmSync(configPath, { force: true });
  }
});

test("configuration fields with the wrong type are rejected before registration", async () => {
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ shortcut: 42 }));
  try {
    const runtime = await createRuntime();
    await runtime.shortcut(runtime.ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /shortcut must be a string/);
    await runtime.shutdown();
  } finally {
    rmSync(configPath, { force: true });
  }
});

test("invalid transcription timeouts fall back to the default", async () => {
  const paths = testPaths("invalid-timeout");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({
    timeoutMs: -1,
    transcribeCommand: "cat {file} >/dev/null; sleep 0.05; printf voice-ok",
  });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await runtime.shortcut(runtime.ctx);
    assert.equal(runtime.pasted(), "voice-ok");
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("OpenAI transcription pastes the returned text", async () => {
  const paths = testPaths("openai");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  process.env.PI_DICTATION_OPENAI_API_KEY = "test-key";
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ text: "openai-ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const runtime = await createRuntime({ transcribeCommand: null });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await runtime.shortcut(runtime.ctx);
    assert.equal(runtime.pasted(), "openai-ok");
    assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(request.options.headers.Authorization, "Bearer test-key");
  } finally {
    await runtime.shutdown();
    global.fetch = originalFetch;
    delete process.env.PI_DICTATION_OPENAI_API_KEY;
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("an unexpected recorder exit is reported and cleaned up", async () => {
  const paths = testPaths("recorder-exit");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--exit-immediately" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => runtime.notifications.some(({ message }) => /stopped unexpectedly/.test(message)));
    assert.equal(runtime.pasted(), "");
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the external recording limit stops a recorder and its descendants", async () => {
  const paths = testPaths("recording-limit");
  const childPidFile = join(paths.dir, "child-pid");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  process.env.PI_DICTATION_TEST_CHILD_PID_FILE = childPidFile;
  const runtime = await createRuntime({ maxRecordingMs: 1000, recorderArgs: "--spawn-child" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1 && existsSync(childPidFile));
    const [pid] = readPids(paths.pidFile);
    const childPid = Number(readFileSync(childPidFile, "utf8"));
    await waitFor(() => !isRunning(pid) && !isRunning(childPid), 7500);
    assert.equal(isRunning(pid), false);
    assert.equal(isRunning(childPid), false);
  } finally {
    await runtime.shutdown();
    delete process.env.PI_DICTATION_TEST_CHILD_PID_FILE;
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the external watchdog survives an abrupt Pi exit", async () => {
  const paths = testPaths("abrupt-pi");
  const childPidFile = join(paths.dir, "child-pid");
  const harness = spawn(process.execPath, [abruptPiPath], {
    cwd: packageRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      PI_DICTATION_RECORD_CMD: `${process.execPath} ${recorderPath} {file} --ignore-int --spawn-child`,
      PI_DICTATION_TRANSCRIBE_CMD: "printf unused",
      PI_DICTATION_MAX_RECORDING_MS: "1000",
      PI_DICTATION_TEST_PID_FILE: paths.pidFile,
      PI_DICTATION_TEST_CHILD_PID_FILE: childPidFile,
    },
  });
  let recorderPid;
  let childPid;
  try {
    await waitFor(() => existsSync(paths.pidFile) && existsSync(childPidFile));
    [recorderPid] = readPids(paths.pidFile);
    childPid = Number(readFileSync(childPidFile, "utf8"));
    harness.kill("SIGKILL");
    await waitFor(() => harness.exitCode !== null || harness.signalCode !== null);
    await waitFor(() => !isRunning(recorderPid) && !isRunning(childPid), 7500);
    assert.equal(isRunning(recorderPid), false);
    assert.equal(isRunning(childPid), false);
  } finally {
    if (harness.exitCode === null && harness.signalCode === null) harness.kill("SIGKILL");
    for (const pid of [recorderPid, childPid]) {
      if (pid && isRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("rapid repeated toggles do not start a recorder", async () => {
  const paths = testPaths("toggle-race");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await Promise.all([
      runtime.shortcut(runtime.ctx),
      runtime.shortcut(runtime.ctx),
      runtime.shortcut(runtime.ctx),
    ]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    assert.equal(readPids(paths.pidFile).length, 0);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("cancel supersedes transcription already in progress", async () => {
  const paths = testPaths("cancel");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({
    transcribeCommand: `cat {file} >/dev/null; touch ${paths.marker}; sleep 30; printf too-late`,
  });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const stopping = runtime.shortcut(runtime.ctx);
    await waitFor(() => existsSync(paths.marker));
    await runtime.commands["dictate-cancel"]("", runtime.ctx);
    await stopping;
    assert.equal(runtime.pasted(), "");
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("shutdown kills a recorder that ignores SIGINT", async () => {
  const paths = testPaths("stubborn-recorder");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--ignore-int" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const [pid] = readPids(paths.pidFile);
    await runtime.shutdown();
    assert.equal(isAlive(pid), false);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test.after(() => {
  delete process.env.PI_DICTATION_RECORD_CMD;
  delete process.env.PI_DICTATION_TRANSCRIBE_CMD;
  delete process.env.PI_DICTATION_MAX_RECORDING_MS;
  delete process.env.PI_DICTATION_TIMEOUT_MS;
  delete process.env.PI_DICTATION_TEST_PID_FILE;
  delete process.env.PI_DICTATION_TEST_RECORDING_PATH_FILE;
  delete process.env.PI_DICTATION_TEST_CHILD_PID_FILE;
  delete process.env.PI_DICTATION_OPENAI_API_KEY;
  rmSync(testHome, { recursive: true, force: true });
});
