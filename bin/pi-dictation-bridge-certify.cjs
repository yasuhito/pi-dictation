#!/usr/bin/env node
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const net = require("node:net");
const { commitProvenLifecycle, recoverLifecycleOrRethrow, recoversLifecycleInlineAfterError } = require("./certification-recovery.cjs");
const { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");

const protocolVersion = 3;
const product = "com.yasuhito.pi-dictation.bridge";
const root = join(homedir(), "Library", "Application Support", "pi-dictation", "bridge");
const runtime = join(homedir(), "Library", "Caches", "pi-dictation", "bridge");
const certificationRuntime = join(homedir(), "Library", "Caches", "pi-dictation-certification");
const socket = join(runtime, "companion.sock");
const credentialPath = join(root, "credential.json");
const statePath = join(certificationRuntime, "state.json");
const controlDeadlineMilliseconds = 5_000;
const tunnelLivenessBoundMilliseconds = 15_000;

const scenarios = new Map([
  ["bridge-level-transcription", {
    kind: "guided", host: true,
    actions: [
      "In an interactive Pi session on the selected host, run /dictate.",
      "Speak the phrase shown by this command and confirm the Dictation strip shows actual changing levels.",
      "Run /dictate again and confirm the recognizable phrase is inserted by transcription.",
    ],
  }],
  ["bridge-cancellation", { kind: "automated", host: true }],
  ["bridge-duration-limit", {
    kind: "duration", host: true,
    actions: ["Speak continuously into the Mac microphone until this command prints its bounded JSON result."],
  }],
  ["bridge-tunnel-reconnect", {
    kind: "tunnel", host: true, livenessBoundMilliseconds: tunnelLivenessBoundMilliseconds,
    reconnectValidation: "authenticated-remote-health",
    actions: [
      "The certification command owns a private Recording lease and stops only the selected tunnel LaunchAgent.",
      "Run the displayed fault command immediately; it measures owner-liveness termination and authenticated tunnel recovery.",
    ],
  }],
  ["bridge-single-lease", { kind: "automated", host: true, hostCount: 2 }],
  ["local-recording", {
    kind: "guided", host: false,
    actions: [
      "In a Pi session configured with the local Recorder, run /dictate and speak the phrase shown by this command.",
      "Run /dictate again and confirm changing live levels and recognizable transcription.",
      "Run /dictate once more, cancel it, and confirm no audio or transcription remains.",
    ],
  }],
  ["clean-user-tarball", {
    kind: "clean-user", host: true,
    stages: [
      "tarball-install", "real-audio-preflight", "idempotent-install", "human-diagnosis", "json-diagnosis",
      "bridge-recording", "upgrade", "credential-rotation", "uninstall", "external-artifact-preservation",
    ],
  }],
  ["sleep", { kind: "lifecycle", reason: "sleep", action: "Run `pmset sleepnow`, then wake the Mac." }],
  ["logout", { kind: "lifecycle", reason: "logout", action: "Log out, then log back in and run the verify command shown below." }],
  ["reboot", { kind: "lifecycle", reason: "reboot", action: "Restart the Mac, then log back in and run the verify command shown below." }],
  ["session-lock", { kind: "lifecycle", reason: "session-lock", action: "Lock the Mac session, then unlock it." }],
  ["companion-stop", { kind: "lifecycle", reason: "companion-stop", action: `Run \`launchctl kill SIGTERM gui/$(id -u)/${product}\`.` }],
  ["companion-restart", { kind: "lifecycle", reason: "companion-restart", action: `Run \`launchctl kill SIGKILL gui/$(id -u)/${product}\`.` }],
  ["device-loss", { kind: "lifecycle", reason: "device-loss", action: "Disconnect or disable the default input device that was active when capture started." }],
]);

function fail(message) { throw new Error(message); }
function privateJson(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) {
    fail("Refusing unsafe certification input.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
function privateDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) {
    fail("Refusing unsafe certification directory.");
  }
}
function validateCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !/^[0-9a-f-]{36}$/i.test(value.id || "") ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value.secret || "") || Buffer.from(value.secret, "base64").length !== 32) {
    fail("Refusing invalid certification credential.");
  }
  return value;
}
function atomicState(value, requireAbsent) {
  if (!existsSync(certificationRuntime)) mkdirSync(certificationRuntime, { mode: 0o700 });
  privateDirectory(certificationRuntime);
  if (requireAbsent && existsSync(statePath)) fail("A certification state transition is already pending.");
  const temporary = join(certificationRuntime, `.state-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function writeState(value) { atomicState(value, true); }
function replaceState(value) {
  privateJson(statePath);
  atomicState(value, false);
}
function clearState() {
  rmSync(statePath, { force: true });
  if (existsSync(certificationRuntime)) {
    privateDirectory(certificationRuntime);
    if (readdirSync(certificationRuntime).length === 0) rmdirSync(certificationRuntime);
  }
}
function encode(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length); pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}
function tag(secret, fields) { return createHmac("sha256", Buffer.from(secret, "base64")).update(encode(fields)).digest(); }
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 64 * 1024) fail("Certification request exceeded the protocol bound.");
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
async function readFrame(iterator, buffered) {
  while (buffered.value.length < 4) {
    const next = await iterator.next(); if (next.done) fail("Bridge connection ended before a complete frame.");
    buffered.value = Buffer.concat([buffered.value, next.value]);
  }
  const length = buffered.value.readUInt32BE(0);
  if (length > 64 * 1024) fail("Bridge response exceeded the protocol bound.");
  while (buffered.value.length < length + 4) {
    const next = await iterator.next(); if (next.done) fail("Bridge connection ended before a complete frame.");
    buffered.value = Buffer.concat([buffered.value, next.value]);
  }
  const body = buffered.value.subarray(4, length + 4);
  buffered.value = buffered.value.subarray(length + 4);
  return JSON.parse(body);
}
async function request(credential, operation, payload, requestId = randomUUID()) {
  const connection = net.createConnection({ path: socket, allowHalfOpen: true });
  connection.setTimeout(controlDeadlineMilliseconds, () => {
    connection.destroy(new Error("Bridge certification control deadline exceeded."));
  });
  try {
    await new Promise((resolve, reject) => {
      connection.once("connect", resolve);
      connection.once("error", reject);
    });
    const iterator = connection[Symbol.asyncIterator]();
    const buffered = { value: Buffer.alloc(0) };
    const challengeFrame = await readFrame(iterator, buffered);
    const challenge = Buffer.from(challengeFrame.challenge, "base64");
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const hmac = tag(credential.secret, ["request", protocolVersion, challenge, credential.id, requestId, operation, payloadBytes]);
    connection.end(frame({ type: "request", version: protocolVersion, credentialId: credential.id, requestId, operation,
      payload: payloadBytes.toString("base64"), hmac: hmac.toString("hex") }));
    const response = await readFrame(iterator, buffered);
    const responseBytes = Buffer.from(response.payload, "base64");
    const expected = tag(credential.secret, ["response", protocolVersion, response.version, challenge, credential.id,
      requestId, `${operation}:${response.status}`, responseBytes]);
    const actual = Buffer.from(response.hmac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("Bridge response authentication failed.");
    return { status: response.status, payload: JSON.parse(responseBytes) };
  } finally {
    connection.destroy();
  }
}
function capability() { return { recordingId: randomUUID(), leaseSecret: randomBytes(32).toString("base64") }; }

function configuredHost(alias) {
  const hosts = join(root, "hosts");
  privateDirectory(hosts);
  for (const id of readdirSync(hosts)) {
    if (!/^[0-9a-f]{16}$/.test(id)) fail("Refusing unexpected bridge host entry.");
    const directory = join(hosts, id);
    privateDirectory(directory);
    const ownership = privateJson(join(directory, "ownership.json"));
    if (ownership.product !== product || ownership.hostId !== id || typeof ownership.sshAlias !== "string") {
      fail("Refusing unowned bridge host state.");
    }
    if (ownership.sshAlias === alias) return {
      credential: validateCredential(privateJson(join(directory, "credential.json"))),
      id,
      plist: join(homedir(), "Library", "LaunchAgents", `${product}.tunnel.${id}.plist`),
      tunnel: join(directory, "tunnel.json"),
    };
  }
  fail("The requested configured host alias was not found.");
}
async function assertNoOwnedAudio(credential) {
  const effects = await request(credential, "credential-effects", {});
  if (effects.status !== "ok" || effects.payload.activeRecordingLease !== 0 ||
      effects.payload.incompleteAudio !== 0 || effects.payload.retainedWav !== 0) {
    fail("Certification cleanup did not prove owner-scoped audio deletion.");
  }
}
async function assertReady(credential) {
  const health = await request(credential, "health", {});
  if (health.status !== "ok" || health.payload.permission !== "authorized" || health.payload.defaultInputAvailable !== true) {
    fail("Installed companion health is not ready for real-device capture.");
  }
}
function safeEvidence(scenario, manual) {
  console.log(JSON.stringify({ product, protocolVersion, scenario, result: "passed", audioRetained: false,
    secretRetained: false, manualConfirmation: manual, completedAt: new Date().toISOString() }));
}
function fileDigest(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("Refusing an unsafe clean-user certification artifact.");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function certificationCommand(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8", timeout: options.timeout || 10 * 60 * 1000,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error || result.status !== 0) fail(options.failure || "A clean-user certification command failed.");
  return result.stdout || "";
}
function packagedPiCommand(tarball, arguments_, options = {}) {
  return certificationCommand("npm", ["exec", "--yes", "--package", tarball, "--", "pi-dictation", ...arguments_], options);
}
function installRemoteCandidate(alias, tarball, expectedSha256) {
  if (!/^[A-Za-z0-9_.@-]+$/.test(alias) || alias.startsWith("-")) fail("Refusing an unsafe SSH alias for candidate installation.");
  const remoteTarball = `/tmp/pi-dictation-certification-${expectedSha256}-${randomBytes(6).toString("hex")}.tgz`;
  try {
    certificationCommand("scp", ["--", tarball, `${alias}:${remoteTarball}`], { failure: "Candidate tarball transfer to the remote Pi host failed." });
    const checksum = certificationCommand("ssh", ["--", alias, "sha256sum", remoteTarball], { failure: "Remote candidate digest verification failed." });
    if (checksum.trim().split(/\s+/)[0] !== expectedSha256) fail("Remote candidate tarball does not match the certified SHA-256.");
    certificationCommand("ssh", ["--", alias, "npm", "install", "--global", remoteTarball], { failure: "Exact candidate tarball installation on the remote Pi host failed." });
  } finally {
    spawnSync("ssh", ["--", alias, "rm", "-f", "--", remoteTarball], { stdio: "ignore", timeout: controlDeadlineMilliseconds });
  }
}

const companionLifecycleScenarios = new Set(["companion-stop", "companion-restart"]);
function isCompanionLifecycle(name) { return companionLifecycleScenarios.has(name); }

async function restartCompanionForLifecycleVerification(credential) {
  const target = `gui/${process.getuid()}/${product}`;
  const deadline = Date.now() + 15_000;
  let launchAccepted = false;
  while (Date.now() < deadline) {
    if (!launchAccepted) {
      const result = spawnSync("launchctl", ["kickstart", target], {
        stdio: "ignore", timeout: controlDeadlineMilliseconds,
      });
      launchAccepted = !result.error && result.status === 0;
    }
    if (launchAccepted) {
      try {
        await assertReady(credential);
        return;
      } catch {}
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail(launchAccepted
    ? "Companion restart did not return authenticated readiness."
    : "The owned companion could not be restarted for lifecycle verification.");
}

async function cleanupLifecycle(state, credential) {
  const expected = scenarios.get(state.scenario);
  if (isCompanionLifecycle(state.scenario)) {
    await restartCompanionForLifecycleVerification(credential);
  }
  let status = await request(credential, "status", state.lease);
  const observedReason = status.payload.reason;
  if (["recording", "finalizing", "result-ready"].includes(status.payload.state)) {
    await request(credential, "cancel", state.lease);
    status = await request(credential, "status", state.lease);
  }
  await assertNoOwnedAudio(credential);
  commitProvenLifecycle(observedReason, expected.reason, status.payload.state, clearState);
  safeEvidence(state.scenario, true);
}
async function prepareLifecycle(name, scenario) {
  const credential = validateCredential(privateJson(credentialPath));
  await assertReady(credential);
  await assertNoOwnedAudio(credential);
  const lease = capability();
  writeState({ schemaVersion: 1, scenario: name, lease });
  try {
    const started = await request(credential, "start", { ...lease, maxDurationMs: 10 * 60 * 1000 });
    if (started.status !== "ok" || started.payload.state !== "recording") fail("Real-device Recording lease did not start.");
    console.log(scenario.action);
    console.log("After login or reboot, run: pi-dictation-bridge-certify verify");
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const status = await request(credential, "status", lease);
        if (status.payload.state !== "recording") break;
      } catch {
        if (isCompanionLifecycle(name)) {
          await restartCompanionForLifecycleVerification(credential);
        }
      }
    }
    await cleanupLifecycle({ schemaVersion: 1, scenario: name, lease }, credential);
  } catch (error) {
    if (!recoversLifecycleInlineAfterError(name)) {
      console.error("Private certification recovery state remains; run `pi-dictation-bridge-certify verify` after login to prove cleanup and remove it.");
      return;
    }
    try {
      return await recoverLifecycleOrRethrow(error, () =>
        cleanupLifecycle({ schemaVersion: 1, scenario: name, lease }, credential));
    } finally {
      if (existsSync(statePath)) console.error("Private certification recovery state remains; run `pi-dictation-bridge-certify verify` to prove cleanup and remove it.");
    }
  }
}
function prepareCleanUser(arguments_) {
  if (arguments_.length !== 4) {
    fail("Scenario clean-user-tarball requires CANDIDATE_TARBALL, PREDECESSOR_TARBALL, one configured SSH alias, and an external artifact path.");
  }
  const [tarballArgument, predecessorArgument, alias, externalArtifactArgument] = arguments_;
  const tarball = resolve(tarballArgument);
  const predecessor = resolve(predecessorArgument);
  const externalArtifact = resolve(externalArtifactArgument);
  if (!tarball.endsWith(".tgz") || !predecessor.endsWith(".tgz")) {
    fail("Clean-user certification requires actual candidate and predecessor npm tarballs.");
  }
  const tarballSha256 = fileDigest(tarball);
  const predecessorSha256 = fileDigest(predecessor);
  if (tarballSha256 === predecessorSha256) fail("The predecessor and candidate tarballs must be distinct.");
  const externalArtifactSha256 = fileDigest(externalArtifact);
  if (existsSync(root)) fail("Clean-user certification must begin in a new user account without Bridge state.");
  const state = { schemaVersion: 1, scenario: "clean-user-tarball", phase: "preparing-predecessor",
    tarball, tarballSha256, predecessor, predecessorSha256, alias, externalArtifact, externalArtifactSha256 };
  writeState(state);
  certificationCommand("npm", ["install", "--global", predecessor], { failure: "The predecessor tarball could not be installed for upgrade certification." });
  packagedPiCommand(predecessor, ["bridge", "install"], { inherit: true, failure: "Companion installation from the predecessor tarball failed." });
  replaceState({ ...state, phase: "awaiting-preflight" });
  console.log("Run `pi-dictation bridge preflight`, speak when requested, and confirm actual input levels.");
  console.log("Then run: pi-dictation-bridge-certify advance --confirm");
}

async function advanceCleanUser(confirm) {
  if (!confirm || !existsSync(statePath)) fail("Clean-user certification advance requires --confirm and private pending state.");
  const state = privateJson(statePath);
  if (state.schemaVersion !== 1 || state.scenario !== "clean-user-tarball") fail("No clean-user tarball certification is awaiting advancement.");
  if (fileDigest(state.tarball) !== state.tarballSha256) fail("The candidate tarball changed during certification.");
  if (fileDigest(state.predecessor) !== state.predecessorSha256 || state.predecessorSha256 === state.tarballSha256) {
    fail("The distinct predecessor tarball changed during certification.");
  }
  if (fileDigest(state.externalArtifact) !== state.externalArtifactSha256) fail("The external artifact changed during certification.");
  if (state.phase === "preparing-predecessor") {
    certificationCommand("npm", ["install", "--global", state.predecessor], { failure: "The predecessor tarball could not be installed for upgrade certification." });
    packagedPiCommand(state.predecessor, ["bridge", "install"], { inherit: true, failure: "Companion installation from the predecessor tarball failed." });
    replaceState({ ...state, phase: "awaiting-preflight" });
    console.log("Run `pi-dictation bridge preflight`, speak when requested, and confirm actual input levels.");
    console.log("Then run: pi-dictation-bridge-certify advance --confirm");
    return;
  }
  if (state.phase === "awaiting-preflight") {
    packagedPiCommand(state.predecessor, ["bridge", "health"], { failure: "Predecessor real-audio preflight is not healthy." });
    packagedPiCommand(state.predecessor, ["bridge", "install", state.alias], { inherit: true, failure: "Host Bridge installation failed." });
    packagedPiCommand(state.predecessor, ["bridge", "install", state.alias], { inherit: true, failure: "Idempotent host Bridge installation failed." });
    packagedPiCommand(state.predecessor, ["bridge", "doctor"], { inherit: true, failure: "Human Bridge diagnosis failed." });
    JSON.parse(packagedPiCommand(state.predecessor, ["bridge", "doctor", "--json"], { failure: "JSON Bridge diagnosis failed." }));
    const phrase = `Pi Dictation predecessor ${randomBytes(3).toString("hex")}`;
    replaceState({ ...state, phase: "awaiting-recording", phrase });
    console.log("In Pi on the configured host, record the displayed phrase, confirm actual levels and recognizable transcription, then confirm cancellation cleanup.");
    console.log(`Recognizable phrase: ${phrase}`);
    console.log("Then run: pi-dictation-bridge-certify advance --confirm");
    return;
  }
  if (state.phase === "awaiting-recording") {
    await assertNoOwnedAudio(configuredHost(state.alias).credential);
    replaceState({ ...state, phase: "upgrading-candidate", phrase: undefined });
    certificationCommand("npm", ["install", "--global", state.tarball], { failure: "Candidate tarball installation failed." });
    installRemoteCandidate(state.alias, state.tarball, state.tarballSha256);
    packagedPiCommand(state.tarball, ["bridge", "upgrade"], { inherit: true, failure: "Actual-tarball Bridge upgrade failed." });
    replaceState({ ...state, phase: "awaiting-candidate-preflight", phrase: undefined });
    console.log("Run the candidate command `pi-dictation bridge preflight`, speak when requested, and confirm actual input levels.");
    console.log("Then run: pi-dictation-bridge-certify advance --confirm");
    return;
  }
  if (state.phase === "upgrading-candidate") {
    certificationCommand("npm", ["install", "--global", state.tarball], { failure: "Candidate tarball installation failed." });
    installRemoteCandidate(state.alias, state.tarball, state.tarballSha256);
    if (existsSync(join(root, "upgrade.json"))) {
      packagedPiCommand(state.tarball, ["bridge", "preflight"], { inherit: true, failure: "Interrupted candidate upgrade requires successful candidate preflight." });
      replaceState({ ...state, phase: "awaiting-candidate-preflight", phrase: undefined });
      console.log("Confirm the candidate preflight used real microphone input, then run: pi-dictation-bridge-certify advance --confirm");
    } else {
      packagedPiCommand(state.tarball, ["bridge", "upgrade"], { inherit: true, failure: "Actual-tarball Bridge upgrade failed." });
      replaceState({ ...state, phase: "awaiting-candidate-preflight", phrase: undefined });
      console.log("Run the candidate command `pi-dictation bridge preflight`, speak when requested, and confirm actual input levels.");
      console.log("Then run: pi-dictation-bridge-certify advance --confirm");
    }
    return;
  }
  if (state.phase === "awaiting-candidate-preflight") {
    packagedPiCommand(state.tarball, ["bridge", "health"], { failure: "Candidate real-audio preflight is not healthy." });
    packagedPiCommand(state.tarball, ["bridge", "install", state.alias], { inherit: true, failure: "Candidate idempotent Bridge installation failed." });
    packagedPiCommand(state.tarball, ["bridge", "doctor"], { inherit: true, failure: "Candidate human Bridge diagnosis failed." });
    JSON.parse(packagedPiCommand(state.tarball, ["bridge", "doctor", "--json"], { failure: "Candidate JSON Bridge diagnosis failed." }));
    const phrase = `Pi Dictation candidate ${randomBytes(3).toString("hex")}`;
    replaceState({ ...state, phase: "awaiting-candidate-recording", phrase });
    console.log("In Pi on the configured host, record the displayed phrase with the candidate, confirm actual levels and recognizable transcription, then confirm cancellation cleanup.");
    console.log(`Recognizable phrase: ${phrase}`);
    console.log("Then run: pi-dictation-bridge-certify advance --confirm");
    return;
  }
  if (state.phase === "awaiting-candidate-recording") {
    await assertNoOwnedAudio(configuredHost(state.alias).credential);
    packagedPiCommand(state.tarball, ["bridge", "rotate", state.alias], { failure: "Credential rotation failed." });
    const preview = packagedPiCommand(state.tarball, ["bridge", "uninstall", state.alias, "--delete-retained-wav", "--delete-credentials"],
      { failure: "Bridge uninstall preview failed." });
    process.stdout.write(preview);
    replaceState({ ...state, phase: "awaiting-uninstall-confirmation", phrase: undefined,
      uninstallPreviewSha256: createHash("sha256").update(preview).digest("hex") });
    console.log("Review the uninstall preview above. If its exact deletion effects are correct, run: pi-dictation-bridge-certify advance --confirm");
    return;
  }
  if (!["awaiting-uninstall-confirmation", "uninstalling"].includes(state.phase)) {
    fail("Refusing an invalid clean-user certification phase.");
  }
  if (existsSync(root)) {
    const preview = packagedPiCommand(state.tarball, ["bridge", "uninstall", state.alias, "--delete-retained-wav", "--delete-credentials"],
      { failure: "Bridge uninstall preview recheck failed." });
    const previewSha256 = createHash("sha256").update(preview).digest("hex");
    if (previewSha256 !== state.uninstallPreviewSha256) {
      process.stdout.write(preview);
      replaceState({ ...state, phase: "awaiting-uninstall-confirmation", uninstallPreviewSha256: previewSha256 });
      console.log("Uninstall effects changed. Review the new preview above, then separately run: pi-dictation-bridge-certify advance --confirm");
      return;
    }
    replaceState({ ...state, phase: "uninstalling" });
    packagedPiCommand(state.tarball, ["bridge", "uninstall", state.alias, "--delete-retained-wav", "--delete-credentials", "--confirm"],
      { inherit: true, failure: "Bridge uninstall failed." });
  }
  if (existsSync(root)) fail("Clean-user uninstall did not return Bridge state to its pre-install absence.");
  certificationCommand("npm", ["uninstall", "--global", "pi-dictation"], { failure: "Tarball package uninstall failed." });
  if (fileDigest(state.externalArtifact) !== state.externalArtifactSha256) fail("Uninstall changed the external artifact.");
  clearState();
  safeEvidence("clean-user-tarball", true);
}

async function prepareGuided(name, scenario, alias) {
  let credential;
  if (scenario.host) {
    if (!alias) fail(`Scenario ${name} requires one configured SSH host alias.`);
    credential = configuredHost(alias).credential;
    await assertReady(credential);
    await assertNoOwnedAudio(credential);
  } else if (alias) {
    fail(`Scenario ${name} does not accept a host alias.`);
  }
  const phrase = `Pi Dictation certification ${randomBytes(3).toString("hex")}`;
  writeState({ schemaVersion: 1, scenario: name, alias: alias || null, phrase });
  console.log(`Scenario: ${name}`);
  if (scenario.actions.some((action) => action.includes("phrase shown"))) console.log(`Recognizable phrase: ${phrase}`);
  for (const [index, action] of scenario.actions.entries()) console.log(`${index + 1}. ${action}`);
  console.log("When every observation is complete, run: pi-dictation-bridge-certify verify --confirm");
}
async function waitForResult(credential, lease, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const status = await request(credential, "status", lease);
    if (status.payload.state === "result-ready") return status.payload;
    if (status.payload.state === "failed") fail(`Recording failed during certification: ${status.payload.reason || "unknown"}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("Recording did not reach its expected terminal result within the certification bound.");
}
async function runAutomated(name, aliases) {
  const scenario = scenarios.get(name);
  for (const action of scenario.actions || []) console.log(action);
  const expectedAliases = scenario.hostCount || 1;
  if (aliases.length !== expectedAliases) fail(`Scenario ${name} requires ${expectedAliases} configured SSH host alias${expectedAliases === 1 ? "" : "es"}.`);
  const hosts = aliases.map(configuredHost);
  for (const host of hosts) { await assertReady(host.credential); await assertNoOwnedAudio(host.credential); }
  const leases = hosts.map(() => capability());
  writeState({ schemaVersion: 1, scenario: name, aliases, leases, phase: "running" });
  let completed = false;
  try {
    if (name === "bridge-cancellation") {
      const started = await request(hosts[0].credential, "start", { ...leases[0], maxDurationMs: 60_000 });
      if (started.status !== "ok" || started.payload.state !== "recording") fail("Cancellation certification could not start capture.");
      const cancelled = await request(hosts[0].credential, "cancel", leases[0]);
      if (cancelled.status !== "ok" || cancelled.payload.state !== "cancelled") fail("Cancellation certification did not reach cancelled.");
    } else if (name === "bridge-duration-limit") {
      const started = await request(hosts[0].credential, "start", { ...leases[0], maxDurationMs: 5_000 });
      if (started.status !== "ok" || started.payload.state !== "recording") fail("Duration certification could not start capture.");
      const result = await waitForResult(hosts[0].credential, leases[0], 31_000);
      if (result.completion !== "duration-limit") fail("Duration certification did not report duration-limit.");
    } else if (name === "bridge-single-lease") {
      const started = await request(hosts[0].credential, "start", { ...leases[0], maxDurationMs: 60_000 });
      if (started.status !== "ok" || started.payload.state !== "recording") fail("Single-lease certification could not start the owner capture.");
      const excluded = await request(hosts[1].credential, "start", { ...leases[1], maxDurationMs: 60_000 });
      if (excluded.status !== "busy" || Object.keys(excluded.payload).length !== 0) fail("Single-lease certification did not return isolated busy.");
    }
    completed = true;
  } finally {
    let cleanupFailure;
    for (const [index, host] of hosts.entries()) {
      try { await request(host.credential, "cancel", leases[index]); } catch (error) { cleanupFailure ||= error; }
      try { await assertNoOwnedAudio(host.credential); } catch (error) { cleanupFailure ||= error; }
    }
    if (!cleanupFailure) clearState();
    if (cleanupFailure) throw cleanupFailure;
  }
  if (completed) safeEvidence(name, false);
}
function launchctl(arguments_) {
  const result = spawnSync("launchctl", arguments_, { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) fail("The owned tunnel LaunchAgent operation failed.");
}
async function prepareTunnel(name, scenario, alias) {
  if (!alias) fail(`Scenario ${name} requires one configured SSH host alias.`);
  const host = configuredHost(alias);
  await assertReady(host.credential);
  await assertNoOwnedAudio(host.credential);
  const lease = capability();
  writeState({ schemaVersion: 1, scenario: name, alias, lease, phase: "awaiting-fault" });
  try {
    const started = await request(host.credential, "start", { ...lease, maxDurationMs: 60_000 });
    if (started.status !== "ok" || started.payload.state !== "recording") fail("Tunnel certification could not start its private Recording lease.");
  } catch (error) {
    try { await request(host.credential, "cancel", lease); } catch {}
    try { await assertNoOwnedAudio(host.credential); clearState(); } catch {}
    throw error;
  }
  console.log(`Scenario: ${name}`);
  for (const [index, action] of scenario.actions.entries()) console.log(`${index + 1}. ${action}`);
  console.log("Fault command: pi-dictation-bridge-certify fault");
}
async function waitForTunnelHealth(host) {
  const configuration = privateJson(host.tunnel);
  if (configuration.product !== product || !Array.isArray(configuration.healthProbeArguments)) {
    fail("Refusing invalid owned tunnel health configuration.");
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = spawnSync("ssh", configuration.healthProbeArguments, { stdio: "ignore", timeout: controlDeadlineMilliseconds });
    if (!health.error && health.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("The restarted tunnel did not return authenticated remote health within thirty seconds.");
}
async function tunnelFault() {
  if (!existsSync(statePath)) fail("No tunnel-loss certification is awaiting fault injection.");
  const state = privateJson(statePath);
  if (state.schemaVersion !== 1 || state.scenario !== "bridge-tunnel-reconnect" || state.phase !== "awaiting-fault" ||
      !state.lease) fail("No tunnel-loss certification is awaiting fault injection.");
  const host = configuredHost(state.alias);
  const before = await request(host.credential, "credential-effects", {});
  if (before.status !== "ok" || before.payload.activeRecordingLease !== 1) {
    fail("The tunnel fault must begin while the certification-owned Recording lease is active.");
  }
  const domain = `gui/${process.getuid()}`;
  const faultAt = Date.now();
  let cleanupFailure;
  try {
    launchctl(["bootout", `${domain}/${product}.tunnel.${host.id}`]);
    const deadline = faultAt + tunnelLivenessBoundMilliseconds;
    let effects;
    while (Date.now() <= deadline) {
      effects = await request(host.credential, "credential-effects", {});
      if (effects.payload.activeRecordingLease === 0 && effects.payload.retainedWav === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!effects || effects.payload.activeRecordingLease !== 0 || effects.payload.retainedWav !== 1 || Date.now() > deadline) {
      fail("Tunnel loss did not terminate capture and retain the owner result within fifteen seconds.");
    }
  } finally {
    try {
      launchctl(["bootstrap", domain, host.plist]);
      launchctl(["kickstart", `${domain}/${product}.tunnel.${host.id}`]);
      await waitForTunnelHealth(host);
    } catch (error) { cleanupFailure ||= error; }
    try { await request(host.credential, "cancel", state.lease); } catch (error) { cleanupFailure ||= error; }
    try { await assertNoOwnedAudio(host.credential); } catch (error) { cleanupFailure ||= error; }
    if (!cleanupFailure) clearState();
    if (cleanupFailure) throw cleanupFailure;
  }
  safeEvidence(state.scenario, false);
}
async function verify() {
  if (!existsSync(statePath)) fail("No real-device certification is awaiting verification.");
  const state = privateJson(statePath);
  const scenario = scenarios.get(state.scenario);
  if (!scenario || state.schemaVersion !== 1) fail("Refusing invalid certification recovery state.");
  if (scenario.kind === "lifecycle") {
    const credential = validateCredential(privateJson(credentialPath));
    await cleanupLifecycle(state, credential);
    return;
  }
  if (scenario.kind === "clean-user") fail("Clean-user certification must resume with `advance --confirm`; verify cannot bypass its staged gates.");
  if (["automated", "duration"].includes(scenario.kind)) {
    if (!Array.isArray(state.aliases) || !Array.isArray(state.leases) || state.aliases.length !== state.leases.length) {
      fail("Refusing invalid automated certification recovery state.");
    }
    const hosts = state.aliases.map(configuredHost);
    for (const [index, host] of hosts.entries()) {
      try { await request(host.credential, "cancel", state.leases[index]); } catch {}
      await assertNoOwnedAudio(host.credential);
    }
    clearState();
    fail("Interrupted certification audio was cleaned safely. Rerun the complete scenario; recovery is not passing evidence.");
  }
  if (scenario.kind === "tunnel") {
    if (!state.lease || typeof state.alias !== "string") fail("Refusing invalid tunnel certification recovery state.");
    const host = configuredHost(state.alias);
    try { await request(host.credential, "cancel", state.lease); } catch {}
    await assertNoOwnedAudio(host.credential);
    clearState();
    fail("Interrupted tunnel certification audio was cleaned safely. Rerun the complete scenario; recovery is not passing evidence.");
  }
  if (!process.argv.slice(2).includes("--confirm")) fail("Guided certification requires --confirm after every listed observation succeeds.");
  if (scenario.host) await assertNoOwnedAudio(configuredHost(state.alias).credential);
  clearState();
  safeEvidence(state.scenario, true);
}
function list(json) {
  const values = [...scenarios].map(([name, value]) => ({ name, kind: value.kind,
    requiredHostAliases: value.host === true ? value.hostCount || 1 : 0,
    requiresHumanAction: ["guided", "duration", "tunnel", "lifecycle", "clean-user"].includes(value.kind),
    ...(value.stages ? { stages: value.stages } : {}),
    ...(value.livenessBoundMilliseconds ? { livenessBoundMilliseconds: value.livenessBoundMilliseconds } : {}),
    ...(value.reconnectValidation ? { reconnectValidation: value.reconnectValidation } : {}) }));
  if (json) console.log(JSON.stringify({ protocolVersion, scenarios: values }));
  else for (const value of values) console.log(`${value.name}\t${value.kind}`);
}
function usage() {
  console.log("Usage: pi-dictation-bridge-certify list [--json] | prepare SCENARIO [arguments ...] | advance --confirm | fault | verify [--confirm]");
}
async function main() {
  const [operation, ...arguments_] = process.argv.slice(2);
  if (operation === "list" && (arguments_.length === 0 || arguments_.length === 1 && arguments_[0] === "--json")) {
    return list(arguments_[0] === "--json");
  }
  if (process.platform !== "darwin") fail("Real-device Bridge certification requires macOS.");
  if (operation === "verify" && (arguments_.length === 0 || arguments_.length === 1 && arguments_[0] === "--confirm")) return verify();
  if (operation === "advance" && arguments_.length === 1 && arguments_[0] === "--confirm") return advanceCleanUser(true);
  if (operation === "fault" && arguments_.length === 0) return tunnelFault();
  const [name, ...aliases] = arguments_;
  const scenario = scenarios.get(name);
  if (operation !== "prepare" || !scenario) { usage(); fail("Unknown certification command or scenario."); }
  if (existsSync(statePath)) fail("A real-device certification is already pending; run verify first.");
  if (scenario.kind === "lifecycle") {
    if (aliases.length !== 0) fail(`Scenario ${name} does not accept a host alias.`);
    return prepareLifecycle(name, scenario);
  }
  if (scenario.kind === "clean-user") return prepareCleanUser(aliases);
  if (["automated", "duration"].includes(scenario.kind)) return runAutomated(name, aliases);
  if (scenario.kind === "tunnel") {
    if (aliases.length !== 1) fail(`Scenario ${name} requires one configured SSH host alias.`);
    return prepareTunnel(name, scenario, aliases[0]);
  }
  if (aliases.length > 1) fail(`Scenario ${name} accepts at most one configured SSH host alias.`);
  return prepareGuided(name, scenario, aliases[0]);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : "Certification failed unexpectedly."}`);
  process.exitCode = 1;
});
