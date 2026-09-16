const { cpSync, symlinkSync } = require("node:fs");
const { relative, resolve, sep } = require("node:path");

const packageRoot = resolve(__dirname, "../..");

// `npm pack` runs the `prepare` script even with `--ignore-scripts`, and
// `prepare` rebuilds `dist` (`rm -rf dist` first) and then runs husky when it
// detects a git repository. Tests that pack the package therefore never run
// `npm pack` in the real checkout: they pack a copy and strip inherited
// `GIT_*` variables so a run started from a git hook (which exports
// `GIT_DIR`) cannot make the copy's `prepare` reach the real repository.
function isolatedPackageEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return environment;
}

// Copies the checkout so `npm pack` (and its `prepare` rebuild) touches only
// the copy; the shared `dist` stays intact for parallel tests (guarded by the
// inode subtest in bridge-cli.test.cjs). `includeBuild` also copies the
// current `dist` so the copy already carries the compiled artifacts.
function copyPackageSource(destination, { includeBuild = false } = {}) {
  const excludedRoots = new Set([
    ".git",
    ".pi",
    ".pi-subagents",
    "node_modules",
  ]);
  if (!includeBuild) excludedRoots.add("dist");
  cpSync(packageRoot, destination, {
    recursive: true,
    filter(source) {
      const topLevel = relative(packageRoot, source).split(sep)[0];
      return !excludedRoots.has(topLevel);
    },
  });
  symlinkSync(
    resolve(packageRoot, "node_modules"),
    resolve(destination, "node_modules"),
    "dir"
  );
  return destination;
}

module.exports = { copyPackageSource, isolatedPackageEnvironment };
