#!/usr/bin/env node
/** Reproducibly generate the README/catalog demo. No microphone or API key is used. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 960;
const HEIGHT = 420;
const FPS = 15;
const DURATION = 10;
const FRAMES = FPS * DURATION;
const RECORDING_START = 0.9;
const RECORDING_END = 5.15;
const PROCESSING_END = 5.85;
const TRANSCRIBING_END = 6.85;
const READY_END = 7.95;
const FADE_START = 9.35;
const BARS = "▁▂▃▄▅▆▇█";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repoRoot, "assets");
const framesDir = mkdtempSync(join(tmpdir(), "pi-dictation-demo-"));
mkdirSync(outputDir, { recursive: true });

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function smoothstep(edge0, edge1, value) {
  const x = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function voiceLevel(seconds) {
  if (seconds < 0.18 || seconds > 4.0) return 0;
  const wordCenters = [0.38, 0.72, 1.08, 1.43, 1.82, 2.17, 2.55, 2.9, 3.28, 3.67];
  let envelope = 0;
  for (const center of wordCenters) {
    const distance = Math.abs(seconds - center);
    envelope = Math.max(envelope, Math.max(0, 1 - distance / 0.24));
  }
  const articulation = 0.56 + 0.3 * Math.sin(seconds * 29) + 0.14 * Math.sin(seconds * 53 + 1.2);
  const value = envelope * Math.max(0.16, articulation);
  return Math.max(0, Math.min(7, Math.round(value * 7)));
}

function waveformSpans(time, columns = 73) {
  const elapsed = Math.max(0, Math.min(RECORDING_END - RECORDING_START, time - RECORDING_START));
  const values = [];
  for (let index = 0; index < columns; index++) {
    const sampleTime = elapsed - (columns - 1 - index) * 0.05;
    values.push(BARS[voiceLevel(sampleTime)]);
  }
  const first = Math.floor(columns * 0.2);
  const second = Math.floor(columns * 0.65);
  return [
    `<tspan fill="#53606f">${values.slice(0, first).join("")}</tspan>`,
    `<tspan fill="#8b98a8">${values.slice(first, second).join("")}</tspan>`,
    `<tspan fill="#58d6ff">${values.slice(second).join("")}</tspan>`,
  ].join("");
}

function keyBadge(label, opacity) {
  if (opacity <= 0) return "";
  return `<g opacity="${opacity.toFixed(3)}">
    <rect x="756" y="70" width="132" height="38" rx="9" fill="#20252e" stroke="#566170"/>
    <text x="822" y="95" text-anchor="middle" class="small" fill="#e8edf3">${escapeXml(label)}</text>
  </g>`;
}

function frameSvg(frame) {
  const time = frame / FPS;
  const recording = time >= RECORDING_START && time < RECORDING_END;
  const processing = time >= RECORDING_END && time < PROCESSING_END;
  const transcribing = time >= PROCESSING_END && time < TRANSCRIBING_END;
  const ready = time >= TRANSCRIBING_END && time < READY_END;
  const pasted = time >= TRANSCRIBING_END;
  const blinkOn = Math.floor((time - RECORDING_START) / 0.52) % 2 === 0;
  const elapsedSeconds = Math.max(0, Math.floor(time - RECORDING_START));
  const elapsed = `00:${String(elapsedSeconds).padStart(2, "0")}`;
  const fadeOpacity = 1 - smoothstep(FADE_START, DURATION, time);
  const overallOpacity = fadeOpacity;
  const insertStartOpacity = 1 - smoothstep(0.72, 1.0, time) * smoothstep(0.72, 1.0, time);
  const insertStopOpacity = time < 4.72 || time > 5.25 ? 0 : 1 - Math.abs(time - 4.98) / 0.27;

  let strip = "";
  if (recording) {
    strip = `<text x="64" y="252" class="mono strip">
      <tspan fill="${blinkOn ? "#ff5263" : "#11151b"}">●</tspan><tspan fill="#e8edf3"> REC  </tspan>${waveformSpans(time)}<tspan fill="#7f8a98">  ${elapsed}</tspan>
    </text>`;
  } else if (processing || transcribing) {
    const frames = ["◌", "◒", "◐", "◓"];
    const spinner = frames[Math.floor(time * 10) % frames.length];
    const label = processing ? "Processing recording…" : "Transcribing…";
    strip = `<text x="64" y="252" class="mono strip" fill="#ffca67">${spinner} ${label}</text>`;
  } else if (ready) {
    strip = `<text x="64" y="252" class="mono strip" fill="#62d394">✓ Dictation ready</text>`;
  }

  const editorText = pasted ? "Let’s make the command line feel a little more human." : "";
  const cursorX = pasted ? 64 + 18 + editorText.length * 10.15 : 82;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <style>
    .mono { font-family: "JetBrains Mono", "Noto Sans Mono", monospace; }
    .small { font: 14px "JetBrains Mono", monospace; }
    .strip { font-size: 17px; }
  </style>
  <rect width="960" height="420" rx="16" fill="#0b0e13"/>
  <g opacity="${overallOpacity.toFixed(3)}">
    <rect x="1" y="1" width="958" height="418" rx="15" fill="none" stroke="#303744" stroke-width="2"/>
    <rect x="1" y="1" width="958" height="42" rx="15" fill="#161a21"/>
    <rect x="1" y="28" width="958" height="15" fill="#161a21"/>
    <circle cx="25" cy="22" r="5" fill="#ff5f57"/><circle cx="43" cy="22" r="5" fill="#febc2e"/><circle cx="61" cy="22" r="5" fill="#28c840"/>
    <text x="480" y="27" text-anchor="middle" class="small" fill="#8b96a5">pi · ~/Work/pi-dictation</text>

    <text x="64" y="91" class="mono" font-size="20" font-weight="700" fill="#58d6ff">π  Pi Dictation</text>
    <text x="64" y="122" class="mono" font-size="15" fill="#8692a2">Push-to-talk voice input for Pi</text>
    <text x="64" y="175" class="mono" font-size="15" fill="#c7d0db">Press Insert, speak naturally, then press Insert again.</text>

    ${keyBadge("Insert", Math.max(0, insertStartOpacity))}
    ${keyBadge("Insert", Math.max(0, insertStopOpacity))}
    ${strip}

    <rect x="54" y="272" width="852" height="68" rx="8" fill="#12171e" stroke="#3b4655"/>
    <text x="82" y="312" class="mono" font-size="16" fill="#edf2f7">${escapeXml(editorText)}</text>
    <rect x="${cursorX}" y="292" width="2" height="24" fill="#58d6ff" opacity="${pasted ? 0.8 : 1}"/>

    <line x1="54" y1="359" x2="906" y2="359" stroke="#252c36"/>
    <text x="64" y="388" class="mono" font-size="13" fill="#657181">~/Work/pi-dictation</text>
    <text x="896" y="388" text-anchor="end" class="mono" font-size="13" fill="#657181">openai-codex · gpt-5.6-sol</text>
  </g>
  </svg>`;
}

try {
  for (let frame = 0; frame < FRAMES; frame++) {
    writeFileSync(join(framesDir, `frame-${String(frame).padStart(4, "0")}.svg`), frameSvg(frame));
  }

  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", String(FPS),
    "-i", join(framesDir, "frame-%04d.svg"),
    "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart",
    join(outputDir, "pi-dictation-demo.mp4"),
  ]);

  const palette = join(framesDir, "palette.png");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", String(FPS),
    "-i", join(framesDir, "frame-%04d.svg"),
    "-vf", "fps=12,scale=800:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff",
    palette,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", String(FPS),
    "-i", join(framesDir, "frame-%04d.svg"), "-i", palette,
    "-lavfi", "fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop", "0", join(outputDir, "pi-dictation-demo.gif"),
  ]);

  console.log(`Generated ${join(outputDir, "pi-dictation-demo.gif")}`);
  console.log(`Generated ${join(outputDir, "pi-dictation-demo.mp4")}`);
} finally {
  rmSync(framesDir, { recursive: true, force: true });
}
