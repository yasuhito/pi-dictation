const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const gate = join(repositoryRoot, "scripts", "check-strict-migration.mjs");

function runGate({
  module,
  validFixture,
  invalidFixture,
  expectedDiagnostics = [2322],
  dependencies = {},
}) {
  const root = mkdtempSync(join(tmpdir(), "pi-dictation-strict-gate-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "module.ts"), module);
  for (const [name, contents] of Object.entries(dependencies)) {
    writeFileSync(join(root, "src", name), contents);
  }
  writeFileSync(join(root, "test", "valid.ts"), validFixture);
  writeFileSync(join(root, "test", "invalid.ts"), invalidFixture);
  writeFileSync(
    join(root, "strict-migration.json"),
    JSON.stringify({
      modules: ["src/module.ts"],
      typeFixtures: ["test/valid.ts"],
      invalidTypeFixtures: [{ path: "test/invalid.ts", expectedDiagnostics }],
    })
  );
  try {
    return spawnSync(
      process.execPath,
      [gate, join(root, "strict-migration.json")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const validFixture = 'import { value } from "../src/module.js";\nvoid value;\n';
const invalidFixture =
  'import { value } from "../src/module.js";\nconst invalid: number = value;\nvoid invalid;\n';

test("the strict migration gate accepts a valid dependency-closed manifest", () => {
  const result = runGate({
    module: 'export const value = "strict";\n',
    validFixture,
    invalidFixture,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the strict migration gate rejects explicit any", () => {
  const result = runGate({
    module: "export const value: any = 'strict';\n",
    validFixture,
    invalidFixture,
  });
  assert.match(result.stderr, /explicit `any`/);
});

test("the strict migration gate rejects implicit any", () => {
  const result = runGate({
    module: "export function value(input) { return input; }\n",
    validFixture: 'import { value } from "../src/module.js";\nvoid value;\n',
    invalidFixture:
      'import { value } from "../src/module.js";\nconst invalid: number = value("strict");\nvoid invalid;\n',
  });
  assert.match(result.stderr, /implicitly has an 'any' type/);
});

test("the strict migration gate rejects implicit any in invalid fixtures", () => {
  const result = runGate({
    module: 'export const value = "strict";\n',
    validFixture,
    invalidFixture:
      'import { value } from "../src/module.js";\nfunction invalid(input) { return input; }\nvoid value;\nvoid invalid;\n',
    expectedDiagnostics: [7006],
  });
  assert.match(result.stderr, /implicit `any` is forbidden/);
});

test("the strict migration gate rejects ts-ignore", () => {
  const result = runGate({
    module: '// @ts-ignore\nexport const value = "strict";\n',
    validFixture,
    invalidFixture,
  });
  assert.match(result.stderr, /forbidden TypeScript suppression/);
});

test("the strict migration gate rejects ts-nocheck", () => {
  const result = runGate({
    module: '// @ts-nocheck\nexport const value = "strict";\n',
    validFixture,
    invalidFixture,
  });
  assert.match(result.stderr, /forbidden TypeScript suppression/);
});

test("the strict migration gate rejects any emitted in a declaration", () => {
  const result = runGate({
    module: 'export const value = JSON.parse("null");\n',
    validFixture,
    invalidFixture,
  });
  assert.match(result.stderr, /declaration contains `any`/);
});

test("the strict migration gate requires invalid fixtures to fail", () => {
  const result = runGate({
    module: "export const value = 1;\n",
    validFixture,
    invalidFixture:
      'import { value } from "../src/module.js";\nconst valid: number = value;\nvoid valid;\n',
  });
  assert.match(result.stderr, /compiled successfully/);
});

test("the strict migration gate verifies the expected failure", () => {
  const result = runGate({
    module: 'export const value = "strict";\n',
    validFixture,
    invalidFixture,
    expectedDiagnostics: [2345],
  });
  assert.match(result.stderr, /expected diagnostics 2345, received 2322/);
});

test("the strict migration gate rejects source dependencies outside the manifest", () => {
  const result = runGate({
    module:
      'import { dependency } from "./dependency.js";\nexport const value = dependency;\n',
    validFixture,
    invalidFixture,
    dependencies: { "dependency.ts": 'export const dependency = "strict";\n' },
  });
  assert.match(result.stderr, /outside the migrated-module manifest/);
});
