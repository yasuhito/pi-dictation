const { cpSync, symlinkSync } = require("node:fs");
const { relative, resolve, sep } = require("node:path");

const packageRoot = resolve(__dirname, "../..");

function isolatedPackageEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return environment;
}

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
