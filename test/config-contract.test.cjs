const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });

function readJson(path) {
  return JSON.parse(readFileSync(join(packageRoot, path), "utf8"));
}

test("the package ships its configuration schema", () => {
  const manifest = readJson("package.json");
  assert.ok(manifest.files.includes("pi-dictation.schema.json"));
});

test("the package ships its example configuration", () => {
  const manifest = readJson("package.json");
  assert.ok(manifest.files.includes("pi-dictation.example.json"));
});

test("the configuration schema is valid JSON Schema 2020-12", () => {
  const schema = readJson("pi-dictation.schema.json");
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  assert.doesNotThrow(() => ajv.compile(schema));
});

test("the example configuration satisfies the schema", () => {
  const schema = readJson("pi-dictation.schema.json");
  const example = readJson("pi-dictation.example.json");
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});

test("the transcription timeout schema declares the runtime bounds", () => {
  const { timeoutMs } = readJson("pi-dictation.schema.json").properties;
  assert.deepEqual({ minimum: timeoutMs.minimum, maximum: timeoutMs.maximum }, { minimum: 1000, maximum: 3600000 });
});

test("the recording limit schema declares the runtime bounds", () => {
  const { maxRecordingMs } = readJson("pi-dictation.schema.json").properties;
  assert.deepEqual({ minimum: maxRecordingMs.minimum, maximum: maxRecordingMs.maximum }, { minimum: 1000, maximum: 3600000 });
});

for (const { name, value, expected } of [
  { name: "accepts the minimum duration", value: 1000, expected: 1000 },
  { name: "accepts the maximum duration", value: 3600000, expected: 3600000 },
  { name: "rejects a duration below the minimum", value: 999, expected: 120000 },
  { name: "rejects a duration above the maximum", value: 3600001, expected: 120000 },
  { name: "rejects a fractional duration", value: 1000.5, expected: 120000 },
]) {
  test(`runtime ${name}`, async () => {
    const { normalizeDuration } = await jiti.import(join(packageRoot, "extensions", "config.ts"));
    assert.equal(normalizeDuration(value, 120000), expected);
  });
}
