import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

const PRODUCT = "com.yasuhito.pi-dictation.bridge";
export const BRIDGE_PROTOCOL_VERSION = 3;
const packageRoot = new URL("..", import.meta.url);
const supervisorPath = fileURLToPath(new URL("./pi-dictation-tunnel.mjs", import.meta.url));

export class BridgeHostError extends Error {}

function hostKey(alias) {
  if (typeof alias !== "string" || !/^[A-Za-z0-9_.@-]+$/.test(alias)) {
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

function readOwnedJson(path, description) {
  inspect(path, "file", 0o600, description);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new BridgeHostError(`Refusing invalid ${description}.`); }
}

function validateCredential(credential, description) {
  if (typeof credential?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credential.id) ||
      typeof credential.secret !== "string" || Buffer.from(credential.secret, "base64").length !== 32) {
    throw new BridgeHostError(`Refusing invalid ${description}.`);
  }
  return credential;
}

function localPaths(alias) {
  const home = homedir();
  const bridgeRoot = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const id = hostKey(alias);
  const root = join(bridgeRoot, "hosts", id);
  return {
    home, id, bridgeRoot, root,
    credential: join(root, "credential.json"),
    endpoint: join(root, "endpoint.json"),
    state: join(root, "setup.json"),
    tunnel: join(root, "tunnel.json"),
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
  const result = spawnSync("ssh", [...baseSshOptions, alias, ...remoteArgs], {
    encoding: "utf8", input: options.input, timeout: options.timeout ?? 15000,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
    throw new BridgeHostError(`${options.failure || "SSH command failed"}${detail ? `: ${detail}` : ""}`);
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

function verifyBatchMode(alias) {
  ssh(alias, ["true"], { failure: `Non-interactive BatchMode authentication failed for SSH alias '${alias}'` });
}

function safePackageInfo(alias) {
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
  const result = spawnSync("ssh", [...baseSshOptions, "-G", alias], { encoding: "utf8", timeout: 10000 });
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
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-N", "-T", "-R", `${transport.remoteForward}:${companionSocket}`, hostname,
  );
  return arguments_;
}

function plist(paths, alias) {
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- pi-dictation-host:${paths.id}:${escape(alias)} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${PRODUCT}.tunnel.${paths.id}</string>\n<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(supervisorPath)}</string><string>${escape(paths.tunnel)}</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
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
  for (const [path, description] of [[paths.credential, "host credential"], [paths.endpoint, "host endpoint"], [paths.state, "host setup state"], [paths.tunnel, "host tunnel configuration"]]) {
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
      !setup.stages || Object.keys(pendingStages).some((name) => typeof setup.stages[name] !== "string")) {
    throw new BridgeHostError("Refusing an unowned or invalid host setup state.");
  }
  return { ...pendingStages, ...setup.stages };
}

function state(paths, alias, stages, error) {
  atomicWrite(paths.state, `${JSON.stringify({ product: PRODUCT, hostId: paths.id, sshAlias: alias, stages, error: error || null, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export function installHost(alias, args = []) {
  if (ownerUid() === 0) throw new BridgeHostError("Refusing to install a tunnel as root.");
  const paths = localPaths(alias);
  inspect(paths.bridgeRoot, "directory", 0o700, "bridge support directory");
  const receipt = readOwnedJson(join(paths.bridgeRoot, "ownership.json"), "bridge ownership receipt");
  if (receipt.product !== PRODUCT || typeof receipt.installId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.installId)) {
    throw new BridgeHostError("Run `pi-dictation bridge install` to install the Mac companion first.");
  }
  ensureOwnedParent(dirname(paths.plist), "LaunchAgents directory");
  ensureDirectory(join(paths.bridgeRoot, "hosts"), "bridge hosts directory");
  assertOwnedHost(paths, alias);
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
      : { id: randomUUID(), secret: randomBytes(32).toString("base64") };
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
      stableAfterMs: 30000,
      sshArguments: resolvedTunnelArguments(alias, transport, paths.companionSocket),
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
    const companionRestart = spawnSync("launchctl", ["kickstart", "-k", `${domain}/${PRODUCT}`], { encoding: "utf8" });
    if (companionRestart.error || companionRestart.status !== 0) throw new BridgeHostError("The Mac companion could not be restarted with the host credential.");
    spawnSync("launchctl", ["bootout", `${domain}/${PRODUCT}.tunnel.${paths.id}`], { stdio: "ignore" });
    const loaded = spawnSync("launchctl", ["bootstrap", domain, paths.plist], { encoding: "utf8" });
    if (loaded.error || loaded.status !== 0) throw new BridgeHostError("The host tunnel LaunchAgent could not be loaded.");
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
      const currentHash = current ? configDigest(current) : null;
      if (currentHash !== receipt.previousSha256) {
        throw new BridgeHostError("Refusing an interrupted remote Pi Dictation configuration with unproven contents.");
      }
      if (existsSync(staged)) { inspect(staged, "file", 0o600, "staged remote Pi Dictation configuration"); rmSync(staged); }
      if (current) atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "ready", sha256: currentHash })}\n`);
      else rmSync(paths.receipt);
    } else if (receipt.phase === "pending") {
      const current = existsSync(paths.config) ? readOwnedJson(paths.config, "remote Pi Dictation configuration") : undefined;
      const currentHash = current ? configDigest(current) : null;
      if (currentHash === receipt.previousSha256) {
        inspect(staged, "file", 0o600, "staged remote Pi Dictation configuration");
        const next = readOwnedJson(staged, "staged remote Pi Dictation configuration");
        if (configDigest(next) !== receipt.nextSha256) throw new BridgeHostError("Refusing an invalid staged remote Pi Dictation configuration.");
        renameSync(staged, paths.config);
      } else if (currentHash === receipt.nextSha256) {
        if (existsSync(staged)) { inspect(staged, "file", 0o600, "staged remote Pi Dictation configuration"); rmSync(staged); }
      } else {
        throw new BridgeHostError("Refusing an interrupted remote Pi Dictation configuration with unproven contents.");
      }
      atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "ready", sha256: receipt.nextSha256 })}\n`);
    }
  }

  if (existsSync(paths.config) && !existsSync(paths.receipt)) {
    throw new BridgeHostError("Refusing to overwrite an unowned remote Pi Dictation configuration.");
  }
  const current = existsSync(paths.config) ? readOwnedJson(paths.config, "remote Pi Dictation configuration") : {};
  if (existsSync(paths.receipt)) {
    const receipt = readOwnedJson(paths.receipt, "remote Pi Dictation configuration ownership receipt");
    if (receipt.phase !== "ready" || receipt.sha256 !== configDigest(current)) {
      throw new BridgeHostError("Refusing to overwrite a remote Pi Dictation configuration changed outside bridge setup.");
    }
  }
  const next = { ...current, recorder };
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  if (existsSync(staged)) throw new BridgeHostError("Refusing an unexpected staged remote Pi Dictation configuration.");
  const previousSha256 = existsSync(paths.config) ? configDigest(current) : null;
  const nextSha256 = configDigest(next);
  atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "preparing", previousSha256 })}\n`);
  atomicWrite(staged, `${JSON.stringify(next, null, 2)}\n`);
  atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "pending", previousSha256, nextSha256 })}\n`);
  renameSync(staged, paths.config);
  atomicWrite(paths.receipt, `${JSON.stringify({ product: PRODUCT, hostId: id, phase: "ready", sha256: nextSha256 })}\n`);
}

export function remotePrepare(id, encodedEndpoint) {
  let endpoint; let credential;
  try { endpoint = JSON.parse(Buffer.from(encodedEndpoint, "base64").toString("utf8")); }
  catch { throw new BridgeHostError("Invalid remote endpoint configuration."); }
  try { credential = JSON.parse(readFileSync(0, "utf8")); }
  catch { throw new BridgeHostError("Invalid remote bridge credential."); }
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
  const credentialPath = join(root, "credential.json");
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
  const credential = validateCredential(readOwnedJson(join(root, "credential.json"), "remote bridge credential"), "remote bridge credential");
  const health = await healthAt(endpoint, credential);
  console.log(JSON.stringify({ protocolVersion: BRIDGE_PROTOCOL_VERSION, authenticatedHealth: "ok", permission: health.permission, defaultInputAvailable: health.defaultInputAvailable }));
}
