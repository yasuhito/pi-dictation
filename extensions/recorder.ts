import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { RecorderConfig } from "./config.js";
import { GrowingPcm16WavInput } from "./live-level.js";
import { shellQuote } from "./shell.js";
import { createBridgeRecorder } from "./bridge-recorder.js";

const execFileAsync = promisify(execFile);
const LEVEL_INTERVAL_MS = 50;

export type LevelObservation = {
  sequence: number;
  capturedAtMs: number;
  dbfs: number | "silence";
};

export type RecorderStartOptions = {
  destination: string;
  maxDurationMs: number;
  signal: AbortSignal;
  onLevel(observation: LevelObservation): void;
};

export type Recording = {
  stop(): Promise<void>;
  cancel(): Promise<void>;
};

export type Recorder = {
  start(options: RecorderStartOptions): Promise<Recording>;
};

export type RecorderErrorCode =
  | "cancelled"
  | "cancellation-unconfirmed"
  | "duration-limit-reached"
  | "invalid-audio"
  | "outcome-unknown"
  | "recorder-busy"
  | "recorder-unavailable"
  | "recording-failed";

const SAFE_MESSAGES: Record<RecorderErrorCode, string> = {
  cancelled: "Recording was cancelled.",
  "cancellation-unconfirmed": "Cancellation could not be confirmed within five seconds; the recording owner may remain live on the companion.",
  "duration-limit-reached": "Recording reached the maximum duration.",
  "invalid-audio": "The recorder did not produce a complete PCM16 mono WAV.",
  "outcome-unknown": "The Bridge recording outcome could not be determined within the recovery window.",
  "recorder-busy": "Another Bridge recording is already in progress.",
  "recorder-unavailable": "No supported local recorder is available.",
  "recording-failed": "Voice recording stopped unexpectedly.",
};

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;

  constructor(code: RecorderErrorCode, options?: ErrorOptions) {
    super(SAFE_MESSAGES[code], options);
    this.name = "RecorderError";
    this.code = code;
  }
}

type RecorderEnvironment = {
  platform: NodeJS.Platform;
  commandExists(command: string): Promise<boolean>;
};

type LocalRecorderOptions = {
  command?: string;
  environment?: RecorderEnvironment;
  cwd?: string;
  onFailure?(error: RecorderError): void;
};

async function systemCommandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

const systemEnvironment: RecorderEnvironment = {
  platform: process.platform,
  commandExists: systemCommandExists,
};

export async function detectDefaultRecorder(
  environment: RecorderEnvironment = systemEnvironment
): Promise<"ffmpeg" | "pw-record" | "arecord"> {
  if (environment.platform === "darwin") {
    if (await environment.commandExists("ffmpeg")) return "ffmpeg";
    throw new RecorderError("recorder-unavailable");
  }
  if (environment.platform !== "linux") {
    throw new RecorderError("recorder-unavailable");
  }
  if (await environment.commandExists("pw-record")) return "pw-record";
  if (await environment.commandExists("arecord")) return "arecord";
  throw new RecorderError("recorder-unavailable");
}

function expandFileTemplate(template: string, file: string): string {
  return template.includes("{file}")
    ? template.replaceAll("{file}", shellQuote(file))
    : `${template} ${shellQuote(file)}`;
}

export async function defaultRecordCommand(
  file: string,
  environment: RecorderEnvironment = systemEnvironment
): Promise<string> {
  const recorder = await detectDefaultRecorder(environment);
  if (recorder === "ffmpeg") {
    return `ffmpeg -hide_banner -loglevel error -nostdin -f avfoundation -i ':default' -vn -ac 1 -ar 16000 -c:a pcm_s16le -flush_packets 1 -y ${shellQuote(file)}`;
  }
  if (recorder === "pw-record") {
    return `pw-record --format s16 --rate 16000 --channels 1 ${shellQuote(file)}`;
  }
  return `arecord -q -f S16_LE -r 16000 -c 1 -t wav ${shellQuote(file)}`;
}

function signalProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
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

function processGroupExists(proc: ChildProcess): boolean {
  if (process.platform === "win32" || !proc.pid) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(proc: ChildProcess, timeoutMs = 3000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => signalProcessGroup(proc, "SIGKILL"), timeoutMs);
    timer.unref?.();
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (processGroupExists(proc)) signalProcessGroup(proc, "SIGKILL");
}

async function stopProcessGroup(proc: ChildProcess, timeoutMs = 3000): Promise<void> {
  signalProcessGroup(proc, "SIGINT");
  await waitForExit(proc, timeoutMs);
}

async function waitForRecorderStartup(
  partial: string,
  proc: ChildProcess,
  signal: AbortSignal,
  timeoutMs = 3000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal.aborted) throw new RecorderError("cancelled");
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new RecorderError("recording-failed");
    }
    try {
      if ((await stat(partial)).size > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new RecorderError("recording-failed");
}

function rmsDbfs(samples: Int16Array): number | "silence" {
  if (!samples.length) return "silence";
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  if (sum === 0) return "silence";
  return 20 * Math.log10(Math.sqrt(sum / samples.length));
}

export async function validatePcm16MonoWav(path: string, signal?: AbortSignal): Promise<void> {
  const checkCancellation = () => {
    if (signal?.aborted) throw new RecorderError("cancelled");
  };
  checkCancellation();
  const size = (await stat(path)).size;
  if (size < 44) throw new RecorderError("invalid-audio");
  const handle = await open(path, "r");
  const readAt = async (position: number, length: number): Promise<Buffer> => {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new RecorderError("invalid-audio");
    return buffer;
  };
  try {
    const riff = await readAt(0, 12);
    const riffEnd = 8 + riff.readUInt32LE(4);
    if (
      riff.toString("ascii", 0, 4) !== "RIFF" ||
      riff.toString("ascii", 8, 12) !== "WAVE" ||
      riffEnd !== size
    ) throw new RecorderError("invalid-audio");

    let formatValid = false;
    let dataOffset = 0;
    let dataSize = 0;
    let chunkOffset = 12;
    for (; chunkOffset + 8 <= riffEnd; ) {
      checkCancellation();
      const header = await readAt(chunkOffset, 8);
      const chunkSize = header.readUInt32LE(4);
      const body = chunkOffset + 8;
      const next = body + chunkSize + (chunkSize % 2);
      if (next <= chunkOffset || next > riffEnd) throw new RecorderError("invalid-audio");
      const id = header.toString("ascii", 0, 4);
      if (id === "fmt ") {
        if (chunkSize < 16) throw new RecorderError("invalid-audio");
        const format = await readAt(body, 16);
        const sampleRate = format.readUInt32LE(4);
        formatValid =
          format.readUInt16LE(0) === 1 &&
          format.readUInt16LE(2) === 1 &&
          sampleRate >= 8_000 &&
          sampleRate <= 192_000 &&
          format.readUInt32LE(8) === sampleRate * 2 &&
          format.readUInt16LE(14) === 16 &&
          format.readUInt16LE(12) === 2;
      } else if (id === "data") {
        dataOffset = body;
        dataSize = chunkSize;
      }
      chunkOffset = next;
    }
    if (chunkOffset !== riffEnd || !formatValid || !dataOffset || dataSize < 2 || dataSize % 2 !== 0) {
      throw new RecorderError("invalid-audio");
    }

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let hasSignal = false;
    for (let position = dataOffset; position < dataOffset + dataSize; ) {
      checkCancellation();
      const length = Math.min(buffer.length, dataOffset + dataSize - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) throw new RecorderError("invalid-audio");
      for (let offset = 0; offset + 1 < bytesRead; offset += 2) {
        if (buffer.readInt16LE(offset) !== 0) hasSignal = true;
      }
      position += bytesRead;
    }
    if (!hasSignal) throw new RecorderError("invalid-audio");
  } finally {
    await handle.close();
  }
}

export function createLocalRecorder(options: LocalRecorderOptions = {}): Recorder {
  return {
    async start(startOptions) {
      if (startOptions.signal.aborted) throw new RecorderError("cancelled");
      const partial = `${startOptions.destination}.partial-${randomUUID()}`;
      const command = options.command
        ? expandFileTemplate(options.command, partial)
        : await defaultRecordCommand(partial, options.environment);
      if (startOptions.signal.aborted) throw new RecorderError("cancelled");

      const maxSeconds = Math.ceil(startOptions.maxDurationMs / 1000);
      const watchdog = `trap '' INT TERM HUP; sleep ${maxSeconds}; kill -INT -\"$pgid\" 2>/dev/null; sleep 5; kill -KILL -\"$pgid\" 2>/dev/null`;
      const boundedCommand = `pgid=$$; (${watchdog}) & exec /bin/sh -lc ${shellQuote(`exec ${command}`)}`;
      const proc = spawn("/bin/sh", ["-lc", boundedCommand], {
        cwd: options.cwd,
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      });
      proc.stderr?.resume();
      try {
        await waitForRecorderStartup(partial, proc, startOptions.signal);
      } catch (error) {
        await stopProcessGroup(proc).catch(() => {});
        await rm(partial, { force: true }).catch(() => {});
        throw error;
      }

      let state: "active" | "stopping" | "stopped" | "cancelled" | "failed" = "active";
      let stopPromise: Promise<void> | undefined;
      let cancelPromise: Promise<void> | undefined;
      let durationReached = false;
      let cancellationRequested = false;
      let unexpected = false;
      let sequence = 0;
      let levelReadInFlight = false;
      const input = new GrowingPcm16WavInput(partial);
      const levelTimer = setInterval(async () => {
        const currentSequence = sequence++;
        if (levelReadInFlight) return;
        levelReadInFlight = true;
        try {
          const samples = await input.readNewestInterval(LEVEL_INTERVAL_MS);
          if (!samples.length || state !== "active") return;
          startOptions.onLevel({
            sequence: currentSequence,
            capturedAtMs: currentSequence * LEVEL_INTERVAL_MS,
            dbfs: rmsDbfs(samples),
          });
        } catch {
        } finally {
          levelReadInFlight = false;
        }
      }, LEVEL_INTERVAL_MS);
      levelTimer.unref?.();
      const durationTimer = setTimeout(() => {
        if (state !== "active") return;
        durationReached = true;
        void stopProcessGroup(proc).catch(() => {});
      }, startOptions.maxDurationMs);
      durationTimer.unref?.();

      const cleanup = async () => {
        clearInterval(levelTimer);
        clearTimeout(durationTimer);
        await rm(partial, { force: true }).catch(() => {});
      };
      proc.once("error", () => {
        if (state !== "active") return;
        signalProcessGroup(proc, "SIGKILL");
        unexpected = true;
        state = "failed";
        void cleanup();
        options.onFailure?.(new RecorderError("recording-failed"));
      });
      proc.once("exit", () => {
        if (state !== "active") return;
        signalProcessGroup(proc, "SIGKILL");
        unexpected = true;
        state = "failed";
        void cleanup();
        options.onFailure?.(new RecorderError(durationReached ? "duration-limit-reached" : "recording-failed"));
      });

      const onStartupAbort = () => {
        if (state === "active") void recording.cancel();
      };
      startOptions.signal.addEventListener("abort", onStartupAbort, { once: true });

      const recording: Recording = {
        stop() {
          if (state === "stopped") return Promise.resolve();
          if (state === "cancelled") return Promise.reject(new RecorderError("cancelled"));
          if (state === "failed" || unexpected) {
            return Promise.reject(new RecorderError(durationReached ? "duration-limit-reached" : "recording-failed"));
          }
          if (stopPromise) return stopPromise;
          state = "stopping";
          stopPromise = (async () => {
            try {
              await stopProcessGroup(proc);
              if (cancellationRequested) throw new RecorderError("cancelled");
              if (durationReached) throw new RecorderError("duration-limit-reached");
              await validatePcm16MonoWav(partial);
              if (cancellationRequested) throw new RecorderError("cancelled");
              await rename(partial, startOptions.destination);
              if (cancellationRequested) {
                await rm(startOptions.destination, { force: true });
                throw new RecorderError("cancelled");
              }
              state = "stopped";
            } catch (error) {
              if (!cancellationRequested) state = "failed";
              if (error instanceof RecorderError) throw error;
              throw new RecorderError("recording-failed", { cause: error });
            } finally {
              startOptions.signal.removeEventListener("abort", onStartupAbort);
              clearInterval(levelTimer);
              clearTimeout(durationTimer);
              if (state !== "stopped") await rm(partial, { force: true }).catch(() => {});
            }
          })();
          return stopPromise;
        },
        cancel() {
          if (state === "stopped" || state === "cancelled") return Promise.resolve();
          if (cancelPromise) return cancelPromise;
          cancellationRequested = true;
          state = "cancelled";
          cancelPromise = (async () => {
            await stopProcessGroup(proc).catch(() => {});
            if (stopPromise) await stopPromise.catch(() => {});
            await rm(startOptions.destination, { force: true }).catch(() => {});
            await cleanup();
            startOptions.signal.removeEventListener("abort", onStartupAbort);
          })();
          return cancelPromise;
        },
      };

      if (startOptions.signal.aborted) {
        await recording.cancel();
        throw new RecorderError("cancelled");
      }
      startOptions.signal.removeEventListener("abort", onStartupAbort);
      return recording;
    },
  };
}

export function createRecorder(
  config: RecorderConfig,
  options: Omit<LocalRecorderOptions, "command"> = {}
): Recorder {
  if (config.type === "local") return createLocalRecorder({ ...options, command: config.command });
  return createBridgeRecorder(config);
}
