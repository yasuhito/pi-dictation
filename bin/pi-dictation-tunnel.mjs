#!/usr/bin/env node
import { randomInt } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const configurationPath = process.argv[2];
if (!configurationPath) throw new Error("Tunnel supervisor configuration is required.");
function inspectPrivateFile(path, description) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Refusing unsafe ${description}.`);
  }
}
inspectPrivateFile(configurationPath, "tunnel supervisor configuration");
const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
if (configuration.product !== "com.yasuhito.pi-dictation.bridge" || !Array.isArray(configuration.sshArguments) ||
    !Array.isArray(configuration.listenerProbeArguments) || !Array.isArray(configuration.healthProbeArguments)) {
  throw new Error("Refusing invalid tunnel supervisor configuration.");
}

let child;
let stopping = false;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function writeStatus(patch) {
  inspectPrivateFile(configuration.statusFile, "tunnel status file");
  const current = JSON.parse(readFileSync(configuration.statusFile, "utf8"));
  const next = { ...current, stages: { ...current.stages, ...patch }, updatedAt: new Date().toISOString() };
  const temporary = join(dirname(configuration.statusFile), `.${basename(configuration.statusFile)}.${process.pid}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, configuration.statusFile);
}

function stop() {
  stopping = true;
  const ownedChild = child;
  if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill("SIGTERM");
}

async function probeTunnel(tunnel) {
  while (!stopping && child === tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
    const listener = spawnSync("ssh", configuration.listenerProbeArguments, { stdio: "ignore", timeout: 2500 });
    if (child !== tunnel || tunnel.exitCode !== null || tunnel.signalCode !== null) return;
    if (!listener.error && listener.status === 0) {
      writeStatus({ listener: "established" });
      const health = spawnSync("ssh", configuration.healthProbeArguments, { stdio: "ignore", timeout: 2500 });
      if (child !== tunnel || tunnel.exitCode !== null || tunnel.signalCode !== null) return;
      writeStatus({ authenticatedHealth: !health.error && health.status === 0 ? "ready" : "pending" });
    } else {
      writeStatus({ listener: "pending", authenticatedHealth: "pending" });
    }
    await sleep(1000);
  }
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

let failures = 0;
while (!stopping) {
  const startedAt = Date.now();
  writeStatus({ tunnelProcess: "starting", listener: "pending", authenticatedHealth: "pending" });
  const tunnel = spawn("ssh", configuration.sshArguments, { stdio: "ignore" });
  child = tunnel;
  await new Promise((resolve) => {
    tunnel.once("spawn", () => {
      writeStatus({ tunnelProcess: "running" });
      void probeTunnel(tunnel);
    });
    tunnel.once("error", resolve);
    tunnel.once("exit", resolve);
  });
  const lifetime = Date.now() - startedAt;
  child = undefined;
  if (stopping) break;
  writeStatus({ tunnelProcess: "stopped", listener: "pending", authenticatedHealth: "pending" });
  failures = lifetime >= (configuration.stableAfterMs || 30000) ? 0 : Math.min(failures + 1, 6);
  const ceiling = Math.min(60000, 1000 * (2 ** failures));
  const jittered = Math.min(60000, Math.max(250, ceiling + randomInt(-Math.floor(ceiling / 4), Math.floor(ceiling / 4) + 1)));
  await sleep(jittered);
}
writeStatus({ tunnelProcess: "stopped", listener: "pending", authenticatedHealth: "pending" });
