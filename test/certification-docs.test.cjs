const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const packageRoot = resolve(__dirname, "..");

test("the actual npm tarball carries and executes its Bridge certification documentation", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-dictation-certification-docs-"));
  try {
    const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", temporary], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    if (packed.status !== 0) throw new Error(packed.stderr);
    const tarball = join(temporary, packed.stdout.trim().split("\n").at(-1));
    const extracted = spawnSync("tar", ["-xzf", tarball, "-C", temporary], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(extracted.stderr);
    const packagedRoot = join(temporary, "package");
    const listed = spawnSync(process.execPath, [join(packagedRoot, "bin", "pi-dictation-bridge-certify.cjs"), "list", "--json"], {
      cwd: packagedRoot,
      encoding: "utf8",
    });
    if (listed.status !== 0) throw new Error(listed.stderr);
    const scenarios = JSON.parse(listed.stdout).scenarios.map(({ name }) => name);
    const readme = readFileSync(join(packagedRoot, "README.md"), "utf8");

    await t.test("ships the exact support boundary", () => {
      assert.equal(existsSync(join(packagedRoot, "docs", "bridge-recording-support.md")), true);
    });
    await t.test("ships the redacted certification template", () => {
      assert.equal(existsSync(join(packagedRoot, "docs", "certification", "bridge-recording-template.md")), true);
    });
    await t.test("runs the documented list command from packed bytes", () => {
      assert.equal(scenarios.includes("clean-user-tarball"), true);
    });
    await t.test("does not claim an uncertified macOS version", () => {
      assert.match(readme, /not yet certified for a supported release/);
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
