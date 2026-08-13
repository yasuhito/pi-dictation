import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import cliSpinners from "cli-spinners";
import {
  DEFAULT_MAX_RECORDING_MS,
  DEFAULT_SHORTCUT,
  DEFAULT_SPINNER,
  DEFAULT_TIMEOUT_MS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  type BridgeRecorderConfig,
  type DictationConfigFile,
  type RecorderSelection,
  acquireBridgeSelectionLock,
  getConfigPath,
  migrateRecorderConfiguration,
  normalizeDuration,
  readConfigFile,
  writeConfigFileAtomic,
} from "./config.js";
import { checkBridgeRecorder } from "./bridge-recorder.js";
import { detectDefaultRecorder } from "./recorder.js";

type EditableField = "shortcut" | "language" | "openaiModel" | "timeoutMs" | "maxRecordingMs" | "spinner";

type ConfigUiOptions = {
  path?: string;
  env?: NodeJS.ProcessEnv;
  detectRecorder?: typeof detectDefaultRecorder;
  checkBridge?: (config: BridgeRecorderConfig) => Promise<boolean>;
  acquireBridgeLock?: typeof acquireBridgeSelectionLock;
};

const FIELD_ENVIRONMENT: Record<EditableField, string> = {
  shortcut: "PI_DICTATION_SHORTCUT",
  language: "PI_DICTATION_LANGUAGE",
  openaiModel: "PI_DICTATION_OPENAI_MODEL",
  timeoutMs: "PI_DICTATION_TIMEOUT_MS",
  maxRecordingMs: "PI_DICTATION_MAX_RECORDING_MS",
  spinner: "PI_DICTATION_SPINNER",
};

const SHORTCUTS = ["insert", "f8", "f9", "ctrl+space", "ctrl+shift+d", "alt+d", "(default)"];

function display(value: unknown): string {
  const text = String(value === "" ? "(automatic)" : value).replace(/[\x00-\x1f\x7f]/g, "�");
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function configuredSource(env: NodeJS.ProcessEnv, variable: string, fileValue: unknown): string | undefined {
  if (env[variable]) return variable;
  if (fileValue) return "configuration";
  return undefined;
}

type RecorderStatuses = {
  local: string;
  bridge: "available" | "unavailable" | "not configured";
};

async function recorderStatuses(
  persisted: DictationConfigFile,
  detectRecorder: typeof detectDefaultRecorder,
  checkBridge: (config: BridgeRecorderConfig) => Promise<boolean>
): Promise<RecorderStatuses> {
  const migrated = migrateRecorderConfiguration(persisted);
  let local: string;
  if (migrated.recorders?.local?.command) local = "configured";
  else {
    try { local = `${await detectRecorder()} available`; }
    catch { local = "unavailable"; }
  }
  const profile = migrated.recorders?.bridge;
  const bridge = !profile
    ? "not configured"
    : await checkBridge({ ...profile, type: "bridge" }) ? "available" : "unavailable";
  return { local, bridge };
}

function backendStatus(persisted: DictationConfigFile, env: NodeJS.ProcessEnv): string {
  const commandSource = configuredSource(env, "PI_DICTATION_TRANSCRIBE_CMD", persisted.transcribeCommand);
  let backend: string;
  if (commandSource) backend = `custom command configured (${commandSource}; not executed)`;
  else {
    const credentialSource = env.PI_DICTATION_OPENAI_API_KEY
      ? "PI_DICTATION_OPENAI_API_KEY"
      : env.OPENAI_API_KEY
        ? "OPENAI_API_KEY"
        : persisted.openaiApiKey
          ? "configuration"
          : configuredSource(env, "PI_DICTATION_OPENAI_API_KEY_COMMAND", persisted.openaiApiKeyCommand);
    backend = credentialSource ? `OpenAI credential configured (${credentialSource})` : "not configured";
  }
  return backend;
}

function parseSingleLine(value: string, label: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (/\r|\n|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized)) {
    throw new Error(`${label} must be one line`);
  }
  return normalized;
}

function parseDuration(value: string, label: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an integer`);
  const duration = Number(normalized);
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    throw new Error(`${label} must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS} ms`);
  }
  return duration;
}

export async function showDictationConfig(
  ctx: ExtensionCommandContext,
  options: ConfigUiOptions = {}
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/dictate-config requires Pi interactive TUI mode.", "error");
    return;
  }

  const path = options.path || getConfigPath();
  const env = options.env || process.env;
  const detectRecorder = options.detectRecorder || detectDefaultRecorder;
  const checkBridge = options.checkBridge || checkBridgeRecorder;
  const acquireBridgeLock = options.acquireBridgeLock || acquireBridgeSelectionLock;
  let persisted: DictationConfigFile;
  try {
    persisted = readConfigFile(path);
  } catch (error) {
    ctx.ui.notify(`Pi Dictation configuration is invalid: ${error.message}`, "error");
    return;
  }

  const draft = migrateRecorderConfiguration(persisted);
  const dirty = new Set<EditableField>();
  let recorderSelectionDirty = false;
  const statuses = await recorderStatuses(draft, detectRecorder, checkBridge);
  const backend = backendStatus(persisted, env);

  while (true) {
    const values: Record<EditableField, string | number> = {
      shortcut: env.PI_DICTATION_SHORTCUT || draft.shortcut || DEFAULT_SHORTCUT,
      language: env.PI_DICTATION_LANGUAGE || draft.language || "",
      openaiModel: env.PI_DICTATION_OPENAI_MODEL || draft.openaiModel || "gpt-4o-mini-transcribe",
      timeoutMs: normalizeDuration(
        env.PI_DICTATION_TIMEOUT_MS || draft.timeoutMs || DEFAULT_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
      ),
      maxRecordingMs: normalizeDuration(
        env.PI_DICTATION_MAX_RECORDING_MS || draft.maxRecordingMs || DEFAULT_MAX_RECORDING_MS,
        DEFAULT_MAX_RECORDING_MS
      ),
      spinner: env.PI_DICTATION_SPINNER || draft.spinner || DEFAULT_SPINNER,
    };
    const selectedRecorder = draft.recorders?.selected || "local";
    const selectedStatus = selectedRecorder === "local" ? statuses.local : statuses.bridge;
    const entries: Array<{ id: EditableField | "recorderSelection" | "save" | "cancel"; label: string }> = [
      { id: "recorderSelection", label: `Recorder: ${selectedRecorder === "local" ? "Local recording" : "Bridge recording"} (${selectedStatus})` },
      { id: "shortcut", label: `Shortcut: ${display(values.shortcut)}` },
      { id: "language", label: `Language: ${display(values.language)}` },
      { id: "openaiModel", label: `OpenAI model: ${display(values.openaiModel)}` },
      { id: "timeoutMs", label: `Transcription timeout: ${display(values.timeoutMs)} ms` },
      { id: "maxRecordingMs", label: `Maximum recording: ${display(values.maxRecordingMs)} ms` },
      { id: "spinner", label: `Spinner: ${display(values.spinner)}` },
      { id: "save", label: "Save changes" },
      { id: "cancel", label: "Cancel" },
    ];
    const overrideNames = (Object.keys(FIELD_ENVIRONMENT) as EditableField[])
      .map((field) => env[FIELD_ENVIRONMENT[field]] ? FIELD_ENVIRONMENT[field] : undefined)
      .filter(Boolean);
    const title = [
      "Pi Dictation settings",
      `Recorder selection: ${selectedRecorder === "local" ? "Local recording" : "Bridge recording"}`,
      `Backend: ${backend}`,
      overrideNames.length ? `Environment overrides: ${overrideNames.join(", ")}` : "Environment overrides: none",
    ].join("\n");
    const selected = await ctx.ui.select(title, entries.map(({ label }) => label));
    if (!selected) return;
    const entry = entries.find(({ label }) => label === selected);
    if (!entry || entry.id === "cancel") return;

    if (entry.id === "save") {
      if (dirty.size === 0 && !recorderSelectionDirty) {
        ctx.ui.notify("Pi Dictation settings were not changed.", "info");
        return;
      }
      let releaseSelectionLock = async () => {};
      const selectedBridge = draft.recorders?.selected === "bridge" ? draft.recorders.bridge : undefined;
      if (selectedBridge) {
        try {
          releaseSelectionLock = await acquireBridgeLock(selectedBridge);
        } catch (error) {
          ctx.ui.notify(`Recorder selection was not saved: ${error.message}.`, "error");
          return;
        }
      }
      let latest: DictationConfigFile;
      try {
        latest = readConfigFile(path);
      } catch (error) {
        await releaseSelectionLock();
        ctx.ui.notify(`Settings were not saved because the configuration changed and is invalid: ${error.message}`, "error");
        return;
      }
      latest = migrateRecorderConfiguration(latest);
      for (const field of dirty) {
        const value = draft[field];
        if (value === undefined) delete latest[field];
        else (latest as Record<string, unknown>)[field] = value;
      }
      if (recorderSelectionDirty && latest.recorders) {
        if (draft.recorders?.selected === "bridge" && !latest.recorders.bridge) {
          await releaseSelectionLock();
          ctx.ui.notify("Recorder selection was not saved because Bridge recording is no longer configured.", "error");
          return;
        }
        latest.recorders.selected = draft.recorders?.selected || "local";
      }
      if (latest.recorders?.selected === "bridge" && latest.recorders.bridge) {
        statuses.bridge = await checkBridge({ ...latest.recorders.bridge, type: "bridge" })
          ? "available"
          : "unavailable";
      }
      try {
        await writeConfigFileAtomic(latest, path);
      } catch (error) {
        await releaseSelectionLock();
        ctx.ui.notify(`Failed to save Pi Dictation settings: ${error.message}`, "error");
        return;
      }
      await releaseSelectionLock();
      const messages = ["Saved Pi Dictation settings. Changes apply to the next recording."];
      if (dirty.has("shortcut")) messages.push("Shortcut changes require /reload or restart.");
      if (recorderSelectionDirty) {
        const selection = draft.recorders?.selected || "local";
        const status = selection === "local" ? statuses.local : statuses.bridge;
        if (status === "unavailable") messages.push("The selected Recorder is currently unavailable; run Pi Dictation doctor before recording.");
      }
      const overridden = [...dirty].map((field) => FIELD_ENVIRONMENT[field]).filter((name) => env[name]);
      if (overridden.length) messages.push(`Saved values are currently overridden by ${overridden.join(", ")}.`);
      ctx.ui.notify(messages.join(" "), "info");
      return;
    }

    try {
      if (entry.id === "recorderSelection") {
        const choices = [
          `Local recording — ${statuses.local}`,
          `Bridge recording — ${statuses.bridge}`,
        ];
        const choice = await ctx.ui.select("Recorder selection", choices);
        if (!choice) continue;
        const selection: RecorderSelection = choice.startsWith("Bridge") ? "bridge" : "local";
        if (selection === "bridge" && statuses.bridge === "not configured") {
          ctx.ui.notify("Bridge recording is not configured. Install a Bridge before selecting it.", "warning");
          continue;
        }
        if (draft.recorders) draft.recorders.selected = selection;
        recorderSelectionDirty = true;
        continue;
      }
      if (entry.id === "shortcut") {
        const choice = await ctx.ui.select("Dictation shortcut", SHORTCUTS);
        if (!choice) continue;
        draft.shortcut = choice === "(default)" ? undefined : choice;
      } else {
        const current = draft[entry.id] ?? "";
        const edited = await ctx.ui.editor(
          `${entry.label.split(":")[0]} (blank = default)`,
          String(current)
        );
        if (edited === undefined) continue;
        if (entry.id === "timeoutMs" || entry.id === "maxRecordingMs") {
          draft[entry.id] = parseDuration(edited, entry.id);
        } else {
          const value = parseSingleLine(edited, entry.id);
          if (entry.id === "spinner" && value && !cliSpinners[value]) {
            throw new Error("spinner must be a cli-spinners name");
          }
          draft[entry.id] = value;
        }
      }
      dirty.add(entry.id);
    } catch (error) {
      ctx.ui.notify(`Invalid setting: ${error.message}`, "error");
    }
  }
}
