const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });

async function configModule() {
  return jiti.import(join(packageRoot, "extensions", "config.ts"));
}

test("atomic configuration writes preserve hidden fields and private permissions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-write-"));
  const path = join(directory, "nested", "pi-dictation.json");
  const config = {
    $schema: "schema",
    language: "ja",
    recorder: { type: "local", command: "PRIVATE_RECORDER" },
    transcribeCommand: "PRIVATE_TRANSCRIBER",
    openaiApiKey: "PRIVATE_API_KEY",
    openaiApiKeyCommand: "PRIVATE_KEY_COMMAND",
  };
  const { writeConfigFileAtomic } = await configModule();
  await writeConfigFileAtomic(config, path);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  await t.test("writes the requested complete object", () => {
    assert.deepEqual(parsed, config);
  });
  await t.test("sets exact private file permissions", () => {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
  await t.test("leaves no temporary file", () => {
    assert.deepEqual(readdirSync(join(directory, "nested")), ["pi-dictation.json"]);
  });
});

test("atomic configuration writes replace a permissive file privately", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-mode-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, "{}\n");
  chmodSync(path, 0o644);
  const { writeConfigFileAtomic } = await configModule();
  await writeConfigFileAtomic({ language: "en" }, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("configuration validation rejects persisted durations outside the contract", async () => {
  const { validateConfigFile } = await configModule();
  assert.throws(() => validateConfigFile({ timeoutMs: 999 }), /between 1000 and 3600000/);
});

test("configuration validation rejects fractional persisted durations", async () => {
  const { validateConfigFile } = await configModule();
  assert.throws(() => validateConfigFile({ maxRecordingMs: 1000.5 }), /must be an integer/);
});

test("an omitted Recorder defaults to local", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-default-recorder-"));
  const { loadConfig } = await configModule();
  assert.deepEqual(loadConfig(join(directory, "missing.json"), {}).recorder, { type: "local" });
});

test("Recorder selection chooses the persisted Local Recorder profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-selection-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, JSON.stringify({
    recorders: {
      selected: "local",
      local: { command: "capture {file}" },
      bridge: {
        endpoint: { type: "unix", path: "/run/user/1000/pi-dictation.sock" },
        credentialFile: "/home/user/.config/pi-dictation/credential",
      },
    },
  }));
  const { loadConfig } = await configModule();
  assert.deepEqual(loadConfig(path, {}).recorder, { type: "local", command: "capture {file}" });
});

test("Recorder selection chooses the persisted Bridge Recorder profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-bridge-selection-"));
  const path = join(directory, "pi-dictation.json");
  const bridge = {
    endpoint: { type: "unix", path: "/run/user/1000/pi-dictation.sock" },
    credentialFile: "/home/user/.config/pi-dictation/credential",
  };
  writeFileSync(path, JSON.stringify({ recorders: { selected: "bridge", bridge } }));
  const { loadConfig } = await configModule();
  assert.deepEqual(loadConfig(path, {}).recorder, { type: "bridge", ...bridge });
});

test("package-specific environment settings are ignored", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-env-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, JSON.stringify({
    shortcut: "f8",
    language: "en",
    transcribeCommand: "transcribe {file}",
    openaiModel: "file-model",
    openaiBaseUrl: "https://file.example/v1",
    openaiApiKey: "file-key",
    openaiApiKeyCommand: "file-key-command",
    timeoutMs: 2000,
    maxRecordingMs: 3000,
    spinner: "dots",
  }));
  const { loadConfig } = await configModule();
  const config = loadConfig(path, {
    PI_DICTATION_SHORTCUT: "insert",
    PI_DICTATION_LANGUAGE: "ja",
    PI_DICTATION_TRANSCRIBE_CMD: "environment-transcriber",
    PI_DICTATION_OPENAI_MODEL: "environment-model",
    PI_DICTATION_OPENAI_BASE_URL: "https://environment.example/v1",
    PI_DICTATION_OPENAI_API_KEY: "package-key",
    PI_DICTATION_OPENAI_API_KEY_COMMAND: "environment-key-command",
    PI_DICTATION_TIMEOUT_MS: "9000",
    PI_DICTATION_MAX_RECORDING_MS: "10000",
    PI_DICTATION_SPINNER: "arc",
    OPENAI_API_KEY: "standard-key",
  });
  assert.deepEqual(
    {
      shortcut: config.shortcut,
      language: config.language,
      transcribeCommand: config.transcribeCommand,
      openaiModel: config.openaiModel,
      openaiBaseUrl: config.openaiBaseUrl,
      openaiApiKey: config.openaiApiKey,
      openaiApiKeyCommand: config.openaiApiKeyCommand,
      timeoutMs: config.timeoutMs,
      maxRecordingMs: config.maxRecordingMs,
      spinner: config.spinner,
    },
    {
      shortcut: "f8",
      language: "en",
      transcribeCommand: "transcribe {file}",
      openaiModel: "file-model",
      openaiBaseUrl: "https://file.example/v1",
      openaiApiKey: "standard-key",
      openaiApiKeyCommand: "file-key-command",
      timeoutMs: 2000,
      maxRecordingMs: 3000,
      spinner: "dots",
    }
  );
});

test("Local Recorder profiles cannot override their discriminator", async () => {
  const { validateConfigFile } = await configModule();
  assert.throws(
    () => validateConfigFile({ recorders: {
      selected: "local",
      local: {
        type: "bridge",
        endpoint: { type: "unix", path: "/run/user/1000/pi-dictation.sock" },
        credentialFile: "/home/user/.config/pi-dictation/credential",
      },
    } }),
    /Unknown Recorder configuration field/
  );
});

test("configuration validation rejects Bridge selection without a Bridge profile", async () => {
  const { validateConfigFile } = await configModule();
  assert.throws(
    () => validateConfigFile({ recorders: { selected: "bridge" } }),
    /requires a configured Bridge Recorder/
  );
});

test("runtime validation rejects the removed top-level recordCommand", async () => {
  const { validateConfigFile } = await configModule();
  assert.throws(() => validateConfigFile({ recordCommand: "capture" }), /Unknown configuration field/);
});

test("runtime validation rejects non-loopback Bridge endpoints", async () => {
  const { validateConfigFile } = await configModule();
  assert.throws(
    () => validateConfigFile({ recorder: { type: "bridge", endpoint: { type: "tcp", host: "0.0.0.0", port: 1234 }, credentialFile: "/secret" } }),
    /must be loopback/
  );
});
