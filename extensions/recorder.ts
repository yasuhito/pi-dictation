import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote } from "./shell.js";

const execFileAsync = promisify(execFile);

type RecorderEnvironment = {
  platform: NodeJS.Platform;
  commandExists(command: string): Promise<boolean>;
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
    throw new Error("No recorder found. Install ffmpeg or set PI_DICTATION_RECORD_CMD.");
  }
  if (environment.platform !== "linux") {
    throw new Error(`Unsupported recording platform: ${environment.platform}`);
  }
  if (await environment.commandExists("pw-record")) return "pw-record";
  if (await environment.commandExists("arecord")) return "arecord";
  throw new Error("No recorder found. Install pw-record/arecord or set PI_DICTATION_RECORD_CMD.");
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
