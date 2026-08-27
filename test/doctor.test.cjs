const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const packageRoot = resolve(__dirname, "..");

test("package does not expose the removed doctor executable", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.bin?.["pi-dictation-doctor"], undefined);
});
