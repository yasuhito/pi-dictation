import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MIN_DURATION_MS = 1000;
export const MAX_DURATION_MS = 60 * 60 * 1000;
export const DEFAULT_SHORTCUT = "insert";
export const DEFAULT_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_RECORDING_MS = 10 * 60 * 1000;
export const DEFAULT_SPINNER = "arc";

export type LocalRecorderConfig = { type: "local"; command?: string };

export type BridgeRecorderConfig = {
  type: "bridge";
  endpoint:
    | { type: "unix"; path: string }
    | { type: "tcp"; host: "127.0.0.1" | "::1"; port: number };
  credentialFile: string;
};

export type RecorderConfig = LocalRecorderConfig | BridgeRecorderConfig;

export type DictationConfigFile = {
  $schema?: string;
  shortcut?: string;
  language?: string;
  recorder?: RecorderConfig;
  transcribeCommand?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiApiKeyCommand?: string;
  timeoutMs?: number;
  maxRecordingMs?: number;
  spinner?: string;
};

export type EffectiveDictationConfig = {
  shortcut: string;
  language: string;
  recorder: RecorderConfig;
  transcribeCommand: string;
  openaiModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiApiKeyCommand: string;
  timeoutMs: number;
  maxRecordingMs: number;
  spinner: string;
  configError?: string;
};

export function getConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "pi-dictation.json");
}

export function normalizeDuration(value: unknown, fallback: number): number {
  const duration = Number(value);
  return Number.isInteger(duration) && duration >= MIN_DURATION_MS && duration <= MAX_DURATION_MS
    ? duration
    : fallback;
}

export function validateConfigFile(value: unknown): DictationConfigFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration root must be an object");
  }
  const config = value as Record<string, unknown>;
  const stringFields = [
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
  const knownFields = new Set([...stringFields, "recorder", "timeoutMs", "maxRecordingMs"]);
  if (Object.keys(config).some((field) => !knownFields.has(field))) {
    throw new Error("Unknown configuration field");
  }
  for (const field of stringFields) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`${field} must be a string`);
    }
  }
  for (const field of ["timeoutMs", "maxRecordingMs"]) {
    if (config[field] === undefined) continue;
    if (typeof config[field] !== "number") throw new Error(`${field} must be a number`);
    if (!Number.isInteger(config[field])) throw new Error(`${field} must be an integer`);
    if (config[field] < MIN_DURATION_MS || config[field] > MAX_DURATION_MS) {
      throw new Error(`${field} must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}`);
    }
  }
  if (config.recorder !== undefined) validateRecorderConfig(config.recorder);
  return config as DictationConfigFile;
}

function validateExactFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error("Unknown Recorder configuration field");
  }
}

export function validateRecorderConfig(value: unknown): RecorderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("recorder must be an object");
  }
  const recorder = value as Record<string, unknown>;
  if (recorder.type === "local") {
    validateExactFields(recorder, ["type", "command"]);
    if (
      recorder.command !== undefined &&
      (typeof recorder.command !== "string" || recorder.command.length === 0)
    ) {
      throw new Error("recorder.command must be a non-empty string");
    }
    return recorder as RecorderConfig;
  }
  if (recorder.type !== "bridge") throw new Error("recorder.type must be local or bridge");
  validateExactFields(recorder, ["type", "endpoint", "credentialFile"]);
  if (typeof recorder.credentialFile !== "string" || !isAbsolute(recorder.credentialFile)) {
    throw new Error("Bridge credentialFile must be an absolute path");
  }
  if (!recorder.endpoint || typeof recorder.endpoint !== "object" || Array.isArray(recorder.endpoint)) {
    throw new Error("Bridge endpoint must be an object");
  }
  const endpoint = recorder.endpoint as Record<string, unknown>;
  if (endpoint.type === "unix") {
    validateExactFields(endpoint, ["type", "path"]);
    if (typeof endpoint.path !== "string" || !isAbsolute(endpoint.path)) {
      throw new Error("Bridge Unix endpoint path must be absolute");
    }
  } else if (endpoint.type === "tcp") {
    validateExactFields(endpoint, ["type", "host", "port"]);
    if (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") {
      throw new Error("Bridge TCP endpoint host must be loopback");
    }
    if (!Number.isInteger(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
      throw new Error("Bridge TCP endpoint port must be from 1 to 65535");
    }
  } else {
    throw new Error("Bridge endpoint type must be unix or tcp");
  }
  return recorder as RecorderConfig;
}

export function readConfigFile(path = getConfigPath()): DictationConfigFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size < 2 || info.size > 64 * 1024) throw new Error();
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("invalid JSON");
  }
  return validateConfigFile(parsed);
}

export function loadConfig(
  path = getConfigPath(),
  env: NodeJS.ProcessEnv = process.env
): EffectiveDictationConfig {
  let fromFile: DictationConfigFile = {};
  let configError: string | undefined;
  try {
    fromFile = readConfigFile(path);
  } catch (error) {
    configError = `Failed to load ${path}: ${error.message}`;
  }

  return {
    shortcut: env.PI_DICTATION_SHORTCUT || fromFile.shortcut || DEFAULT_SHORTCUT,
    language: env.PI_DICTATION_LANGUAGE || fromFile.language || "",
    recorder: fromFile.recorder || { type: "local" },
    transcribeCommand: env.PI_DICTATION_TRANSCRIBE_CMD || fromFile.transcribeCommand || "",
    openaiModel: env.PI_DICTATION_OPENAI_MODEL || fromFile.openaiModel || "gpt-4o-mini-transcribe",
    openaiBaseUrl:
      env.PI_DICTATION_OPENAI_BASE_URL || fromFile.openaiBaseUrl || "https://api.openai.com/v1",
    openaiApiKey:
      env.PI_DICTATION_OPENAI_API_KEY || env.OPENAI_API_KEY || fromFile.openaiApiKey || "",
    openaiApiKeyCommand:
      env.PI_DICTATION_OPENAI_API_KEY_COMMAND || fromFile.openaiApiKeyCommand || "",
    timeoutMs: normalizeDuration(
      env.PI_DICTATION_TIMEOUT_MS || fromFile.timeoutMs || DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    maxRecordingMs: normalizeDuration(
      env.PI_DICTATION_MAX_RECORDING_MS || fromFile.maxRecordingMs || DEFAULT_MAX_RECORDING_MS,
      DEFAULT_MAX_RECORDING_MS
    ),
    spinner: env.PI_DICTATION_SPINNER || fromFile.spinner || DEFAULT_SPINNER,
    configError,
  };
}

export async function writeConfigFileAtomic(
  config: DictationConfigFile,
  path = getConfigPath()
): Promise<void> {
  const validated = validateConfigFile(config);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.pi-dictation.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
