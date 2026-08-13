#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MIN_NODE_VERSION = [22, 19, 0];
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const SAFE_PACKAGE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const CONFIG_DISPLAY_PATH = "~/.pi/agent/pi-dictation.json";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-dictation.json");
const STRING_FIELDS = [
  "$schema",
  "shortcut",
  "language",
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
  const knownFields = new Set([...STRING_FIELDS, "recorder", "recorders", ...NUMBER_FIELDS]);
  if (Object.keys(config).some((field) => !knownFields.has(field))) {
    throw new Error("unknown configuration field");
  }
  for (const field of STRING_FIELDS) {
    if (config[field] !== undefined &&
        (typeof config[field] !== "string" || Buffer.byteLength(config[field]) > 8 * 1024)) {
      throw new Error(`${field} must be a bounded string`);
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
  if (config.recorder !== undefined && config.recorders !== undefined) {
    throw new Error("recorder and recorders cannot both be configured");
  }
  if (config.recorder !== undefined) validateRecorder(config.recorder);
  if (config.recorders !== undefined) validateRecorderProfiles(config.recorders);
  return config;
}

function exactFields(value, fields) {
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error("unknown Recorder configuration field");
  }
}

function validateRecorder(recorder) {
  if (!recorder || typeof recorder !== "object" || Array.isArray(recorder)) {
    throw new Error("recorder must be an object");
  }
  if (recorder.type === "local") {
    exactFields(recorder, ["type", "command"]);
    if (
      recorder.command !== undefined
      && (typeof recorder.command !== "string" || recorder.command.length === 0)
    ) {
      throw new Error("recorder.command must be a non-empty string");
    }
    return;
  }
  if (recorder.type !== "bridge") throw new Error("recorder.type must be local or bridge");
  exactFields(recorder, ["type", "endpoint", "credentialFile"]);
  if (typeof recorder.credentialFile !== "string" || !recorder.credentialFile.startsWith("/")) {
    throw new Error("Bridge credentialFile must be an absolute path");
  }
  const endpoint = recorder.endpoint;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new Error("Bridge endpoint must be an object");
  }
  if (endpoint.type === "unix") {
    exactFields(endpoint, ["type", "path"]);
    if (typeof endpoint.path !== "string" || !endpoint.path.startsWith("/")) {
      throw new Error("Bridge Unix endpoint path must be absolute");
    }
    return;
  }
  if (endpoint.type !== "tcp") throw new Error("Bridge endpoint type must be unix or tcp");
  exactFields(endpoint, ["type", "host", "port"]);
  if (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") {
    throw new Error("Bridge TCP endpoint host must be loopback");
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error("Bridge TCP endpoint port must be from 1 to 65535");
  }
}

function validateRecorderProfiles(recorders) {
  if (!recorders || typeof recorders !== "object" || Array.isArray(recorders)) {
    throw new Error("recorders must be an object");
  }
  exactFields(recorders, ["selected", "local", "bridge"]);
  if (recorders.selected !== "local" && recorders.selected !== "bridge") {
    throw new Error("recorders.selected must be local or bridge");
  }
  if (recorders.selected === "bridge" && recorders.bridge === undefined) {
    throw new Error("Bridge selection requires a configured Bridge Recorder");
  }
  if (recorders.local !== undefined) {
    if (!recorders.local || typeof recorders.local !== "object" || Array.isArray(recorders.local)) {
      throw new Error("recorders.local must be an object");
    }
    exactFields(recorders.local, ["command"]);
    validateRecorder({ ...recorders.local, type: "local" });
  }
  if (recorders.bridge !== undefined) {
    if (!recorders.bridge || typeof recorders.bridge !== "object" || Array.isArray(recorders.bridge)) {
      throw new Error("recorders.bridge must be an object");
    }
    exactFields(recorders.bridge, ["endpoint", "credentialFile"]);
    validateRecorder({ ...recorders.bridge, type: "bridge" });
  }
}

function selectedRecorder(config) {
  if (!config.recorders) return config.recorder || { type: "local" };
  if (config.recorders.selected === "bridge" && config.recorders.bridge) {
    return { ...config.recorders.bridge, type: "bridge" };
  }
  return { ...config.recorders.local, type: "local" };
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return { value: {}, status: "not found; defaults and environment used" };
  let parsed;
  try {
    const info = statSync(CONFIG_PATH);
    if (!info.isFile() || info.size < 2 || info.size > 64 * 1024) throw new Error();
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
      const manifest = join(modulesDirectory, packageName, "package.json");
      const info = statSync(manifest);
      if (!info.isFile() || info.size < 2 || info.size > MAX_PACKAGE_MANIFEST_BYTES) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === packageName && typeof parsed.version === "string" &&
          SAFE_PACKAGE_VERSION.test(parsed.version)) return parsed.version;
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
} else if (process.platform === "darwin") {
  lines.push("Platform: ok (macOS)");
} else {
  lines.push(`Platform: unsupported (${process.platform}; Linux or macOS required)`);
  issues.push("use Pi Dictation on Linux or macOS");
}

if (config.error) {
  lines.push(`Config: invalid (${config.error})`);
  issues.push(`fix ${CONFIG_DISPLAY_PATH}`);
} else {
  lines.push(`Config: ok (${config.status})`);
}

const recorder = selectedRecorder(config.value);
if (recorder.type === "bridge") {
  lines.push("Recorder: configured (Bridge recording)");
} else if (recorder.command) {
  lines.push("Recorder: ok (custom local command configured)");
} else if (process.platform === "darwin") {
  if (commandExists("ffmpeg")) {
    lines.push("Recorder: ok (ffmpeg AVFoundation auto-detected)");
  } else {
    lines.push("Recorder: unavailable (ffmpeg not found)");
    issues.push("install ffmpeg or configure recorder.command");
  }
} else if (process.platform === "linux") {
  if (commandExists("pw-record")) {
    lines.push("Recorder: ok (pw-record auto-detected)");
  } else if (commandExists("arecord")) {
    lines.push("Recorder: ok (arecord auto-detected)");
  } else {
    lines.push("Recorder: unavailable (pw-record and arecord not found)");
    issues.push("install pw-record/arecord or configure recorder.command");
  }
} else {
  lines.push(`Recorder: unavailable (no default recorder for ${process.platform})`);
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
