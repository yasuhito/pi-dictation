const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..");

test("the package loads in the current Pi extension and Node CLI runtime regimes", async (t) => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const jiti = createJiti(__filename, { interopDefault: true });
  const extension = await jiti.import(join(packageRoot, "extensions", "pi-dictation.ts"), { default: true });
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-package-loading-"));
  try {
    const cli = spawnSync(process.execPath, [join(packageRoot, "bin", "pi-dictation.mjs"), "bridge", "list", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    await t.test("declares the TypeScript Pi extension entrypoint", () => {
      assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-dictation.ts"]);
    });
    await t.test("loads the extension through Pi's TypeScript loading regime", () => {
      assert.equal(typeof extension, "function");
    });
    await t.test("executes the native ESM CLI directly under Node", () => {
      assert.equal(cli.status === 0 && JSON.parse(cli.stdout).schemaVersion === 1, true, cli.stderr);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
