// Pi Dictation extension
//
// Press Insert (default) or run /dictate to start recording.
// Press it again to stop, transcribe, and paste the text into Pi's editor.
//
// Optional config file: ~/.pi/agent/pi-dictation.json
// {
//   "shortcut": "insert",
//   "language": "ja",
//   "transcribeCommand": "whisper-cli -m ~/models/ggml-small.bin -f {file} -l ja -otxt -of -",
//   "recordCommand": "pw-record --format s16 --rate 16000 --channels 1 {file}",
//   "maxRecordingMs": 600000,
//   "openaiModel": "gpt-4o-mini-transcribe",
//   "openaiApiKeyCommand": "secret-tool lookup service openai account pi-dictation"
// }
//
// Transcription backend order:
// 1. PI_DICTATION_TRANSCRIBE_CMD or config.transcribeCommand
// 2. OpenAI audio transcription when OPENAI_API_KEY is set
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import cliSpinners from "cli-spinners";

const execFileAsync = promisify(execFile);
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-dictation.json");
const DEFAULT_SHORTCUT = "insert";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_RECORDER_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_DETAIL_BYTES = 8 * 1024;
const STATUS_KEY = "pi-dictation";
const DEFAULT_SPINNER = "arc";
const FALLBACK_SPINNER = { interval: 140, frames: ["|", "/", "-", "\\"] };

type DictationConfigFile = {
  shortcut?: string;
  language?: string;
  recordCommand?: string;
  transcribeCommand?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiApiKeyCommand?: string;
  timeoutMs?: number;
  maxRecordingMs?: number;
  spinner?: string;
  configError?: string;
};

type BadgeOptions = {
  autoHideMs?: number;
  blink?: boolean;
  spin?: boolean;
  spinner?: string;
};

type ActiveRecording = {
  proc: ChildProcess;
  file: string;
  dir: string;
  stderrChunks: Buffer[];
  stopping: boolean;
  maxTimer?: ReturnType<typeof setTimeout>;
  stopPromise: Promise<void> | null;
  cancelRequested: boolean;
  abortController: AbortController;
};

function normalizeDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 100 ? duration : fallback;
}

function validateConfig(config) {
  const stringFields = [
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
  for (const field of stringFields) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`${field} must be a string`);
    }
  }
  for (const field of ["timeoutMs", "maxRecordingMs"]) {
    if (config[field] !== undefined && typeof config[field] !== "number") {
      throw new Error(`${field} must be a number`);
    }
  }
  return config;
}

function loadConfig() {
  let fromFile: DictationConfigFile = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("configuration root must be an object");
      }
      fromFile = validateConfig(parsed);
    } catch (error) {
      fromFile = { configError: `Failed to load ${CONFIG_PATH}: ${error.message}` };
    }
  }

  const timeoutMs = normalizeDuration(
    process.env.PI_DICTATION_TIMEOUT_MS || fromFile.timeoutMs || DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const maxRecordingMs = normalizeDuration(
    process.env.PI_DICTATION_MAX_RECORDING_MS || fromFile.maxRecordingMs || DEFAULT_MAX_RECORDING_MS,
    DEFAULT_MAX_RECORDING_MS
  );

  return {
    shortcut: process.env.PI_DICTATION_SHORTCUT || fromFile.shortcut || DEFAULT_SHORTCUT,
    language: process.env.PI_DICTATION_LANGUAGE || fromFile.language || "",
    recordCommand: process.env.PI_DICTATION_RECORD_CMD || fromFile.recordCommand || "",
    transcribeCommand: process.env.PI_DICTATION_TRANSCRIBE_CMD || fromFile.transcribeCommand || "",
    openaiModel: process.env.PI_DICTATION_OPENAI_MODEL || fromFile.openaiModel || "gpt-4o-mini-transcribe",
    openaiBaseUrl:
      process.env.PI_DICTATION_OPENAI_BASE_URL || fromFile.openaiBaseUrl || "https://api.openai.com/v1",
    openaiApiKey:
      process.env.PI_DICTATION_OPENAI_API_KEY || process.env.OPENAI_API_KEY || fromFile.openaiApiKey || "",
    openaiApiKeyCommand:
      process.env.PI_DICTATION_OPENAI_API_KEY_COMMAND || fromFile.openaiApiKeyCommand || "",
    timeoutMs,
    maxRecordingMs,
    spinner: process.env.PI_DICTATION_SPINNER || fromFile.spinner || DEFAULT_SPINNER,
    configError: fromFile.configError,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function errorDetail(value) {
  const sanitized = String(value || "").replace(/[^\t\n\x20-\x7e\u00a0-\uffff]/g, "�").trim();
  const bytes = Buffer.from(sanitized);
  if (bytes.length <= MAX_ERROR_DETAIL_BYTES) return sanitized;
  return `${bytes.subarray(0, MAX_ERROR_DETAIL_BYTES).toString("utf8")}\n[diagnostic truncated]`;
}

async function boundedResponseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes <= MAX_ERROR_DETAIL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const retained = value.subarray(0, MAX_ERROR_DETAIL_BYTES + 1 - bytes);
      chunks.push(Buffer.from(retained));
      bytes += retained.length;
      if (bytes > MAX_ERROR_DETAIL_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return errorDetail(Buffer.concat(chunks));
}

async function commandExists(command) {
  try {
    await execFileAsync("/bin/sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

async function defaultRecordCommand(file) {
  if (await commandExists("pw-record")) {
    return `pw-record --format s16 --rate 16000 --channels 1 ${shellQuote(file)}`;
  }
  if (await commandExists("arecord")) {
    return `arecord -q -f S16_LE -r 16000 -c 1 -t wav ${shellQuote(file)}`;
  }
  throw new Error("No recorder found. Install pw-record/arecord or set PI_DICTATION_RECORD_CMD.");
}

function expandFileTemplate(template, file) {
  if (template.includes("{file}")) {
    return template.replaceAll("{file}", shellQuote(file));
  }
  return `${template} ${shellQuote(file)}`;
}

function signalProcessGroup(proc, signal) {
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {}
  }
  try {
    proc.kill(signal);
  } catch {}
}

async function waitForExit(proc, timeoutMs = 3000, forceKill = () => proc.kill("SIGKILL")) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return { code: proc.exitCode, signal: proc.signalCode };
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      try {
        forceKill();
      } catch {}
    }, timeoutMs);
    timer.unref?.();
    proc.once("exit", done);
  });
}

function processGroupExists(proc) {
  if (process.platform === "win32" || !proc.pid) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcessGroup(proc, timeoutMs = 3000) {
  signalProcessGroup(proc, "SIGINT");
  const result = await waitForExit(proc, timeoutMs, () => signalProcessGroup(proc, "SIGKILL"));
  if (processGroupExists(proc)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (processGroupExists(proc)) signalProcessGroup(proc, "SIGKILL");
  }
  return result;
}

async function runIsolatedShellCommand(
  command: string,
  {
    cwd,
    signal,
    timeoutMs,
    maxBuffer,
  }: { cwd?: string; signal?: AbortSignal; timeoutMs: number; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("/bin/sh", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let stopReason = "";
    let settled = false;

    const requestStop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      void stopProcessGroup(proc).catch(() => {});
    };
    const onAbort = () => requestStop("aborted");
    const timer = setTimeout(() => requestStop("timed out"), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const collect = (target) => (chunk) => {
      const value = Buffer.from(chunk);
      outputBytes += value.length;
      if (outputBytes > maxBuffer) {
        requestStop("exceeded output limit");
        return;
      }
      target.push(value);
    };
    proc.stdout?.on("data", collect(stdoutChunks));
    proc.stderr?.on("data", collect(stderrChunks));

    const finish = async (error, code, processSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (processGroupExists(proc)) signalProcessGroup(proc, "SIGKILL");

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (error || stopReason || code !== 0) {
        const reason = error?.message || stopReason || processSignal || `exit code ${code}`;
        const failure = Object.assign(new Error(reason), { stdout, stderr });
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    };

    proc.once("error", (error) => void finish(error, null, null));
    proc.once("exit", (code, processSignal) => void finish(null, code, processSignal));
  });
}

async function transcribeWithCommand(config, file, cwd, signal) {
  const command = expandFileTemplate(config.transcribeCommand, file);
  try {
    const { stdout, stderr } = await runIsolatedShellCommand(command, {
      cwd,
      signal,
      timeoutMs: config.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const text = String(stdout || "").trim();
    if (!text) {
      throw new Error(String(stderr || "transcribeCommand produced no stdout").trim());
    }
    return text;
  } catch (error) {
    const stdout = error.stdout ? `\nstdout:\n${errorDetail(error.stdout)}` : "";
    const stderr = error.stderr ? `\nstderr:\n${errorDetail(error.stderr)}` : "";
    throw new Error(`transcribeCommand failed: ${error.message}${stdout}${stderr}`);
  }
}

async function resolveOpenAIApiKey(config, signal) {
  if (config.openaiApiKey) return config.openaiApiKey;
  if (!config.openaiApiKeyCommand) return "";

  try {
    const { stdout } = await runIsolatedShellCommand(config.openaiApiKeyCommand, {
      signal,
      timeoutMs: 5000,
      maxBuffer: 128 * 1024,
    });
    return String(stdout || "").trim();
  } catch (error) {
    const stdout = error.stdout ? `\nstdout:\n${errorDetail(error.stdout)}` : "";
    const stderr = error.stderr ? `\nstderr:\n${errorDetail(error.stderr)}` : "";
    throw new Error(`openaiApiKeyCommand failed: ${error.message}${stdout}${stderr}`);
  }
}

async function transcribeWithOpenAI(config, file, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(new Error(`OpenAI transcription timed out after ${config.timeoutMs}ms`)),
    config.timeoutMs
  );
  timer.unref?.();

  try {
    const apiKey = await resolveOpenAIApiKey(config, controller.signal);
    if (!apiKey) {
      throw new Error(
        "No transcription backend configured. Store an API key with secret-tool or set OPENAI_API_KEY."
      );
    }

    const audio = await readFile(file, { signal: controller.signal });
    const form = new FormData();
    form.append("model", config.openaiModel);
    if (config.language) form.append("language", config.language);
    form.append("file", new Blob([audio], { type: "audio/wav" }), "recording.wav");

    const endpoint = `${config.openaiBaseUrl.replace(/\/$/, "")}/audio/transcriptions`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw new Error(`OpenAI request to ${endpoint} failed: ${error.message}`);
    }

    if (!response.ok) {
      const body = await boundedResponseText(response).catch(() => "");
      throw new Error(`OpenAI transcription failed: HTTP ${response.status} ${body}`);
    }

    const json = await response.json();
    const text = String(json.text || "").trim();
    if (!text) throw new Error("OpenAI transcription returned empty text.");
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function transcribe(config, file, cwd, signal) {
  if (config.transcribeCommand) {
    return transcribeWithCommand(config, file, cwd, signal);
  }
  return transcribeWithOpenAI(config, file, signal);
}

function resolveSpinner(name) {
  return cliSpinners?.[name] || cliSpinners?.[DEFAULT_SPINNER] || FALLBACK_SPINNER;
}

class VoiceBadge {
  ui: any;
  label: string;
  spinner: { interval: number; frames: string[] };
  frameIndex: number;
  blinkOn: boolean;
  animationMode: "none" | "spin" | "blink";
  timer: ReturnType<typeof setInterval> | null;

  constructor(ui: any, label: string, options: BadgeOptions = {}) {
    this.ui = ui;
    this.label = label;
    this.spinner = resolveSpinner(options.spinner);
    this.frameIndex = 0;
    this.blinkOn = true;
    this.animationMode = "none";
    this.timer = null;
    this.setLabel(label, options);
  }

  setLabel(label: string, options: BadgeOptions = {}) {
    this.label = label;
    if (options.spinner) this.spinner = resolveSpinner(options.spinner);
    this.animationMode = options.spin ? "spin" : options.blink ? "blink" : "none";
    this.frameIndex = 0;
    this.blinkOn = true;
    this.restartAnimationTimer();
    this.render();
  }

  restartAnimationTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.animationMode === "none") return;

    const interval = this.animationMode === "spin" ? this.spinner.interval : 520;
    this.timer = setInterval(() => {
      if (this.animationMode === "spin") {
        this.frameIndex = (this.frameIndex + 1) % this.spinner.frames.length;
      } else {
        this.blinkOn = !this.blinkOn;
      }
      this.render();
    }, interval || FALLBACK_SPINNER.interval);
    this.timer.unref?.();
  }

  render() {
    const indicator =
      this.animationMode === "spin"
        ? `${this.spinner.frames[this.frameIndex] ?? ""} `
        : this.animationMode === "blink" && this.blinkOn
          ? "● "
          : "";
    this.ui.setStatus(STATUS_KEY, `${indicator}${this.label}`);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ui.setStatus(STATUS_KEY, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  let recording: ActiveRecording | null = null;
  let recordingPhase: "idle" | "starting" | "recording" | "stopping" = "idle";
  let shuttingDown = false;
  let cancelStartupRequested = false;
  const recordingProcesses = new Set<ActiveRecording>();
  let badge = null;
  let badgeHideTimer = null;

  function clearBadgeTimer() {
    if (badgeHideTimer) {
      clearTimeout(badgeHideTimer);
      badgeHideTimer = null;
    }
  }

  function clearBadge() {
    clearBadgeTimer();
    badge?.dispose();
    badge = null;
  }

  function showBadge(ctx: any, label: string, options: BadgeOptions = {}) {
    clearBadgeTimer();
    if (badge) badge.setLabel(label, options);
    else badge = new VoiceBadge(ctx.ui, label, options);

    if (options.autoHideMs) {
      badgeHideTimer = setTimeout(() => clearBadge(), options.autoHideMs);
      badgeHideTimer.unref?.();
    }
  }

  function showDone(ctx) {
    showBadge(ctx, "✓ Done", { autoHideMs: 1200 });
  }

  async function startRecording(ctx) {
    if (shuttingDown || recordingPhase !== "idle") return;
    recordingPhase = "starting";
    cancelStartupRequested = false;

    const config = loadConfig();
    let dir = "";
    let ownershipTransferred = false;
    try {
      if (config.configError) {
        ctx.ui.notify(config.configError, "error");
        return;
      }

      dir = await mkdtemp(join(tmpdir(), "pi-dictation-"));
      await chmod(dir, 0o700);
      if (shuttingDown || cancelStartupRequested) return;
      const file = join(dir, "recording.wav");
      const command = config.recordCommand
        ? expandFileTemplate(config.recordCommand, file)
        : await defaultRecordCommand(file);
      if (shuttingDown || cancelStartupRequested) return;
      const maxRecordingSeconds = Math.ceil(config.maxRecordingMs / 1000);
      const watchdog = `trap '' INT TERM HUP; sleep ${maxRecordingSeconds}; kill -INT -\"$pgid\" 2>/dev/null; sleep 5; kill -KILL -\"$pgid\" 2>/dev/null`;
      const boundedCommand = `pgid=$$; (${watchdog}) & exec /bin/sh -lc ${shellQuote(`exec ${command}`)}`;

      const proc = spawn("/bin/sh", ["-lc", boundedCommand], {
        cwd: ctx.cwd,
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      });

      const stderrChunks = [];
      let stderrBytes = 0;
      proc.stderr?.on("data", (chunk) => {
        if (stderrBytes >= MAX_RECORDER_STDERR_BYTES) return;
        const value = Buffer.from(chunk);
        const retained = value.subarray(0, MAX_RECORDER_STDERR_BYTES - stderrBytes);
        stderrChunks.push(retained);
        stderrBytes += retained.length;
      });

      const active: ActiveRecording = {
        proc,
        file,
        dir,
        stderrChunks,
        stopping: false,
        stopPromise: null,
        cancelRequested: false,
        abortController: new AbortController(),
      };
      recording = active;
      recordingPhase = "recording";
      recordingProcesses.add(active);
      ownershipTransferred = true;

      active.maxTimer = setTimeout(() => {
        if (active.stopping) return;
        void stopProcessGroup(proc).catch(() => {});
      }, config.maxRecordingMs);
      active.maxTimer.unref?.();

      let terminationHandled = false;
      const handleRecorderTermination = (code, signal, error) => {
        if (terminationHandled) return;
        terminationHandled = true;
        clearTimeout(active.maxTimer);
        if (active.stopping) return;
        if (processGroupExists(proc)) signalProcessGroup(proc, "SIGKILL");
        recordingProcesses.delete(active);
        if (!recording || recording.proc !== proc) {
          void rm(dir, { recursive: true, force: true });
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        recording = null;
        recordingPhase = "idle";
        showBadge(ctx, "Stopped", { autoHideMs: 1800 });
        ctx.ui.notify(
          `Voice recording stopped unexpectedly (${error?.message || signal || code}).${stderr ? ` ${stderr}` : ""}`,
          "error"
        );
        void rm(dir, { recursive: true, force: true });
      };
      proc.once("error", (error) => handleRecorderTermination(null, null, error));
      proc.once("exit", (code, signal) => handleRecorderTermination(code, signal, null));

      showBadge(ctx, "Recording", { blink: true });
    } catch (error) {
      if (!shuttingDown && !cancelStartupRequested) {
        showBadge(ctx, "Failed", { autoHideMs: 2000 });
        ctx.ui.notify(`Dictation failed: ${error.message}`, "error");
      }
    } finally {
      if (!ownershipTransferred) {
        cancelStartupRequested = false;
        if (!shuttingDown) recordingPhase = "idle";
        if (dir) void rm(dir, { recursive: true, force: true });
      }
    }
  }

  async function stopRecording(ctx, { cancel = false } = {}) {
    const active = recording;
    if (!active) {
      if (recordingPhase === "starting") {
        cancelStartupRequested = true;
        if (!shuttingDown) showBadge(ctx, "Cancelled", { autoHideMs: 1000 });
        return;
      }
      if (!shuttingDown) showBadge(ctx, "Idle", { autoHideMs: 1000 });
      return;
    }
    if (cancel) active.cancelRequested = true;
    if (active.stopPromise) {
      if (cancel) active.abortController.abort();
      return active.stopPromise;
    }

    const config = loadConfig();
    active.stopping = true;
    recordingPhase = "stopping";
    clearTimeout(active.maxTimer);
    if (!shuttingDown) showBadge(ctx, "Processing", { spin: true, spinner: config.spinner });

    active.stopPromise = (async () => {
      try {
        await stopProcessGroup(active.proc, 3000);

        if (active.cancelRequested || shuttingDown) {
          if (!shuttingDown) showBadge(ctx, "Cancelled", { autoHideMs: 1000 });
          return;
        }

        let size = 0;
        try {
          size = (await stat(active.file)).size;
        } catch {}
        if (size < 1024) {
          const stderr = Buffer.concat(active.stderrChunks).toString("utf8").trim();
          throw new Error(`Recording file is empty or too small.${stderr ? ` ${stderr}` : ""}`);
        }

        showBadge(ctx, "Transcribing", { spin: true, spinner: config.spinner });
        const text = await transcribe(config, active.file, ctx.cwd, active.abortController.signal);
        if (shuttingDown || active.cancelRequested) return;
        ctx.ui.pasteToEditor(text);
        showDone(ctx);
      } catch (error) {
        if (!shuttingDown && active.cancelRequested) {
          showBadge(ctx, "Cancelled", { autoHideMs: 1000 });
        } else if (!shuttingDown) {
          showBadge(ctx, "Failed", { autoHideMs: 2000 });
          ctx.ui.notify(`Dictation failed: ${error.message}`, "error");
        }
      } finally {
        if (recording === active) recording = null;
        if (!shuttingDown) recordingPhase = "idle";
        recordingProcesses.delete(active);
        await rm(active.dir, { recursive: true, force: true }).catch(() => {});
      }
    })();

    return active.stopPromise;
  }

  async function toggle(ctx) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Dictation requires Pi interactive TUI mode.", "error");
      return;
    }
    if (recordingPhase === "starting") {
      await stopRecording(ctx, { cancel: true });
      return;
    }
    if (recordingPhase === "stopping") return;
    if (recordingPhase === "recording") {
      await stopRecording(ctx);
    } else {
      await startRecording(ctx);
    }
  }

  const initialConfig = loadConfig();
  const shortcut = (initialConfig.shortcut || DEFAULT_SHORTCUT) as Parameters<
    ExtensionAPI["registerShortcut"]
  >[0];
  pi.registerShortcut(shortcut, {
    description: "Start/stop dictation and paste transcription into the editor",
    handler: toggle,
  });

  pi.registerCommand("dictate", {
    description: "Start/stop dictation and paste transcription into the editor",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerCommand("dictate-cancel", {
    description: "Cancel active dictation",
    handler: async (_args, ctx) => stopRecording(ctx, { cancel: true }),
  });

  pi.registerCommand("dictate-help", {
    description: "Show dictation setup help",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      const backend = config.transcribeCommand
        ? "custom command"
        : config.openaiApiKey || config.openaiApiKeyCommand
          ? `OpenAI ${config.openaiModel}`
          : "not configured";
      ctx.ui.notify(
        `Pi Dictation: shortcut=${config.shortcut}, recorder=${config.recordCommand ? "custom" : "auto"}, transcriber=${backend}. Config: ${CONFIG_PATH}`,
        backend === "not configured" ? "warning" : "info"
      );
    },
  });

  pi.on("session_shutdown", async () => {
    clearBadge();
    shuttingDown = true;
    recordingPhase = "stopping";
    const activeRecordings = [...recordingProcesses];
    for (const active of activeRecordings) active.abortController.abort();
    await Promise.all(
      activeRecordings.map(async (active) => {
        if (active.stopPromise) return active.stopPromise;
        active.stopping = true;
        clearTimeout(active.maxTimer);
        await stopProcessGroup(active.proc, 1000).catch(() => {});
        recordingProcesses.delete(active);
        await rm(active.dir, { recursive: true, force: true }).catch(() => {});
      })
    );
    recording = null;
    recordingPhase = "idle";
  });
}
