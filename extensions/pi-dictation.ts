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
//   "recorder": { "type": "local", "command": "pw-record --format s16 --rate 16000 --channels 1 {file}" },
//   "maxRecordingMs": 600000,
//   "openaiModel": "gpt-4o-mini-transcribe"
// }
//
// Transcription backend order:
// 1. PI_DICTATION_TRANSCRIBE_CMD or config.transcribeCommand
// 2. OpenAI audio transcription when OPENAI_API_KEY is set
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cliSpinners from "cli-spinners";
import { DEFAULT_SHORTCUT, DEFAULT_SPINNER, getConfigPath, loadConfig } from "./config.js";
import { showDictationConfig } from "./config-ui.js";
import { levelForDb } from "./live-level.js";
import { createRecorder, type LevelEvent, type LevelObservation, type Recording } from "./recorder.js";
import { shellQuote } from "./shell.js";
const CONFIG_PATH = getConfigPath();
const MAX_ERROR_DETAIL_BYTES = 8 * 1024;
const WIDGET_KEY = "pi-dictation";
const FALLBACK_SPINNER = { interval: 140, frames: ["|", "/", "-", "\\"] };
const LEVEL_REFRESH_MS = 50;
const LEVEL_BARS = "▁▂▃▄▅▆▇█";

type StripOptions = {
  autoHideMs?: number;
  blink?: boolean;
  spin?: boolean;
  spinner?: string;
};

type LevelSlot = LevelObservation | { type: "unavailable" | "gap"; sequence: number; capturedAtMs: number };

type ActiveRecording = {
  config: ReturnType<typeof loadConfig>;
  handle: Recording;
  file: string;
  dir: string;
  stopPromise: Promise<void> | null;
  cancelRequested: boolean;
  abortController: AbortController;
};

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
        "No transcription backend configured. Configure openaiApiKeyCommand or set OPENAI_API_KEY."
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

class DictationStrip {
  ui: any;
  label: string;
  spinner: { interval: number; frames: string[] };
  frameIndex: number;
  blinkOn: boolean;
  animationMode: "none" | "spin" | "blink";
  timer: ReturnType<typeof setInterval> | null;
  tui: any;
  theme: any;
  startedAt: number;
  levels: number[];
  levelObservations: Map<number, LevelSlot>;
  levelDiagnosis: "ok" | "measurement-unavailable" | "transport-gap" | "transport-unavailable" | "conflicting-duplicate";
  levelTimer: ReturnType<typeof setInterval> | null;

  constructor(ui: any, label: string, options: StripOptions = {}) {
    this.ui = ui;
    this.label = label;
    this.spinner = resolveSpinner(options.spinner);
    this.frameIndex = 0;
    this.blinkOn = true;
    this.animationMode = "none";
    this.timer = null;
    this.startedAt = Date.now();
    this.levels = [];
    this.levelObservations = new Map();
    this.levelDiagnosis = "ok";
    this.levelTimer = null;
    this.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        this.tui = tui;
        this.theme = theme;
        return this;
      },
      { placement: "aboveEditor" }
    );
    this.setLabel(label, options);
  }

  setLabel(label: string, options: StripOptions = {}) {
    this.label = label;
    if (options.spinner) this.spinner = resolveSpinner(options.spinner);
    this.animationMode = options.spin ? "spin" : options.blink ? "blink" : "none";
    if (this.animationMode === "blink") this.startLiveLevels();
    else this.stopLiveLevels();
    this.frameIndex = 0;
    this.blinkOn = true;
    if (this.animationMode === "blink") this.startedAt = Date.now();
    this.restartAnimationTimer();
    this.requestRender();
  }

  setRecordingStartedAt(startedAt: number) {
    if (this.animationMode !== "blink" || !Number.isFinite(startedAt) || startedAt > Date.now()) return;
    this.startedAt = startedAt;
    this.rebuildLevels();
    this.requestRender();
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
      this.requestRender();
    }, interval || FALLBACK_SPINNER.interval);
    this.timer.unref?.();
  }

  requestRender() {
    this.tui?.requestRender();
  }

  startLiveLevels() {
    this.stopLiveLevels();
    this.levels = [];
    this.levelObservations.clear();
    this.levelDiagnosis = "ok";
    this.levelTimer = setInterval(() => {
      this.rebuildLevels();
      this.requestRender();
    }, LEVEL_REFRESH_MS);
    this.levelTimer.unref?.();
  }

  observeLevel(event: LevelEvent) {
    if (this.animationMode !== "blink") return;
    if (event.type === "transport") {
      this.levelDiagnosis = event.state === "connected" ? "ok" : "transport-unavailable";
      return;
    }
    if (event.type === "gap") {
      if (!Number.isInteger(event.fromSequence) || !Number.isInteger(event.toSequence) ||
          event.fromSequence < 0 || event.toSequence < event.fromSequence) return;
      const latestSlot = Math.max(0, Math.floor((Date.now() - this.startedAt) / LEVEL_REFRESH_MS));
      const first = Math.max(event.fromSequence, latestSlot - 499);
      const last = Math.min(event.toSequence, latestSlot + 499);
      for (let sequence = first; sequence <= last; sequence++) {
        if (!this.levelObservations.has(sequence)) this.levelObservations.set(sequence, {
          type: "gap", sequence, capturedAtMs: sequence * LEVEL_REFRESH_MS,
        });
      }
      this.levelDiagnosis = "transport-gap";
      this.rebuildLevels();
      this.requestRender();
      return;
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0 ||
        !Number.isFinite(event.capturedAtMs) || event.capturedAtMs !== event.sequence * LEVEL_REFRESH_MS ||
        (event.type === "observation" && event.dbfs !== "silence" && !Number.isFinite(event.dbfs))) return;
    const slot = event.capturedAtMs / LEVEL_REFRESH_MS;
    const existing = this.levelObservations.get(slot);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(event)) return;
      this.levelDiagnosis = "conflicting-duplicate";
      return;
    }
    this.levelObservations.set(slot, event);
    if (event.type === "unavailable") this.levelDiagnosis = "measurement-unavailable";
    this.rebuildLevels();
    this.requestRender();
  }

  rebuildLevels() {
    const latestSlot = Math.max(0, Math.floor((Date.now() - this.startedAt) / LEVEL_REFRESH_MS));
    const firstSlot = Math.max(0, latestSlot - 499);
    for (const sequence of this.levelObservations.keys()) {
      if (sequence < firstSlot) this.levelObservations.delete(sequence);
    }
    const levels: number[] = [];
    let smoothedRms = 0;
    for (let sequence = firstSlot; sequence <= latestSlot; sequence++) {
      const observation = this.levelObservations.get(sequence);
      if (!observation) {
        smoothedRms = 0;
        levels.push(0);
        continue;
      }
      if (observation.type !== "observation" || observation.dbfs === "silence") {
        smoothedRms = 0;
        levels.push(0);
        continue;
      }
      const rawRms = 10 ** (observation.dbfs / 20);
      const coefficient = rawRms > smoothedRms ? 0.82 : 0.45;
      smoothedRms += (rawRms - smoothedRms) * coefficient;
      levels.push(levelForDb(20 * Math.log10(smoothedRms)));
    }
    this.levels = levels;
  }

  stopLiveLevels() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (this.animationMode === "blink") {
      const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
      const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
      const marker = this.blinkOn ? this.theme?.bold(this.theme?.fg("error", "●") ?? "●") ?? "●" : " ";
      const left = `${marker} REC  `;
      const leftWidth = "● REC  ".length;
      const right = `  ${elapsed}`;
      if (safeWidth < leftWidth + right.length) {
        return [truncateToWidth(`${this.blinkOn ? "●" : " "} REC ${elapsed}`, safeWidth, "")];
      }
      const waveWidth = safeWidth - leftWidth - right.length;
      const selected = waveWidth > 0 ? this.levels.slice(-waveWidth) : [];
      const levels = Array(Math.max(0, waveWidth - selected.length)).fill(0).concat(selected);
      const wave = levels.map((level, index) => {
        const ratio = (index + 1) / waveWidth;
        const color = ratio <= 0.2 ? "dim" : ratio <= 0.65 ? "muted" : "accent";
        const bar = LEVEL_BARS[level] ?? LEVEL_BARS[0];
        return this.theme?.fg(color, bar) ?? bar;
      }).join("");
      return [`${left}${wave}${right}`];
    }

    let indicator = this.animationMode === "spin" ? (this.spinner.frames[this.frameIndex] ?? "") : "";
    let color = "warning";
    if (this.label === "Dictation ready") {
      indicator = "✓";
      color = "success";
    } else if (this.label === "Dictation cancelled") {
      indicator = "–";
      color = "dim";
    } else if (this.label === "Dictation failed") {
      indicator = "×";
      color = "error";
    }
    const plain = `${indicator}${indicator ? " " : ""}${this.label}`;
    const styled = this.theme?.fg(color, plain) ?? plain;
    return [truncateToWidth(styled, safeWidth, "")];
  }

  remove() {
    this.dispose();
    this.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
  }

  dispose() {
    this.stopLiveLevels();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export default function (pi: ExtensionAPI) {
  let recording: ActiveRecording | null = null;
  let recordingPhase: "idle" | "starting" | "recording" | "stopping" = "idle";
  let shuttingDown = false;
  let cancelStartupRequested = false;
  let startupAbortController: AbortController | null = null;
  const activeRecordings = new Set<ActiveRecording>();
  let strip = null;
  let stripHideTimer = null;

  function clearStripTimer() {
    if (stripHideTimer) {
      clearTimeout(stripHideTimer);
      stripHideTimer = null;
    }
  }

  function clearStrip() {
    clearStripTimer();
    const currentStrip = strip;
    strip = null;
    currentStrip?.remove();
  }

  function showStrip(ctx: any, label: string, options: StripOptions = {}) {
    clearStripTimer();
    if (strip) strip.setLabel(label, options);
    else strip = new DictationStrip(ctx.ui, label, options);

    if (options.autoHideMs) {
      stripHideTimer = setTimeout(() => clearStrip(), options.autoHideMs);
      stripHideTimer.unref?.();
    }
  }

  function showDone(ctx) {
    showStrip(ctx, "Dictation ready", { autoHideMs: 1200 });
  }

  async function startRecording(ctx) {
    if (shuttingDown || recordingPhase !== "idle") return;
    recordingPhase = "starting";
    cancelStartupRequested = false;

    const config = loadConfig();
    let dir = "";
    let ownershipTransferred = false;
    const startupController = new AbortController();
    startupAbortController = startupController;
    try {
      if (config.configError) {
        showStrip(ctx, "Dictation failed", { autoHideMs: 2000 });
        ctx.ui.notify(config.configError, "error");
        return;
      }

      dir = await mkdtemp(join(tmpdir(), "pi-dictation-"));
      await chmod(dir, 0o700);
      if (shuttingDown || cancelStartupRequested) {
        startupController.abort();
        return;
      }
      const file = join(dir, "recording.wav");
      let active: ActiveRecording | undefined;
      let earlyFailure: Error | undefined;
      const handleFailure = (error: Error) => {
        if (!active) {
          earlyFailure = error;
          return;
        }
        if (active.stopPromise || recording !== active) return;
        recording = null;
        recordingPhase = "idle";
        activeRecordings.delete(active);
        showStrip(ctx, "Dictation failed", { autoHideMs: 2000 });
        ctx.ui.notify(`Dictation failed: ${error.message}`, "error");
        void rm(dir, { recursive: true, force: true });
      };
      const recorder = createRecorder(config.recorder, {
        cwd: ctx.cwd,
        onFailure: handleFailure,
      });
      const pendingLevelEvents: LevelEvent[] = [];
      let levelsReady = false;
      const handle = await recorder.start({
        destination: file,
        maxDurationMs: config.maxRecordingMs,
        signal: startupController.signal,
        onLevel(event) {
          if (levelsReady) strip?.observeLevel(event);
          else {
            pendingLevelEvents.push(event);
            if (pendingLevelEvents.length > 600) pendingLevelEvents.shift();
          }
        },
      });
      if (shuttingDown || cancelStartupRequested) {
        await handle.cancel();
        return;
      }
      active = {
        config,
        handle,
        file,
        dir,
        stopPromise: null,
        cancelRequested: false,
        abortController: new AbortController(),
      };
      recording = active;
      recordingPhase = "recording";
      activeRecordings.add(active);
      ownershipTransferred = true;
      showStrip(ctx, "Recording", { blink: true });
      strip?.setRecordingStartedAt(handle.startedAt);
      levelsReady = true;
      for (const event of pendingLevelEvents) strip?.observeLevel(event);
      if (earlyFailure) handleFailure(earlyFailure);
    } catch (error) {
      if (!shuttingDown && !cancelStartupRequested) {
        showStrip(ctx, "Dictation failed", { autoHideMs: 2000 });
        ctx.ui.notify(`Dictation failed: ${error.message}`, "error");
      }
    } finally {
      if (startupAbortController === startupController) startupAbortController = null;
      if (!ownershipTransferred) {
        cancelStartupRequested = false;
        if (!shuttingDown) recordingPhase = "idle";
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function stopRecording(ctx, { cancel = false } = {}) {
    const active = recording;
    if (!active) {
      if (recordingPhase === "starting") {
        cancelStartupRequested = true;
        startupAbortController?.abort();
        if (!shuttingDown) showStrip(ctx, "Dictation cancelled", { autoHideMs: 1000 });
        return;
      }
      if (!shuttingDown) showStrip(ctx, "Idle", { autoHideMs: 1000 });
      return;
    }
    if (cancel) active.cancelRequested = true;
    if (active.stopPromise) {
      if (cancel) {
        active.abortController.abort();
        await active.handle.cancel();
      }
      return active.stopPromise;
    }

    const config = active.config;
    recordingPhase = "stopping";
    if (!shuttingDown) showStrip(ctx, "Processing recording…", { spin: true, spinner: config.spinner });

    active.stopPromise = (async () => {
      try {
        if (active.cancelRequested || shuttingDown) await active.handle.cancel();
        else await active.handle.stop();

        if (active.cancelRequested || shuttingDown) {
          if (!shuttingDown) showStrip(ctx, "Dictation cancelled", { autoHideMs: 1000 });
          return;
        }

        showStrip(ctx, "Transcribing…", { spin: true, spinner: config.spinner });
        const text = await transcribe(config, active.file, ctx.cwd, active.abortController.signal);
        if (shuttingDown || active.cancelRequested) return;
        ctx.ui.pasteToEditor(text);
        showDone(ctx);
      } catch (error) {
        if (!shuttingDown && active.cancelRequested) {
          showStrip(ctx, "Dictation cancelled", { autoHideMs: 1000 });
        } else if (!shuttingDown) {
          showStrip(ctx, "Dictation failed", { autoHideMs: 2000 });
          ctx.ui.notify(`Dictation failed: ${error.message}`, "error");
        }
      } finally {
        if (recording === active) recording = null;
        if (!shuttingDown) recordingPhase = "idle";
        activeRecordings.delete(active);
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

  pi.registerCommand("dictate-config", {
    description: "Configure Pi Dictation",
    handler: async (_args, ctx) => showDictationConfig(ctx),
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
        `Pi Dictation: shortcut=${config.shortcut}, recorder=${config.recorder.type}${config.recorder.type === "local" && config.recorder.command ? " (custom)" : ""}, transcriber=${backend}. Config: ${CONFIG_PATH}`,
        backend === "not configured" ? "warning" : "info"
      );
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    startupAbortController?.abort();
    clearStrip();
    recordingPhase = "stopping";
    const shutdownRecordings = [...activeRecordings];
    for (const active of shutdownRecordings) active.abortController.abort();
    await Promise.all(
      shutdownRecordings.map(async (active) => {
        if (active.stopPromise) return active.stopPromise;
        await active.handle.cancel().catch(() => {});
        activeRecordings.delete(active);
        await rm(active.dir, { recursive: true, force: true }).catch(() => {});
      })
    );
    recording = null;
    recordingPhase = "idle";
  });
}
