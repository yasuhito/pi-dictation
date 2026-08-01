#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MIN_NODE_VERSION = [22, 19, 0];
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const CONFIG_DISPLAY_PATH = "~/.pi/agent/pi-dictation.json";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-dictation.json");
const STRING_FIELDS = [
  "$schema",
  "shortcut",
  "language",
  "recordCommand",
  "transcribeCommand",
  "openaiModel",
  "openaiBaseUrl",
  "openaiApiKey",
  "openaiApiKeyCommand",
  "spinner",
];
const NUMBER_FIELDS = ["timeoutMs", "maxRecordingMs"];

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("configuration root must be an object");
  }
  for (const field of STRING_FIELDS) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`${field} must be a string`);
    }
  }
  for (const field of NUMBER_FIELDS) {
    if (config[field] === undefined) continue;
    if (
      !Number.isInteger(config[field])
      || config[field] < MIN_DURATION_MS
      || config[field] > MAX_DURATION_MS
    ) {
      throw new Error(`${field} must be an integer from ${MIN_DURATION_MS} to ${MAX_DURATION_MS}`);
    }
  }
  return config;
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return { value: {}, status: "not found; defaults and environment used" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { value: {}, error: `${CONFIG_DISPLAY_PATH}: invalid JSON` };
  }
  try {
    return { value: validateConfig(parsed), status: CONFIG_DISPLAY_PATH };
  } catch (error) {
    return { value: {}, error: `${CONFIG_DISPLAY_PATH}: ${error.message}` };
  }
}

function versionAtLeast(current, minimum) {
  const parts = current.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    if ((parts[index] || 0) > minimum[index]) return true;
    if ((parts[index] || 0) < minimum[index]) return false;
  }
  return true;
}

function commandExists(command) {
  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) continue;
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function findPackageVersion(packageName) {
  const require = createRequire(import.meta.url);
  for (const modulesDirectory of require.resolve.paths(packageName) || []) {
    try {
      const parsed = JSON.parse(readFileSync(join(modulesDirectory, packageName, "package.json"), "utf8"));
      if (parsed.name === packageName && typeof parsed.version === "string") return parsed.version;
    } catch {}
  }
  return "";
}

function configuredValue(envName, fileValue) {
  return process.env[envName] || fileValue || "";
}

const config = readConfig();
const issues = [];
const lines = ["Pi Dictation doctor", ""];

const nodeVersion = process.versions.node;
if (versionAtLeast(nodeVersion, MIN_NODE_VERSION)) {
  lines.push(`Node: ok (v${nodeVersion})`);
} else {
  lines.push(`Node: unavailable (v${nodeVersion}; requires >=22.19.0)`);
  issues.push("upgrade Node.js to 22.19.0 or newer");
}

const piVersion = findPackageVersion("@earendil-works/pi-coding-agent");
if (piVersion) {
  lines.push(`Pi: ok (${piVersion})`);
} else {
  lines.push("Pi: unavailable (package not found)");
  issues.push("install Pi before using Pi Dictation");
}

if (process.platform === "linux") {
  lines.push("Platform: ok (linux)");
} else {
  lines.push(`Platform: unsupported (${process.platform}; Linux required)`);
  issues.push("use Pi Dictation on Linux");
}

if (config.error) {
  lines.push(`Config: invalid (${config.error})`);
  issues.push(`fix ${CONFIG_DISPLAY_PATH}`);
} else {
  lines.push(`Config: ok (${config.status})`);
}

const recordCommand = configuredValue("PI_DICTATION_RECORD_CMD", config.value.recordCommand);
if (recordCommand) {
  lines.push("Recorder: ok (custom command configured)");
} else if (commandExists("pw-record")) {
  lines.push("Recorder: ok (pw-record auto-detected)");
} else if (commandExists("arecord")) {
  lines.push("Recorder: ok (arecord auto-detected)");
} else {
  lines.push("Recorder: unavailable (pw-record and arecord not found)");
  issues.push("install pw-record/arecord or configure PI_DICTATION_RECORD_CMD");
}

const transcribeCommand = configuredValue("PI_DICTATION_TRANSCRIBE_CMD", config.value.transcribeCommand);
const directKeySource = process.env.PI_DICTATION_OPENAI_API_KEY
  ? "PI_DICTATION_OPENAI_API_KEY"
  : process.env.OPENAI_API_KEY
    ? "OPENAI_API_KEY"
    : config.value.openaiApiKey
      ? "config"
      : "";
const keyCommand = configuredValue(
  "PI_DICTATION_OPENAI_API_KEY_COMMAND",
  config.value.openaiApiKeyCommand
);

if (transcribeCommand) {
  lines.push("Backend requested: custom command");
  lines.push("Backend effective: ok (custom command configured)");
} else {
  lines.push("Backend requested: OpenAI-compatible transcription");
  if (directKeySource || keyCommand) {
    lines.push("Backend effective: ok (OpenAI-compatible transcription)");
  } else {
    lines.push("Backend effective: unavailable (no local command or OpenAI credential configured)");
    issues.push("configure a local transcription command or an OpenAI credential");
  }
}

if (directKeySource) {
  lines.push(`OpenAI credential: present (${directKeySource})`);
} else if (keyCommand) {
  lines.push("OpenAI credential: configured (key command; not executed)");
} else {
  lines.push("OpenAI credential: absent");
}

lines.push("");
if (issues.length === 0) {
  lines.push("Result: ready");
} else {
  lines.push("Result: needs attention");
  for (const issue of issues) lines.push(`- ${issue}`);
}

console.log(lines.join("\n"));
process.exitCode = issues.length === 0 ? 0 : 1;
