import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { EffectiveDictationConfig } from "./config.js";
import { checkBridgeRecorder } from "./bridge-recorder.js";

export type DoctorReport = {
  ready: boolean;
  text: string;
};

function commandExists(command: string, path = process.env.PATH || ""): boolean {
  for (const directory of path.split(":")) {
    if (!directory) continue;
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function versionAtLeast(current: string, minimum: number[]): boolean {
  const parts = current.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    if ((parts[index] || 0) > minimum[index]) return true;
    if ((parts[index] || 0) < minimum[index]) return false;
  }
  return true;
}

export async function diagnoseDictation(
  config: EffectiveDictationConfig,
  { platform = process.platform, path = process.env.PATH || "", nodeVersion = process.versions.node } = {}
): Promise<DoctorReport> {
  const issues: string[] = [];
  const lines = ["Pi Dictation doctor", ""];

  if (versionAtLeast(nodeVersion, [22, 19, 0])) lines.push(`Node: ok (v${nodeVersion})`);
  else {
    lines.push(`Node: unavailable (v${nodeVersion}; requires >=22.19.0)`);
    issues.push("upgrade Node.js to 22.19.0 or newer");
  }
  lines.push("Pi: ok (extension loaded)");

  if (platform === "linux") lines.push("Platform: ok (linux)");
  else if (platform === "darwin") lines.push("Platform: ok (macOS)");
  else {
    lines.push(`Platform: unsupported (${platform}; Linux or macOS required)`);
    issues.push("use Pi Dictation on Linux or macOS");
  }

  if (config.configError) {
    lines.push("Config: invalid (~/.pi/agent/pi-dictation.json)");
    issues.push("fix ~/.pi/agent/pi-dictation.json");
  } else {
    lines.push("Config: ok (~/.pi/agent/pi-dictation.json or defaults)");
  }

  if (config.recorder.type === "bridge") {
    if (await checkBridgeRecorder(config.recorder)) lines.push("Recorder: ok (Bridge recording available)");
    else {
      lines.push("Recorder: unavailable (Bridge recording health check failed)");
      issues.push("run pi-dictation bridge doctor on the Mac that owns the microphone");
    }
  } else if (config.recorder.command) {
    lines.push("Recorder: ok (custom local command configured)");
  } else if (platform === "darwin") {
    if (commandExists("ffmpeg", path)) lines.push("Recorder: ok (ffmpeg AVFoundation auto-detected)");
    else {
      lines.push("Recorder: unavailable (ffmpeg not found)");
      issues.push("install ffmpeg or configure the Local Recorder command");
    }
  } else if (platform === "linux") {
    if (commandExists("pw-record", path)) lines.push("Recorder: ok (pw-record auto-detected)");
    else if (commandExists("arecord", path)) lines.push("Recorder: ok (arecord auto-detected)");
    else {
      lines.push("Recorder: unavailable (pw-record and arecord not found)");
      issues.push("install pw-record/arecord or configure the Local Recorder command");
    }
  } else {
    lines.push(`Recorder: unavailable (no default recorder for ${platform})`);
  }

  if (config.transcribeCommand) {
    lines.push("Backend: ok (custom command configured)");
  } else if (config.openaiApiKey || config.openaiApiKeyCommand) {
    lines.push(`Backend: ok (OpenAI-compatible transcription; model=${config.openaiModel})`);
  } else {
    lines.push("Backend: unavailable (no local command or OpenAI credential configured)");
    issues.push("configure a local transcription command or an OpenAI credential");
  }

  if (config.openaiApiKey) lines.push("OpenAI credential: present (value hidden)");
  else if (config.openaiApiKeyCommand) lines.push("OpenAI credential: configured (key command not executed)");
  else lines.push("OpenAI credential: absent");

  lines.push("", issues.length === 0 ? "Result: ready" : "Result: needs attention");
  for (const issue of issues) lines.push(`- ${issue}`);
  return { ready: issues.length === 0, text: lines.join("\n") };
}
