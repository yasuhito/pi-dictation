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
  quiesceUpgradeHosts,
  configuredHosts,
  diagnoseHosts,
  hostStatus,
  inspectHostEffects,
  inspectUpgrade,
  installHost,
  launchAgentLoaded,
  listHosts,
  readBridgeLogs,
  repairHost,
  remoteCredentialCommit,
  remoteCredentialRevoke,
  remoteHealth,
  remoteInfo,
  remoteListener,
  remoteListenerCleanup,
  remotePrepare,
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
    companionLog: join(runtime, "companion.log"),
    credential: join(root, "credential.json"),
    receipt: join(root, "ownership.json"),
    preflight: join(root, "preflight.json"),
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
  const contents = join(path, "Contents");
  const resources = join(contents, "Resources");
  const macos = join(contents, "MacOS");
  inspectPath(contents, "directory", 0o700, "companion Contents directory");
  inspectPath(resources, "directory", 0o700, "companion Resources directory");
  inspectPath(macos, "directory", 0o700, "companion executable directory");
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

async function preflight() {
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
    const upgradePath = join(p.root, "upgrade.json");
    if (pathExists(upgradePath)) {
      const upgradeState = readJsonOwned(upgradePath, "bridge upgrade state");
      if (upgradeState.product !== LABEL || upgradeState.phase !== "preflight-required" || !Array.isArray(upgradeState.hosts)) {
        throw new CliError("Refusing invalid bridge upgrade state.");
      }
      try {
        const checked = await inspectUpgrade(companionRequestAt);
        const checkedAliases = checked.map(({ sshAlias }) => sshAlias).sort();
        if (JSON.stringify(checkedAliases) !== JSON.stringify([...upgradeState.hosts].sort())) {
          throw new CliError("Registered bridge destinations changed during upgrade; rerun upgrade checks.");
        }
        const healthReports = await diagnoseHosts(companionRequestAt);
        if (healthReports.some((host) => host.listener.status !== "established" ||
            host.authenticatedHealth.status !== "ready" || host.protocolCompatibility.status !== "compatible")) {
          throw new CliError("Upgrade preflight passed, but not every registered destination passed listener and authenticated health checks. Repair the affected bridge and rerun preflight.");
        }
        rmSync(upgradePath);
        console.log("Upgrade complete; authenticated health passed for every registered destination.");
      } catch (error) {
        spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" });
        rmSync(p.preflight, { force: true });
        atomicWrite(p.plist, launchAgentPlist(p, receipt.installId));
        throw error;
      }
    }
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
  if (pathExists(join(p.root, "upgrade.json"))) {
    throw new CliError("Bridge upgrade is incomplete; finish required real-audio preflight and all-host health checks first.");
  }
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

function build(args) {
  const index = args.indexOf("--output");
  if (index === -1 || !args[index + 1] || args.length !== 2) {
    throw new CliError("Usage: pi-dictation bridge build --output /path/to/PiDictationBridge.app");
  }
  const output = resolve(args[index + 1]);
  buildBundle(output);
  console.log(`Built ${APP_NAME}.app from packaged Swift source.`);
}

function diagnosticStage(status, detail) {
  return detail === undefined ? { status } : { status, detail };
}

async function bridgeDoctor(json) {
  const p = paths();
  let installation = diagnosticStage("not-installed");
  let companionLaunchAgent = diagnosticStage("not-configured");
  let companionProcess = diagnosticStage("not-running");
  if (pathExists(p.root)) {
    try {
      verifyInstallation();
      installation = diagnosticStage("ready");
      companionLaunchAgent = diagnosticStage(launchAgentLoaded(LABEL) ? "loaded" : "not-loaded");
    } catch {
      installation = diagnosticStage("needs-attention");
      companionLaunchAgent = pathExists(p.plist) ? diagnosticStage("needs-attention") : diagnosticStage("not-configured");
    }
  }
  if (pathExists(p.socket)) {
    try { inspectSocket(p.socket); companionProcess = diagnosticStage("socket-present"); }
    catch { companionProcess = diagnosticStage("needs-attention"); }
  }
  let hosts = [];
  if (installation.status !== "not-installed") {
    try { hosts = await diagnoseHosts(companionRequestAt); }
    catch { hosts = []; }
  }
  if (hosts.some((host) => host.authenticatedHealth.status === "ready")) companionProcess = diagnosticStage("running");
  let permission = hosts.find((host) => host.permission.status !== "unavailable")?.permission || diagnosticStage("unavailable");
  if (permission.status === "unavailable" && installation.status === "ready" && companionProcess.status === "running") {
    try {
      const credential = validateCredential(p.credential);
      const health = await healthAt({ type: "unix", path: p.socket }, credential);
      permission = diagnosticStage(health.permission);
      companionProcess = diagnosticStage("running");
    } catch {}
  }
  const report = {
    schemaVersion: 1,
    companion: { installation, permission, launchAgent: companionLaunchAgent, process: companionProcess },
    hosts,
    limits: { maximumHosts: 1000, maximumConnections: 16, maximumConnectionsPerCredential: 4, maximumRetainedWav: 2, maximumRetainedWavBytes: 268435456, levelHistoryObservations: 600 },
  };
  const encoded = JSON.stringify(report);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new CliError("Bridge doctor output exceeds its safe limit.");
  if (json) return console.log(encoded);
  console.log("Pi Dictation Bridge doctor");
  console.log(`Installation: ${installation.status}`);
  console.log(`Microphone permission: ${permission.status}`);
  console.log(`Companion LaunchAgent: ${companionLaunchAgent.status}`);
  console.log(`Companion process: ${companionProcess.status}`);
  for (const host of hosts) {
    console.log(`SSH alias: ${host.sshAlias}`);
    console.log(`  Tunnel process: ${host.tunnelProcess.status}`);
    console.log(`  Listener: ${host.listener.status}`);
    console.log(`  Authenticated health: ${host.authenticatedHealth.status}`);
    console.log(`  Protocol compatibility: ${host.protocolCompatibility.status}`);
    console.log(`  Bounded storage: ${host.storage.status}`);
    console.log(`  Bounded connections: ${host.connections.status}`);
    console.log(`  Level availability: ${host.levelAvailability.status}`);
  }
}

function bridgeLogs(alias) {
  const records = readBridgeLogs(alias);
  if (records.length === 0) return console.log("No bridge log records available.");
  const lines = records.map((record) => `${record.source} ${record.component} ${record.code}${record.stage ? ` stage=${record.stage}` : ""}${record.retry === undefined ? "" : ` retry=${record.retry}`}${record.version === undefined ? "" : ` version=${record.version}`}`);
  const output = lines.join("\n");
  if (Buffer.byteLength(output) > 64 * 1024) throw new CliError("Bridge log output exceeds its safe limit.");
  console.log(output);
}

async function bridgeRepair(args) {
  const confirmed = args.includes("--confirm");
  const positional = args.filter((arg) => arg !== "--confirm");
  if (positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--confirm")) {
    throw new CliError("Usage: pi-dictation bridge repair [ssh-alias] [--confirm]");
  }
  const initialPaths = paths();
  if (!pathExists(initialPaths.root)) {
    console.log("Repair preview: no installed bridge artifacts; no changes are required.");
    console.log("Preview only. Repair never installs, changes credentials, requests permission, or opens audio.");
    return;
  }
  const { p, receipt } = verifyInstallation();
  const known = configuredHosts().map((host) => host.sshAlias);
  const aliases = positional.length ? positional : known;
  if (aliases.some((alias) => !known.includes(alias))) throw new CliError("Unknown host bridge; no repair was performed.");
  let companionHealthy = false;
  if (launchAgentLoaded(LABEL) && pathExists(p.socket)) {
    try {
      inspectSocket(p.socket);
      await healthAt({ type: "unix", path: p.socket }, validateCredential(p.credential));
      companionHealthy = true;
    } catch {}
  }
  const reloadCompanion = !companionHealthy;
  if (reloadCompanion) console.log(`Repair preview:\n- ${launchAgentLoaded(LABEL) ? "restart" : "load"} the owned companion LaunchAgent`);
  const reports = await diagnoseHosts(companionRequestAt);
  const reconcileAliases = new Set(reports.filter((host) => host.tunnelProcess.status !== "running" ||
    host.listener.status !== "established" || host.authenticatedHealth.status !== "ready" ||
    host.protocolCompatibility.status !== "compatible").map((host) => host.sshAlias));
  for (const alias of aliases) repairHost(alias, false, reconcileAliases.has(alias));
  if (!confirmed) {
    if (!reloadCompanion && aliases.length === 0) console.log("Repair preview: no changes are required.");
    console.log("Preview only. Rerun with --confirm. Credentials, microphone permission, and audio are never changed.");
    return;
  }
  if (reloadCompanion) {
    const ready = readJsonOwned(p.preflight, "preflight receipt");
    if (ready.product !== LABEL || ready.installId !== receipt.installId || ready.executableSha256 !== executableDigest(p)) {
      throw new CliError("Repair cannot bypass required real-audio preflight.");
    }
    const domain = `gui/${uid()}`;
    const loaded = launchAgentLoaded(LABEL);
    if (!loaded) run("launchctl", ["bootstrap", domain, p.plist], { failure: "The companion LaunchAgent could not be loaded" });
    run("launchctl", ["kickstart", ...(loaded ? ["-k"] : []), `${domain}/${LABEL}`], { failure: "The companion could not be restarted" });
  }
  for (const alias of aliases) repairHost(alias, true, reconcileAliases.has(alias));
}

function stopOwnedCompanion(p) {
  spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" });
  for (let attempt = 0; attempt < 20 && pathExists(p.socket); attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (pathExists(p.socket)) {
    inspectSocket(p.socket);
    rmSync(p.socket);
  }
}

async function upgrade(args) {
  const allowed = new Set(["--cancel-active", "--confirm"]);
  if (args.some((arg) => !allowed.has(arg))) throw new CliError("Usage: pi-dictation bridge upgrade [--cancel-active --confirm]");
  const { p } = verifyInstallation();
  const upgradePath = join(p.root, "upgrade.json");
  let upgradeState;
  if (pathExists(upgradePath)) {
    upgradeState = readJsonOwned(upgradePath, "bridge upgrade state");
    if (upgradeState.product !== LABEL || !["quiescing", "ready-to-install"].includes(upgradeState.phase) ||
        !Array.isArray(upgradeState.hosts) || !Array.isArray(upgradeState.cancelAliases) ||
        !upgradeState.requestIds || typeof upgradeState.requestIds !== "object") {
      throw new CliError("Upgrade already changed the companion; complete required real-audio preflight before continuing.");
    }
  } else {
    const effects = await inspectUpgrade(companionRequestAt);
    const active = effects.filter((effect) => effect.activeRecordingLease > 0 || effect.incompleteAudio > 0).map((effect) => effect.sshAlias);
    if (active.length && !args.includes("--cancel-active")) {
      throw new CliError(`Active recording blocks upgrade for: ${active.join(", ")}. Rerun with --cancel-active --confirm to delete affected audio.`);
    }
    if (active.length && !args.includes("--confirm")) {
      console.log(`Active recordings to cancel: ${active.join(", ")}`);
      console.log("Preview only. Rerun with --cancel-active --confirm.");
      return;
    }
    const hosts = effects.map(({ sshAlias }) => sshAlias);
    upgradeState = {
      product: LABEL, phase: "quiescing", hosts, cancelAliases: active,
      requestIds: Object.fromEntries(hosts.map((alias) => [alias, randomUUID()])),
    };
    atomicWrite(upgradePath, `${JSON.stringify(upgradeState)}\n`);
  }
  if (upgradeState.phase === "quiescing") {
    if (upgradeState.cancelAliases.length) console.log(`Cancelling active recordings for: ${upgradeState.cancelAliases.join(", ")}`);
    let results;
    try {
      results = await quiesceUpgradeHosts(
        upgradeState.hosts, upgradeState.requestIds, upgradeState.cancelAliases, companionRequestAt,
      );
    } catch (error) {
      if (error?.status === "invalid-state") {
        rmSync(upgradePath);
        throw new CliError("Recording state changed during upgrade checks; no companion change was made. Preview the affected bridges again.");
      }
      throw error;
    }
    if (results.some((effect) => upgradeState.cancelAliases.includes(effect.sshAlias) && effect.activeRecordingLease < 1)) {
      throw new CliError("Companion did not confirm deletion of every affected recording.");
    }
    upgradeState = { ...upgradeState, phase: "ready-to-install" };
    atomicWrite(upgradePath, `${JSON.stringify(upgradeState)}\n`);
  }
  stopOwnedCompanion(p);
  install();
  atomicWrite(upgradePath, `${JSON.stringify({ ...upgradeState, phase: "preflight-required" })}\n`);
  console.log("Shared companion upgraded after every registered destination passed compatibility checks.");
  console.log("Required next step: run `pi-dictation bridge preflight`; completion includes all-host authenticated health checks.");
}

function assertRemovalLayout(p) {
  inspectPath(p.root, "directory", 0o700, "bridge support directory");
  const allowedRoot = new Set([`${APP_NAME}.app`, "credential.json", "ownership.json", "preflight.json", "hosts", "upgrade.json"]);
  for (const name of readdirSync(p.root)) {
    if (!allowedRoot.has(name)) throw new CliError(`Refusing unexpected artifact '${name}' whose ownership cannot be proven.`);
  }
  const receipt = readJsonOwned(p.receipt, "bridge ownership receipt");
  if (receipt.product !== LABEL || typeof receipt.installId !== "string") throw new CliError("Refusing bridge artifacts whose ownership cannot be proven.");
  if (pathExists(p.app)) proveApp(p.app, receipt.installId);
  if (pathExists(p.credential)) validateCredential(p.credential);
  if (pathExists(p.preflight)) readJsonOwned(p.preflight, "preflight receipt");
  const upgradePath = join(p.root, "upgrade.json");
  if (pathExists(upgradePath)) {
    const pending = readJsonOwned(upgradePath, "bridge upgrade state");
    if (pending.product !== LABEL || !["quiescing", "ready-to-install", "preflight-required"].includes(pending.phase) || !Array.isArray(pending.hosts)) throw new CliError("Refusing invalid bridge upgrade state.");
  }
  if (pathExists(p.plist)) {
    inspectPath(p.plist, "file", 0o600, "bridge LaunchAgent");
    if (!readFileSync(p.plist, "utf8").includes(`pi-dictation-install-id:${receipt.installId}`)) throw new CliError("Refusing a LaunchAgent whose ownership cannot be proven.");
  }
  if (pathExists(p.runtime)) {
    inspectPath(p.runtime, "directory", 0o700, "bridge runtime directory");
    const allowed = /^(?:companion\.sock|companion\.log(?:\.[12])?|resource-metrics\.json|recording-[0-9a-f-]{36}\.(?:wav|json|reserve)|request-[0-9a-f-]{36}\.json|revocation-[0-9a-f-]{36}\.json)$/i;
    for (const name of readdirSync(p.runtime)) {
      if (!allowed.test(name)) throw new CliError(`Refusing unexpected runtime artifact '${name}' whose ownership cannot be proven.`);
      const artifact = join(p.runtime, name);
      if (name === "companion.sock") inspectSocket(artifact);
      else inspectPath(artifact, "file", 0o600, "bridge runtime artifact");
    }
  }
}

async function uninstall(args) {
  const confirmed = args.includes("--confirm");
  const removeAll = args.includes("--all");
  const cancelActive = args.includes("--cancel-active");
  const deleteAudio = args.includes("--delete-retained-wav");
  const deleteCredentials = args.includes("--delete-credentials");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1 || removeAll && positional.length || args.some((arg) => arg.startsWith("--") && !["--confirm", "--all", "--cancel-active", "--delete-retained-wav", "--delete-credentials"].includes(arg))) {
    throw new CliError("Usage: pi-dictation bridge uninstall <ssh-alias>|--all [--cancel-active] [--delete-retained-wav --delete-credentials] --confirm");
  }
  const p = paths();
  assertRemovalLayout(p);
  const hosts = configuredHosts();
  const targets = removeAll ? hosts.map((host) => host.sshAlias) : positional;
  if (targets.length === 0 && !removeAll) throw new CliError("Specify an SSH alias or --all.");
  const removingLast = targets.length === hosts.length && targets.every((alias) => hosts.some((host) => host.sshAlias === alias));
  if (targets.some((alias) => !hosts.some((host) => host.sshAlias === alias))) throw new CliError("Unknown host bridge; nothing was removed.");
  const pendingTargets = hosts.filter((host) => targets.includes(host.sshAlias) && host.status.lifecycle === "revocation-pending").map((host) => host.sshAlias);
  const selected = await inspectHostEffects(targets.filter((alias) => !pendingTargets.includes(alias)), companionRequestAt);
  for (const sshAlias of pendingTargets) selected.push({ sshAlias, connections: 0, activeRecordingLease: 0, incompleteAudio: 0, retainedWav: 0 });
  const active = selected.filter((effect) => effect.activeRecordingLease > 0).map((effect) => effect.sshAlias);
  console.log(`Host bridges to remove: ${targets.join(", ") || "none"}`);
  console.log(`Active recordings to cancel: ${active.join(", ") || "none"}`);
  console.log(`Retained WAVs to delete: ${selected.reduce((sum, effect) => sum + effect.retainedWav, 0)}`);
  console.log(`Credentials to delete: ${targets.length}`);
  if (active.length && !cancelActive) throw new CliError(`Active recording blocks uninstall for: ${active.join(", ")}. Rerun with --cancel-active after reviewing the deletion preview.`);
  const retainedWav = selected.reduce((sum, effect) => sum + effect.retainedWav, 0);
  if (removingLast && (!deleteAudio || !deleteCredentials)) {
    console.log("Preview only. Removing the last bridge requires separate --delete-retained-wav and --delete-credentials confirmations.");
    return;
  }
  if (retainedWav > 0 && !deleteAudio) {
    console.log("Preview only. Deleting retained WAVs requires separate --delete-retained-wav confirmation.");
    return;
  }
  if (!confirmed) {
    console.log("Preview only. Rerun with --confirm after reviewing the exact deletion effects.");
    return;
  }
  const deletionPolicy = cancelActive
    ? "confirmed"
    : deleteAudio
      ? "delete-retained-if-no-active"
      : "preserve-retained";
  for (const alias of targets) await revokeHost(alias, true, companionRequestAt, deletionPolicy);
  if (!removingLast) {
    console.log("Shared companion and other host bridges were preserved.");
    return;
  }
  stopOwnedCompanion(p);
  if (pathExists(p.plist)) rmSync(p.plist);
  if (pathExists(p.runtime)) rmSync(p.runtime, { recursive: true });
  rmSync(p.root, { recursive: true });
  console.log("Last bridge and shared companion removed.");
  console.log("macOS microphone permission history may remain in Privacy & Security settings.");
}

function usage() {
  console.log("Usage: pi-dictation bridge <build|install|preflight|health|status|list|doctor|logs|repair|upgrade|rotate|revoke|uninstall>");
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
  if (command === "status" && args.length === 1) return hostStatus(args[0]);
  if (command === "list" && (args.length === 0 || args.length === 1 && args[0] === "--json")) return listHosts(args[0] === "--json");
  if (command === "doctor" && (args.length === 0 || args.length === 1 && args[0] === "--json")) return bridgeDoctor(args[0] === "--json");
  if (command === "logs" && args.length <= 1 && args[0] !== "--json") return bridgeLogs(args[0]);
  if (command === "repair") return bridgeRepair(args);
  if (command === "upgrade") return upgrade(args);
  if (command === "uninstall") return uninstall(args);
  if (command === "rotate" && args.length === 1) return rotateHost(args[0], companionRequestAt);
  if (command === "revoke" && (args.length === 1 || args.length === 2 && args[1] === "--confirm")) return revokeHost(args[0], args[1] === "--confirm", companionRequestAt);
  if (command === "preflight" && args.length === 0) return preflight();
  if (command === "health" && args.length === 0) return authenticatedHealth();
  if (command === "remote-info" && args.length === 0) return remoteInfo();
  if (command === "remote-prepare" && args.length === 2) return remotePrepare(args[0], args[1]);
  if (command === "remote-credential-commit" && args.length === 3) return remoteCredentialCommit(args[0], args[1], args[2]);
  if (command === "remote-credential-revoke" && args.length === 1) return remoteCredentialRevoke(args[0]);
  if (command === "remote-listener" && args.length === 1) return remoteListener(args[0]);
  if (command === "remote-listener-cleanup" && args.length === 1) return remoteListenerCleanup(args[0]);
  if (command === "remote-health" && args.length === 1) return remoteHealth(args[0], healthAt);
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
