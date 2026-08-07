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
  hostStatus,
  installHost,
  remoteHealth,
  remoteInfo,
  remoteListener,
  remotePrepare,
} from "./bridge-host.mjs";

const LABEL = "com.yasuhito.pi-dictation.bridge";
const APP_NAME = "PiDictationBridge";
const MAX_FRAME_BYTES = 64 * 1024;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-companion", "PiDictationBridge.swift");

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
  if (!existsSync(sourcePath)) throw new CliError("The packaged macOS companion source is missing. Reinstall pi-dictation.");
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
      "-O", "-whole-module-optimization", "-sdk", toolchain.sdk, "-target", "arm64-apple-macosx14.0",
      "-framework", "AVFoundation", "-framework", "AudioToolbox",
      "-framework", "CoreMedia", "-framework", "CryptoKit", "-framework", "Security",
      sourcePath, "-o", executable,
    ], {
      failure: "The Swift toolchain cannot build the macOS companion. Update Xcode or Apple's command line tools.",
    });
    chmodSync(executable, 0o700);
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

function readJsonOwned(path, description) {
  inspectPath(path, "file", 0o600, description);
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

async function healthAt(endpoint, credential) {
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
    const challengeFrame = await readFrame(socket);
    const challengeMessage = challengeFrame.value;
    if (!exactObject(challengeMessage, ["type", "challenge"]) || challengeMessage.type !== "challenge") {
      throw new CliError("The companion sent an invalid authentication challenge.");
    }
    const challenge = canonicalBase64(challengeMessage.challenge, 32);
    const requestId = randomUUID();
    const payload = Buffer.from("{}", "utf8");
    const tag = hmac(secret, ["request", BRIDGE_PROTOCOL_VERSION, challenge, credential.id, requestId, "health", payload]);
    socket.end(frame({
      type: "request", version: BRIDGE_PROTOCOL_VERSION, credentialId: credential.id,
      requestId, operation: "health", payload: payload.toString("base64"), hmac: tag.toString("hex"),
    }));
    const responseFrame = await readFrame(socket, 5000, true);
    const response = responseFrame.value;
    if (!exactObject(response, ["type", "version", "requestId", "status", "payload", "hmac"]) ||
        response.type !== "response" || !Number.isSafeInteger(response.version) || response.version < 1 ||
        response.requestId !== requestId || !["ok", "version-mismatch"].includes(response.status)) {
      throw new CliError("The companion returned an invalid authenticated health response.");
    }
    const responsePayload = canonicalBase64(response.payload);
    const expected = hmac(secret, ["response", BRIDGE_PROTOCOL_VERSION, response.version, challenge, credential.id,
      requestId, `health:${response.status}`, responsePayload]);
    const actual = canonicalHex(response.hmac, expected.length);
    if (!timingSafeEqual(actual, expected)) {
      throw new CliError("The companion health response could not be authenticated.");
    }
    const health = parseUtf8Json(responsePayload);
    if (response.status === "version-mismatch") {
      if (!exactObject(health, ["clientVersion", "companionVersion"]) ||
          health.clientVersion !== BRIDGE_PROTOCOL_VERSION || health.companionVersion !== response.version) {
        throw new CliError("The companion returned invalid authenticated version data.");
      }
      throw new CliError(`Authenticated protocol mismatch: Pi uses version ${health.clientVersion}; companion uses version ${health.companionVersion}.`);
    }
    if (response.version !== BRIDGE_PROTOCOL_VERSION) {
      throw new CliError("The companion returned invalid authenticated version data.");
    }
    if (!exactObject(health, ["permission", "defaultInputAvailable"]) ||
        typeof health.permission !== "string" || health.permission.length > 32 ||
        typeof health.defaultInputAvailable !== "boolean") {
      throw new CliError("The companion returned invalid health data.");
    }
    return health;
  } finally {
    socket.end();
    socket.destroy();
  }
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
  console.log("Usage: pi-dictation bridge <build|install [ssh-alias]|preflight|health|status ssh-alias>");
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
  if (command === "preflight" && args.length === 0) return preflight();
  if (command === "health" && args.length === 0) return authenticatedHealth();
  if (command === "remote-info" && args.length === 0) return remoteInfo();
  if (command === "remote-prepare" && args.length === 2) return remotePrepare(args[0], args[1]);
  if (command === "remote-listener" && args.length === 1) return remoteListener(args[0]);
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
