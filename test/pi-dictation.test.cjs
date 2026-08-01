const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { createJiti } = require("jiti");
const { visibleWidth } = require("@earendil-works/pi-tui");

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
  ansiTheme = false,
} = {}) {
  const extension = await loadExtension();
  const commands = {};
  const notifications = [];
  let shortcut;
  let shutdown;
  let pasted = "";
  let widget;
  const widgetCalls = [];
  let renderRequests = 0;

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
      setWidget(key, content, options) {
        widgetCalls.push({ key, content, options });
        if (!content) {
          widget?.dispose?.();
          widget = undefined;
          return;
        }
        widget = content(
          { requestRender() { renderRequests++; } },
          {
            fg(_color, text) { return ansiTheme ? `\u001b[31m${text}\u001b[0m` : text; },
            bold(text) { return ansiTheme ? `\u001b[1m${text}\u001b[0m` : text; },
          }
        );
      },
      setStatus() {
        throw new Error("dictation must not use the footer status boundary");
      },
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
    widget: () => widget,
    widgetCalls,
    renderRequests: () => renderRequests,
  };
}

function testPaths(name) {
  const dir = mkdtempSync(join(tmpdir(), `pi-dictation-${name}-`));
  return { dir, marker: join(dir, "marker"), pidFile: join(dir, "pids") };
}

test("recording appears as a responsive below-editor Dictation strip", async () => {
  const paths = testPaths("recording-strip");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);

    assert.equal(runtime.widgetCalls.length, 1);
    assert.equal(runtime.widgetCalls[0].key, "pi-dictation");
    assert.deepEqual(runtime.widgetCalls[0].options, { placement: "belowEditor" });
    const [line] = runtime.widget().render(32);
    assert.equal(line.length, 32);
    assert.match(line, /^[● ] REC  /);
    assert.match(line, /▁+  \d\d:\d\d$/);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("theme styling does not break the responsive Dictation strip width", async () => {
  const paths = testPaths("styled-width");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ ansiTheme: true });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await waitFor(
      () => runtime.widget().render(32)[0].replace(/\u001b\[[0-9;]*m/g, "").startsWith("● REC  "),
      1200
    );
    const plain = runtime.widget().render(32)[0].replace(/\u001b\[[0-9;]*m/g, "");
    assert.equal(plain.length, 32);
    assert.match(plain, /^● REC  /);
    assert.match(plain, /  \d\d:\d\d$/);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("multi-column spinner frames never exceed the terminal width", async () => {
  const paths = testPaths("spinner-width");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  process.env.PI_DICTATION_SPINNER = "fistBump";
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const stopping = runtime.shortcut(runtime.ctx);
    const [line] = runtime.widget().render(12);
    assert.ok(visibleWidth(line) <= 12, `${JSON.stringify(line)} is ${visibleWidth(line)} columns`);
    await stopping;
  } finally {
    await runtime.shutdown();
    delete process.env.PI_DICTATION_SPINNER;
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the recording marker fully blinks off after 520 ms without shifting the strip", async () => {
  const paths = testPaths("recording-blink");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await waitFor(() => runtime.widget().render(32)[0].startsWith("● REC  "), 1200);
    const on = runtime.widget().render(32)[0];
    assert.match(on, /^● REC  /);
    await waitFor(() => runtime.widget().render(32)[0].startsWith("  REC  "), 800);
    const off = runtime.widget().render(32)[0];
    assert.equal(off.length, on.length);
    assert.match(off, /^  REC  /);
    assert.ok(runtime.renderRequests() > 0);
  } finally {
    await runtime.shutdown();
    assert.equal(runtime.widget(), undefined);
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("valid −40 dBFS microphone silence renders as one thin line", async () => {
  const paths = testPaths("live-silence-line");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--growing-wav-silence" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const plain = runtime.widget().render(32)[0].replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(plain, /^[● ] REC  ▁+  \d\d:\d\d$/);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the Dictation strip renders actual appended PCM as live level history", async () => {
  const paths = testPaths("live-level-history");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--growing-wav" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await waitFor(() => /[▂▃▄▅▆▇█]/.test(runtime.widget().render(32)[0]));
    assert.match(runtime.widget().render(32)[0], /^[● ] REC  .+  \d\d:\d\d$/);
    const [minimumWidth] = runtime.widget().render(14);
    assert.equal(visibleWidth(minimumWidth), 14);
    assert.match(minimumWidth, /^[● ] REC {4}\d\d:\d\d$/);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("one Dictation strip transitions through processing, transcribing, ready, and auto-hide", async () => {
  const paths = testPaths("strip-lifecycle");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({
    transcribeCommand: `cat {file} >/dev/null; touch ${paths.marker}; sleep 0.15; printf voice-ok`,
  });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const strip = runtime.widget();

    const stopping = runtime.shortcut(runtime.ctx);
    assert.match(strip.render(32)[0], /Processing recording…/);
    await waitFor(() => existsSync(paths.marker));
    assert.match(strip.render(32)[0], /Transcribing…/);
    await stopping;
    assert.match(strip.render(32)[0], /✓ Dictation ready/);
    assert.equal(runtime.widgetCalls.filter(({ content }) => content).length, 1);
    await waitFor(() => runtime.widget() === undefined, 2000);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

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
    assert.match(runtime.widget().render(32)[0], /× Dictation failed/);
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
    assert.match(runtime.widget().render(32)[0], /× Dictation failed/);
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
    assert.match(runtime.widget().render(32)[0], /– Dictation cancelled/);
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
