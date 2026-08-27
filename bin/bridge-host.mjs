import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { isCanonicalIdentity } from "../lib/bridge-protocol.mjs";

const PRODUCT = "com.yasuhito.pi-dictation.bridge";
export const BRIDGE_PROTOCOL_VERSION = 3;
const packageRoot = new URL("..", import.meta.url);
const supervisorPath = fileURLToPath(new URL("./pi-dictation-tunnel.mjs", import.meta.url));
const MAX_MANAGED_JSON_BYTES = 64 * 1024;
const MAX_REMOTE_BODY_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_REMOTE_ENDPOINT_BYTES = 16 * 1024;
const MAX_REMOTE_CREDENTIAL_BYTES = 64 * 1024;

export class BridgeHostError extends Error {}

function hostKey(alias) {
  if (typeof alias !== "string" || alias.length > 255 || !/^[A-Za-z0-9_.@-]+$/.test(alias)) {
    throw new BridgeHostError("SSH host alias must contain only letters, digits, '.', '_', '@', or '-'.");
  }
  return createHash("sha256").update(alias).digest("hex").slice(0, 16);
}

function mode(path) { return lstatSync(path).mode & 0o777; }
function ownerUid() { return process.getuid?.(); }

function inspect(path, kind, expectedMode, description) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new BridgeHostError(`Refusing symlink at ${description}.`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new BridgeHostError(`Refusing unexpected file type at ${description}.`);
  }
  if (ownerUid() !== undefined && stat.uid !== ownerUid()) throw new BridgeHostError(`Refusing unowned ${description}.`);
  if ((stat.mode & 0o777) !== expectedMode) throw new BridgeHostError(`Refusing unsafe permissions at ${description}.`);
  if (kind === "file" && stat.nlink !== 1) throw new BridgeHostError(`Refusing hard-linked ${description}.`);
  return stat;
}

function ensureDirectory(path, description) {
  if (!inspect(path, "directory", 0o700, description)) mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  inspect(path, "directory", 0o700, description);
}

function ensureOwnedParent(path, description) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (ownerUid() !== undefined && stat.uid !== ownerUid())) {
    throw new BridgeHostError(`Refusing unowned or unsafe ${description}.`);
  }
}

function atomicWrite(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, contents); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function readOwnedJson(path, description, maximumBytes = MAX_MANAGED_JSON_BYTES) {
  const info = inspect(path, "file", 0o600, description);
  if (!info || info.size < 2 || info.size > maximumBytes) throw new BridgeHostError(`Refusing oversized ${description}.`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new BridgeHostError(`Refusing invalid ${description}.`); }
}

function validateCredential(credential, description) {
  if (!isCanonicalIdentity(credential?.id) ||
      typeof credential.secret !== "string" || Buffer.from(credential.secret, "base64").length !== 32 ||
      (credential.createdAt !== undefined && (typeof credential.createdAt !== "string" || credential.createdAt.length > 32 || Number.isNaN(Date.parse(credential.createdAt))))) {
    throw new BridgeHostError(`Refusing invalid ${description}.`);
  }
  return credential;
}

export function localPaths(alias) {
  const home = homedir();
  const bridgeRoot = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const id = hostKey(alias);
  const root = join(bridgeRoot, "hosts", id);
  return {
    home, id, bridgeRoot, root,
    credential: join(root, "credential.json"),
    nextCredential: join(root, "credential.next.json"),
    previousCredential: join(root, "credential.previous.json"),
    rotation: join(root, "credential.rotation.json"),
    revocation: join(root, "credential.revocation.json"),
    revokedCredential: join(root, "credential.revoked.json"),
    endpoint: join(root, "endpoint.json"),
    state: join(root, "setup.json"),
    tunnel: join(root, "tunnel.json"),
    tunnelLog: join(root, "tunnel.log"),
    companionSocket: join(home, "Library", "Caches", "pi-dictation", "bridge", "companion.sock"),
    plist: join(home, "Library", "LaunchAgents", `${PRODUCT}.tunnel.${id}.plist`),
  };
}

const baseSshOptions = [
  "-o", "BatchMode=yes",
  "-o", "RequestTTY=no",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "ForwardX11Trusted=no",
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "ControlPersist=no",
  "-o", "ClearAllForwardings=yes",
];

function ssh(alias, remoteArgs, options = {}) {
  if (typeof options.input === "string" && Buffer.byteLength(options.input) > MAX_REMOTE_BODY_BYTES) {
    throw new BridgeHostError("Remote request body exceeds the safe limit");
  }
  const result = spawnSync("ssh", [...baseSshOptions, alias, ...remoteArgs], {
    encoding: "utf8", input: options.input, timeout: options.timeout ?? 15000,
    maxBuffer: MAX_REMOTE_BODY_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new BridgeHostError(options.failure || "SSH command failed");
  }
  return result.stdout.trim();
}

function waitForRemoteListener(alias, id) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const listener = JSON.parse(ssh(alias, ["pi-dictation", "bridge", "remote-listener", id], {
        timeout: 2000, failure: "Remote listener check failed",
      }));
      if (listener.listener === "established") return listener;
      lastError = new BridgeHostError("Remote listener is not established.");
    } catch (error) { lastError = error; }
    if (attempt < 19) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw lastError || new BridgeHostError("Remote listener check failed.");
}

function waitForRemoteHealth(alias, id) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const health = JSON.parse(ssh(alias, ["pi-dictation", "bridge", "remote-health", id], {
        timeout: 2000, failure: "Remote authenticated companion health check failed",
      }));
      if (health.protocolVersion === BRIDGE_PROTOCOL_VERSION && health.authenticatedHealth === "ok") return health;
      lastError = new BridgeHostError("Remote endpoint returned incompatible or unauthenticated health.");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 19) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw lastError || new BridgeHostError("Remote authenticated companion health check failed.");
}

export function verifyBatchMode(alias) {
  ssh(alias, ["true"], { failure: `Non-interactive BatchMode authentication failed for SSH alias '${alias}'` });
}

export function safePackageInfo(alias) {
  let text;
  try {
    text = ssh(alias, ["pi-dictation", "bridge", "remote-info"], {
      failure: "The remote Pi Dictation package could not be inspected",
    });
  } catch (error) {
    throw new BridgeHostError(`${error.message}. Update it exactly with: npm install -g pi-dictation@${packageVersion()}`);
  }
  let info;
  try { info = JSON.parse(text); }
  catch { throw new BridgeHostError(`Remote Pi Dictation is incompatible. Update it exactly with: npm install -g pi-dictation@${packageVersion()}`); }
  if (info.packageVersion !== packageVersion() || info.protocolVersion !== BRIDGE_PROTOCOL_VERSION || typeof info.home !== "string" || !info.home.startsWith("/")) {
    throw new BridgeHostError(`Remote Pi Dictation is incompatible. Update it exactly with: npm install -g pi-dictation@${packageVersion()}`);
  }
  return info;
}

function packageVersion() {
  return JSON.parse(readFileSync(new URL("./package.json", packageRoot), "utf8")).version;
}

function parseTransport(args, remoteHome, id) {
  const transportIndex = args.indexOf("--transport");
  const transport = transportIndex === -1 ? "unix" : args[transportIndex + 1];
  const allowed = new Set(transportIndex === -1 ? [] : [transportIndex, transportIndex + 1]);
  if (transport !== "unix" && transport !== "tcp") throw new BridgeHostError("--transport must be unix or tcp.");
  const bindIndex = args.indexOf("--bind");
  if (transport === "unix") {
    if (bindIndex !== -1 || args.includes("--allow-loopback")) throw new BridgeHostError("Unix socket transport does not accept loopback fallback options.");
    if (args.some((_, index) => !allowed.has(index))) throw new BridgeHostError("Unknown bridge install option.");
    const path = join(remoteHome, ".local", "share", "pi-dictation", "bridge", "hosts", id, "listener.sock");
    return { endpoint: { type: "unix", path }, display: path, remoteForward: `${path}` };
  }
  if (bindIndex === -1 || !args[bindIndex + 1] || !args.includes("--allow-loopback")) {
    throw new BridgeHostError("TCP fallback requires explicit --allow-loopback and --bind 127.0.0.1:PORT or [::1]:PORT; Unix forwarding is never replaced implicitly.");
  }
  allowed.add(bindIndex); allowed.add(bindIndex + 1); allowed.add(args.indexOf("--allow-loopback"));
  if (args.some((_, index) => !allowed.has(index))) throw new BridgeHostError("Unknown bridge install option.");
  const bind = args[bindIndex + 1];
  let host; let port;
  let match = bind.match(/^127\.0\.0\.1:([1-9][0-9]{0,4})$/);
  if (match) { host = "127.0.0.1"; port = Number(match[1]); }
  else {
    match = bind.match(/^\[::1\]:([1-9][0-9]{0,4})$/);
    if (match) { host = "::1"; port = Number(match[1]); }
  }
  if (!host || port > 65535) throw new BridgeHostError("TCP bind must be exactly 127.0.0.1:PORT or [::1]:PORT; wildcard and non-loopback binds are refused.");
  return { endpoint: { type: "tcp", host, port }, display: bind, remoteForward: host === "::1" ? `[::1]:${port}` : `${host}:${port}` };
}

function resolvedTunnelArguments(alias, transport, companionSocket) {
  const result = spawnSync("ssh", [...baseSshOptions, "-G", alias], {
    encoding: "utf8", timeout: 10000, maxBuffer: MAX_REMOTE_BODY_BYTES,
  });
  if (result.error || result.status !== 0) throw new BridgeHostError(`The SSH alias '${alias}' configuration could not be resolved safely.`);
  const values = new Map();
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1);
    const existing = values.get(key) || [];
    existing.push(value); values.set(key, existing);
  }
  const first = (key) => values.get(key)?.[0];
  const hostname = first("hostname");
  const user = first("user");
  const port = first("port");
  if (!hostname || !user || !/^\d+$/.test(port || "")) throw new BridgeHostError(`The SSH alias '${alias}' did not resolve to a complete host configuration.`);
  const arguments_ = ["-F", "/dev/null", "-o", "BatchMode=yes"];
  const option = (name, value) => { if (value && value !== "none") arguments_.push("-o", `${name}=${value}`); };
  option("User", user); option("Port", port);
  for (const [key, name] of [
    ["addressfamily", "AddressFamily"], ["bindaddress", "BindAddress"], ["bindinterface", "BindInterface"],
    ["stricthostkeychecking", "StrictHostKeyChecking"], ["checkhostip", "CheckHostIP"],
    ["hashknownhosts", "HashKnownHosts"], ["updatehostkeys", "UpdateHostKeys"],
    ["verifyhostkeydns", "VerifyHostKeyDNS"], ["hostkeyalgorithms", "HostKeyAlgorithms"],
    ["pubkeyauthentication", "PubkeyAuthentication"], ["identitiesonly", "IdentitiesOnly"],
    ["identityagent", "IdentityAgent"], ["preferredauthentications", "PreferredAuthentications"],
  ]) option(name, first(key));
  option("HostKeyAlias", first("hostkeyalias") === "none" ? hostname : first("hostkeyalias"));
  for (const [key, name] of [["identityfile", "IdentityFile"], ["certificatefile", "CertificateFile"], ["userknownhostsfile", "UserKnownHostsFile"], ["globalknownhostsfile", "GlobalKnownHostsFile"]]) {
    for (const value of values.get(key) || []) option(name, value);
  }
  const proxyCommand = first("proxycommand");
  const proxyJump = first("proxyjump");
  if (proxyCommand && proxyCommand !== "none") option("ProxyCommand", proxyCommand);
  else if (proxyJump && proxyJump !== "none") {
    const hops = proxyJump.split(",");
    if (hops.some((hop) => !/^[A-Za-z0-9_.@:\[\]-]+$/.test(hop))) throw new BridgeHostError("The SSH ProxyJump route contains unsupported unsafe characters.");
    const last = hops.pop();
    const jump = hops.length ? `-J ${hops.join(",")} ` : "";
    option("ProxyCommand", `ssh -o BatchMode=yes -o RequestTTY=no -o ForwardAgent=no -o ForwardX11=no -o ControlMaster=no -o ClearAllForwardings=yes ${jump}-W %h:%p ${last}`);
  }
  arguments_.push(
    "-o", "RequestTTY=no", "-o", "RemoteCommand=none", "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no", "-o", "ForwardX11Trusted=no", "-o", "ControlMaster=no",
    "-o", "ControlPath=none", "-o", "ControlPersist=no",
    "-o", "ExitOnForwardFailure=yes",
  );
  if (transport.endpoint.type === "unix") arguments_.push("-o", "StreamLocalBindUnlink=yes");
  arguments_.push(
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-N", "-T", "-R", `${transport.remoteForward}:${companionSocket}`, hostname,
  );
  return arguments_;
}

function plist(paths, alias) {
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- pi-dictation-host:${paths.id}:${escape(alias)} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${PRODUCT}.tunnel.${paths.id}</string>\n<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(supervisorPath)}</string><string>${escape(paths.tunnel)}</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}

function bootstrapLaunchAgent(domain, path) {
  let result;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    result = spawnSync("launchctl", ["bootstrap", domain, path], { encoding: "utf8" });
    if (!result.error && result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new BridgeHostError("The host tunnel LaunchAgent could not be loaded.");
}

function assertOwnedHost(paths, alias) {
  if (!existsSync(paths.root)) return;
  inspect(paths.root, "directory", 0o700, "host bridge directory");
  const ownershipPath = join(paths.root, "ownership.json");
  if (!existsSync(ownershipPath)) {
    if (readdirSync(paths.root).length === 0) return;
    throw new BridgeHostError("Refusing host artifacts whose ownership cannot be proven.");
  }
  const ownership = readOwnedJson(ownershipPath, "host ownership receipt");
  if (ownership.product !== PRODUCT || ownership.hostId !== paths.id || ownership.sshAlias !== alias) {
    throw new BridgeHostError("Refusing host artifacts whose ownership cannot be proven.");
  }
  const allowed = new Set([
    "ownership.json", "credential.json", "credential.next.json", "credential.previous.json",
    "credential.rotation.json", "credential.revocation.json", "credential.revoked.json",
    "endpoint.json", "setup.json", "tunnel.json", "tunnel.log", "tunnel.log.1", "tunnel.log.2",
  ]);
  if (readdirSync(paths.root).some((name) => !allowed.has(name))) {
    throw new BridgeHostError("Refusing unexpected host artifact whose ownership cannot be proven.");
  }
  for (const [path, description] of [[paths.credential, "host credential"], [paths.nextCredential, "staged host credential"], [paths.previousCredential, "previous host credential"], [paths.rotation, "credential rotation state"], [paths.revocation, "credential revocation state"], [paths.revokedCredential, "revoked host credential"], [paths.endpoint, "host endpoint"], [paths.state, "host setup state"], [paths.tunnel, "host tunnel configuration"], [paths.tunnelLog, "host tunnel log"], [`${paths.tunnelLog}.1`, "rotated host tunnel log"], [`${paths.tunnelLog}.2`, "rotated host tunnel log"]]) {
    if (existsSync(path)) inspect(path, "file", 0o600, description);
  }
  if (existsSync(paths.plist)) {
    inspect(paths.plist, "file", 0o600, "host tunnel LaunchAgent");
    const contents = readFileSync(paths.plist, "utf8");
    if (!contents.includes(`<!-- pi-dictation-host:${paths.id}:`) ||
        !contents.includes(`<key>Label</key><string>${PRODUCT}.tunnel.${paths.id}</string>`)) {
      throw new BridgeHostError("Refusing an unowned host tunnel LaunchAgent.");
    }
  }
}

const pendingStages = Object.freeze({
  authentication: "pending",
  package: "pending",
  configuration: "pending",
  tunnelProcess: "pending",
  listener: "pending",
  authenticatedHealth: "pending",
});

function readStages(paths, alias) {
  if (!existsSync(paths.state)) return { ...pendingStages };
  const setup = readOwnedJson(paths.state, "host setup state");
  if (setup.product !== PRODUCT || setup.hostId !== paths.id || setup.sshAlias !== alias ||
      !setup.stages || Object.keys(pendingStages).some((name) => typeof setup.stages[name] !== "string" || setup.stages[name].length > 32 || !/^[a-z-]+$/.test(setup.stages[name]))) {
    throw new BridgeHostError("Refusing an unowned or invalid host setup state.");
  }
  return { ...pendingStages, ...setup.stages };
}

function safeDiagnostic(error) {
  const text = String(error || "setup failed")
    .replaceAll(homedir(), "[private-path]")
    .replace(/[A-Za-z0-9+/]{43}=/g, "[redacted]")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/ig, "[redacted]")
    .replace(/[^\x20-\x7e]/g, "?");
  const bytes = Buffer.from(text);
  return bytes.subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8");
}

function state(paths, alias, stages, error) {
  atomicWrite(paths.state, `${JSON.stringify({
    product: PRODUCT, hostId: paths.id, sshAlias: alias, stages,
    error: error ? safeDiagnostic(error) : null, updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

export function installHost(alias, args = []) {
  if (ownerUid() === 0) throw new BridgeHostError("Refusing to install a tunnel as root.");
  const paths = localPaths(alias);
  inspect(paths.bridgeRoot, "directory", 0o700, "bridge support directory");
  const receipt = readOwnedJson(join(paths.bridgeRoot, "ownership.json"), "bridge ownership receipt");
  if (receipt.product !== PRODUCT || !isCanonicalIdentity(receipt.installId)) {
    throw new BridgeHostError("Run `pi-dictation bridge install` to install the Mac companion first.");
  }
  ensureOwnedParent(dirname(paths.plist), "LaunchAgents directory");
  ensureDirectory(join(paths.bridgeRoot, "hosts"), "bridge hosts directory");
  assertOwnedHost(paths, alias);
  if (existsSync(paths.revocation)) throw new BridgeHostError("Credential revocation is pending; finish it before reinstalling this host bridge.");
  if (!existsSync(paths.root)) ensureDirectory(paths.root, "host bridge directory");
  const ownershipPath = join(paths.root, "ownership.json");
  if (!existsSync(ownershipPath)) atomicWrite(ownershipPath, `${JSON.stringify({ product: PRODUCT, hostId: paths.id, sshAlias: alias })}\n`);
  let stages = readStages(paths, alias);
  state(paths, alias, stages);
  try {
    stages = { ...stages, authentication: "pending" }; state(paths, alias, stages);
    verifyBatchMode(alias);
    stages = { ...stages, authentication: "ready" }; state(paths, alias, stages);
    stages = { ...stages, package: "pending" }; state(paths, alias, stages);
    const info = safePackageInfo(alias);
    stages = { ...stages, package: "ready" }; state(paths, alias, stages);
    const transport = parseTransport(args, info.home, paths.id);
    const credential = existsSync(paths.credential)
      ? validateCredential(readOwnedJson(paths.credential, "host credential"), "host credential")
      : { id: randomUUID(), secret: randomBytes(32).toString("base64"), createdAt: new Date().toISOString() };
    if (!existsSync(paths.credential)) atomicWrite(paths.credential, `${JSON.stringify(credential)}\n`);
    const endpoint = { ...transport.endpoint, credentialFile: join(info.home, ".local", "share", "pi-dictation", "bridge", "hosts", paths.id, "credential.json") };
    stages = { ...stages, configuration: "pending" }; state(paths, alias, stages);
    ssh(alias, ["pi-dictation", "bridge", "remote-prepare", paths.id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      input: `${JSON.stringify(credential)}\n`, failure: "Remote listener and Recorder endpoint configuration failed",
    });
    atomicWrite(paths.endpoint, `${JSON.stringify(endpoint, null, 2)}\n`);
    atomicWrite(paths.tunnel, `${JSON.stringify({
      product: PRODUCT,
      hostId: paths.id,
      sshAlias: alias,
      statusFile: paths.state,
      logFile: paths.tunnelLog,
      stableAfterMs: 30000,
      sshArguments: resolvedTunnelArguments(alias, transport, paths.companionSocket),
      listenerCleanupArguments: [...baseSshOptions, alias, "pi-dictation", "bridge", "remote-listener-cleanup", paths.id],
      listenerProbeArguments: [...baseSshOptions, alias, "pi-dictation", "bridge", "remote-listener", paths.id],
      healthProbeArguments: [...baseSshOptions, alias, "pi-dictation", "bridge", "remote-health", paths.id],
    }, null, 2)}\n`);
    stages = { ...stages, configuration: "ready" }; state(paths, alias, stages);
    const plistContents = plist(paths, alias);
    if (existsSync(paths.plist)) {
      inspect(paths.plist, "file", 0o600, "host tunnel LaunchAgent");
      const existingPlist = readFileSync(paths.plist, "utf8");
      const marker = `<!-- pi-dictation-host:${paths.id}:${alias.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")} -->`;
      const label = `<key>Label</key><string>${PRODUCT}.tunnel.${paths.id}</string>`;
      if (!existingPlist.includes(marker) || !existingPlist.includes(label)) throw new BridgeHostError("Refusing an unowned host tunnel LaunchAgent.");
    }
    atomicWrite(paths.plist, plistContents);
    const domain = `gui/${ownerUid()}`;
    const companionStart = spawnSync("launchctl", ["kickstart", `${domain}/${PRODUCT}`], { encoding: "utf8" });
    if (companionStart.error || companionStart.status !== 0) throw new BridgeHostError("The Mac companion could not be started with the host credential.");
    spawnSync("launchctl", ["bootout", `${domain}/${PRODUCT}.tunnel.${paths.id}`], { stdio: "ignore" });
    bootstrapLaunchAgent(domain, paths.plist);
    const kicked = spawnSync("launchctl", ["kickstart", `${domain}/${PRODUCT}.tunnel.${paths.id}`], { encoding: "utf8" });
    if (kicked.error || kicked.status !== 0) throw new BridgeHostError("The host tunnel supervisor could not be started.");
    stages = { ...stages, tunnelProcess: "running", listener: "pending", authenticatedHealth: "pending" }; state(paths, alias, stages);
    try {
      waitForRemoteListener(alias, paths.id);
    } catch (error) {
      if (transport.endpoint.type === "unix") {
        throw new BridgeHostError(`The Unix listener could not be forwarded (${error.message}). No TCP fallback was applied. If this SSH server cannot forward Unix sockets, rerun explicitly with: pi-dictation bridge install ${alias} --transport tcp --allow-loopback --bind 127.0.0.1:PORT`);
      }
      throw error;
    }
    stages = { ...stages, listener: "established" }; state(paths, alias, stages);
    waitForRemoteHealth(alias, paths.id);
    stages = { ...stages, authenticatedHealth: "ready" }; state(paths, alias, stages);
    console.log(`Bridge ready for SSH alias '${alias}'.`);
    console.log(`Remote listener: ${transport.display}`);
  } catch (error) {
    state(paths, alias, stages, error instanceof Error ? error.message : "setup failed");
    throw error;
  }
}

export function refreshHostSupervisors(aliases) {
  const domain = `gui/${ownerUid()}`;
  for (const alias of aliases) {
    const paths = localPaths(alias);
    assertOwnedHost(paths, alias);
    const endpoint = readOwnedJson(paths.endpoint, "host endpoint");
    let transport;
    if (endpoint.type === "unix" && typeof endpoint.credentialFile === "string" &&
        endpoint.path === join(dirname(endpoint.credentialFile), "listener.sock") &&
        endpoint.path.endsWith(`/bridge/hosts/${paths.id}/listener.sock`)) {
      transport = { endpoint, remoteForward: endpoint.path };
    } else if (endpoint.type === "tcp" && typeof endpoint.credentialFile === "string" &&
        endpoint.credentialFile.endsWith(`/bridge/hosts/${paths.id}/credential.json`) &&
        ["127.0.0.1", "::1"].includes(endpoint.host) && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535) {
      transport = { endpoint, remoteForward: endpoint.host === "::1" ? `[::1]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}` };
    } else {
      throw new BridgeHostError("Refusing invalid host endpoint during tunnel supervisor refresh.");
    }
    atomicWrite(paths.tunnel, `${JSON.stringify({
      product: PRODUCT, hostId: paths.id, sshAlias: alias, statusFile: paths.state,
      logFile: paths.tunnelLog, stableAfterMs: 30000,
      sshArguments: resolvedTunnelArguments(alias, transport, paths.companionSocket),
      listenerCleanupArguments: [...baseSshOptions, alias, "pi-dictation", "bridge", "remote-listener-cleanup", paths.id],
      listenerProbeArguments: [...baseSshOptions, alias, "pi-dictation", "bridge", "remote-listener", paths.id],
      healthProbeArguments: [...baseSshOptions, alias, "pi-dictation", "bridge", "remote-health", paths.id],
    }, null, 2)}\n`);
    atomicWrite(paths.plist, plist(paths, alias));
    spawnSync("launchctl", ["bootout", `${domain}/${PRODUCT}.tunnel.${paths.id}`], { stdio: "ignore" });
    bootstrapLaunchAgent(domain, paths.plist);
    const kicked = spawnSync("launchctl", ["kickstart", `${domain}/${PRODUCT}.tunnel.${paths.id}`], { encoding: "utf8" });
    if (kicked.error || kicked.status !== 0) throw new BridgeHostError("The refreshed host tunnel supervisor could not be started.");
    state(paths, alias, { ...readStages(paths, alias), tunnelProcess: "running", listener: "pending", authenticatedHealth: "pending" });
  }
}

export function hostStatus(alias) {
  const paths = localPaths(alias);
  assertOwnedHost(paths, alias);
  const setup = readOwnedJson(paths.state, "host setup state");
  const stages = readStages(paths, alias);
  console.log(`SSH alias: ${alias}`);
  console.log(`Tunnel process: ${stages.tunnelProcess}`);
  console.log(`Listener establishment: ${stages.listener}`);
  console.log(`Authenticated health: ${stages.authenticatedHealth}`);
  if (setup.error) console.log(`Setup error: ${setup.error}`);
}

export function configuredHosts() {
  const root = join(homedir(), "Library", "Application Support", "pi-dictation", "bridge");
  inspect(root, "directory", 0o700, "bridge support directory");
  const hostsRoot = join(root, "hosts");
  if (!existsSync(hostsRoot)) return [];
  inspect(hostsRoot, "directory", 0o700, "bridge hosts directory");
  const result = [];
  for (const id of readdirSync(hostsRoot).sort()) {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new BridgeHostError("Refusing unexpected entry in bridge hosts directory.");
    const ownership = readOwnedJson(join(hostsRoot, id, "ownership.json"), "host ownership receipt");
    if (ownership.product !== PRODUCT || ownership.hostId !== id || typeof ownership.sshAlias !== "string" || hostKey(ownership.sshAlias) !== id) {
      throw new BridgeHostError("Refusing host artifacts whose ownership cannot be proven.");
    }
    const paths = localPaths(ownership.sshAlias);
    assertOwnedHost(paths, ownership.sshAlias);
    const stages = readStages(paths, ownership.sshAlias);
    const hasRevocationIntent = existsSync(paths.revocation);
    if (hasRevocationIntent) readOwnedJson(paths.revocation, "credential revocation state");
    const revocationPending = hasRevocationIntent || !existsSync(paths.credential) && existsSync(paths.revokedCredential);
    const credentialPath = existsSync(paths.credential) ? paths.credential : paths.revokedCredential;
    const credential = validateCredential(readOwnedJson(credentialPath, revocationPending ? "host credential pending revocation" : "host credential"), revocationPending ? "host credential pending revocation" : "host credential");
    result.push({
      sshAlias: ownership.sshAlias,
      credential: { name: credential.id, createdAt: typeof credential.createdAt === "string" ? credential.createdAt : null },
      status: {
        lifecycle: revocationPending ? "revocation-pending" : "active",
        tunnel: revocationPending ? "pending" : stages.tunnelProcess,
        listener: revocationPending ? "pending" : stages.listener,
        authenticatedHealth: revocationPending ? "pending" : stages.authenticatedHealth,
      },
    });
    if (result.length > 1000) throw new BridgeHostError("Bridge list exceeds the safe 1000-host output limit.");
  }
  return result.sort((left, right) => left.sshAlias.localeCompare(right.sshAlias));
}

export function listHosts(json = false) {
  const hosts = configuredHosts();
  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, hosts }));
    return;
  }
  if (hosts.length === 0) return console.log("No host bridges configured.");
  for (const host of hosts) {
    console.log(`${host.sshAlias}: lifecycle=${host.status.lifecycle}, tunnel=${host.status.tunnel}, listener=${host.status.listener}, health=${host.status.authenticatedHealth}, credential=${host.credential.name}, created=${host.credential.createdAt || "unknown"}`);
  }
}

function stage(status, detail) {
  return detail === undefined ? { status } : { status, detail };
}

export function launchAgentLoaded(label) {
  const result = spawnSync("launchctl", ["print", `gui/${ownerUid()}/${label}`], {
    encoding: "utf8", timeout: 3000, maxBuffer: MAX_DIAGNOSTIC_BYTES,
  });
  return !result.error && result.status === 0;
}

export async function diagnoseHosts(companionRequestAt) {
  const hosts = configuredHosts();
  const reports = [];
  for (const host of hosts) {
    const paths = localPaths(host.sshAlias);
    let listener = stage("unavailable");
    let authenticatedHealth = stage("unavailable");
    let protocolCompatibility = stage("unavailable");
    let permission = stage("unavailable");
    let levelAvailability = stage("unavailable");
    try {
      const value = JSON.parse(ssh(host.sshAlias, ["pi-dictation", "bridge", "remote-listener", paths.id], {
        timeout: 3000, failure: "Remote listener check failed",
      }));
      if (value.listener === "established") listener = stage("established");
    } catch {}
    try {
      const value = JSON.parse(ssh(host.sshAlias, ["pi-dictation", "bridge", "remote-health", paths.id], {
        timeout: 3000, failure: "Remote authenticated health check failed",
      }));
      if (value.authenticatedHealth === "ok") authenticatedHealth = stage("ready");
      protocolCompatibility = stage(value.protocolVersion === BRIDGE_PROTOCOL_VERSION ? "compatible" : "incompatible", {
        client: BRIDGE_PROTOCOL_VERSION,
        companion: Number.isSafeInteger(value.protocolVersion) ? value.protocolVersion : null,
      });
      if (["authorized", "denied", "restricted", "not-determined", "unknown"].includes(value.permission)) permission = stage(value.permission);
      levelAvailability = stage(value.authenticatedHealth === "ok" && value.protocolVersion === BRIDGE_PROTOCOL_VERSION ? "available" : "unavailable");
    } catch {}
    let effects;
    try {
      const credential = validateCredential(readOwnedJson(paths.credential, "host credential"), "host credential");
      effects = validateCredentialEffects(await companionRequestAt(localCompanionEndpoint(paths), credential, "credential-effects"));
    } catch {}
    reports.push({
      sshAlias: host.sshAlias,
      lifecycle: host.status.lifecycle,
      tunnelProcess: stage(launchAgentLoaded(`${PRODUCT}.tunnel.${paths.id}`) ? "running" : "not-running"),
      listener,
      authenticatedHealth,
      protocolCompatibility,
      permission,
      storage: effects ? stage(effects.retainedWav <= 2 && effects.incompleteAudio <= 1 ? "bounded" : "limit-exceeded", {
        incompleteAudio: effects.incompleteAudio, retainedWav: effects.retainedWav,
        maximumRetainedWav: 2, maximumRetainedWavBytes: 268435456,
      }) : stage("unavailable"),
      connections: effects ? stage(effects.connections <= 4 ? "bounded" : "limit-exceeded", {
        currentForCredential: effects.connections, maximumPerCredential: 4, maximumTotal: 16,
      }) : stage("unavailable"),
      levelAvailability,
    });
  }
  return reports;
}

export function readBridgeLogs(alias) {
  const files = [];
  if (alias) {
    const paths = localPaths(alias);
    assertOwnedHost(paths, alias);
    for (const suffix of [".2", ".1", ""]) files.push({ path: `${paths.tunnelLog}${suffix}`, source: `tunnel:${alias}` });
  } else {
    const path = join(homedir(), "Library", "Caches", "pi-dictation", "bridge", "companion.log");
    const runtime = dirname(path);
    if (existsSync(runtime)) inspect(runtime, "directory", 0o700, "bridge runtime directory");
    for (const suffix of [".2", ".1", ""]) files.push({ path: `${path}${suffix}`, source: "companion" });
  }
  const records = [];
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    const info = inspect(file.path, "file", 0o600, "bridge log");
    if (info.size > 1024 * 1024) throw new BridgeHostError("Refusing oversized bridge log.");
    for (const line of readFileSync(file.path, "utf8").split("\n")) {
      if (!line || records.length >= 256) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      const safe = (text) => typeof text === "string" && /^[A-Za-z0-9._:-]{1,96}$/.test(text) ? text : undefined;
      const component = safe(value.component);
      const code = safe(value.code);
      if (!component || !code) continue;
      records.push({ source: file.source, component, code, ...(safe(value.stage) ? { stage: value.stage } : {}),
        ...(Number.isSafeInteger(value.retry) ? { retry: Math.max(0, Math.min(value.retry, 1_000_000)) } : {}),
        ...(Number.isSafeInteger(value.version) ? { version: Math.max(0, Math.min(value.version, 1_000_000)) } : {}) });
    }
  }
  return records;
}

export function repairHost(alias, confirmed, needsReconcile = true) {
  if (!alias) {
    console.log("Repair preview: no host selected; no changes are required.");
    console.log("Preview only. Repair never changes credentials, microphone permission, or audio.");
    return;
  }
  const paths = localPaths(alias);
  assertOwnedHost(paths, alias);
  if (!existsSync(paths.credential)) throw new BridgeHostError("Repair refuses to create or change a missing host credential; reinstall this host bridge explicitly.");
  validateCredential(readOwnedJson(paths.credential, "host credential"), "host credential");
  readOwnedJson(paths.tunnel, "host tunnel configuration");
  const loaded = launchAgentLoaded(`${PRODUCT}.tunnel.${paths.id}`);
  const actions = !needsReconcile ? [] : [loaded
    ? `restart the owned tunnel LaunchAgent for '${alias}' to reconcile its listener and health probes`
    : `load the owned tunnel LaunchAgent for '${alias}' to recreate its listener and health probes`];
  console.log(actions.length ? `Repair preview:\n- ${actions.join("\n- ")}` : "Repair preview: no changes are required.");
  console.log("Credentials, microphone permission, and audio will not be changed.");
  if (!confirmed) {
    console.log(`Preview only. Rerun with: pi-dictation bridge repair ${alias} --confirm`);
    return;
  }
  if (needsReconcile) {
    const domain = `gui/${ownerUid()}`;
    if (!loaded) {
      const loadedResult = spawnSync("launchctl", ["bootstrap", domain, paths.plist], { encoding: "utf8" });
      if (loadedResult.error || loadedResult.status !== 0) throw new BridgeHostError(`The owned tunnel LaunchAgent for '${alias}' could not be loaded.`);
    }
    const kicked = spawnSync("launchctl", ["kickstart", ...(loaded ? ["-k"] : []), `${domain}/${PRODUCT}.tunnel.${paths.id}`], { encoding: "utf8" });
    if (kicked.error || kicked.status !== 0) throw new BridgeHostError(`The owned tunnel supervisor for '${alias}' could not be started.`);
  }
}

export async function inspectHostEffects(aliases, companionRequestAt) {
  const effects = [];
  for (const alias of aliases) {
    const paths = localPaths(alias);
    assertOwnedHost(paths, alias);
    const credential = validateCredential(readOwnedJson(paths.credential, "host credential"), "host credential");
    const value = validateCredentialEffects(await companionRequestAt(localCompanionEndpoint(paths), credential, "credential-effects"));
    effects.push({ sshAlias: alias, ...value });
  }
  return effects;
}

export async function inspectUpgrade(companionRequestAt) {
  const hosts = configuredHosts();
  for (const host of hosts) {
    verifyBatchMode(host.sshAlias);
    safePackageInfo(host.sshAlias);
  }
  return inspectHostEffects(hosts.map((host) => host.sshAlias), companionRequestAt);
}

export async function quiesceUpgradeHosts(hosts, requestIds, cancelAliases, companionRequestAt) {
  const results = [];
  for (const alias of hosts) {
    const paths = localPaths(alias);
    assertOwnedHost(paths, alias);
    const credential = validateCredential(readOwnedJson(paths.credential, "host credential"), "host credential");
    const operation = cancelAliases.includes(alias) ? "credential-cancel-recordings" : "credential-quiesce-if-idle";
    const effects = validateCredentialEffects(await companionRequestAt(
      localCompanionEndpoint(paths), credential, operation, requestIds[alias],
    ));
    results.push({ sshAlias: alias, ...effects });
  }
  return results;
}

function localCompanionEndpoint(paths) {
  return { type: "unix", path: paths.companionSocket };
}

function administrationRequestId(credentialId, operation) {
  const hex = createHash("sha256").update(`${PRODUCT}\0${credentialId}\0${operation}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function validateCredentialEffects(value) {
  const keys = ["connections", "activeRecordingLease", "incompleteAudio", "retainedWav"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join() ||
      keys.some((key) => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100000)) {
    throw new BridgeHostError("The companion returned invalid credential deletion effects.");
  }
  return value;
}

const rotationPhases = new Set(["staged", "old-revoked", "promoted", "remote-committed"]);

function writeRotation(paths, rotation, phase) {
  atomicWrite(paths.rotation, `${JSON.stringify({ ...rotation, phase })}\n`);
  return { ...rotation, phase };
}

function readRotation(paths) {
  if (!existsSync(paths.rotation)) return undefined;
  const rotation = readOwnedJson(paths.rotation, "credential rotation state");
  if (rotation.product !== PRODUCT || rotation.hostId !== paths.id ||
      !isCanonicalIdentity(rotation.oldCredentialId) || !isCanonicalIdentity(rotation.nextCredentialId) ||
      !isCanonicalIdentity(rotation.revokeRequestId) ||
      rotation.oldCredentialId === rotation.nextCredentialId || !rotationPhases.has(rotation.phase)) {
    throw new BridgeHostError("Refusing invalid credential rotation state.");
  }
  return rotation;
}

function optionalCredential(path, description) {
  return existsSync(path) ? validateCredential(readOwnedJson(path, description), description) : undefined;
}

function reconcilePromotedCredential(paths, rotation) {
  let current = optionalCredential(paths.credential, "host credential");
  let next = optionalCredential(paths.nextCredential, "staged host credential");
  let previous = optionalCredential(paths.previousCredential, "previous host credential");
  if (current?.id === rotation.oldCredentialId && next?.id === rotation.nextCredentialId && !previous) {
    renameSync(paths.credential, paths.previousCredential);
    current = undefined;
    previous = optionalCredential(paths.previousCredential, "previous host credential");
  }
  if (!current && next?.id === rotation.nextCredentialId && previous?.id === rotation.oldCredentialId) {
    renameSync(paths.nextCredential, paths.credential);
    current = optionalCredential(paths.credential, "host credential");
    next = undefined;
  }
  if (current?.id !== rotation.nextCredentialId || previous?.id !== rotation.oldCredentialId || next) {
    throw new BridgeHostError("Refusing an inconsistent interrupted credential rotation.");
  }
  return current;
}

function testInterruption(name) {
  if (process.env.NODE_ENV === "test" && process.env.PI_DICTATION_TEST_INTERRUPT === name) {
    throw new BridgeHostError(`Simulated interruption at ${name}.`);
  }
}

export async function rotateHost(alias, companionRequestAt) {
  const paths = localPaths(alias);
  assertOwnedHost(paths, alias);
  if (existsSync(paths.revocation)) throw new BridgeHostError("Credential revocation is pending; finish it before rotating this host bridge.");
  let rotation = readRotation(paths);
  if (!rotation) {
    const previous = optionalCredential(paths.previousCredential, "previous host credential");
    const current = optionalCredential(paths.credential, "host credential");
    const staged = optionalCredential(paths.nextCredential, "staged host credential");
    if (previous) {
      const replacement = current || staged;
      if (!replacement) throw new BridgeHostError("Refusing an interrupted rotation without a replacement credential.");
      rotation = writeRotation(paths, {
        product: PRODUCT, hostId: paths.id,
        oldCredentialId: previous.id, nextCredentialId: replacement.id,
        revokeRequestId: randomUUID(),
      }, "old-revoked");
    } else {
      if (!current) throw new BridgeHostError("Refusing rotation without a current host credential.");
      const replacement = staged || { id: randomUUID(), secret: randomBytes(32).toString("base64"), createdAt: new Date().toISOString() };
      if (!staged) atomicWrite(paths.nextCredential, `${JSON.stringify(replacement)}\n`);
      rotation = writeRotation(paths, {
        product: PRODUCT, hostId: paths.id,
        oldCredentialId: current.id, nextCredentialId: replacement.id,
        revokeRequestId: randomUUID(),
      }, "staged");
    }
  }
  try {
    const current = optionalCredential(paths.credential, "host credential");
    const staged = optionalCredential(paths.nextCredential, "staged host credential");
    const replacement = current?.id === rotation.nextCredentialId ? current : staged;
    if (!replacement || replacement.id !== rotation.nextCredentialId) {
      throw new BridgeHostError("Refusing rotation without the recorded replacement credential.");
    }
    const endpoint = readOwnedJson(paths.endpoint, "host endpoint");
    if (rotation.phase === "staged" || rotation.phase === "old-revoked") {
      ssh(alias, ["pi-dictation", "bridge", "remote-prepare", paths.id, Buffer.from(JSON.stringify({ ...endpoint, stagedCredential: true })).toString("base64")], {
        input: `${JSON.stringify(replacement)}\n`, failure: "The new remote credential could not be installed",
      });
      waitForRemoteHealth(alias, paths.id);
    }
    if (rotation.phase === "staged") {
      const oldCredential = optionalCredential(paths.credential, "host credential");
      if (!oldCredential || oldCredential.id !== rotation.oldCredentialId) throw new BridgeHostError("Refusing rotation without the old credential.");
      try {
        validateCredentialEffects(await companionRequestAt(
          localCompanionEndpoint(paths), oldCredential, "credential-revoke-if-idle",
          rotation.revokeRequestId,
        ));
      } catch (error) {
        if (error?.status === "invalid-state") {
          rotation = writeRotation(paths, { ...rotation, revokeRequestId: randomUUID() }, "staged");
        }
        throw error;
      }
      testInterruption("after-revoke");
      rotation = writeRotation(paths, rotation, "old-revoked");
    }
    if (rotation.phase === "old-revoked") {
      if (existsSync(paths.credential) && !existsSync(paths.previousCredential)) {
        renameSync(paths.credential, paths.previousCredential);
        testInterruption("after-old-rename");
      }
      if (!existsSync(paths.credential) && existsSync(paths.nextCredential)) {
        renameSync(paths.nextCredential, paths.credential);
        testInterruption("after-new-rename");
      }
      reconcilePromotedCredential(paths, rotation);
      rotation = writeRotation(paths, rotation, "promoted");
    }
    if (rotation.phase === "promoted") {
      ssh(alias, ["pi-dictation", "bridge", "remote-credential-commit", paths.id, rotation.oldCredentialId, rotation.nextCredentialId], {
        failure: "The verified remote credential could not be committed",
      });
      testInterruption("after-remote-commit");
      rotation = writeRotation(paths, rotation, "remote-committed");
    }
    if (existsSync(paths.previousCredential)) rmSync(paths.previousCredential);
    if (existsSync(paths.nextCredential)) rmSync(paths.nextCredential);
    rmSync(paths.rotation);
    console.log(`Credential rotated for SSH alias '${alias}'.`);
  } catch (error) {
    throw new BridgeHostError(`${error instanceof Error ? error.message : "Credential rotation failed"} The staged credential was preserved for a safe retry.`);
  }
}

export async function revokeHost(alias, confirmed, companionRequestAt, deletionPolicy = "confirmed") {
  const paths = localPaths(alias);
  assertOwnedHost(paths, alias);
  let revocation;
  if (existsSync(paths.revocation)) {
    revocation = readOwnedJson(paths.revocation, "credential revocation state");
    if (revocation.product !== PRODUCT || revocation.hostId !== paths.id ||
        !["confirmed", "companion-revoked"].includes(revocation.phase) ||
        (revocation.operation !== undefined && !["credential-revoke", "credential-revoke-if-idle", "credential-revoke-if-no-active"].includes(revocation.operation)) ||
        !isCanonicalIdentity(revocation.credentialId) ||
        !isCanonicalIdentity(revocation.requestId)) {
      throw new BridgeHostError("Refusing invalid credential revocation state.");
    }
  }
  const alreadyDisabled = existsSync(paths.revokedCredential) && !existsSync(paths.credential);
  if (!revocation) {
    if (alreadyDisabled) throw new BridgeHostError("Credential revocation state is missing; refusing unsafe cleanup.");
    const credential = validateCredential(readOwnedJson(paths.credential, "host credential"), "host credential");
    const effects = validateCredentialEffects(await companionRequestAt(localCompanionEndpoint(paths), credential, "credential-effects"));
    console.log(`SSH alias: ${alias}`);
    console.log(`Connections to close: ${effects.connections}`);
    console.log(`Active Recording leases to delete: ${effects.activeRecordingLease}`);
    console.log(`Incomplete audio to delete: ${effects.incompleteAudio}`);
    console.log(`Retained WAVs to delete: ${effects.retainedWav}`);
    if (!confirmed) {
      console.log(`Preview only. Rerun with: pi-dictation bridge revoke ${alias} --confirm`);
      return;
    }
    ssh(alias, ["pi-dictation", "bridge", "remote-recorder-removal-check", paths.id], {
      failure: "Select Local recording with /dictate-config before removing the selected Bridge Recorder",
    });
    const operation = deletionPolicy === "preserve-retained"
      ? "credential-revoke-if-idle"
      : deletionPolicy === "delete-retained-if-no-active"
        ? "credential-revoke-if-no-active"
        : "credential-revoke";
    revocation = {
      product: PRODUCT, hostId: paths.id, credentialId: credential.id, operation,
      requestId: administrationRequestId(credential.id, operation), phase: "confirmed",
    };
    atomicWrite(paths.revocation, `${JSON.stringify(revocation)}\n`);
  } else if (!confirmed) {
    throw new BridgeHostError("Credential revocation is already confirmed and awaiting cleanup; rerun with --confirm.");
  }
  if (revocation.phase === "confirmed") {
    const credentialPath = existsSync(paths.credential) ? paths.credential : paths.revokedCredential;
    const credential = validateCredential(readOwnedJson(credentialPath, "host credential pending revocation"), "host credential pending revocation");
    if (credential.id !== revocation.credentialId) throw new BridgeHostError("Credential changed during revocation.");
    try {
      validateCredentialEffects(await companionRequestAt(
        localCompanionEndpoint(paths), credential, revocation.operation || "credential-revoke", revocation.requestId,
      ));
    } catch (error) {
      if (error?.status === "invalid-state" && ["credential-revoke-if-idle", "credential-revoke-if-no-active"].includes(revocation.operation)) {
        rmSync(paths.revocation);
        try { ssh(alias, ["pi-dictation", "bridge", "remote-recorder-removal-release", paths.id]); }
        catch {
          throw new BridgeHostError("Recording state changed before uninstall could revoke the credential. The remote Recorder selection lock could not be released; retry the confirmed removal to reconcile it.");
        }
        throw new BridgeHostError("Recording state changed before uninstall could revoke the credential; no bridge was removed. Preview again and explicitly confirm the required deletion.");
      }
      throw new BridgeHostError(`${error instanceof Error ? error.message : "Credential revocation failed"} The confirmed revocation was preserved for a safe retry.`);
    }
    revocation = { ...revocation, phase: "companion-revoked" };
    atomicWrite(paths.revocation, `${JSON.stringify(revocation)}\n`);
  }
  const domain = `gui/${ownerUid()}`;
  spawnSync("launchctl", ["bootout", `${domain}/${PRODUCT}.tunnel.${paths.id}`], { stdio: "ignore" });
  if (existsSync(paths.credential) && !existsSync(paths.revokedCredential)) renameSync(paths.credential, paths.revokedCredential);
  else if (existsSync(paths.credential) || !existsSync(paths.revokedCredential)) throw new BridgeHostError("Credential files are inconsistent during revocation.");
  try {
    ssh(alias, ["pi-dictation", "bridge", "remote-credential-revoke", paths.id], { failure: "Remote credential revocation failed" });
  } catch (error) {
    throw new BridgeHostError(`${error instanceof Error ? error.message : "Remote credential revocation failed"}. The local credential and tunnel remain disabled; rerun with --confirm to finish remote cleanup.`);
  }
  if (existsSync(paths.plist)) {
    inspect(paths.plist, "file", 0o600, "host tunnel LaunchAgent");
    rmSync(paths.plist);
  }
  testInterruption("after-plist-removal");
  rmSync(paths.root, { recursive: true });
  console.log(`Credential revoked for SSH alias '${alias}'.`);
}

function remoteRoot(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new BridgeHostError("Invalid bridge host identifier.");
  return join(homedir(), ".local", "share", "pi-dictation", "bridge", "hosts", id);
}

export function remoteInfo() {
  console.log(JSON.stringify({ packageVersion: packageVersion(), protocolVersion: BRIDGE_PROTOCOL_VERSION, home: homedir() }));
}

function remoteConfigPaths(id) {
  const configDirectory = join(homedir(), ".pi", "agent");
  return {
    configDirectory,
    config: join(configDirectory, "pi-dictation.json"),
    receipt: join(configDirectory, "pi-dictation.bridge-owner.json"),
    hostId: id,
  };
}

function configDigest(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function withRemoteRecorderProfile(current, recorder) {
  const next = { ...current };
  let recorders;
  if (current.recorders) {
    recorders = { ...current.recorders };
  } else if (current.recorder?.type === "local") {
    recorders = {
      selected: "local",
      local: current.recorder.command ? { command: current.recorder.command } : undefined,
    };
  } else if (current.recorder?.type === "bridge") {
    recorders = {
      selected: "bridge",
      bridge: { endpoint: current.recorder.endpoint, credentialFile: current.recorder.credentialFile },
    };
  } else {
    recorders = { selected: "local" };
  }
  delete next.recorder;
  if (recorder.type === "bridge") {
    recorders.bridge = { endpoint: recorder.endpoint, credentialFile: recorder.credentialFile };
  } else {
    if (recorders.selected === "bridge") {
      throw new BridgeHostError("Select Local recording with /dictate-config before removing the selected Bridge Recorder.");
    }
    delete recorders.bridge;
  }
  next.recorders = recorders;
  return next;
}

function managedRecorder(config) {
  if (config?.recorders?.bridge) return { ...config.recorders.bridge, type: "bridge" };
  return config?.recorder?.type === "bridge" ? config.recorder : null;
}

function managedRecorderDigest(config) {
  return config ? configDigest(managedRecorder(config)) : null;
}

function readyRecorderReceipt(id, config) {
  return { product: PRODUCT, hostId: id, phase: "ready", recorderSha256: managedRecorderDigest(config) };
}

function legacyReceiptCanMigrate(id, receipt, current) {
  if (receipt.sha256 === configDigest(current)) return true;
  const endpointPath = join(remoteRoot(id), "endpoint.json");
  if (!existsSync(endpointPath)) return false;
  const endpoint = readOwnedJson(endpointPath, "remote Recorder endpoint configuration");
  return JSON.stringify(endpoint) === JSON.stringify(managedRecorder(current));
}

function reconcileRemoteRecorder(id, recorder) {
  const paths = remoteConfigPaths(id);
  const staged = join(paths.configDirectory, "pi-dictation.bridge-next.json");
  ensureOwnedParent(join(homedir(), ".pi"), "remote Pi directory");
  ensureOwnedParent(paths.configDirectory, "remote Pi agent directory");

  if (existsSync(paths.receipt)) {
    const receipt = readOwnedJson(paths.receipt, "remote Pi Dictation configuration ownership receipt");
    if (receipt.product !== PRODUCT || receipt.hostId !== id || !["preparing", "pending", "ready"].includes(receipt.phase)) {
      throw new BridgeHostError("Refusing an unowned remote Pi Dictation configuration.");
    }
    if (receipt.phase === "preparing") {
      const current = existsSync(paths.config) ? readOwnedJson(paths.config, "remote Pi Dictation configuration") : undefined;
      const currentHash = receipt.previousRecorderSha256 === undefined
        ? (current ? configDigest(current) : null)
        : managedRecorderDigest(current);
      const expected = receipt.previousRecorderSha256 !== undefined
        ? receipt.previousRecorderSha256
        : receipt.previousSha256;
      if (currentHash !== expected) {
        throw new BridgeHostError("Refusing an interrupted remote Pi Dictation configuration with unproven contents.");
      }
      if (existsSync(staged)) { inspect(staged, "file", 0o600, "staged remote Pi Dictation configuration"); rmSync(staged); }
      if (current) atomicWrite(paths.receipt, `${JSON.stringify(readyRecorderReceipt(id, current))}\n`);
      else rmSync(paths.receipt);
    } else if (receipt.phase === "pending") {
      const current = existsSync(paths.config) ? readOwnedJson(paths.config, "remote Pi Dictation configuration") : undefined;
      const managedTransaction = receipt.nextRecorderSha256 !== undefined;
      const currentHash = managedTransaction ? managedRecorderDigest(current) : (current ? configDigest(current) : null);
      const previousHash = managedTransaction ? receipt.previousRecorderSha256 : receipt.previousSha256;
      const nextHash = managedTransaction ? receipt.nextRecorderSha256 : receipt.nextSha256;
      if (currentHash === previousHash) {
        inspect(staged, "file", 0o600, "staged remote Pi Dictation configuration");
        const stagedConfig = readOwnedJson(staged, "staged remote Pi Dictation configuration");
        const stagedHash = managedTransaction ? managedRecorderDigest(stagedConfig) : configDigest(stagedConfig);
        if (stagedHash !== nextHash) throw new BridgeHostError("Refusing an invalid staged remote Pi Dictation configuration.");
        const next = managedTransaction
          ? withRemoteRecorderProfile(current || {}, managedRecorder(stagedConfig) || { type: "local" })
          : stagedConfig;
        atomicWrite(paths.config, `${JSON.stringify(next, null, 2)}\n`);
        rmSync(staged);
      } else if (currentHash === nextHash) {
        if (existsSync(staged)) { inspect(staged, "file", 0o600, "staged remote Pi Dictation configuration"); rmSync(staged); }
      } else {
        throw new BridgeHostError("Refusing an interrupted remote Pi Dictation configuration with unproven contents.");
      }
      const recovered = readOwnedJson(paths.config, "remote Pi Dictation configuration");
      atomicWrite(paths.receipt, `${JSON.stringify(readyRecorderReceipt(id, recovered))}\n`);
    }
  }

  if (existsSync(paths.config) && !existsSync(paths.receipt)) {
    throw new BridgeHostError("Refusing to overwrite an unowned remote Pi Dictation configuration.");
  }
  const current = existsSync(paths.config) ? readOwnedJson(paths.config, "remote Pi Dictation configuration") : {};
  if (existsSync(paths.receipt)) {
    const receipt = readOwnedJson(paths.receipt, "remote Pi Dictation configuration ownership receipt");
    const owned = receipt.phase === "ready" && (
      receipt.recorderSha256 === managedRecorderDigest(current) ||
      (receipt.recorderSha256 === undefined && legacyReceiptCanMigrate(id, receipt, current))
    );
    if (!owned) {
      throw new BridgeHostError("Refusing to overwrite a remote Pi Dictation Bridge Recorder changed outside bridge setup.");
    }
    if (receipt.recorderSha256 === undefined) {
      atomicWrite(paths.receipt, `${JSON.stringify(readyRecorderReceipt(id, current))}\n`);
    }
  }
  const next = withRemoteRecorderProfile(current, recorder);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  if (existsSync(staged)) throw new BridgeHostError("Refusing an unexpected staged remote Pi Dictation configuration.");
  const previousRecorderSha256 = existsSync(paths.config) ? managedRecorderDigest(current) : null;
  const nextRecorderSha256 = managedRecorderDigest(next);
  atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "preparing", previousRecorderSha256 })}\n`);
  atomicWrite(staged, `${JSON.stringify(next, null, 2)}\n`);
  atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "pending", previousRecorderSha256, nextRecorderSha256 })}\n`);
  renameSync(staged, paths.config);
  atomicWrite(paths.receipt, `${JSON.stringify(readyRecorderReceipt(id, next))}\n`);
}

function readBoundedStandardInput(maximumBytes) {
  const chunks = [];
  let bytes = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(4096, maximumBytes + 1 - bytes));
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    bytes += count;
    if (bytes > maximumBytes) throw new BridgeHostError("Remote request body exceeds the safe limit.");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export function remotePrepare(id, encodedEndpoint) {
  let endpoint; let credential;
  try {
    if (typeof encodedEndpoint !== "string" || Buffer.byteLength(encodedEndpoint) > MAX_REMOTE_ENDPOINT_BYTES ||
        encodedEndpoint.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedEndpoint)) throw new Error();
    const decoded = Buffer.from(encodedEndpoint, "base64");
    if (decoded.toString("base64") !== encodedEndpoint) throw new Error();
    endpoint = JSON.parse(decoded.toString("utf8"));
  } catch { throw new BridgeHostError("Invalid remote endpoint configuration."); }
  try { credential = JSON.parse(readBoundedStandardInput(MAX_REMOTE_CREDENTIAL_BYTES)); }
  catch (error) {
    if (error instanceof BridgeHostError) throw error;
    throw new BridgeHostError("Invalid remote bridge credential.");
  }
  validateCredential(credential, "remote bridge credential");
  if (endpoint.type === "unix") {
    if (typeof endpoint.path !== "string" || !endpoint.path.startsWith("/") || !endpoint.path.endsWith("/listener.sock")) throw new BridgeHostError("Invalid remote Unix listener.");
  } else if (endpoint.type === "tcp") {
    if (!(["127.0.0.1", "::1"].includes(endpoint.host)) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new BridgeHostError("Refusing wildcard or non-loopback remote listener.");
  } else throw new BridgeHostError("Invalid remote listener type.");
  const root = remoteRoot(id);
  const home = homedir();
  ensureOwnedParent(home, "remote home directory");
  let parent = home;
  for (const component of [".local", "share"]) {
    parent = join(parent, component);
    ensureOwnedParent(parent, `remote ${component} directory`);
  }
  for (const component of ["pi-dictation", "bridge", "hosts"]) {
    parent = join(parent, component);
    ensureDirectory(parent, `remote ${component} directory`);
  }
  if (existsSync(root)) {
    inspect(root, "directory", 0o700, "remote host bridge directory");
    const ownership = readOwnedJson(join(root, "ownership.json"), "remote bridge ownership receipt");
    if (ownership.product !== PRODUCT || ownership.hostId !== id) throw new BridgeHostError("Refusing unowned remote bridge artifacts.");
  } else {
    mkdirSync(root, { mode: 0o700 });
    atomicWrite(join(root, "ownership.json"), `${JSON.stringify({ product: PRODUCT, hostId: id })}\n`);
  }
  const credentialPath = join(root, endpoint.stagedCredential === true ? "credential.next.json" : "credential.json");
  const endpointPath = join(root, "endpoint.json");
  if (existsSync(credentialPath)) {
    const old = readOwnedJson(credentialPath, "remote bridge credential");
    if (old.id !== credential.id || old.secret !== credential.secret) throw new BridgeHostError("Refusing to overwrite a different remote bridge credential.");
  } else atomicWrite(credentialPath, `${JSON.stringify(credential)}\n`);
  const recorder = { type: "bridge", endpoint: endpoint.type === "unix" ? { type: "unix", path: endpoint.path } : { type: "tcp", host: endpoint.host, port: endpoint.port }, credentialFile: credentialPath };
  if (existsSync(endpointPath)) readOwnedJson(endpointPath, "remote Recorder endpoint configuration");
  atomicWrite(endpointPath, `${JSON.stringify(recorder, null, 2)}\n`);
  reconcileRemoteRecorder(id, recorder);
  console.log(JSON.stringify({ configured: true }));
}

export function remoteCredentialCommit(id, oldCredentialId, nextCredentialId) {
  if (!isCanonicalIdentity(oldCredentialId) || !isCanonicalIdentity(nextCredentialId) ||
      oldCredentialId === nextCredentialId) {
    throw new BridgeHostError("Invalid credential rotation identities.");
  }
  const root = remoteRoot(id);
  inspect(root, "directory", 0o700, "remote host bridge directory");
  const ownership = readOwnedJson(join(root, "ownership.json"), "remote bridge ownership receipt");
  if (ownership.product !== PRODUCT || ownership.hostId !== id) throw new BridgeHostError("Refusing unowned remote bridge artifacts.");
  const currentPath = join(root, "credential.json");
  const nextPath = join(root, "credential.next.json");
  const current = validateCredential(readOwnedJson(currentPath, "remote bridge credential"), "remote bridge credential");
  const next = existsSync(nextPath)
    ? validateCredential(readOwnedJson(nextPath, "staged remote bridge credential"), "staged remote bridge credential")
    : undefined;
  if (current.id === oldCredentialId && next?.id === nextCredentialId) {
    atomicWrite(currentPath, `${JSON.stringify(next)}\n`);
    testInterruption("after-remote-current-copy");
  } else if (current.id !== nextCredentialId || (next && next.id !== nextCredentialId)) {
    throw new BridgeHostError("Remote credential changed during rotation.");
  }
  const endpointPath = join(root, "endpoint.json");
  const staged = readOwnedJson(endpointPath, "remote Recorder endpoint configuration");
  const recorder = { ...staged, credentialFile: currentPath };
  atomicWrite(endpointPath, `${JSON.stringify(recorder, null, 2)}\n`);
  reconcileRemoteRecorder(id, recorder);
  if (existsSync(nextPath)) {
    const retained = validateCredential(readOwnedJson(nextPath, "staged remote bridge credential"), "staged remote bridge credential");
    if (retained.id !== nextCredentialId) throw new BridgeHostError("Remote credential changed during rotation.");
    rmSync(nextPath);
  }
  console.log(JSON.stringify({ committed: true }));
}

function recorderSelectionLockPath(root) {
  return join(root, "recorder-selection.lock");
}

function acquireRemoteRemovalLock(root, id) {
  const path = recorderSelectionLockPath(root);
  const value = { product: PRODUCT, hostId: id, purpose: "removal" };
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    chmodSync(path, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readOwnedJson(path, "remote Recorder selection lock");
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new BridgeHostError("Recorder selection is being saved; retry Bridge removal.");
    }
  }
}

export function remoteRecorderRemovalCheck(id) {
  const root = remoteRoot(id);
  if (!existsSync(root)) {
    console.log(JSON.stringify({ removable: true }));
    return;
  }
  inspect(root, "directory", 0o700, "remote host bridge directory");
  const ownership = readOwnedJson(join(root, "ownership.json"), "remote bridge ownership receipt");
  if (ownership.product !== PRODUCT || ownership.hostId !== id) {
    throw new BridgeHostError("Refusing unowned remote bridge artifacts.");
  }
  acquireRemoteRemovalLock(root, id);
  const paths = remoteConfigPaths(id);
  if (existsSync(paths.config)) {
    const current = readOwnedJson(paths.config, "remote Pi Dictation configuration");
    const selected = current.recorders?.selected || current.recorder?.type || "local";
    const configured = managedRecorder(current);
    if (selected === "bridge" && JSON.stringify(configured ?? {}).includes(root)) {
      rmSync(recorderSelectionLockPath(root));
      throw new BridgeHostError("Select Local recording with /dictate-config before removing the selected Bridge Recorder.");
    }
  }
  console.log(JSON.stringify({ removable: true }));
}

export function remoteRecorderRemovalRelease(id) {
  const root = remoteRoot(id);
  if (!existsSync(root)) return;
  const path = recorderSelectionLockPath(root);
  if (!existsSync(path)) return;
  const lock = readOwnedJson(path, "remote Recorder selection lock");
  if (lock.product !== PRODUCT || lock.hostId !== id || lock.purpose !== "removal") {
    throw new BridgeHostError("Refusing an unowned remote Recorder selection lock.");
  }
  rmSync(path);
  console.log(JSON.stringify({ released: true }));
}

export function remoteCredentialRevoke(id) {
  const root = remoteRoot(id);
  if (!existsSync(root)) {
    console.log(JSON.stringify({ revoked: true }));
    return;
  }
  inspect(root, "directory", 0o700, "remote host bridge directory");
  const ownership = readOwnedJson(join(root, "ownership.json"), "remote bridge ownership receipt");
  if (ownership.product !== PRODUCT || ownership.hostId !== id) throw new BridgeHostError("Refusing unowned remote bridge artifacts.");
  const configPaths = remoteConfigPaths(id);
  if (existsSync(configPaths.receipt)) {
    const receipt = readOwnedJson(configPaths.receipt, "remote Pi Dictation configuration ownership receipt");
    if (receipt.hostId === id) {
      const lockPath = recorderSelectionLockPath(root);
      if (!existsSync(lockPath)) {
        throw new BridgeHostError("Bridge removal requires an owned Recorder selection lock.");
      }
      const lock = readOwnedJson(lockPath, "remote Recorder selection lock");
      if (lock.product !== PRODUCT || lock.hostId !== id || lock.purpose !== "removal") {
        throw new BridgeHostError("Refusing an invalid remote Recorder selection lock.");
      }
    }
  }
  const allowed = new Set(["ownership.json", "credential.json", "credential.next.json", "endpoint.json", "recorder-selection.lock", "listener.sock"]);
  for (const name of readdirSync(root)) {
    if (!allowed.has(name)) throw new BridgeHostError("Refusing unexpected remote bridge artifact whose ownership cannot be proven.");
    if (name === "listener.sock") {
      const value = lstatSync(join(root, name));
      if (value.isSymbolicLink() || !value.isSocket() || (ownerUid() !== undefined && value.uid !== ownerUid()) || (value.mode & 0o777) !== 0o600) {
        throw new BridgeHostError("Refusing unsafe remote bridge listener.");
      }
    } else {
      inspect(join(root, name), "file", 0o600, `remote bridge ${name}`);
      const value = readOwnedJson(join(root, name), `remote bridge ${name}`);
      if (["credential.json", "credential.next.json"].includes(name)) validateCredential(value, `remote bridge ${name}`);
      if (name === "recorder-selection.lock" &&
          (value.product !== PRODUCT || value.hostId !== id || value.purpose !== "removal")) {
        throw new BridgeHostError("Refusing an invalid remote Recorder selection lock.");
      }
      if (name === "endpoint.json") {
        const endpoint = value?.endpoint;
        const validEndpoint = endpoint?.type === "unix"
          ? typeof endpoint.path === "string" && endpoint.path === join(root, "listener.sock")
          : endpoint?.type === "tcp" && ["127.0.0.1", "::1"].includes(endpoint.host) &&
            Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535;
        if (value?.type !== "bridge" || !validEndpoint ||
            ![join(root, "credential.json"), join(root, "credential.next.json")].includes(value.credentialFile)) {
          throw new BridgeHostError("Refusing invalid remote Recorder endpoint configuration.");
        }
      }
    }
  }
  if (existsSync(configPaths.receipt)) {
    const receipt = readOwnedJson(configPaths.receipt, "remote Pi Dictation configuration ownership receipt");
    if (receipt.product !== PRODUCT || !/^[0-9a-f]{16}$/.test(receipt.hostId) ||
        receipt.phase !== "ready") {
      throw new BridgeHostError("Refusing an unowned remote Pi Dictation configuration.");
    }
    if (receipt.hostId === id) {
      reconcileRemoteRecorder(id, { type: "local" });
    } else {
      const current = existsSync(configPaths.config)
        ? readOwnedJson(configPaths.config, "remote Pi Dictation configuration") : {};
      const owned = receipt.recorderSha256 === managedRecorderDigest(current) ||
        (receipt.recorderSha256 === undefined && legacyReceiptCanMigrate(receipt.hostId, receipt, current));
      if (!owned) {
        throw new BridgeHostError("Refusing an unowned remote Pi Dictation configuration.");
      }
      const encodedRecorder = JSON.stringify(managedRecorder(current) ?? {});
      if (encodedRecorder.includes(root)) {
        throw new BridgeHostError("Refusing to remove a host still referenced by remote Pi Dictation configuration.");
      }
    }
  } else {
    reconcileRemoteRecorder(id, { type: "local" });
  }
  rmSync(root, { recursive: true });
  console.log(JSON.stringify({ revoked: true }));
}

function verifyLinuxLoopbackListener(endpoint) {
  const portHex = endpoint.port.toString(16).toUpperCase().padStart(4, "0");
  const expectedAddress = endpoint.host === "127.0.0.1" ? "0100007F" : "00000000000000000000000001000000";
  const tables = endpoint.host === "127.0.0.1" ? ["/proc/net/tcp"] : ["/proc/net/tcp6"];
  let found = false;
  for (const table of tables) {
    let contents;
    try { contents = readFileSync(table, "utf8"); }
    catch { throw new BridgeHostError("TCP fallback requires Linux listener verification; refusing an unverifiable bind."); }
    for (const line of contents.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, port] = (fields[1] || "").split(":");
      if (port !== portHex || fields[3] !== "0A") continue;
      if (address !== expectedAddress) throw new BridgeHostError("Refusing a TCP listener exposed on a wildcard or non-loopback address (check SSH GatewayPorts).");
      found = true;
    }
  }
  if (!found) throw new BridgeHostError("The requested loopback TCP listener is not established.");
}

function connectEndpoint(endpoint, timeoutMs = 2000) {
  return new Promise((resolveConnection, reject) => {
    const socket = endpoint.type === "unix" ? net.createConnection({ path: endpoint.path }) : net.createConnection({ host: endpoint.host, port: endpoint.port });
    const timeout = setTimeout(() => socket.destroy(new BridgeHostError("Remote listener connection timed out.")), timeoutMs);
    socket.once("connect", () => { clearTimeout(timeout); socket.destroy(); resolveConnection(); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

export async function remoteListenerCleanup(id) {
  const root = remoteRoot(id);
  inspect(root, "directory", 0o700, "remote host bridge directory");
  const endpointConfig = readOwnedJson(join(root, "endpoint.json"), "remote Recorder endpoint configuration");
  const endpoint = endpointConfig.endpoint;
  if (endpoint?.type === "tcp") {
    if (!(["127.0.0.1", "::1"].includes(endpoint.host)) || !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 || endpoint.port > 65535) {
      throw new BridgeHostError("Refusing invalid remote TCP listener configuration.");
    }
    return;
  }
  if (endpoint?.type !== "unix" || endpoint.path !== join(root, "listener.sock")) {
    throw new BridgeHostError("Remote listener cleanup applies only to the managed Unix socket.");
  }
  if (!existsSync(endpoint.path)) return;
  const info = lstatSync(endpoint.path);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
    throw new BridgeHostError("Refusing unsafe remote listener cleanup.");
  }
  try {
    await connectEndpoint(endpoint, 500);
    throw new BridgeHostError("Refusing to remove an active remote listener.");
  } catch (error) {
    if (error instanceof BridgeHostError) throw error;
  }
  rmSync(endpoint.path);
}

export async function remoteListener(id) {
  const root = remoteRoot(id);
  inspect(root, "directory", 0o700, "remote host bridge directory");
  const endpointConfig = readOwnedJson(join(root, "endpoint.json"), "remote Recorder endpoint configuration");
  if (endpointConfig.endpoint?.type === "tcp") verifyLinuxLoopbackListener(endpointConfig.endpoint);
  await connectEndpoint(endpointConfig.endpoint);
  console.log(JSON.stringify({ listener: "established" }));
}

export async function remoteHealth(id, healthAt) {
  const root = remoteRoot(id);
  inspect(root, "directory", 0o700, "remote host bridge directory");
  const endpointConfig = readOwnedJson(join(root, "endpoint.json"), "remote Recorder endpoint configuration");
  const endpoint = endpointConfig.endpoint;
  if (endpoint?.type === "unix") {
    if (typeof endpoint.path !== "string" || !endpoint.path.startsWith(root + "/") || !endpoint.path.endsWith("/listener.sock")) throw new BridgeHostError("Refusing invalid remote Unix listener configuration.");
  } else if (endpoint?.type === "tcp") {
    if (!(["127.0.0.1", "::1"].includes(endpoint.host)) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new BridgeHostError("Refusing wildcard or non-loopback remote listener configuration.");
  } else throw new BridgeHostError("Refusing invalid remote listener configuration.");
  if (![join(root, "credential.json"), join(root, "credential.next.json")].includes(endpointConfig.credentialFile)) {
    throw new BridgeHostError("Refusing invalid remote credential configuration.");
  }
  const credential = validateCredential(readOwnedJson(endpointConfig.credentialFile, "remote bridge credential"), "remote bridge credential");
  const health = await healthAt(endpoint, credential);
  console.log(JSON.stringify({ protocolVersion: BRIDGE_PROTOCOL_VERSION, authenticatedHealth: "ok", permission: health.permission, defaultInputAvailable: health.defaultInputAvailable }));
}
