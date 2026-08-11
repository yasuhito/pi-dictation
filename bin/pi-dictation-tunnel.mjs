#!/usr/bin/env node
import { randomInt } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createBoundedLogger } from "./bounded-log.mjs";

const MAX_MANAGED_JSON_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 4096;
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const configurationPath = process.argv[2];
if (!configurationPath) throw new Error("Tunnel supervisor configuration is required.");
function inspectPrivateFile(path, description, maximumBytes = MAX_MANAGED_JSON_BYTES) {
  const stat = lstatSync(path);
  if (stat.size < 2 || stat.size > maximumBytes || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Refusing unsafe ${description}.`);
  }
}
inspectPrivateFile(configurationPath, "tunnel supervisor configuration");
const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
const argumentListIsSafe = (value) => Array.isArray(value) && value.length <= MAX_ARGUMENTS &&
  value.every((argument) => typeof argument === "string" && Buffer.byteLength(argument) <= MAX_ARGUMENT_BYTES);
if (configuration.product !== "com.yasuhito.pi-dictation.bridge" ||
    typeof configuration.logFile !== "string" || Buffer.byteLength(configuration.logFile) > 4096 ||
    !argumentListIsSafe(configuration.sshArguments) ||
    !argumentListIsSafe(configuration.listenerProbeArguments) ||
    !argumentListIsSafe(configuration.healthProbeArguments) ||
    !Number.isSafeInteger(configuration.stableAfterMs) || configuration.stableAfterMs < 1000 || configuration.stableAfterMs > 300000) {
  throw new Error("Refusing invalid tunnel supervisor configuration.");
}
const logger = createBoundedLogger(configuration.logFile, "tunnel");
logger.event("supervisor-start", { stage: "startup" });

let child;
let stopping = false;
let terminationEscalation;
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
  if (!ownedChild || ownedChild.exitCode !== null || ownedChild.signalCode !== null) return;
  ownedChild.kill("SIGTERM");
  terminationEscalation = setTimeout(() => {
    if (child === ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      ownedChild.kill("SIGKILL");
    }
  }, 5000);
}

async function probeTunnel(tunnel) {
  while (!stopping && child === tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
    const listener = spawnSync("ssh", configuration.listenerProbeArguments, {
      stdio: "ignore", timeout: 2500, maxBuffer: 64 * 1024,
    });
    if (child !== tunnel || tunnel.exitCode !== null || tunnel.signalCode !== null) return;
    if (!listener.error && listener.status === 0) {
      writeStatus({ listener: "established" });
      const health = spawnSync("ssh", configuration.healthProbeArguments, {
        stdio: "ignore", timeout: 2500, maxBuffer: 64 * 1024,
      });
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
  clearTimeout(terminationEscalation);
  terminationEscalation = undefined;
  child = undefined;
  if (stopping) break;
  writeStatus({ tunnelProcess: "stopped", listener: "pending", authenticatedHealth: "pending" });
  failures = lifetime >= configuration.stableAfterMs ? 0 : Math.min(failures + 1, 6);
  logger.event("tunnel-stopped", { stage: "connect", retry: failures });
  const ceiling = Math.min(60000, 1000 * (2 ** failures));
  const jittered = Math.min(60000, Math.max(250, ceiling + randomInt(-Math.floor(ceiling / 4), Math.floor(ceiling / 4) + 1)));
  await sleep(jittered);
}
writeStatus({ tunnelProcess: "stopped", listener: "pending", authenticatedHealth: "pending" });
logger.event("supervisor-stop", { stage: "shutdown" });
logger.close();
