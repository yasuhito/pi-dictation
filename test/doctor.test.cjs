const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const packageRoot = resolve(__dirname, "..");
const doctorPath = join(packageRoot, "bin", "pi-dictation-doctor.mjs");

function runDoctor({ config, env = {}, path = "/nonexistent" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-doctor-"));
  if (config !== undefined) {
    const configDir = join(home, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "pi-dictation.json"), config);
  }

  const result = spawnSync(process.execPath, [doctorPath], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: path,
      ...env,
    },
  });
  rmSync(home, { recursive: true, force: true });
  return result;
}

test("package exposes the doctor executable", async (t) => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

  await t.test("maps the public command to the doctor script", () => {
    assert.equal(manifest.bin?.["pi-dictation-doctor"], "bin/pi-dictation-doctor.mjs");
  });
  await t.test("ships the bin directory", () => {
    assert.ok(manifest.files.includes("bin"));
  });
});

test("doctor reports a ready custom setup without exposing commands or API keys", async (t) => {
  const result = runDoctor({
    env: {
      PI_DICTATION_RECORD_CMD: "capture --token recorder-secret {file}",
      PI_DICTATION_TRANSCRIBE_CMD: "transcribe --token transcript-secret {file}",
      PI_DICTATION_OPENAI_API_KEY: "openai-secret",
    },
  });

  const expectations = [
    ["exits successfully", () => assert.equal(result.status, 0, result.stderr || result.stdout)],
    ["identifies the report", () => assert.match(result.stdout, /Pi Dictation doctor/)],
    ["reports Node", () => assert.match(result.stdout, /Node: ok \(v\d+\./)],
    ["reports Pi", () => assert.match(result.stdout, /Pi: ok \(.+\)/)],
    ["reports Linux", () => assert.match(result.stdout, /Platform: ok \(linux\)/)],
    ["reports the optional config as absent", () => assert.match(result.stdout, /Config: ok \(not found; defaults and environment used\)/)],
    ["reports a custom recorder", () => assert.match(result.stdout, /Recorder: ok \(custom command configured\)/)],
    ["reports the requested backend", () => assert.match(result.stdout, /Backend requested: custom command/)],
    ["reports the effective backend", () => assert.match(result.stdout, /Backend effective: ok \(custom command configured\)/)],
    ["reports the credential source", () => assert.match(result.stdout, /OpenAI credential: present \(PI_DICTATION_OPENAI_API_KEY\)/)],
    ["reports readiness", () => assert.match(result.stdout, /Result: ready/)],
    ["redacts commands and secrets", () => assert.doesNotMatch(result.stdout, /recorder-secret|transcript-secret|openai-secret|capture|transcribe --token/)],
  ];
  for (const [name, expectation] of expectations) await t.test(name, expectation);
});

test("doctor reports malformed configuration without exposing its contents", async (t) => {
  const result = runDoctor({ config: "SUPER_SECRET_NOT_JSON" });

  await t.test("exits unsuccessfully", () => {
    assert.equal(result.status, 1);
  });
  await t.test("identifies the configuration as invalid", () => {
    assert.match(result.stdout, /Config: invalid \(~\/.pi\/agent\/pi-dictation.json:/);
  });
  await t.test("does not echo malformed configuration contents", () => {
    assert.doesNotMatch(result.stdout, /SUPER_SECRET_NOT_JSON|SUPER_SECR/);
  });
});

test("doctor tolerates unknown configuration fields", () => {
  const result = runDoctor({ config: JSON.stringify({ futureMetadata: true }) });
  assert.match(result.stdout, /Config: ok \(~\/.pi\/agent\/pi-dictation.json\)/);
});

for (const { name, config, expected } of [
  {
    name: "accepts exact duration boundaries",
    config: { timeoutMs: 1000, maxRecordingMs: 3600000 },
    expected: /Config: ok \(~\/.pi\/agent\/pi-dictation.json\)/,
  },
  {
    name: "rejects durations below the minimum",
    config: { timeoutMs: 999 },
    expected: /timeoutMs must be an integer from 1000 to 3600000/,
  },
  {
    name: "rejects durations above the maximum",
    config: { maxRecordingMs: 3600001 },
    expected: /maxRecordingMs must be an integer from 1000 to 3600000/,
  },
  {
    name: "rejects fractional durations",
    config: { timeoutMs: 1000.5 },
    expected: /timeoutMs must be an integer from 1000 to 3600000/,
  },
]) {
  test(`doctor ${name}`, () => {
    const result = runDoctor({ config: JSON.stringify(config) });
    assert.match(result.stdout, expected);
  });
}

test("doctor recognizes an OpenAI key command without executing it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-key-command-"));
  const marker = join(dir, "executed");
  try {
    const result = runDoctor({
      env: {
        PI_DICTATION_RECORD_CMD: "capture {file}",
        PI_DICTATION_OPENAI_API_KEY_COMMAND: `touch ${marker}`,
      },
    });

    await t.test("reports a configured key command", () => {
      assert.match(result.stdout, /OpenAI credential: configured \(key command; not executed\)/);
    });
    await t.test("does not execute the key command", () => {
      assert.equal(existsSync(marker), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor fails with actionable guidance when recording and transcription are unavailable", async (t) => {
  const result = runDoctor();

  const expectations = [
    ["exits unsuccessfully", () => assert.equal(result.status, 1)],
    ["reports missing recorders", () => assert.match(result.stdout, /Recorder: unavailable \(pw-record and arecord not found\)/)],
    ["reports the default requested backend", () => assert.match(result.stdout, /Backend requested: OpenAI-compatible transcription/)],
    ["reports no effective backend", () => assert.match(result.stdout, /Backend effective: unavailable \(no local command or OpenAI credential configured\)/)],
    ["reports an absent OpenAI credential", () => assert.match(result.stdout, /OpenAI credential: absent/)],
    ["reports that attention is needed", () => assert.match(result.stdout, /Result: needs attention/)],
    ["suggests recorder setup", () => assert.match(result.stdout, /install pw-record\/arecord or configure PI_DICTATION_RECORD_CMD/)],
    ["suggests transcription setup", () => assert.match(result.stdout, /configure a local transcription command or an OpenAI credential/)],
  ];
  for (const [name, expectation] of expectations) await t.test(name, expectation);
});
