const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { fork, spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
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
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const state = result.stdout.trim();
  return Boolean(state) && !state.startsWith("Z");
}

async function createRuntime({
  recorderArgs = "",
  transcribeCommand = "cat {file} >/dev/null; printf voice-ok",
  timeoutMs,
  maxRecordingMs = 10000,
  ansiTheme = false,
  recorderConfig,
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

  delete process.env.PI_DICTATION_RECORD_CMD;
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  try {
    const persisted = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
    persisted.recorder = recorderConfig || {
      type: "local",
      command: `${process.execPath} ${recorderPath} {file} ${recorderArgs}`.trim(),
    };
    writeFileSync(configPath, JSON.stringify(persisted));
  } catch {}
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
        throw new Error("dictation must use the above-editor Dictation strip boundary");
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

test("portable process inspection recognizes a running process", () => {
  assert.equal(isRunning(process.pid), true);
});

test("portable process inspection rejects a missing process", () => {
  assert.equal(isRunning(99999999), false);
});

test("the extension registers the focused settings command", async () => {
  const runtime = await createRuntime();
  assert.equal(typeof runtime.commands["dictate-config"], "function");
});

test("recording appears as a responsive above-editor Dictation strip", async (t) => {
  const paths = testPaths("recording-strip");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const [line] = runtime.widget().render(32);
    const expectations = [
      ["registers one widget", () => assert.equal(runtime.widgetCalls.length, 1)],
      ["uses the Dictation widget key", () => assert.equal(runtime.widgetCalls[0].key, "pi-dictation")],
      ["places the widget above the editor", () => assert.deepEqual(runtime.widgetCalls[0].options, { placement: "aboveEditor" })],
      ["fills the available width", () => assert.equal(line.length, 32)],
      ["shows the recording marker and label", () => assert.match(line, /^[● ] REC  /)],
      ["shows level history and elapsed time", () => assert.match(line, /▁+  \d\d:\d\d$/)],
    ];
    for (const [name, expectation] of expectations) await t.test(name, expectation);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("theme styling does not break the responsive Dictation strip width", async (t) => {
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
    await t.test("preserves the requested width", () => {
      assert.equal(plain.length, 32);
    });
    await t.test("preserves the recording prefix", () => {
      assert.match(plain, /^● REC  /);
    });
    await t.test("preserves elapsed time", () => {
      assert.match(plain, /  \d\d:\d\d$/);
    });
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

test("the recording marker fully blinks off after 520 ms without shifting the strip", async (t) => {
  const paths = testPaths("recording-blink");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await waitFor(() => runtime.widget().render(32)[0].startsWith("● REC  "), 1200);
    const on = runtime.widget().render(32)[0];
    await t.test("starts with the marker visible", () => {
      assert.match(on, /^● REC  /);
    });
    await waitFor(() => runtime.widget().render(32)[0].startsWith("  REC  "), 800);
    const off = runtime.widget().render(32)[0];
    await t.test("does not shift while blinking", () => {
      assert.equal(off.length, on.length);
    });
    await t.test("fully hides the marker", () => {
      assert.match(off, /^  REC  /);
    });
    await t.test("requests an animation render", () => {
      assert.ok(runtime.renderRequests() > 0);
    });
  } finally {
    await runtime.shutdown();
    await t.test("removes the widget on shutdown", () => {
      assert.equal(runtime.widget(), undefined);
    });
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

test("the Dictation strip renders actual appended PCM as live level history", async (t) => {
  const paths = testPaths("live-level-history");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--growing-wav" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await waitFor(() => /[▂▃▄▅▆▇█]/.test(runtime.widget().render(32)[0]));
    const fullWidth = runtime.widget().render(32)[0];
    const [minimumWidth] = runtime.widget().render(14);
    await t.test("shows measured levels at full width", () => {
      assert.match(fullWidth, /^[● ] REC  .+  \d\d:\d\d$/);
    });
    await t.test("fits the minimum width", () => {
      assert.equal(visibleWidth(minimumWidth), 14);
    });
    await t.test("drops level history at the minimum width", () => {
      assert.match(minimumWidth, /^[● ] REC {4}\d\d:\d\d$/);
    });
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("missing Level observations return the Dictation strip to the Silent line", async () => {
  const paths = testPaths("missing-level-silent-line");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--growing-wav-one-chunk" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => /[▂▃▄▅▆▇█]/.test(runtime.widget().render(32)[0]));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    assert.match(runtime.widget().render(32)[0], /▁  \d\d:\d\d$/);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the Dictation strip preserves truthful Level slot states", async (t) => {
  const paths = testPaths("truthful-level-slots");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--growing-wav-one-chunk" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const strip = runtime.widget();
    strip.levelObservations.clear();
    strip.startedAt = Date.now() - 110;
    strip.observeLevel({ type: "observation", sequence: 0, capturedAtMs: 0, dbfs: -10 });
    strip.observeLevel({ type: "observation", sequence: 2, capturedAtMs: 100, dbfs: -31 });
    const beforeDelayed = strip.levels.at(-1);
    strip.observeLevel({ type: "observation", sequence: 1, capturedAtMs: 50, dbfs: -10 });
    const afterDelayed = strip.levels.at(-1);
    strip.observeLevel({ type: "unavailable", sequence: 1, capturedAtMs: 50 });
    const conflictDiagnosis = strip.levelDiagnosis;
    strip.observeLevel({ type: "transport", state: "connected" });
    strip.observeLevel({ type: "gap", fromSequence: 3, toSequence: 3 });
    const gapDiagnosis = strip.levelDiagnosis;
    strip.observeLevel({ type: "unavailable", sequence: 4, capturedAtMs: 200 });
    const unavailableDiagnosis = strip.levelDiagnosis;

    await t.test("a missing interval resets smoothing", () => {
      assert.equal(beforeDelayed, 0);
    });
    await t.test("an in-window delayed observation recomputes visible history", () => {
      assert.equal(afterDelayed > beforeDelayed, true);
    });
    await t.test("a conflicting duplicate is rejected diagnostically", () => {
      assert.equal(conflictDiagnosis, "conflicting-duplicate");
    });
    await t.test("a replay gap remains diagnosed after connection", () => {
      assert.equal(gapDiagnosis, "transport-gap");
    });
    await t.test("measurement unavailability remains distinct in diagnosis", () => {
      assert.equal(unavailableDiagnosis, "measurement-unavailable");
    });
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("one Dictation strip transitions through processing, transcribing, ready, and auto-hide", async (t) => {
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
    await t.test("shows processing", () => {
      assert.match(strip.render(32)[0], /Processing recording…/);
    });
    await waitFor(() => existsSync(paths.marker));
    await t.test("shows transcription", () => {
      assert.match(strip.render(32)[0], /Transcribing…/);
    });
    await stopping;
    await t.test("shows completion", () => {
      assert.match(strip.render(32)[0], /✓ Dictation ready/);
    });
    await t.test("reuses one strip", () => {
      assert.equal(runtime.widgetCalls.filter(({ content }) => content).length, 1);
    });
    await waitFor(() => runtime.widget() === undefined, 2000);
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("one simulated Bridge recording crosses the Pi command flow through transcription and cleanup", async (t) => {
  const paths = { dir: mkdtempSync(join("/tmp", "pi-de-")) };
  const socketDirectory = join(paths.dir, "socket");
  require("node:fs").mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentialFile = join(paths.dir, "credential.json");
  const events = join(paths.dir, "events");
  const recordingDirectoryFile = join(paths.dir, "recording-directory");
  const credential = { id: "88888888-8888-4888-8888-888888888888", secret: Buffer.alloc(32, 14).toString("base64") };
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const companion = fork(join(packageRoot, "test", "fixtures", "fake-bridge-companion.cjs"), [
    socket, Buffer.from(JSON.stringify(credential)).toString("base64"), "valid", events,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(companion, "message");
  const runtime = await createRuntime({
    recorderConfig: { type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile },
    transcribeCommand: `dirname {file} > '${recordingDirectoryFile}'; test -f {file}; printf bridge-ok`,
  });
  try {
    await runtime.commands.dictate("", runtime.ctx);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await runtime.commands.dictate("", runtime.ctx);
    await t.test("pastes the Pi-side transcription", () => assert.equal(runtime.pasted(), "bridge-ok"));
    await t.test("acknowledges validated audio for Mac cleanup", () => assert.match(readFileSync(events, "utf8"), /acknowledged/));
    await t.test("deletes Pi temporary audio after transcription", () => assert.equal(existsSync(readFileSync(recordingDirectoryFile, "utf8").trim()), false));
  } finally {
    await runtime.shutdown();
    companion.kill("SIGTERM");
    await once(companion, "exit").catch(() => {});
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a duration-limited Bridge result is never submitted for transcription", async (t) => {
  const paths = { dir: mkdtempSync(join("/tmp", "pi-duration-")) };
  const socketDirectory = join(paths.dir, "socket");
  require("node:fs").mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentialFile = join(paths.dir, "credential.json");
  const events = join(paths.dir, "events");
  const transcriptionMarker = join(paths.dir, "transcribed");
  const credential = { id: "99999999-9999-4999-8999-999999999999", secret: Buffer.alloc(32, 15).toString("base64") };
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const companion = fork(join(packageRoot, "test", "fixtures", "fake-bridge-companion.cjs"), [
    socket, Buffer.from(JSON.stringify(credential)).toString("base64"), "mac-duration-early", events,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(companion, "message");
  const runtime = await createRuntime({
    maxRecordingMs: 1000,
    recorderConfig: { type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile },
    transcribeCommand: `touch '${transcriptionMarker}'; printf should-not-run`,
  });
  try {
    await runtime.commands.dictate("", runtime.ctx);
    await new Promise((resolveWait) => setTimeout(resolveWait, 650));
    await runtime.commands.dictate("", runtime.ctx);
    await t.test("does not invoke the transcription backend", () => assert.equal(existsSync(transcriptionMarker), false));
    await t.test("does not paste transcription output", () => assert.equal(runtime.pasted(), ""));
    await t.test("still acknowledges remote audio cleanup", () => assert.match(readFileSync(events, "utf8"), /acknowledged/));
  } finally {
    await runtime.shutdown();
    companion.kill("SIGTERM");
    await once(companion, "exit").catch(() => {});
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("unconfirmed Bridge cancellation never reaches transcription", async (t) => {
  const paths = { dir: mkdtempSync(join("/tmp", "pi-cancel-risk-")) };
  const socketDirectory = join(paths.dir, "socket");
  require("node:fs").mkdirSync(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "listener.sock");
  const credentialFile = join(paths.dir, "credential.json");
  const events = join(paths.dir, "events");
  const transcriptionMarker = join(paths.dir, "transcribed");
  const credential = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secret: Buffer.alloc(32, 16).toString("base64") };
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const companion = fork(join(packageRoot, "test", "fixtures", "fake-bridge-companion.cjs"), [
    socket, Buffer.from(JSON.stringify(credential)).toString("base64"), "cancel-unconfirmed", events,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(companion, "message");
  const runtime = await createRuntime({
    recorderConfig: { type: "bridge", endpoint: { type: "unix", path: socket }, credentialFile },
    transcribeCommand: `touch '${transcriptionMarker}'; printf should-not-run`,
  });
  try {
    await runtime.commands.dictate("", runtime.ctx);
    await runtime.commands["dictate-cancel"]("", runtime.ctx);
    await t.test("does not invoke the transcription backend", () => assert.equal(existsSync(transcriptionMarker), false));
    await t.test("does not paste transcription output", () => assert.equal(runtime.pasted(), ""));
    await t.test("attempts remote cancellation", () => assert.match(readFileSync(events, "utf8"), /cancel/));
  } finally {
    await runtime.shutdown();
    companion.kill("SIGTERM");
    await once(companion, "exit").catch(() => {});
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("normal dictation pastes the transcription", async (t) => {
  const paths = testPaths("normal");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    const [pid] = readPids(paths.pidFile);
    await runtime.shortcut(runtime.ctx);
    await t.test("pastes the returned text", () => {
      assert.equal(runtime.pasted(), "voice-ok");
    });
    await t.test("stops the recorder", () => {
      assert.equal(isRunning(pid), false);
    });
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

test("valid JSON with a non-object root reports a configuration error", async (t) => {
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, "null");
  try {
    const runtime = await createRuntime();
    await runtime.shortcut(runtime.ctx);
    await t.test("explains the invalid root", () => {
      assert.match(runtime.notifications.at(-1)?.message ?? "", /configuration.*object/i);
    });
    await t.test("shows failure in the strip", () => {
      assert.match(runtime.widget().render(32)[0], /× Dictation failed/);
    });
    await runtime.shutdown();
  } finally {
    rmSync(configPath, { force: true });
  }
});

test("the shipped example configuration loads successfully", async () => {
  const paths = testPaths("example-config");
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, readFileSync(join(packageRoot, "pi-dictation.example.json"), "utf8"));
  const runtime = await createRuntime();
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    await runtime.shortcut(runtime.ctx);
    assert.equal(runtime.pasted(), "voice-ok");
  } finally {
    await runtime.shutdown();
    rmSync(configPath, { force: true });
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("configuration changes during recording apply to the next recording", async () => {
  const paths = testPaths("config-snapshot");
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ transcribeCommand: "printf voice-ok" }));
  const runtime = await createRuntime({ transcribeCommand: null });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => readPids(paths.pidFile).length === 1);
    writeFileSync(configPath, JSON.stringify({ futureMetadata: true }));
    await runtime.shortcut(runtime.ctx);
    assert.equal(runtime.pasted(), "voice-ok");
  } finally {
    await runtime.shutdown();
    rmSync(configPath, { force: true });
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("unknown configuration fields are rejected without exposing their names", async (t) => {
  const configPath = join(testHome, ".pi", "agent", "pi-dictation.json");
  require("node:fs").mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ shortcut: "f8", SUPER_SECRET_FIELD: true }));
  try {
    const runtime = await createRuntime();
    await runtime.shortcut(runtime.ctx);
    const message = runtime.notifications.at(-1)?.message ?? "";
    await t.test("rejects the configuration", () => {
      assert.match(message, /unknown configuration field/i);
    });
    await t.test("does not expose the unknown field name", () => {
      assert.doesNotMatch(message, /SUPER_SECRET_FIELD/);
    });
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

test("transcription timeouts below the schema minimum fall back to the default", async () => {
  const paths = testPaths("invalid-timeout");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({
    timeoutMs: 500,
    transcribeCommand: "cat {file} >/dev/null; sleep 0.6; printf voice-ok",
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

test("OpenAI transcription pastes the returned text", async (t) => {
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
    await t.test("pastes the returned text", () => {
      assert.equal(runtime.pasted(), "openai-ok");
    });
    await t.test("uses the audio transcription endpoint", () => {
      assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
    });
    await t.test("authorizes with the configured key", () => {
      assert.equal(request.options.headers.Authorization, "Bearer test-key");
    });
  } finally {
    await runtime.shutdown();
    global.fetch = originalFetch;
    delete process.env.PI_DICTATION_OPENAI_API_KEY;
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("an unexpected recorder exit is reported and cleaned up", async (t) => {
  const paths = testPaths("recorder-exit");
  process.env.PI_DICTATION_TEST_PID_FILE = paths.pidFile;
  const runtime = await createRuntime({ recorderArgs: "--exit-immediately" });
  try {
    await runtime.shortcut(runtime.ctx);
    await waitFor(() => runtime.notifications.some(({ message }) => /stopped unexpectedly/.test(message)));
    await t.test("shows failure in the strip", () => {
      assert.match(runtime.widget().render(32)[0], /× Dictation failed/);
    });
    await t.test("does not paste a transcript", () => {
      assert.equal(runtime.pasted(), "");
    });
  } finally {
    await runtime.shutdown();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the external recording limit stops a recorder and its descendants", async (t) => {
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
    await t.test("stops the recorder", () => {
      assert.equal(isRunning(pid), false);
    });
    await t.test("stops the recorder descendant", () => {
      assert.equal(isRunning(childPid), false);
    });
  } finally {
    await runtime.shutdown();
    delete process.env.PI_DICTATION_TEST_CHILD_PID_FILE;
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the external watchdog survives an abrupt Pi exit", async (t) => {
  const paths = testPaths("abrupt-pi");
  const childPidFile = join(paths.dir, "child-pid");
  const abruptHome = mkdtempSync(join(tmpdir(), "pi-dictation-abrupt-home-"));
  require("node:fs").mkdirSync(join(abruptHome, ".pi", "agent"), { recursive: true });
  writeFileSync(join(abruptHome, ".pi", "agent", "pi-dictation.json"), JSON.stringify({
    recorder: { type: "local", command: `${process.execPath} ${recorderPath} {file} --ignore-int --spawn-child` },
  }));
  const harness = spawn(process.execPath, [abruptPiPath], {
    cwd: packageRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: abruptHome,
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
    await t.test("stops the recorder", () => {
      assert.equal(isRunning(recorderPid), false);
    });
    await t.test("stops the recorder descendant", () => {
      assert.equal(isRunning(childPid), false);
    });
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
    rmSync(abruptHome, { recursive: true, force: true });
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

test("cancel supersedes transcription already in progress", async (t) => {
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
    await t.test("shows cancellation in the strip", () => {
      assert.match(runtime.widget().render(32)[0], /– Dictation cancelled/);
    });
    await t.test("does not paste late output", () => {
      assert.equal(runtime.pasted(), "");
    });
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
