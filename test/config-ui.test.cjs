const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });

async function loadUi() {
  return jiti.import(join(packageRoot, "extensions", "config-ui.ts"));
}

function fakeContext({ mode = "tui", selections = [], edits = [] } = {}) {
  const dialogs = [];
  const notifications = [];
  let selectionIndex = 0;
  let editIndex = 0;
  return {
    ctx: {
      mode,
      ui: {
        async select(title, options) {
          dialogs.push({ kind: "select", title, options });
          const wanted = selections[selectionIndex++];
          if (wanted === undefined) return undefined;
          return options.find((option) => option === wanted || option.startsWith(wanted));
        },
        async editor(title, value) {
          dialogs.push({ kind: "editor", title, value });
          return edits[editIndex++];
        },
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    },
    dialogs,
    notifications,
  };
}

const detectRecorder = async () => "ffmpeg";

test("the settings UI edits a safe field while preserving hidden configuration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-ui-"));
  const path = join(directory, "pi-dictation.json");
  const original = {
    language: "en",
    recorder: { type: "local", command: "PRIVATE_RECORDER" },
    transcribeCommand: "PRIVATE_TRANSCRIBER",
    openaiApiKey: "PRIVATE_API_KEY",
    openaiApiKeyCommand: "PRIVATE_KEY_COMMAND",
  };
  writeFileSync(path, `${JSON.stringify(original)}\n`);
  const runtime = fakeContext({ selections: ["Language:", "Save changes"], edits: ["ja"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const rendered = JSON.stringify({ dialogs: runtime.dialogs, notifications: runtime.notifications });
  await t.test("saves the edited language", () => {
    assert.equal(saved.language, "ja");
  });
  await t.test("preserves all hidden fields", () => {
    assert.deepEqual({ ...saved, language: "en" }, original);
  });
  await t.test("never renders hidden values", () => {
    assert.doesNotMatch(rendered, /PRIVATE_/);
  });
  await t.test("explains when changes apply", () => {
    assert.match(runtime.notifications.at(-1).message, /next recording/);
  });
});

for (const scenario of [
  { name: "OpenAI model", selection: "OpenAI model:", edit: "gpt-4o-transcribe", field: "openaiModel", expected: "gpt-4o-transcribe" },
  { name: "transcription timeout", selection: "Transcription timeout:", edit: "30000", field: "timeoutMs", expected: 30000 },
  { name: "maximum recording", selection: "Maximum recording:", edit: "45000", field: "maxRecordingMs", expected: 45000 },
  { name: "spinner", selection: "Spinner:", edit: "dots", field: "spinner", expected: "dots" },
]) {
  test(`the settings UI saves ${scenario.name}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-field-"));
    const path = join(directory, "pi-dictation.json");
    writeFileSync(path, "{}\n");
    const runtime = fakeContext({ selections: [scenario.selection, "Save changes"], edits: [scenario.edit] });
    const { showDictationConfig } = await loadUi();
    await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
    assert.equal(JSON.parse(readFileSync(path, "utf8"))[scenario.field], scenario.expected);
  });
}

test("saving merges dirty fields into the latest valid configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-concurrent-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, "{}\n");
  let selectCount = 0;
  const ctx = {
    mode: "tui",
    ui: {
      async select(_title, options) {
        return selectCount++ === 0
          ? options.find((option) => option.startsWith("OpenAI model:"))
          : "Save changes";
      },
      async editor() {
        writeFileSync(path, '{"openaiBaseUrl":"https://concurrent.example/v1"}\n');
        return "gpt-4o-transcribe";
      },
      notify() {},
    },
  };
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(ctx, { path, env: {}, detectRecorder });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).openaiBaseUrl, "https://concurrent.example/v1");
});

test("cancelling the settings UI leaves the file byte-identical", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-cancel-"));
  const path = join(directory, "pi-dictation.json");
  const original = '{"language":"en"}\n';
  writeFileSync(path, original);
  const runtime = fakeContext({ selections: ["Cancel"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  assert.equal(readFileSync(path, "utf8"), original);
});

test("invalid existing configuration is not overwritten", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-invalid-"));
  const path = join(directory, "pi-dictation.json");
  const original = '{"PRIVATE_SECRET"';
  writeFileSync(path, original);
  const runtime = fakeContext();
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  assert.equal(readFileSync(path, "utf8"), original);
});

test("invalid configuration errors do not expose file contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-redaction-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, '{"PRIVATE_SECRET"');
  const runtime = fakeContext();
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  assert.doesNotMatch(runtime.notifications.at(-1).message, /PRIVATE_SECRET/);
});

test("environment overrides are identified without exposing hidden values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-env-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, "{}\n");
  const runtime = fakeContext({ selections: ["Cancel"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, {
    path,
    env: { PI_DICTATION_LANGUAGE: "ja", PI_DICTATION_OPENAI_API_KEY: "PRIVATE_API_KEY" },
    detectRecorder,
  });
  assert.match(runtime.dialogs[0].title, /PI_DICTATION_LANGUAGE/);
});

test("saving an overridden field warns which environment variable wins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-override-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, "{}\n");
  const runtime = fakeContext({ selections: ["Language:", "Save changes"], edits: ["en"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, {
    path,
    env: { PI_DICTATION_LANGUAGE: "ja" },
    detectRecorder,
  });
  assert.match(runtime.notifications.at(-1).message, /overridden by PI_DICTATION_LANGUAGE/);
});

test("invalid duration input does not change the configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-duration-"));
  const path = join(directory, "pi-dictation.json");
  const original = "{}\n";
  writeFileSync(path, original);
  const runtime = fakeContext({ selections: ["Transcription timeout:", "Cancel"], edits: ["999"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  assert.equal(readFileSync(path, "utf8"), original);
});

test("unknown spinner input does not change the configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-spinner-"));
  const path = join(directory, "pi-dictation.json");
  const original = "{}\n";
  writeFileSync(path, original);
  const runtime = fakeContext({ selections: ["Spinner:", "Cancel"], edits: ["not-a-spinner"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  assert.equal(readFileSync(path, "utf8"), original);
});

test("shortcut changes save with the reload boundary", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-config-shortcut-"));
  const path = join(directory, "pi-dictation.json");
  writeFileSync(path, "{}\n");
  const runtime = fakeContext({ selections: ["Shortcut:", "f8", "Save changes"] });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { path, env: {}, detectRecorder });
  await t.test("saves the selected shortcut", () => {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).shortcut, "f8");
  });
  await t.test("explains the reload requirement", () => {
    assert.match(runtime.notifications.at(-1).message, /require \/reload or restart/);
  });
});

test("non-TUI mode rejects the settings command before opening dialogs", async () => {
  const runtime = fakeContext({ mode: "rpc" });
  const { showDictationConfig } = await loadUi();
  await showDictationConfig(runtime.ctx, { env: {}, detectRecorder });
  assert.equal(runtime.dialogs.length, 0);
});
