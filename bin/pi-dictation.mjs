#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeHostError,
  configuredAliases,
  diagnoseHosts,
  hasPendingRotation,
  hostLogs,
  hostStatus,
  inspectHostEffects,
  installHost,
  listHosts,
  precheckUpgrade,
  preflightHostRemovals,
  repairHost,
  remoteCredentialCommit,
  remoteCredentialRevoke,
  remoteHealth,
  remoteInfo,
  remoteListener,
  remotePrepare,
  remoteRemovalPreflight,
  revokeHost,
  rotateHost,
} from "./bridge-host.mjs";

const LABEL = "com.yasuhito.pi-dictation.bridge";
const APP_NAME = "PiDictationBridge";
const MAX_FRAME_BYTES = 64 * 1024;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-companion", "PiDictationBridge.swift");
const watchdogSourcePath = join(packageRoot, "native", "macos-companion", "PiDictationDurationWatchdog.swift");

class CliError extends Error {}

function paths() {
  const home = homedir();
  const productRoot = join(home, "Library", "Application Support", "pi-dictation");
  const root = join(productRoot, "bridge");
  const app = join(root, `${APP_NAME}.app`);
  const runtime = join(home, "Library", "Caches", "pi-dictation", "bridge");
  return {
    home,
    productRoot,
    root,
    app,
    runtime,
    socket: join(runtime, "companion.sock"),
    credential: join(root, "credential.json"),
    nextCredential: join(root, "credential.next.json"),
    previousCredential: join(root, "credential.previous.json"),
    sharedRevocation: join(root, "credential.revocation.json"),
    receipt: join(root, "ownership.json"),
    preflight: join(root, "preflight.json"),
    upgrade: join(root, "upgrade.json"),
    plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

function uid() {
  return process.getuid?.();
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function inspectPath(path, kind, mode, description = "managed artifact") {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new CliError(`Refusing symlink at ${description}.`);
  const expected = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!expected) throw new CliError(`Refusing unexpected file type at ${description}.`);
  if (uid() !== undefined && stat.uid !== uid()) {
    throw new CliError(`Refusing ${description} not owned by the current user.`);
  }
  if ((stat.mode & 0o777) !== mode) {
    throw new CliError(`Refusing ${description} with unsafe permissions (expected ${mode.toString(8)}).`);
  }
  if (kind === "file" && stat.nlink !== 1) {
    throw new CliError(`Refusing hard-linked ${description}.`);
  }
  return stat;
}

function inspectSocket(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") throw new CliError("The companion Unix socket is unavailable.");
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new CliError("Refusing unexpected file type at companion Unix socket.");
  if (uid() !== undefined && stat.uid !== uid()) throw new CliError("Refusing a companion Unix socket not owned by the current user.");
  if ((stat.mode & 0o777) !== 0o600) throw new CliError("Refusing a companion Unix socket with unsafe permissions.");
}

function ensureDirectory(path, mode, description) {
  const existing = inspectPath(path, "directory", mode, description);
  if (existing) return;
  mkdirSync(path, { mode });
  chmodSync(path, mode);
  inspectPath(path, "directory", mode, description);
}

function ensureManagedParents(p) {
  inspectPath(p.home, "directory", lstatSync(p.home).mode & 0o777, "home directory");
  const library = join(p.home, "Library");
  if (!existsSync(library)) mkdirSync(library, { mode: 0o700 });
  else {
    const stat = lstatSync(library);
    if (stat.isSymbolicLink()) throw new CliError("Refusing symlink at Library directory.");
    if (!stat.isDirectory() || (uid() !== undefined && stat.uid !== uid())) {
      throw new CliError("Refusing unowned or unexpected Library directory.");
    }
  }
  for (const parent of [join(library, "Application Support"), join(library, "Caches"), join(library, "LaunchAgents")]) {
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink()) throw new CliError(`Refusing symlink at ${basename(parent)} directory.`);
    if (!stat.isDirectory() || (uid() !== undefined && stat.uid !== uid())) {
      throw new CliError(`Refusing unowned or unexpected ${basename(parent)} directory.`);
    }
  }
  ensureDirectory(p.productRoot, 0o700, "Pi Dictation support directory");
  ensureDirectory(join(p.home, "Library", "Caches", "pi-dictation"), 0o700, "Pi Dictation cache directory");
}

function atomicWrite(path, contents, mode = 0o600) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = options.exposeOutput ? `: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}` : "";
    throw new CliError(`${options.failure || `${command} failed`}${detail}`);
  }
  return result.stdout.trim();
}

function validateToolchain() {
  let swiftc;
  try {
    swiftc = run("xcrun", ["--find", "swiftc"], {
      failure: "Swift compiler not found. Install Apple's command line tools with: xcode-select --install",
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Swift compiler not found. Install Apple's command line tools with: xcode-select --install");
  }
  if (!swiftc || !existsSync(swiftc)) {
    throw new CliError("Swift compiler not found. Install Apple's command line tools with: xcode-select --install");
  }
  const version = run(swiftc, ["--version"], {
    failure: "Swift is unusable. Update Xcode or Apple's command line tools and run xcode-select --switch.",
  });
  const match = version.match(/Swift version (\d+)\.(\d+)/i);
  if (!match || Number(match[1]) < 5 || (Number(match[1]) === 5 && Number(match[2]) < 9)) {
    throw new CliError("Swift 5.9 or newer is required. Update Xcode or Apple's command line tools.");
  }
  if (!/Target:\s*arm64-apple-macosx/i.test(version)) {
    throw new CliError("Bridge companion builds require an Apple Silicon Mac and a macOS Swift toolchain. Run xcode-select --switch with a current Xcode toolchain.");
  }
  const sdk = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
    failure: "The macOS SDK is unavailable. Update Xcode or Apple's command line tools.",
  });
  try {
    run("codesign", ["--version"], { failure: "codesign is unavailable. Install Apple's command line tools." });
  } catch (error) {
    // Apple's codesign prints its version to stderr on some releases; existence is proven later by signing.
    if (error instanceof CliError && !process.env.PATH?.split(":").some((entry) => existsSync(join(entry, "codesign")))) throw error;
  }
  return { swiftc, sdk };
}

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Pi Dictation Bridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Pi Dictation records speech only while you explicitly dictate or run microphone preflight.</string>
</dict></plist>
`;
}

function entitlementsPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`;
}

function packageVersion() {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

function buildBundle(output, installId = "standalone-build") {
  if (!existsSync(sourcePath) || !existsSync(watchdogSourcePath)) {
    throw new CliError("The packaged macOS companion source is missing. Reinstall pi-dictation.");
  }
  if (existsSync(output)) throw new CliError("Refusing to replace an existing build output.");
  const toolchain = validateToolchain();
  const parent = dirname(output);
  if (!existsSync(parent)) throw new CliError("Build output parent directory does not exist.");
  const stage = join(parent, `.${basename(output)}.${randomUUID()}.stage`);
  const entitlements = join(parent, `.pi-dictation-entitlements.${randomUUID()}.plist`);
  try {
    const macos = join(stage, "Contents", "MacOS");
    const resources = join(stage, "Contents", "Resources");
    mkdirSync(macos, { recursive: true, mode: 0o700 });
    mkdirSync(resources, { mode: 0o700 });
    const executable = join(macos, APP_NAME);
    run(toolchain.swiftc, [
      "-O", "-whole-module-optimization", "-parse-as-library", "-sdk", toolchain.sdk, "-target", "arm64-apple-macosx14.0",
      "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "AudioToolbox",
      "-framework", "CoreMedia", "-framework", "CryptoKit", "-framework", "Security",
      sourcePath, "-o", executable,
    ], {
      failure: "The Swift toolchain cannot build the macOS companion. Update Xcode or Apple's command line tools.",
    });
    chmodSync(executable, 0o700);
    const watchdog = join(macos, "PiDictationDurationWatchdog");
    run(toolchain.swiftc, [
      "-O", "-whole-module-optimization", "-parse-as-library", "-sdk", toolchain.sdk,
      "-target", "arm64-apple-macosx14.0", watchdogSourcePath, "-o", watchdog,
    ], {
      failure: "The Swift toolchain cannot build the duration watchdog. Update Xcode or Apple's command line tools.",
    });
    chmodSync(watchdog, 0o700);
    writeFileSync(join(stage, "Contents", "Info.plist"), infoPlist(packageVersion()), { mode: 0o600 });
    writeFileSync(join(resources, "ownership.json"), JSON.stringify({ product: LABEL, installId }) + "\n", { mode: 0o600 });
    writeFileSync(entitlements, entitlementsPlist(), { mode: 0o600 });
    run("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, stage], {
      failure: "The companion could not be signed. Update Xcode or Apple's command line tools.",
    });
    run("codesign", ["--verify", "--strict", stage], {
      failure: "The signed companion failed verification.",
    });
    renameSync(stage, output);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(entitlements, { force: true });
  }
}

function readJsonOwned(path, description, maximumBytes = 64 * 1024) {
  const info = inspectPath(path, "file", 0o600, description);
  if (!info || info.size < 2 || info.size > maximumBytes) {
    throw new CliError(`Refusing oversized ${description}.`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`Refusing invalid ${description}.`);
  }
  return value;
}

function validateCredential(path) {
  const credential = readJsonOwned(path, "bridge credential");
  if (typeof credential.id !== "string" || !/^[0-9a-f-]{36}$/i.test(credential.id) ||
      typeof credential.secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(credential.secret) ||
      Buffer.from(credential.secret, "base64").length !== 32) {
    throw new CliError("Refusing invalid bridge credential.");
  }
  return credential;
}

function existingInstallId(p) {
  if (!pathExists(p.root)) return randomUUID();
  inspectPath(p.root, "directory", 0o700, "bridge support directory");
  const receipt = readJsonOwned(p.receipt, "bridge ownership receipt");
  if (receipt.product !== LABEL || typeof receipt.installId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.installId)) {
    throw new CliError("Refusing bridge artifacts whose ownership cannot be proven.");
  }
  return receipt.installId;
}

function proveApp(path, installId) {
  inspectPath(path, "directory", 0o700, "installed companion app");
  if (readdirSync(path).join("\0") !== "Contents") throw new CliError("Refusing a companion app with unexpected entries.");
  const contents = join(path, "Contents");
  const resources = join(contents, "Resources");
  const macos = join(contents, "MacOS");
  inspectPath(contents, "directory", 0o700, "companion Contents directory");
  if (readdirSync(contents).sort().join("\0") !== ["Info.plist", "MacOS", "Resources", "_CodeSignature"].sort().join("\0")) throw new CliError("Refusing companion Contents with unexpected entries.");
  const signature = join(contents, "_CodeSignature");
  inspectPath(signature, "directory", 0o700, "companion code signature directory");
  if (readdirSync(signature).join("\0") !== "CodeResources") throw new CliError("Refusing companion code signature with unexpected entries.");
  inspectPath(join(signature, "CodeResources"), "file", 0o644, "companion code signature resources");
  inspectPath(resources, "directory", 0o700, "companion Resources directory");
  if (readdirSync(resources).join("\0") !== "ownership.json") throw new CliError("Refusing companion Resources with unexpected entries.");
  inspectPath(macos, "directory", 0o700, "companion executable directory");
  if (readdirSync(macos).sort().join("\0") !== [APP_NAME, "PiDictationDurationWatchdog"].sort().join("\0")) throw new CliError("Refusing companion executables with unexpected entries.");
  inspectPath(join(contents, "Info.plist"), "file", 0o600, "companion metadata");
  inspectPath(join(macos, APP_NAME), "file", 0o700, "companion executable");
  inspectPath(join(macos, "PiDictationDurationWatchdog"), "file", 0o700, "duration watchdog executable");
  const marker = readJsonOwned(join(resources, "ownership.json"), "companion ownership marker");
  if (marker.product !== LABEL || marker.installId !== installId) {
    throw new CliError("Refusing a companion app whose ownership cannot be proven.");
  }
}

function launchAgentPlist(p, installId, enabled = false) {
  const executable = join(p.app, "Contents", "MacOS", APP_NAME);
  const escaped = executable.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const supervision = enabled
    ? "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n"
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- pi-dictation-install-id:${installId} -->
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${escaped}</string></array>
${supervision}  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function install() {
  if (uid() === 0) throw new CliError("Refusing to install as root. Run as the logged-in Mac user without sudo.");
  const p = paths();
  const installId = existingInstallId(p);
  const temporary = mkdtempSync(join(tmpdir(), "pi-dictation-build-"));
  const built = join(temporary, `${APP_NAME}.app`);
  try {
    buildBundle(built, installId);
    ensureManagedParents(p);
    const rootExisted = existsSync(p.root);
    if (!rootExisted) {
      ensureDirectory(p.root, 0o700, "bridge support directory");
      atomicWrite(p.receipt, JSON.stringify({ product: LABEL, installId }) + "\n");
    } else {
      readJsonOwned(p.receipt, "bridge ownership receipt");
    }
    ensureDirectory(p.runtime, 0o700, "bridge runtime directory");

    if (pathExists(p.app)) proveApp(p.app, installId);
    if (pathExists(p.credential)) validateCredential(p.credential);
    if (pathExists(p.preflight)) {
      const previousPreflight = readJsonOwned(p.preflight, "preflight receipt");
      if (previousPreflight.installId !== installId) throw new CliError("Refusing an unowned preflight receipt.");
    }
    if (pathExists(p.socket)) {
      inspectSocket(p.socket);
      throw new CliError("The companion is running. Stop its user LaunchAgent before reinstalling.");
    }
    const plistContents = launchAgentPlist(p, installId);
    if (pathExists(p.plist)) {
      inspectPath(p.plist, "file", 0o600, "bridge LaunchAgent");
      if (!readFileSync(p.plist, "utf8").includes(`pi-dictation-install-id:${installId}`)) {
        throw new CliError("Refusing a LaunchAgent whose ownership cannot be proven.");
      }
    }

    const stagedApp = join(p.root, `.${APP_NAME}.${randomUUID()}.stage`);
    cpSync(built, stagedApp, { recursive: true });
    chmodSync(stagedApp, 0o700);
    chmodSync(join(stagedApp, "Contents"), 0o700);
    chmodSync(join(stagedApp, "Contents", "MacOS"), 0o700);
    chmodSync(join(stagedApp, "Contents", "Resources"), 0o700);
    chmodSync(join(stagedApp, "Contents", "_CodeSignature"), 0o700);
    chmodSync(join(stagedApp, "Contents", "_CodeSignature", "CodeResources"), 0o644);
    chmodSync(join(stagedApp, "Contents", "Info.plist"), 0o600);
    chmodSync(join(stagedApp, "Contents", "MacOS", APP_NAME), 0o700);
    chmodSync(join(stagedApp, "Contents", "MacOS", "PiDictationDurationWatchdog"), 0o700);
    chmodSync(join(stagedApp, "Contents", "Resources", "ownership.json"), 0o600);
    const backup = join(p.root, `.${APP_NAME}.${randomUUID()}.backup`);
    if (pathExists(p.app)) renameSync(p.app, backup);
    try {
      renameSync(stagedApp, p.app);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (pathExists(backup) && !pathExists(p.app)) renameSync(backup, p.app);
      throw error;
    }

    if (!pathExists(p.credential)) {
      atomicWrite(p.credential, JSON.stringify({ id: randomUUID(), secret: randomBytes(32).toString("base64") }) + "\n");
    }

    atomicWrite(p.plist, plistContents);
    if (pathExists(p.preflight)) rmSync(p.preflight);
    console.log("Pi Dictation Bridge installed, but not ready.");
    console.log("Run `pi-dictation bridge preflight` interactively to verify microphone permission and real audio.");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyInstallation() {
  const p = paths();
  inspectPath(p.root, "directory", 0o700, "bridge support directory");
  const receipt = readJsonOwned(p.receipt, "bridge ownership receipt");
  if (receipt.product !== LABEL || typeof receipt.installId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.installId)) {
    throw new CliError("Bridge ownership cannot be proven. Run `pi-dictation bridge install`.");
  }
  proveApp(p.app, receipt.installId);
  validateCredential(p.credential);
  inspectPath(p.runtime, "directory", 0o700, "bridge runtime directory");
  inspectPath(p.plist, "file", 0o600, "bridge LaunchAgent");
  if (!readFileSync(p.plist, "utf8").includes(`pi-dictation-install-id:${receipt.installId}`)) {
    throw new CliError("Refusing a LaunchAgent whose ownership cannot be proven.");
  }
  return { p, receipt };
}

function executableDigest(p) {
  const executable = join(p.app, "Contents", "MacOS", APP_NAME);
  inspectPath(executable, "file", 0o700, "companion executable");
  return createHash("sha256").update(readFileSync(executable)).digest("hex");
}

function preflight() {
  const { p, receipt } = verifyInstallation();
  if (pathExists(p.preflight)) {
    const previous = readJsonOwned(p.preflight, "preflight receipt");
    if (previous.installId !== receipt.installId) throw new CliError("Refusing an unowned preflight receipt.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Microphone permission: not checked");
    console.log("Real-audio capture: not checked");
    throw new CliError("Preflight requires an interactive terminal in the logged-in Mac GUI session.");
  }
  console.log("Speak naturally for five seconds when macOS asks for microphone access.");
  const resultPath = join(p.runtime, `preflight-${randomUUID()}.json`);
  try {
    run("open", ["-gj", "-W", p.app, "--args", "--preflight-result", resultPath], {
      failure: "The installed companion could not run preflight in the GUI session",
    });
    const result = readJsonOwned(resultPath, "preflight result");
    const permission = ["authorized", "denied", "restricted", "not-determined"].includes(result.permission)
      ? result.permission : "unknown";
    console.log(`Microphone permission: ${permission}`);
    const captures = {
      observed: "real audio observed",
      "digital-silence": "digital silence only",
      "no-samples": "no audio samples received",
      "no-device": "no default input device",
      "device-lost": "input device lost during capture",
      "capture-failed": "capture failed",
    };
    const capture = captures[result.capture] || "capture failed";
    console.log(`Real-audio capture: ${capture}`);
    if (permission !== "authorized" || result.capture !== "observed") {
      throw new CliError("Bridge preflight did not observe usable microphone audio; check Privacy & Security > Microphone and the selected input device.");
    }
    atomicWrite(p.preflight, JSON.stringify({
      product: LABEL,
      installId: receipt.installId,
      executableSha256: executableDigest(p),
      completedAt: new Date().toISOString(),
    }) + "\n");
    atomicWrite(p.plist, launchAgentPlist(p, receipt.installId, true));
    try {
      run("launchctl", ["bootstrap", `gui/${uid()}`, p.plist], {
        failure: "Preflight passed, but the user LaunchAgent could not be loaded. Log out and back in, then rerun preflight",
      });
      run("launchctl", ["kickstart", `gui/${uid()}/${LABEL}`], {
        failure: "Preflight passed, but the companion could not be started",
      });
    } catch (error) {
      spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" });
      rmSync(p.preflight, { force: true });
      atomicWrite(p.plist, launchAgentPlist(p, receipt.installId));
      throw error;
    }
    console.log("Pi Dictation Bridge preflight passed; the companion is ready.");
  } finally {
    rmSync(resultPath, { force: true });
  }
}

function encodeAuthFields(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0", "utf8")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}

function hmac(secret, fields) {
  return createHmac("sha256", secret).update(encodeAuthFields(fields)).digest();
}

function canonicalBase64(value, expectedBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CliError("The companion sent malformed authenticated protocol data.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new CliError("The companion sent malformed authenticated protocol data.");
  }
  return decoded;
}

function canonicalHex(value, expectedBytes) {
  if (typeof value !== "string" || value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new CliError("The companion sent malformed authenticated protocol data.");
  }
  return Buffer.from(value, "hex");
}

function parseStrictJsonText(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new CliError("The companion sent malformed authenticated protocol data."); }
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] || "")) index += 1; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    throw new CliError("The companion sent malformed authenticated protocol data.");
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index += 1; whitespace();
      const keys = new Set();
      if (text[index] === "}") { index += 1; return; }
      while (true) {
        const key = string();
        if (keys.has(key)) throw new CliError("The companion sent malformed authenticated protocol data.");
        keys.add(key); whitespace();
        if (text[index++] !== ":") throw new CliError("The companion sent malformed authenticated protocol data.");
        value(); whitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index++] !== ",") throw new CliError("The companion sent malformed authenticated protocol data.");
        whitespace();
      }
    }
    if (text[index] === "[") {
      index += 1; whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(); whitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index++] !== ",") throw new CliError("The companion sent malformed authenticated protocol data.");
      }
    }
    if (text[index] === '"') { string(); return; }
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  };
  value(); whitespace();
  if (index !== text.length) throw new CliError("The companion sent malformed authenticated protocol data.");
  return parsed;
}

function parseUtf8Json(bytes) {
  try { return parseStrictJsonText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("The companion sent malformed authenticated protocol data.");
  }
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new CliError("Bridge protocol frame exceeds its safe limit.");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function readFrame(socket, timeoutMs = 5000, requireEnd = false) {
  return new Promise((resolveFrame, reject) => {
    let buffered = Buffer.alloc(0);
    let parsed;
    const timeout = setTimeout(() => finish(new CliError("Authenticated health request timed out.")), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      error ? reject(error) : resolveFrame(value);
    };
    const onError = () => finish(new CliError("The companion Unix socket is unavailable."));
    const onEnd = () => {
      if (requireEnd && parsed) return finish(undefined, parsed);
      finish(new CliError("The companion closed an incomplete health response."));
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (length < 2 || length > MAX_FRAME_BYTES) return finish(new CliError("The companion sent an invalid protocol frame."));
      if (buffered.length < length + 4) return;
      if (buffered.length !== length + 4) return finish(new CliError("The companion sent trailing protocol bytes."));
      try {
        parsed = { value: parseUtf8Json(buffered.subarray(4)), bytes: buffered.subarray(4) };
        if (!requireEnd) finish(undefined, parsed);
      } catch {
        finish(new CliError("The companion sent malformed protocol data."));
      }
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onEnd);
  });
}

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function companionRequestAt(endpoint, credential, operation, fixedRequestId) {
  let secret;
  try {
    secret = canonicalBase64(credential.secret, 32);
  } catch {
    throw new CliError("Refusing invalid bridge credential.");
  }
  const socket = endpoint.type === "unix"
    ? net.createConnection({ path: endpoint.path })
    : net.createConnection({ host: endpoint.host, port: endpoint.port });
  try {
    const challengeMessage = (await readFrame(socket)).value;
    if (!exactObject(challengeMessage, ["type", "challenge"]) || challengeMessage.type !== "challenge") {
      throw new CliError("The companion sent an invalid authentication challenge.");
    }
    const challenge = canonicalBase64(challengeMessage.challenge, 32);
    const requestId = fixedRequestId || randomUUID();
    const payload = Buffer.from("{}", "utf8");
    const tag = hmac(secret, ["request", BRIDGE_PROTOCOL_VERSION, challenge, credential.id, requestId, operation, payload]);
    socket.end(frame({
      type: "request", version: BRIDGE_PROTOCOL_VERSION, credentialId: credential.id,
      requestId, operation, payload: payload.toString("base64"), hmac: tag.toString("hex"),
    }));
    const response = (await readFrame(socket, 5000, true)).value;
    const statuses = ["ok", "busy", "not-found", "request-conflict", "invalid-state", "failed", "version-mismatch"];
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || !Number.isSafeInteger(response.version) || response.version < 1 ||
        response.requestId !== requestId || !statuses.includes(response.status)) {
      throw new CliError("The companion returned an invalid authenticated response.");
    }
    const responsePayload = canonicalBase64(response.payload);
    const expected = hmac(secret, ["response", BRIDGE_PROTOCOL_VERSION, response.version, challenge, credential.id,
      requestId, `${operation}:${response.status}`, responsePayload]);
    const actual = canonicalHex(response.hmac, expected.length);
    if (!timingSafeEqual(actual, expected)) {
      throw new CliError("The companion response could not be authenticated.");
    }
    const value = parseUtf8Json(responsePayload);
    if (response.status === "version-mismatch") {
      if (!exactObject(value, ["clientVersion", "companionVersion"]) ||
          value.clientVersion !== BRIDGE_PROTOCOL_VERSION || value.companionVersion !== response.version ||
          response.version === BRIDGE_PROTOCOL_VERSION) {
        throw new CliError("The companion returned invalid authenticated version data.");
      }
      throw new CliError(`Authenticated protocol mismatch: Pi uses version ${value.clientVersion}; companion uses version ${value.companionVersion}.`);
    }
    if (response.version !== BRIDGE_PROTOCOL_VERSION) {
      throw new CliError("The companion returned invalid authenticated version data.");
    }
    if (response.status !== "ok") {
      const error = new CliError(`The companion rejected ${operation} with authenticated status ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return value;
  } finally {
    socket.end();
    socket.destroy();
  }
}

async function healthAt(endpoint, credential) {
  const health = await companionRequestAt(endpoint, credential, "health");
  const permissionValues = ["authorized", "denied", "restricted", "not-determined", "unknown"];
  if (!exactObject(health, ["permission", "defaultInputAvailable"]) ||
      !permissionValues.includes(health.permission) ||
      typeof health.defaultInputAvailable !== "boolean") {
    throw new CliError("The companion returned invalid health data.");
  }
  return health;
}

async function authenticatedHealth() {
  const { p, receipt } = verifyInstallation();
  const ready = readJsonOwned(p.preflight, "preflight receipt");
  if (ready.product !== LABEL || ready.installId !== receipt.installId || ready.executableSha256 !== executableDigest(p)) {
    throw new CliError("The installed build has not passed real-audio preflight.");
  }
  inspectSocket(p.socket);
  const credential = readJsonOwned(p.credential, "bridge credential");
  const health = await healthAt({ type: "unix", path: p.socket }, credential);
  console.log(`Protocol: ok (exact version ${BRIDGE_PROTOCOL_VERSION})`);
  console.log(`Authenticated health: ok`);
  console.log(`Microphone permission: ${health.permission}`);
  console.log(`Default input: ${health.defaultInputAvailable ? "available" : "unavailable"}`);
}

function inspectSharedArtifacts() {
  const p = paths();
  if (!pathExists(p.root)) {
    return {
      paths: p,
      report: {
        installation: "not-installed", permission: "not-observed-read-only", realAudioPreflight: "not-run",
        companionLaunchAgent: "not-configured", companionProcess: "not-running",
        protocolCompatibility: "unverified", storageBounds: "unverified",
        connectionBounds: "unverified", levelAvailability: "unverified",
      },
    };
  }
  inspectPath(p.root, "directory", 0o700, "bridge support directory");
  const receipt = readJsonOwned(p.receipt, "bridge ownership receipt");
  if (receipt.product !== LABEL || typeof receipt.installId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.installId)) {
    throw new CliError("Refusing bridge artifacts whose ownership cannot be proven.");
  }
  let installation = "incomplete";
  const appPresent = pathExists(p.app);
  const credentialPresent = pathExists(p.credential);
  const runtimePresent = pathExists(p.runtime);
  const plistPresent = pathExists(p.plist);
  if (appPresent) proveApp(p.app, receipt.installId);
  if (credentialPresent) validateCredential(p.credential);
  if (runtimePresent) inspectPath(p.runtime, "directory", 0o700, "bridge runtime directory");
  let companionLaunchAgent = "not-configured";
  let launchAgentLoaded = false;
  if (plistPresent) {
    inspectPath(p.plist, "file", 0o600, "bridge LaunchAgent");
    if (!readFileSync(p.plist, "utf8").includes(`pi-dictation-install-id:${receipt.installId}`)) {
      throw new CliError("Refusing a LaunchAgent whose ownership cannot be proven.");
    }
    const expected = launchAgentPlist(p, receipt.installId, pathExists(p.preflight));
    const exact = readFileSync(p.plist, "utf8") === expected;
    const observation = sharedLaunchAgentObservation();
    launchAgentLoaded = observation === "loaded";
    companionLaunchAgent = !exact ? "configuration-unverified" : observation === "unavailable" ? "process-state-unavailable" : launchAgentLoaded ? "loaded" : "configured-not-loaded";
  }
  if (appPresent && credentialPresent && runtimePresent && plistPresent && companionLaunchAgent !== "configuration-unverified") installation = "installed";
  const socketPresent = pathExists(p.socket);
  if (socketPresent) inspectSocket(p.socket);
  const companionProcess = launchAgentLoaded
    ? (socketPresent ? "supervised-socket-present" : "supervised-socket-absent")
    : (socketPresent ? "socket-present-process-unverified" : "not-running");
  let preflightState = "not-run";
  if (pathExists(p.preflight)) {
    const ready = readJsonOwned(p.preflight, "preflight receipt");
    if (ready.product !== LABEL || ready.installId !== receipt.installId) throw new CliError("Refusing an unowned preflight receipt.");
    preflightState = installation === "installed" && ready.executableSha256 === executableDigest(p)
      ? "passed-current-build" : "stale";
  }
  return {
    paths: p,
    receipt,
    report: {
      installation, permission: "not-observed-read-only", realAudioPreflight: preflightState,
      companionLaunchAgent, companionProcess, protocolCompatibility: "unverified", storageBounds: "unverified",
      connectionBounds: "unverified", levelAvailability: "unverified",
    },
  };
}

async function bridgeDoctor(args) {
  const json = args.includes("--json");
  const positional = args.filter((argument) => argument !== "--json");
  if (positional.length > 1 || args.some((argument) => argument.startsWith("--") && argument !== "--json")) {
    throw new CliError("Usage: pi-dictation bridge doctor [ssh-alias] [--json]");
  }
  const inspected = inspectSharedArtifacts();
  const hosts = inspected.report.installation === "not-installed" ? [] : diagnoseHosts(positional[0]);
  const configured = hosts.some((host) => host.stages.protocolCompatibility.startsWith("configured-exact-v"));
  const report = {
    schemaVersion: 1,
    shared: {
      ...inspected.report,
      protocolCompatibility: configured ? `configured-exact-v${BRIDGE_PROTOCOL_VERSION}` : "unverified",
      storageBounds: configured ? "configured-bounded" : "unverified",
      connectionBounds: configured ? "configured-bounded" : "unverified",
      levelAvailability: configured ? "supported-not-observed" : "unverified",
    },
    hosts,
  };
  const encoded = JSON.stringify(report);
  if (Buffer.byteLength(encoded) > 512 * 1024) throw new CliError("Bridge doctor output exceeds its safe limit.");
  if (json) return console.log(encoded);
  console.log("Pi Dictation Bridge doctor (read-only)");
  for (const [stage, status] of Object.entries(report.shared)) console.log(`Shared ${stage}: ${status}`);
  for (const host of report.hosts) {
    console.log(`SSH alias: ${host.sshAlias}`);
    for (const [stage, status] of Object.entries(host.stages)) console.log(`  ${stage}: ${status}`);
  }
  console.log("Logs are omitted. Request them separately with `pi-dictation bridge logs SSH_ALIAS`.");
}

function validateEffects(value) {
  const keys = ["connections", "activeRecordingLease", "incompleteAudio", "retainedWav"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join() ||
      keys.some((key) => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100000)) {
    throw new CliError("The companion returned invalid credential effects.");
  }
  return value;
}

function administrationRequestId(credentialId, operation) {
  const hex = createHash("sha256").update(`${LABEL}\0${credentialId}\0${operation}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function primaryEffects(p) {
  const credential = validateCredential(p.credential);
  return validateEffects(await companionRequestAt({ type: "unix", path: p.socket }, credential, "credential-effects"));
}

function validCredentialValue(value) {
  return value && typeof value.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id) &&
    typeof value.secret === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value.secret) && Buffer.from(value.secret, "base64").length === 32;
}

function validatePrimaryUpgrade(primary) {
  if (primary === undefined) return;
  if (!primary || typeof primary !== "object" || !["preparing", "staged", "revoked", "promoted"].includes(primary.phase) ||
      typeof primary.oldCredentialId !== "string" || typeof primary.nextCredentialId !== "string" || primary.oldCredentialId === primary.nextCredentialId ||
      !/^[0-9a-f-]{36}$/i.test(primary.requestId) || !["credential-revoke", "credential-revoke-if-idle"].includes(primary.operation) ||
      (primary.phase === "preparing" && !validCredentialValue(primary.replacement)) ||
      (primary.phase !== "preparing" && primary.replacement !== undefined)) {
    throw new CliError("Refusing invalid shared credential upgrade state.");
  }
}

function readUpgradeState(p) {
  if (!pathExists(p.upgrade)) return undefined;
  const value = readJsonOwned(p.upgrade, "bridge upgrade state");
  const aliasesValid = (aliases) => Array.isArray(aliases) && aliases.length <= 1000 &&
    aliases.every((alias) => typeof alias === "string" && /^[A-Za-z0-9_.@-]{1,255}$/.test(alias));
  validatePrimaryUpgrade(value.primary);
  if (value.product !== LABEL || !["gating", "quiescing", "installing", "awaiting-preflight"].includes(value.phase) || !aliasesValid(value.hosts) ||
      (["gating", "quiescing"].includes(value.phase) && (!aliasesValid(value.completed) || value.completed.some((alias) => !value.hosts.includes(alias)) || typeof value.cancelActive !== "boolean"))) {
    throw new CliError("Refusing invalid bridge upgrade state.");
  }
  return value;
}

async function gatePrimaryUpgrade(p, state) {
  let current = state;
  let primary = current.primary;
  if (!primary) {
    const oldCredential = validateCredential(p.credential);
    const replacement = { id: randomUUID(), secret: randomBytes(32).toString("base64") };
    primary = {
      phase: "preparing", oldCredentialId: oldCredential.id, nextCredentialId: replacement.id,
      replacement, operation: current.cancelActive ? "credential-revoke" : "credential-revoke-if-idle",
      requestId: administrationRequestId(oldCredential.id, current.cancelActive ? "credential-revoke" : "credential-revoke-if-idle"),
    };
    current = { ...current, primary };
    atomicWrite(p.upgrade, `${JSON.stringify(current)}\n`);
  }
  if (primary.phase === "preparing") {
    if (pathExists(p.nextCredential)) throw new CliError("Refusing an unexpected staged shared credential.");
    atomicWrite(p.nextCredential, `${JSON.stringify(primary.replacement)}\n`);
    primary = { ...primary, phase: "staged", replacement: undefined };
    current = { ...current, primary };
    atomicWrite(p.upgrade, `${JSON.stringify(current)}\n`);
  }
  if (primary.phase === "staged") {
    const oldCredential = validateCredential(p.credential);
    const nextCredential = validateCredential(p.nextCredential);
    if (oldCredential.id !== primary.oldCredentialId || nextCredential.id !== primary.nextCredentialId) {
      throw new CliError("Refusing inconsistent staged shared credentials.");
    }
    try {
      validateEffects(await companionRequestAt({ type: "unix", path: p.socket }, oldCredential, primary.operation, primary.requestId));
    } catch (error) {
      if (error?.status === "invalid-state" && primary.operation === "credential-revoke-if-idle") {
        rmSync(p.nextCredential, { force: true });
        rmSync(p.upgrade);
        throw new CliError("Shared companion recording or retained audio atomically blocked upgrade; no upgrade effect was applied. Rerun with --confirm --cancel-active.");
      }
      throw error;
    }
    primary = { ...primary, phase: "revoked" };
    current = { ...current, primary };
    atomicWrite(p.upgrade, `${JSON.stringify(current)}\n`);
  }
  if (primary.phase === "revoked") {
    if (pathExists(p.credential) && !pathExists(p.previousCredential)) renameSync(p.credential, p.previousCredential);
    if (!pathExists(p.credential) && pathExists(p.nextCredential)) renameSync(p.nextCredential, p.credential);
    const currentCredential = validateCredential(p.credential);
    const oldCredential = validateCredential(p.previousCredential);
    if (currentCredential.id !== primary.nextCredentialId || oldCredential.id !== primary.oldCredentialId || pathExists(p.nextCredential)) {
      throw new CliError("Refusing inconsistent promoted shared credentials.");
    }
    primary = { ...primary, phase: "promoted" };
    current = { ...current, primary };
    atomicWrite(p.upgrade, `${JSON.stringify(current)}\n`);
  }
  return current;
}

function sharedLaunchAgentObservation() {
  const result = spawnSync("launchctl", ["print", `gui/${uid()}/${LABEL}`], { encoding: "utf8", timeout: 5000 });
  if (result.error) return "unavailable";
  return result.status === 0 ? "loaded" : "not-loaded";
}

function proveExactSharedLaunchAgent(inspected) {
  const { paths: p, receipt } = inspected;
  inspectPath(p.plist, "file", 0o600, "bridge LaunchAgent");
  const enabled = pathExists(p.preflight);
  if (readFileSync(p.plist, "utf8") !== launchAgentPlist(p, receipt.installId, enabled)) {
    throw new CliError("Refusing a shared LaunchAgent that is not the exact owned configuration.");
  }
}

function stopSharedCompanion(inspected) {
  proveExactSharedLaunchAgent(inspected);
  const observation = sharedLaunchAgentObservation();
  if (observation === "unavailable") throw new CliError("The shared companion process state could not be observed safely; no files were deleted.");
  if (observation === "loaded") {
    const stopped = spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { encoding: "utf8", timeout: 10000 });
    if (stopped.error || stopped.status !== 0) throw new CliError("The shared companion LaunchAgent could not be stopped; no files were deleted.");
  }
  const deadline = Date.now() + 5000;
  while (pathExists(inspected.paths.socket) && Date.now() < deadline) {
    inspectSocket(inspected.paths.socket);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (pathExists(inspected.paths.socket)) {
    inspectSocket(inspected.paths.socket);
    throw new CliError("The companion socket remains while its process may still be live; no files were deleted.");
  }
}

async function continueQuiescedUpgrade(inspected, initialState) {
  let current = initialState;
  if (current.phase === "gating") {
    current = await gatePrimaryUpgrade(inspected.paths, current);
    for (const alias of current.hosts) {
      if (current.completed.includes(alias)) continue;
      await rotateHost(alias, companionRequestAt, current.cancelActive, true, undefined, true);
      current = { ...current, completed: [...current.completed, alias] };
      atomicWrite(inspected.paths.upgrade, `${JSON.stringify(current)}\n`);
    }
    current = { ...current, phase: "quiescing", completed: [] };
    atomicWrite(inspected.paths.upgrade, `${JSON.stringify(current)}\n`);
  }
  for (const alias of current.hosts) {
    const completed = current.completed.includes(alias);
    if (completed && !hasPendingRotation(alias)) continue;
    await rotateHost(alias, companionRequestAt, current.cancelActive, true, async () => {
      if (!current.completed.includes(alias)) {
        current = { ...current, completed: [...current.completed, alias] };
        atomicWrite(inspected.paths.upgrade, `${JSON.stringify(current)}\n`);
      }
    });
  }
  stopSharedCompanion(inspected);
  if (pathExists(inspected.paths.previousCredential)) {
    validateCredential(inspected.paths.previousCredential);
    rmSync(inspected.paths.previousCredential);
  }
  current = { product: LABEL, phase: "installing", hosts: current.hosts, primary: current.primary };
  atomicWrite(inspected.paths.upgrade, `${JSON.stringify(current)}\n`);
  install();
  atomicWrite(inspected.paths.upgrade, `${JSON.stringify({ ...current, phase: "awaiting-preflight" })}\n`);
  console.log("Upgrade installed. Real-audio preflight is required before all-host health reconciliation.");
  console.log("Run `pi-dictation bridge preflight`, then `pi-dictation bridge upgrade --confirm`.");
}

async function bridgeUpgrade(args) {
  const confirmed = args.includes("--confirm");
  const cancelActive = args.includes("--cancel-active");
  if (args.some((argument) => !["--confirm", "--cancel-active"].includes(argument))) {
    throw new CliError("Usage: pi-dictation bridge upgrade [--confirm] [--cancel-active]");
  }
  const inspected = inspectSharedArtifacts();
  const pending = readUpgradeState(inspected.paths);
  if (inspected.report.installation !== "installed" && pending?.phase !== "installing") {
    throw new CliError("A complete owned Bridge installation is required before upgrade.");
  }
  if (pending) {
    if (!confirmed) throw new CliError(["gating", "quiescing"].includes(pending.phase)
      ? "Upgrade host gating or quiescence is pending; rerun upgrade --confirm to reconcile it."
      : pending.phase === "installing"
        ? "Upgrade installation is pending; rerun upgrade --confirm to reconcile it."
        : "Upgrade is awaiting real-audio preflight; run `pi-dictation bridge preflight`, then rerun upgrade --confirm.");
    if (["gating", "quiescing"].includes(pending.phase)) {
      proveExactSharedLaunchAgent(inspected);
      preflightHostRemovals(pending.hosts);
      await continueQuiescedUpgrade(inspected, pending);
      return;
    }
    if (pending.phase === "installing") {
      if (pathExists(inspected.paths.socket)) {
        inspectSocket(inspected.paths.socket);
        throw new CliError("The companion process is still stopping; rerun upgrade --confirm.");
      }
      install();
      atomicWrite(inspected.paths.upgrade, `${JSON.stringify({ ...pending, phase: "awaiting-preflight" })}\n`);
      console.log("Upgrade installed. Run `pi-dictation bridge preflight`, then `pi-dictation bridge upgrade --confirm`.");
      return;
    }
    const { p, receipt } = verifyInstallation();
    const ready = readJsonOwned(p.preflight, "preflight receipt");
    if (ready.product !== LABEL || ready.installId !== receipt.installId || ready.executableSha256 !== executableDigest(p)) {
      throw new CliError("The upgraded companion requires real-audio preflight before host reconciliation.");
    }
    for (const alias of pending.hosts) await repairHost(alias, true, true, companionRequestAt);
    const diagnosis = diagnoseHosts();
    if (diagnosis.some((host) => host.stages.authenticatedHealth !== "last-observed-ready" || !host.stages.protocolCompatibility.startsWith("configured-exact-v"))) {
      throw new CliError("All-host authenticated health has not reconciled; rerun upgrade --confirm.");
    }
    rmSync(p.upgrade);
    console.log("Bridge upgrade reconciled after real-audio preflight and all-host health checks.");
    return;
  }
  proveExactSharedLaunchAgent(inspected);
  const checked = await precheckUpgrade(companionRequestAt);
  const sharedEffects = await primaryEffects(inspected.paths);
  console.log(`Upgrade candidate: package ${packageVersion()}, protocol ${BRIDGE_PROTOCOL_VERSION}`);
  console.log(`Shared companion clients: active=${sharedEffects.activeRecordingLease}, incomplete=${sharedEffects.incompleteAudio}, retained=${sharedEffects.retainedWav}`);
  for (const host of checked) {
    console.log(`SSH alias ${host.sshAlias}: compatible; active=${host.effects.activeRecordingLease}, incomplete=${host.effects.incompleteAudio}, retained=${host.effects.retainedWav}`);
  }
  const affected = checked.filter(({ effects }) => effects.activeRecordingLease || effects.incompleteAudio || effects.retainedWav);
  const activeNames = [
    ...(sharedEffects.activeRecordingLease ? ["shared companion clients"] : []),
    ...affected.filter(({ effects }) => effects.activeRecordingLease).map(({ sshAlias }) => sshAlias),
  ];
  if (activeNames.length && !cancelActive) {
    throw new CliError(`Active recording blocks upgrade for: ${activeNames.join(", ")}. Rerun with --confirm --cancel-active to cancel it explicitly.`);
  }
  const sharedOwnedAudio = sharedEffects.activeRecordingLease || sharedEffects.incompleteAudio || sharedEffects.retainedWav;
  if (!confirmed) {
    console.log(`Preview only. Rerun with: pi-dictation bridge upgrade --confirm${affected.length || sharedOwnedAudio ? " --cancel-active" : ""}`);
    return;
  }
  if ((affected.length || sharedOwnedAudio) && !cancelActive) throw new CliError("Owned retained or incomplete audio blocks upgrade without --cancel-active.");
  const state = { product: LABEL, phase: "gating", hosts: checked.map(({ sshAlias }) => sshAlias), completed: [], cancelActive };
  atomicWrite(inspected.paths.upgrade, `${JSON.stringify(state)}\n`);
  await continueQuiescedUpgrade(inspected, state);
}

function readSharedRevocation(p) {
  if (!pathExists(p.sharedRevocation)) return undefined;
  const value = readJsonOwned(p.sharedRevocation, "shared credential revocation state");
  if (value.product !== LABEL || !["confirmed", "revoked"].includes(value.phase) ||
      typeof value.credentialId !== "string" || !["credential-revoke", "credential-revoke-if-idle"].includes(value.operation) ||
      !/^[0-9a-f-]{36}$/i.test(value.requestId)) {
    throw new CliError("Refusing invalid shared credential revocation state.");
  }
  validateEffects(value.effects);
  return value;
}

async function revokeSharedCredential(p, cancelActive, effects) {
  let state = readSharedRevocation(p);
  const operation = cancelActive ? "credential-revoke" : "credential-revoke-if-idle";
  if (!state) {
    const credential = validateCredential(p.credential);
    state = {
      product: LABEL, phase: "confirmed", credentialId: credential.id, operation,
      requestId: administrationRequestId(credential.id, operation), effects,
    };
    atomicWrite(p.sharedRevocation, `${JSON.stringify(state)}\n`);
  } else if (state.phase === "confirmed" && state.operation !== operation) {
    throw new CliError("Confirmed shared cleanup has different cancellation semantics; finish it with the original options.");
  }
  if (state.phase === "confirmed") {
    const credential = validateCredential(p.credential);
    if (credential.id !== state.credentialId) throw new CliError("Shared credential changed during confirmed uninstall.");
    try {
      validateEffects(await companionRequestAt({ type: "unix", path: p.socket }, credential, state.operation, state.requestId));
    } catch (error) {
      if (error?.status === "invalid-state" && state.operation === "credential-revoke-if-idle") {
        rmSync(p.sharedRevocation);
        throw new CliError("Shared companion recording or retained audio atomically blocked uninstall. Rerun with --confirm --cancel-active.");
      }
      throw new CliError(`${error instanceof Error ? error.message : "Shared credential revocation failed"} Confirmed shared cleanup was preserved for retry.`);
    }
    state = { ...state, phase: "revoked" };
    atomicWrite(p.sharedRevocation, `${JSON.stringify(state)}\n`);
  }
  return state;
}

function validateRuntimeForRemoval(p) {
  if (!pathExists(p.runtime)) return;
  inspectPath(p.runtime, "directory", 0o700, "bridge runtime directory");
  for (const name of readdirSync(p.runtime)) {
    const path = join(p.runtime, name);
    if (name === "companion.sock") { inspectSocket(path); continue; }
    if (!/^(?:companion\.log|request-receipts\.json|resource-metrics\.json|recording-[0-9a-f-]+\.(?:wav|reserve|json)|revocation-[0-9a-f-]+\.json)$/.test(name)) {
      throw new CliError("Refusing an unprovable artifact in bridge runtime directory.");
    }
    inspectPath(path, "file", 0o600, "owned bridge runtime artifact");
  }
}

function validateSharedRemovalCandidate() {
  const inspected = inspectSharedArtifacts();
  const { paths: p } = inspected;
  if (inspected.report.installation === "not-installed") return inspected;
  const allowed = new Set([`${APP_NAME}.app`, "credential.json", "credential.next.json", "credential.previous.json", "credential.revocation.json", "ownership.json", "preflight.json", "upgrade.json", "hosts"]);
  if (readdirSync(p.root).some((name) => !allowed.has(name))) throw new CliError("Refusing unprovable artifacts in bridge support directory.");
  if (pathExists(p.credential)) validateCredential(p.credential);
  if (pathExists(p.nextCredential)) validateCredential(p.nextCredential);
  if (pathExists(p.previousCredential)) validateCredential(p.previousCredential);
  if (pathExists(p.sharedRevocation)) readSharedRevocation(p);
  if (pathExists(p.upgrade)) readUpgradeState(p);
  validateRuntimeForRemoval(p);
  return inspected;
}

function removeSharedCompanion() {
  const inspected = validateSharedRemovalCandidate();
  const { paths: p } = inspected;
  if (inspected.report.installation === "not-installed") return;
  const hostsRoot = join(p.root, "hosts");
  if (pathExists(hostsRoot)) {
    inspectPath(hostsRoot, "directory", 0o700, "bridge hosts directory");
    if (readdirSync(hostsRoot).length !== 0) throw new CliError("Refusing to remove the shared companion while host bridges remain.");
  }
  stopSharedCompanion(inspected);
  validateRuntimeForRemoval(p);
  if (pathExists(p.plist)) { inspectPath(p.plist, "file", 0o600, "bridge LaunchAgent"); rmSync(p.plist); }
  validateSharedRemovalCandidate();
  rmSync(p.root, { recursive: true });
  if (pathExists(p.runtime)) { validateRuntimeForRemoval(p); rmSync(p.runtime, { recursive: true }); }
  console.log("Shared companion and owned LaunchAgent removed.");
  console.log("macOS microphone permission history may remain in Privacy & Security and is not changed by uninstall.");
}

async function bridgeUninstall(args) {
  const confirmed = args.includes("--confirm");
  const cancelActive = args.includes("--cancel-active");
  const positional = args.filter((argument) => !argument.startsWith("--"));
  const all = args.includes("--all");
  if ((all && positional.length) || (!all && positional.length !== 1) ||
      args.some((argument) => argument.startsWith("--") && !["--all", "--confirm", "--cancel-active"].includes(argument))) {
    throw new CliError("Usage: pi-dictation bridge uninstall <ssh-alias>|--all [--confirm] [--cancel-active]");
  }
  const registered = configuredAliases();
  const aliases = all ? registered : positional;
  if (aliases.length === 0 && !all) throw new CliError("No bridge selected for uninstall.");
  const removesShared = aliases.length === registered.length;
  if (removesShared) validateSharedRemovalCandidate();
  const sharedState = removesShared ? readSharedRevocation(paths()) : undefined;
  if (removesShared) proveExactSharedLaunchAgent(validateSharedRemovalCandidate());
  preflightHostRemovals(aliases);
  const sharedEffects = removesShared ? (sharedState?.effects || await primaryEffects(paths())) : undefined;
  const previews = [];
  for (const alias of aliases) previews.push({ alias, effects: await inspectHostEffects(alias, companionRequestAt) });
  for (const { alias, effects } of previews) {
    console.log(`SSH alias ${alias}: credentials=1, active=${effects.activeRecordingLease}, incomplete=${effects.incompleteAudio}, retained=${effects.retainedWav}`);
  }
  if (removesShared) {
    console.log(`Shared credential: credentials=1, active=${sharedEffects.activeRecordingLease}, incomplete=${sharedEffects.incompleteAudio}, retained=${sharedEffects.retainedWav}`);
    console.log("Shared companion and owned LaunchAgent: remove only after every credential and retained WAV deletion is confirmed.");
    console.log("macOS microphone permission history may remain in Privacy & Security.");
  } else {
    console.log("Other host bridges and the shared companion: preserve.");
  }
  const active = previews.filter(({ effects }) => effects.activeRecordingLease > 0);
  const activeNames = [...active.map(({ alias }) => alias), ...(sharedEffects?.activeRecordingLease ? ["shared companion clients"] : [])];
  if (activeNames.length && !cancelActive && !confirmed) {
    throw new CliError(`Active recording blocks uninstall for: ${activeNames.join(", ")}. Rerun with --confirm --cancel-active.`);
  }
  if (!confirmed) {
    const ownedAudio = previews.some(({ effects }) => effects.activeRecordingLease || effects.incompleteAudio || effects.retainedWav) ||
      Boolean(sharedEffects && (sharedEffects.activeRecordingLease || sharedEffects.incompleteAudio || sharedEffects.retainedWav));
    console.log(`Preview only. Rerun with: pi-dictation bridge uninstall ${all ? "--all" : aliases[0]} --confirm${ownedAudio ? " --cancel-active" : ""}`);
    return;
  }
  if (removesShared) {
    try { await revokeSharedCredential(paths(), cancelActive, sharedEffects); }
    catch (error) {
      throw new CliError(`${error instanceof Error ? error.message : "Shared credential cleanup failed"} Affected bridges: ${aliases.join(", ") || "shared companion clients"}.`);
    }
  }
  for (const alias of aliases) await revokeHost(alias, true, companionRequestAt, { uninstall: true, cancelActive });
  if (configuredAliases().length === 0) removeSharedCompanion();
  else console.log("Other host bridges and the shared companion were preserved.");
}

function build(args) {
  const index = args.indexOf("--output");
  if (index === -1 || !args[index + 1] || args.length !== 2) {
    throw new CliError("Usage: pi-dictation bridge build --output /path/to/PiDictationBridge.app");
  }
  const output = resolve(args[index + 1]);
  buildBundle(output);
  console.log(`Built ${APP_NAME}.app from packaged Swift source.`);
}

function usage() {
  console.log("Usage: pi-dictation bridge <build|install [ssh-alias]|preflight|health|doctor [ssh-alias] [--json]|logs ssh-alias [--json]|status ssh-alias|list [--json]|repair ssh-alias [--confirm]|upgrade [--confirm] [--cancel-active]|rotate ssh-alias|revoke ssh-alias [--confirm] [--cancel-active]|uninstall <ssh-alias>|--all [--confirm] [--cancel-active]>");
}

async function main() {
  const [group, command, ...args] = process.argv.slice(2);
  if (group !== "bridge") {
    usage();
    throw new CliError("Unknown command.");
  }
  if (command === "build") return build(args);
  if (command === "install" && args.length === 0) return install();
  if (command === "install" && args.length >= 1) return installHost(args[0], args.slice(1));
  if (command === "doctor") return bridgeDoctor(args);
  if (command === "logs" && (args.length === 1 || args.length === 2 && args[1] === "--json")) return hostLogs(args[0], args[1] === "--json");
  if (command === "status" && args.length === 1) return hostStatus(args[0]);
  if (command === "list" && (args.length === 0 || args.length === 1 && args[0] === "--json")) return listHosts(args[0] === "--json");
  if (command === "repair" && (args.length === 1 || args.length === 2 && args[1] === "--confirm")) return repairHost(args[0], args[1] === "--confirm", false, companionRequestAt);
  if (command === "upgrade") return bridgeUpgrade(args);
  if (command === "rotate" && args.length === 1) return rotateHost(args[0], companionRequestAt);
  if (command === "revoke" && args.length >= 1 && args.length <= 3 && args.slice(1).every((argument) => ["--confirm", "--cancel-active"].includes(argument)) && new Set(args.slice(1)).size === args.slice(1).length) {
    return revokeHost(args[0], args.includes("--confirm"), companionRequestAt, { cancelActive: args.includes("--cancel-active") });
  }
  if (command === "uninstall") return bridgeUninstall(args);
  if (command === "preflight" && args.length === 0) return preflight();
  if (command === "health" && args.length === 0) return authenticatedHealth();
  if (command === "remote-info" && args.length === 0) return remoteInfo();
  if (command === "remote-prepare" && args.length === 2) return remotePrepare(args[0], args[1]);
  if (command === "remote-credential-commit" && args.length === 3) return remoteCredentialCommit(args[0], args[1], args[2]);
  if (command === "remote-credential-revoke" && args.length === 1) return remoteCredentialRevoke(args[0]);
  if (command === "remote-removal-preflight" && args.length === 1) return remoteRemovalPreflight(args[0]);
  if (command === "remote-listener" && args.length === 1) return remoteListener(args[0]);
  if (command === "remote-health" && (args.length === 1 || args.length === 2 && args[1] === "staged")) return remoteHealth(args[0], healthAt, args[1] === "staged");
  usage();
  throw new CliError("Unknown bridge command.");
}

try {
  await main();
} catch (error) {
  const message = error instanceof CliError || error instanceof BridgeHostError ? error.message : "Pi Dictation Bridge failed unexpectedly.";
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
