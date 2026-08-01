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
    recordCommand: "PRIVATE_RECORDER",
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
