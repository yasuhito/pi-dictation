const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");

const root = resolve(__dirname, "..");
const cli = join(root, "bin", "pi-dictation.mjs");

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture() {
  const home = process.platform === "darwin"
    ? mkdtempSync("/tmp/pdi-")
    : mkdtempSync(join(tmpdir(), "pi-dictation-host-install-"));
  const tools = join(home, "tools");
  const bridge = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const launchAgents = join(home, "Library", "LaunchAgents");
  mkdirSync(tools, { mode: 0o700 });
  mkdirSync(bridge, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  writeFileSync(join(bridge, "ownership.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId: "11111111-1111-1111-1111-111111111111" }), { mode: 0o600 });
  const sshLog = join(home, "ssh.log");
  executable(join(tools, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SSH_LOG"
if [ -n "$SSH_UNREACHABLE_ALIAS" ]; then case "$*" in *"$SSH_UNREACHABLE_ALIAS"*) exit 255;; esac; fi
case "$*" in
  *" -G "*) printf 'host %s\\nhostname pi.example.test\\nuser pi\\nport 22\\nstricthostkeychecking true\\nuserknownhostsfile ~/.ssh/known_hosts\\nproxyjump bastion\\nidentityfile ~/.ssh/id_ed25519\\n' "$*"; exit 0 ;;
  *" true") if [ "$SSH_AUTH_FAIL" = 1 ]; then echo denied >&2; exit 255; fi; exit 0 ;;
  *" remote-info") if [ "$SSH_WRONG_VERSION" = 1 ]; then version=9.9.9; else version=0.6.0; fi; printf '{"packageVersion":"%s","protocolVersion":3,"home":"/srv/pi"}\\n' "$version"; exit 0 ;;
  *" remote-prepare "*) cat >/dev/null; printf '{"configured":true}\\n'; exit 0 ;;
  *" remote-listener "*) if [ "$SSH_LISTENER_FAIL" = 1 ]; then exit 1; fi; printf '{"listener":"established"}\\n'; exit 0 ;;
  *" remote-health "*) if [ "$SSH_HEALTH_FAIL" = 1 ]; then exit 1; fi; printf '{"protocolVersion":3,"authenticatedHealth":"ok"}\\n'; exit 0 ;;
  *" remote-credential-commit "*) printf '{"committed":true}\\n'; exit 0 ;;
  *" remote-removal-preflight "*) if [ -n "$REMOTE_PREFLIGHT_FAIL_ALIAS" ]; then case "$*" in *"$REMOTE_PREFLIGHT_FAIL_ALIAS"*) exit 1;; esac; fi; printf '{"proven":true}\\n'; exit 0 ;;
  *" remote-credential-revoke "*) printf '{"revoked":true}\\n'; exit 0 ;;
esac
exit 2
`);
  executable(join(tools, "launchctl"), `#!/bin/sh
if [ -n "$LAUNCHCTL_LOG" ]; then printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"; fi
if [ "$1" = print ] && [ -n "$LAUNCHCTL_NOT_RUNNING" ]; then case "$*" in *"$LAUNCHCTL_NOT_RUNNING"*) exit 1;; esac; fi
if [ "$1" = bootout ] && [ -n "$LAUNCHCTL_FAIL_BOOTOUT" ]; then case "$*" in *"$LAUNCHCTL_FAIL_BOOTOUT"*) exit 1;; esac; fi
if [ "$1" = bootout ] && [ "$LAUNCHCTL_FAIL_SHARED" = 1 ]; then case "$*" in *com.yasuhito.pi-dictation.bridge) exit 1;; esac; fi
if [ "$1" = bootout ]; then case "$*" in *com.yasuhito.pi-dictation.bridge) /bin/rm -f "$HOME/Library/Caches/pi-dictation/bridge/companion.sock";; esac; fi
exit 0
`);
  return { home, tools, bridge, sshLog };
}

function run(f, args, extra = {}) {
  return spawnSync(process.execPath, [cli, "bridge", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, PATH: `${f.tools}:/usr/bin:/bin`, SSH_LOG: f.sshLog, ...extra },
  });
}

function hostDirectories(bridge) {
  const hosts = join(bridge, "hosts");
  return existsSync(hosts) ? require("node:fs").readdirSync(hosts) : [];
}

function completeCompanion(f) {
  const installId = JSON.parse(readFileSync(join(f.bridge, "ownership.json"), "utf8")).installId;
  const app = join(f.bridge, "PiDictationBridge.app");
  for (const directory of [app, join(app, "Contents"), join(app, "Contents", "MacOS"), join(app, "Contents", "Resources"), join(app, "Contents", "_CodeSignature")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  writeFileSync(join(app, "Contents", "Info.plist"), "owned\n", { mode: 0o600 });
  writeFileSync(join(app, "Contents", "_CodeSignature", "CodeResources"), "signed\n", { mode: 0o644 });
  executable(join(app, "Contents", "MacOS", "PiDictationBridge"), "#!/bin/sh\nexit 0\n");
  executable(join(app, "Contents", "MacOS", "PiDictationDurationWatchdog"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "Contents", "Resources", "ownership.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId }), { mode: 0o600 });
  writeFileSync(join(f.bridge, "credential.json"), JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secret: Buffer.alloc(32, 4).toString("base64") }), { mode: 0o600 });
  const runtime = join(f.home, "Library", "Caches", "pi-dictation", "bridge");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const plist = join(f.home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist");
  const executablePath = join(app, "Contents", "MacOS", "PiDictationBridge");
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- pi-dictation-install-id:${installId} -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.yasuhito.pi-dictation.bridge</string>
  <key>ProgramArguments</key><array><string>${executablePath}</string></array>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`, { mode: 0o600 });
  return { app, runtime };
}

async function startCredentialServer(f, busyFile, dropFile, raceFile) {
  const script = join(f.home, "credential-server.cjs");
  const socket = join(f.home, "Library", "Caches", "pi-dictation", "bridge", "companion.sock");
  mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(script, String.raw`
const { createHmac, randomBytes } = require("node:crypto");
const { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const net = require("node:net");
const [bridge, socket, busyFile, dropFile, raceFile] = process.argv.slice(2);
const outcomes = new Map();
function encode(fields) { const pieces=[Buffer.from("pi-dictation-bridge-auth-v1\0")]; for (const field of fields) { const value=Buffer.isBuffer(field)?field:Buffer.from(String(field)); const length=Buffer.alloc(4); length.writeUInt32BE(value.length); pieces.push(length,value); } return Buffer.concat(pieces); }
function tag(secret, fields) { return createHmac("sha256", Buffer.from(secret,"base64")).update(encode(fields)).digest(); }
function frame(value) { const body=Buffer.from(JSON.stringify(value)); const header=Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header,body]); }
function credentials() { const result=new Map(); for (const name of ["credential.json","credential.next.json"]) { try { const value=JSON.parse(readFileSync(join(bridge,name))); result.set(value.id,value); } catch {} } for (const id of readdirSync(join(bridge,"hosts"))) for (const name of ["credential.json","credential.next.json"]) { try { const value=JSON.parse(readFileSync(join(bridge,"hosts",id,name))); result.set(value.id,value); } catch {} } return result; }
const server=net.createServer({allowHalfOpen:true}, client => { const challenge=randomBytes(32); client.write(frame({type:"challenge",challenge:challenge.toString("base64")})); let buffered=Buffer.alloc(0); client.on("data", chunk => { buffered=Buffer.concat([buffered,chunk]); if(buffered.length<4)return; const length=buffered.readUInt32BE(0); if(buffered.length!==length+4)return; const request=JSON.parse(buffered.subarray(4)); const credential=credentials().get(request.credentialId); if(!credential)return client.destroy(); const payload=Buffer.from(request.payload,"base64"); const expected=tag(credential.secret,["request",3,challenge,credential.id,request.requestId,request.operation,payload]); if(Buffer.from(request.hmac,"hex").compare(expected)!==0)return client.destroy(); const key=credential.id+":"+request.requestId; let outcome=outcomes.get(key); if(!outcome) { const effect=existsSync(busyFile)?readFileSync(busyFile,"utf8").trim():""; const rejected=request.operation==="credential-revoke-if-idle"&&Boolean(effect); const race=existsSync(raceFile); outcome={status:rejected?"invalid-state":"ok",payload:rejected?{}:{connections:0,activeRecordingLease:race?0:(effect==="retained"||effect==="incomplete"?0:(effect?1:0)),incompleteAudio:effect==="incomplete"?1:0,retainedWav:effect==="retained"?1:0}}; if(request.operation==="credential-effects"&&race)writeFileSync(busyFile,"raced\n"); outcomes.set(key,outcome); appendFileSync(busyFile+".requests",request.operation+" "+request.requestId+"\n"); } if(request.operation.startsWith("credential-revoke")&&existsSync(dropFile)){rmSync(dropFile);return client.destroy();} const output=Buffer.from(JSON.stringify(outcome.payload)); const responseTag=tag(credential.secret,["response",3,3,challenge,credential.id,request.requestId,request.operation+":"+outcome.status,output]); client.end(frame({type:"response",version:3,requestId:request.requestId,status:outcome.status,payload:output.toString("base64"),hmac:responseTag.toString("hex")})); }); });
rmSync(socket,{force:true}); server.listen(socket,()=>{chmodSync(socket,0o600);if(process.send)process.send("ready");});
`);
  const child = spawn(process.execPath, [script, f.bridge, socket, busyFile, dropFile || `${busyFile}.never-drop`, raceFile || `${busyFile}.never-race`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  return child;
}

test("bridge install establishes the default private Unix listener through an existing SSH alias", async (t) => {
  const f = fixture();
  try {
    const result = run(f, ["install", "work-pi"]);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const endpoint = JSON.parse(readFileSync(join(host, "endpoint.json"), "utf8"));
    const calls = readFileSync(f.sshLog, "utf8");
    const state = JSON.parse(readFileSync(join(host, "setup.json"), "utf8"));

    await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
    await t.test("uses the Unix listener by default", () => assert.equal(endpoint.type, "unix"));
    await t.test("places the listener in a per-host private directory", () => assert.match(endpoint.path, /^\/srv\/pi\/\.local\/share\/pi-dictation\/bridge\/hosts\/[0-9a-f]{16}\/listener\.sock$/));
    await t.test("requires non-interactive authentication", () => assert.match(calls, /BatchMode=yes/));
    await t.test("preserves the SSH alias instead of copying resolved host settings", () => assert.match(calls, / work-pi true/));
    await t.test("marks authenticated health separately", () => assert.equal(state.stages.authenticatedHealth, "ready"));
    await t.test("prints the exact listener", () => assert.match(result.stdout, /Remote listener: \/srv\/pi\//));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("each SSH alias receives independent owned artifacts", async (t) => {
  const f = fixture();
  try {
    const first = run(f, ["install", "first-pi"]);
    if (first.status !== 0) throw new Error(first.stderr);
    const second = run(f, ["install", "second-pi"]);
    if (second.status !== 0) throw new Error(second.stderr);
    const hosts = hostDirectories(f.bridge);
    const credentials = hosts.map((id) => JSON.parse(readFileSync(join(f.bridge, "hosts", id, "credential.json"), "utf8")));
    await t.test("creates one directory per alias", () => assert.equal(hosts.length, 2));
    await t.test("uses independent credentials", () => assert.notEqual(credentials[0].id, credentials[1].id));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("confirmed revocation retries a lost response from durable local intent", async (t) => {
  const f = fixture();
  const busyFile = join(f.home, "no-owned-audio");
  const dropFile = join(f.home, "drop-revoke-response");
  let server;
  try {
    const installed = run(f, ["install", "retry-revoke-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    writeFileSync(dropFile, "drop\n");
    server = await startCredentialServer(f, busyFile, dropFile);
    const interrupted = run(f, ["revoke", "retry-revoke-pi", "--confirm"]);
    const intentPersisted = existsSync(join(host, "credential.revocation.json"));
    const pendingList = run(f, ["list", "--json"]);
    const pendingLifecycle = JSON.parse(pendingList.stdout).hosts[0].status.lifecycle;
    const rotationWhilePending = run(f, ["rotate", "retry-revoke-pi"]);
    const retried = run(f, ["revoke", "retry-revoke-pi", "--confirm"]);

    await t.test("lost response fails the first invocation", () => assert.notEqual(interrupted.status, 0));
    await t.test("local revocation intent survives the lost response", () => assert.equal(intentPersisted, true));
    await t.test("list reports the ambiguous revocation as pending", () => assert.equal(pendingLifecycle, "revocation-pending"));
    await t.test("rotation is refused while revocation is pending", () => assert.notEqual(rotationWhilePending.status, 0));
    await t.test("retry completes with the original request identity", () => assert.equal(retried.status, 0, retried.stderr));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("credential revoke supports its advertised active-recording confirmation", async (t) => {
  const f = fixture();
  const busy = join(f.home, "active-revoke");
  let server;
  try {
    const installed = run(f, ["install", "revoke-active-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    writeFileSync(busy, "active\n");
    server = await startCredentialServer(f, busy);
    const blocked = run(f, ["revoke", "revoke-active-pi", "--confirm"]);
    const cancelled = run(f, ["revoke", "revoke-active-pi", "--confirm", "--cancel-active"]);
    await t.test("blocks without the advertised cancellation flag", () => assert.match(blocked.stderr, /--cancel-active/));
    await t.test("accepts the advertised cancellation flag", () => assert.equal(cancelled.status, 0, cancelled.stderr));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("credential rotation retries an idle rejection without restarting the companion", async (t) => {
  const f = fixture();
  const busyFile = join(f.home, "owned-audio");
  let server;
  try {
    const installed = run(f, ["install", "retry-rotation-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    writeFileSync(busyFile, "busy\n");
    server = await startCredentialServer(f, busyFile);
    const rejected = run(f, ["rotate", "retry-rotation-pi"]);
    const stagedAfterRejection = existsSync(join(host, "credential.rotation.json"));
    rmSync(busyFile);
    const retried = run(f, ["rotate", "retry-rotation-pi"]);
    const requestIds = existsSync(`${busyFile}.requests`)
      ? readFileSync(`${busyFile}.requests`, "utf8").trim().split("\n")
      : [];

    await t.test("rejects rotation while the credential owns audio", () => assert.notEqual(rejected.status, 0));
    await t.test("preserves staged rotation after rejection", () => assert.equal(stagedAfterRejection, true));
    await t.test("uses a new request identity for the new attempt", () => assert.notEqual(requestIds[0], requestIds[1]));
    await t.test("retry succeeds against the same companion", () => assert.equal(retried.status, 0, retried.stderr));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("remote credential commit keeps a readable credential through interruption", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-commit-"));
  const id = "4567890abcdef123";
  const endpoint = { type: "unix", path: join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id, "listener.sock") };
  const oldCredential = { id: "77777777-7777-4777-8777-777777777777", secret: Buffer.alloc(32, 13).toString("base64") };
  const nextCredential = { id: "88888888-8888-4888-8888-888888888888", secret: Buffer.alloc(32, 14).toString("base64") };
  const prepare = (credential, stagedCredential) => spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id,
    Buffer.from(JSON.stringify({ ...endpoint, ...(stagedCredential ? { stagedCredential: true } : {}) })).toString("base64")], {
    cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
  });
  try {
    const initial = prepare(oldCredential, false);
    if (initial.status !== 0) throw new Error(initial.stderr);
    const staged = prepare(nextCredential, true);
    if (staged.status !== 0) throw new Error(staged.stderr);
    const interrupted = spawnSync(process.execPath, [cli, "bridge", "remote-credential-commit", id, oldCredential.id, nextCredential.id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, NODE_ENV: "test", PI_DICTATION_TEST_INTERRUPT: "after-remote-current-copy" },
    });
    const config = JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-dictation.json"), "utf8"));
    const readableDuringInterruption = existsSync(config.recorder.credentialFile);
    const retried = spawnSync(process.execPath, [cli, "bridge", "remote-credential-commit", id, oldCredential.id, nextCredential.id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, NODE_ENV: "test" },
    });

    await t.test("interrupts after copying the current credential", () => assert.notEqual(interrupted.status, 0));
    await t.test("Recorder credential remains readable", () => assert.equal(readableDuringInterruption, true));
    await t.test("retry completes the remote commit", () => assert.equal(retried.status, 0, retried.stderr));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const [name, bind, expectedHost] of [["IPv4", "127.0.0.1:43123", "127.0.0.1"], ["IPv6", "[::1]:43124", "::1"]]) {
  test(`bridge install supports explicit ${name} loopback fallback`, async (t) => {
    const f = fixture();
    try {
      const result = run(f, ["install", `${name.toLowerCase()}-pi`, "--transport", "tcp", "--allow-loopback", "--bind", bind]);
      const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
      const endpoint = JSON.parse(readFileSync(join(host, "endpoint.json"), "utf8"));
      await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
      await t.test("configures only the requested loopback host", () => assert.equal(endpoint.host, expectedHost));
      await t.test("shows the exact bind", () => assert.match(result.stdout, new RegExp(bind.replace(/[\[\]:.]/g, "\\$&"))));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}

test("TCP fallback is never implicit", () => {
  const f = fixture();
  try {
    const result = run(f, ["install", "work-pi", "--transport", "tcp", "--bind", "127.0.0.1:43123"]);
    assert.match(result.stderr, /explicit --allow-loopback/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const bind of ["0.0.0.0:43123", "192.168.1.20:43123", "[::]:43123"]) {
  test(`bridge install rejects unsafe bind ${bind}`, () => {
    const f = fixture();
    try {
      const result = run(f, ["install", "work-pi", "--transport", "tcp", "--allow-loopback", "--bind", bind]);
      assert.match(result.stderr, /wildcard and non-loopback binds are refused/);
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}

test("bridge install stops when BatchMode authentication fails", async (t) => {
  const f = fixture();
  try {
    const result = run(f, ["install", "locked-pi"], { SSH_AUTH_FAIL: "1" });
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const state = JSON.parse(readFileSync(join(host, "setup.json"), "utf8"));
    await t.test("fails", () => assert.notEqual(result.status, 0));
    await t.test("explains non-interactive authentication", () => assert.match(result.stderr, /Non-interactive BatchMode authentication failed/));
    await t.test("preserves resumable setup state", () => assert.equal(state.stages.authentication, "pending"));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("tunnel configuration reuses required alias policy while disabling unrelated behavior", async (t) => {
  const f = fixture();
  try {
    const result = run(f, ["install", "hardened-pi"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const tunnel = JSON.parse(readFileSync(join(host, "tunnel.json"), "utf8"));
    const values = tunnel.sshArguments;
    await t.test("uses an isolated configuration with forwarding-only behavior", () => assert.deepEqual(values.filter((value) => ["/dev/null", "-N", "-T", "RemoteCommand=none", "ForwardAgent=no", "ForwardX11=no", "ControlMaster=no"].includes(value)), ["/dev/null", "RemoteCommand=none", "ForwardAgent=no", "ForwardX11=no", "ControlMaster=no", "-N", "-T"]));
    await t.test("preserves the one explicit remote forward", () => assert.deepEqual(values.filter((value) => value === "-R" || value.startsWith("ClearAllForwardings=")), ["-R"]));
    await t.test("retains strict host-key verification", () => assert.ok(values.includes("StrictHostKeyChecking=true")));
    await t.test("retains ProxyJump routing without enabling unrelated forwarding", () => assert.match(values.find((value) => value.startsWith("ProxyCommand=")), /bastion/));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge install gives an exact update command for an incompatible remote package", () => {
  const f = fixture();
  try {
    const result = run(f, ["install", "old-pi"], { SSH_WRONG_VERSION: "1" });
    assert.match(result.stderr, /npm install -g pi-dictation@0\.6\.0/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("repeated install refuses an unowned tunnel LaunchAgent", () => {
  const f = fixture();
  try {
    const first = run(f, ["install", "owned-pi"]);
    if (first.status !== 0) throw new Error(first.stderr);
    const plist = require("node:fs").readdirSync(join(f.home, "Library", "LaunchAgents")).map((name) => join(f.home, "Library", "LaunchAgents", name))[0];
    writeFileSync(plist, "unowned\n", { mode: 0o600 });
    const result = run(f, ["install", "owned-pi"]);
    assert.match(result.stderr, /Refusing an unowned host tunnel LaunchAgent/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge status reports tunnel, listener, and authenticated health separately", () => {
  const f = fixture();
  try {
    const installed = run(f, ["install", "status-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const result = run(f, ["status", "status-pi"]);
    assert.match(result.stdout, /Tunnel process: running\nListener establishment: established\nAuthenticated health: ready/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge doctor emits bounded privacy-safe JSON without changing managed state", async (t) => {
  const f = fixture();
  const requestBase = join(f.home, "doctor-requests");
  let server;
  try {
    const installed = run(f, ["install", "doctor-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    server = await startCredentialServer(f, requestBase);
    const snapshot = () => readdirSync(f.bridge, { recursive: true }).sort().map((name) => {
      const path = join(f.bridge, name);
      try { return `${name}:${readFileSync(path).toString("base64")}`; } catch { return `${name}:directory`; }
    }).join("\n");
    const before = snapshot();
    const sshBefore = readFileSync(f.sshLog, "utf8");
    const result = run(f, ["doctor", "--json"]);
    const report = JSON.parse(result.stdout);
    const after = snapshot();
    const sshAfter = readFileSync(f.sshLog, "utf8");
    await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
    await t.test("reports each host layer separately", () => assert.deepEqual(Object.keys(report.hosts[0].stages), [
      "tunnelProcess", "listener", "authenticatedHealth", "protocolCompatibility", "storageBounds", "connectionBounds", "levelAvailability",
    ]));
    await t.test("does not expose credentials or private paths", () => assert.equal(/credential|secret|\/Library\//i.test(result.stdout), false));
    await t.test("does not mutate managed bridge state", () => assert.equal(after, before));
    await t.test("issues only a local exact SSH configuration expansion", () => assert.equal(
      sshAfter.split("\n").filter((line) => line && !line.includes(" -G ")).join("\n"),
      sshBefore.split("\n").filter((line) => line && !line.includes(" -G ")).join("\n"),
    ));
    await t.test("does not persist authenticated companion receipts", () => assert.equal(existsSync(`${requestBase}.requests`), false));
    await t.test("types permission as unobserved", () => assert.equal(report.shared.permission, "not-observed-read-only"));
    await t.test("does not claim Level availability", () => assert.equal(report.shared.levelAvailability, "supported-not-observed"));
    await t.test("keeps JSON bounded", () => assert.equal(Buffer.byteLength(result.stdout) <= 64 * 1024, true));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("bridge logs are separately requested, bounded, and redacted", async (t) => {
  const f = fixture();
  try {
    const installed = run(f, ["install", "logs-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const records = [{ component: "tunnel", code: "failure", stage: "secret value /private/path" }];
    for (let index = 0; index < 2000; index += 1) records.push({ component: "tunnel", code: "retry", retry: index });
    writeFileSync(join(host, "tunnel.log"), records.map(JSON.stringify).join("\n") + "\n", { mode: 0o600 });
    const doctor = run(f, ["doctor", "--json"]);
    const result = run(f, ["logs", "logs-pi", "--json"]);
    const output = JSON.parse(result.stdout);
    await t.test("returns at most two hundred records", () => assert.equal(output.records.length, 200));
    await t.test("accounts only retained records while keeping the newest", () => assert.equal(output.records.at(-1).retry, 1999));
    await t.test("redacts rejected log fields", () => assert.equal(/secret value|private\/path/.test(result.stdout), false));
    await t.test("keeps raw logs out of doctor", () => assert.equal(doctor.stdout.includes('"code":"retry"'), false));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge repair previews before reloading only the owned tunnel", async (t) => {
  const f = fixture();
  const launchctlLog = join(f.home, "launchctl.log");
  try {
    const installed = run(f, ["install", "repair-pi"], { LAUNCHCTL_LOG: launchctlLog });
    if (installed.status !== 0) throw new Error(installed.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const setupPath = join(host, "setup.json");
    const mutations = (text) => text.split("\n").filter((line) => line && !line.startsWith("print "));
    const beforeLog = readFileSync(launchctlLog, "utf8");
    const preview = run(f, ["repair", "repair-pi"], { LAUNCHCTL_LOG: launchctlLog, LAUNCHCTL_NOT_RUNNING: ".tunnel." });
    const afterPreviewLog = readFileSync(launchctlLog, "utf8");
    const repaired = run(f, ["repair", "repair-pi", "--confirm"], { LAUNCHCTL_LOG: launchctlLog, LAUNCHCTL_NOT_RUNNING: ".tunnel." });
    const finalSetup = JSON.parse(readFileSync(setupPath, "utf8"));
    await t.test("prints exact non-destructive preview", () => assert.match(preview.stdout, /reload owned tunnel LaunchAgent[\s\S]*Credentials, microphone permission, retained WAVs, and incomplete audio: unchanged/));
    await t.test("preview invokes no mutating launchctl operation", () => assert.deepEqual(mutations(afterPreviewLog), mutations(beforeLog)));
    await t.test("confirmed repair succeeds", () => assert.equal(repaired.status, 0, repaired.stderr));
    await t.test("confirmed repair reconciles health", () => assert.equal(finalSetup.stages.authenticatedHealth, "ready"));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge repair refuses to reload an active Recording lease", async (t) => {
  const f = fixture();
  const busy = join(f.home, "repair-active");
  const launchctlLog = join(f.home, "repair-active-launchctl.log");
  let server;
  try {
    const installed = run(f, ["install", "active-repair-pi"], { LAUNCHCTL_LOG: launchctlLog });
    if (installed.status !== 0) throw new Error(installed.stderr);
    writeFileSync(busy, "active\n");
    server = await startCredentialServer(f, busy);
    const before = readFileSync(launchctlLog, "utf8").split("\n").filter((line) => line.startsWith("bootout ")).length;
    const result = run(f, ["repair", "active-repair-pi", "--confirm"], { LAUNCHCTL_LOG: launchctlLog, SSH_LISTENER_FAIL: "1" });
    const after = readFileSync(launchctlLog, "utf8").split("\n").filter((line) => line.startsWith("bootout ")).length;
    await t.test("refuses the active Recording lease", () => assert.match(result.stderr, /Active Recording lease blocks tunnel reload/));
    await t.test("does not stop the tunnel", () => assert.equal(after, before));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("bridge repair reconciles authenticated health after a partial failure", async (t) => {
  const f = fixture();
  const launchctlLog = join(f.home, "repair-health-launchctl.log");
  let server;
  try {
    const installed = run(f, ["install", "health-repair-pi"], { LAUNCHCTL_LOG: launchctlLog });
    if (installed.status !== 0) throw new Error(installed.stderr);
    server = await startCredentialServer(f, join(f.home, "repair-idle"));
    const failed = run(f, ["repair", "health-repair-pi", "--confirm"], { LAUNCHCTL_LOG: launchctlLog, SSH_HEALTH_FAIL: "1" });
    const retried = run(f, ["repair", "health-repair-pi", "--confirm"], { LAUNCHCTL_LOG: launchctlLog });
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const stages = JSON.parse(readFileSync(join(host, "setup.json"), "utf8")).stages;
    await t.test("records the authenticated health failure", () => assert.notEqual(failed.status, 0));
    await t.test("retry succeeds", () => assert.equal(retried.status, 0, retried.stderr));
    await t.test("retry reconciles authenticated health", () => assert.equal(stages.authenticatedHealth, "ready"));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("bridge repair refuses a tunnel configuration that is not exact", async (t) => {
  const f = fixture();
  const launchctlLog = join(f.home, "launchctl.log");
  try {
    const installed = run(f, ["install", "tampered-repair-pi"], { LAUNCHCTL_LOG: launchctlLog });
    if (installed.status !== 0) throw new Error(installed.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const tunnelPath = join(host, "tunnel.json");
    const tunnel = JSON.parse(readFileSync(tunnelPath, "utf8"));
    tunnel.sshArguments.push("-A");
    writeFileSync(tunnelPath, JSON.stringify(tunnel), { mode: 0o600 });
    const before = readFileSync(launchctlLog, "utf8").split("\n").filter((line) => line && !line.startsWith("print "));
    const result = run(f, ["repair", "tampered-repair-pi", "--confirm"], { LAUNCHCTL_LOG: launchctlLog, LAUNCHCTL_NOT_RUNNING: ".tunnel." });
    const after = readFileSync(launchctlLog, "utf8").split("\n").filter((line) => line && !line.startsWith("print "));
    await t.test("refuses the inexact tunnel", () => assert.match(result.stderr, /not the exact owned configuration/));
    await t.test("does not mutate LaunchAgents", () => assert.deepEqual(after, before));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge doctor reports tampered tunnel commands as unverified", () => {
  const f = fixture();
  try {
    const installed = run(f, ["install", "doctor-tampered-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const tunnelPath = join(host, "tunnel.json");
    const tunnel = JSON.parse(readFileSync(tunnelPath, "utf8"));
    tunnel.sshArguments.push("-A");
    writeFileSync(tunnelPath, JSON.stringify(tunnel), { mode: 0o600 });
    const result = run(f, ["doctor", "--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.hosts[0].stages.tunnelProcess.endsWith("configuration-unverified"), true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("bridge doctor reports a missing shared credential as incomplete", () => {
  const f = fixture();
  try {
    completeCompanion(f);
    rmSync(join(f.bridge, "credential.json"));
    const result = run(f, ["doctor", "--json"]);
    assert.equal(JSON.parse(result.stdout).shared.installation, "incomplete");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("uninstall reconciles a lost confirmed deletion response", async (t) => {
  const f = fixture();
  const drop = join(f.home, "drop-uninstall-response");
  let server;
  try {
    const installed = run(f, ["install", "retry-uninstall-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    writeFileSync(drop, "drop\n");
    server = await startCredentialServer(f, join(f.home, "idle"), drop);
    const interrupted = run(f, ["uninstall", "retry-uninstall-pi", "--confirm"]);
    const pending = existsSync(join(f.bridge, "credential.revocation.json"));
    const retried = run(f, ["uninstall", "retry-uninstall-pi", "--confirm"]);
    await t.test("first attempt reports the lost response", () => assert.notEqual(interrupted.status, 0));
    await t.test("persists confirmed shared cleanup state", () => assert.equal(pending, true));
    await t.test("retry completes cleanup", () => assert.equal(retried.status, 0, retried.stderr));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("idle uninstall atomically refuses a recording that starts after preview", async (t) => {
  const f = fixture();
  const busy = join(f.home, "raced-uninstall");
  const race = join(f.home, "race-uninstall");
  let server;
  try {
    const installed = run(f, ["install", "race-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    writeFileSync(race, "race\n");
    server = await startCredentialServer(f, busy, undefined, race);
    const result = run(f, ["uninstall", "race-pi", "--confirm"]);
    const requests = readFileSync(`${busy}.requests`, "utf8");
    await t.test("is blocked by the atomic idle operation", () => assert.match(result.stderr, /atomically blocked uninstall/));
    await t.test("uses credential-revoke-if-idle", () => assert.match(requests, /^credential-revoke-if-idle /m));
    await t.test("does not use destructive credential revocation", () => assert.equal(/^credential-revoke /m.test(requests), false));
    await t.test("preserves the host for retry", () => assert.equal(hostDirectories(f.bridge).length, 1));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("scoped uninstall refuses unexpected host entries before deletion", async (t) => {
  const f = fixture();
  let server;
  try {
    for (const alias of ["foreign-pi", "keep-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    const foreignHost = join(f.bridge, "hosts", hostDirectories(f.bridge).find((id) =>
      JSON.parse(readFileSync(join(f.bridge, "hosts", id, "ownership.json"), "utf8")).sshAlias === "foreign-pi"));
    writeFileSync(join(foreignHost, "foreign"), "preserve\n", { mode: 0o600 });
    const requestBase = join(f.home, "foreign-delete");
    server = await startCredentialServer(f, requestBase);
    const result = run(f, ["uninstall", "foreign-pi", "--confirm"]);
    const requests = existsSync(`${requestBase}.requests`) ? readFileSync(`${requestBase}.requests`, "utf8") : "";
    await t.test("refuses the unexpected host entry", () => assert.match(result.stderr, /unexpected or unprovable entry/));
    await t.test("does not revoke the credential", () => assert.equal(/credential-revoke/.test(requests), false));
    await t.test("preserves the unexpected entry", () => assert.equal(readFileSync(join(foreignHost, "foreign"), "utf8"), "preserve\n"));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("complete uninstall proves every local host before credential revocation", async (t) => {
  const f = fixture();
  const requestBase = join(f.home, "later-host-preflight");
  let server;
  try {
    for (const alias of ["first-proof-pi", "later-proof-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    completeCompanion(f);
    const later = join(f.bridge, "hosts", hostDirectories(f.bridge).find((id) =>
      JSON.parse(readFileSync(join(f.bridge, "hosts", id, "ownership.json"), "utf8")).sshAlias === "later-proof-pi"));
    writeFileSync(join(later, "foreign"), "preserve\n", { mode: 0o600 });
    server = await startCredentialServer(f, requestBase);
    const result = run(f, ["uninstall", "--all", "--confirm"]);
    const requests = existsSync(`${requestBase}.requests`) ? readFileSync(`${requestBase}.requests`, "utf8") : "";
    await t.test("refuses the later host candidate", () => assert.match(result.stderr, /unexpected or unprovable entry/));
    await t.test("issues no destructive credential request", () => assert.equal(/credential-revoke/.test(requests), false));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("complete uninstall proves the shared LaunchAgent before credential revocation", async (t) => {
  const f = fixture();
  const requestBase = join(f.home, "shared-plist-preflight");
  let server;
  try {
    const installed = run(f, ["install", "shared-proof-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    const plist = join(f.home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist");
    writeFileSync(plist, readFileSync(plist, "utf8").replace("<key>ProcessType</key>", "<key>Disabled</key><true/><key>ProcessType</key>"), { mode: 0o600 });
    server = await startCredentialServer(f, requestBase);
    const result = run(f, ["uninstall", "--all", "--confirm"]);
    const requests = existsSync(`${requestBase}.requests`) ? readFileSync(`${requestBase}.requests`, "utf8") : "";
    await t.test("refuses the modified marker-bearing LaunchAgent", () => assert.match(result.stderr, /not the exact owned configuration/));
    await t.test("issues no destructive credential request", () => assert.equal(/credential-revoke/.test(requests), false));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("complete uninstall proves every remote host before credential revocation", async (t) => {
  const f = fixture();
  const requestBase = join(f.home, "remote-preflight");
  let server;
  try {
    for (const alias of ["remote-good-pi", "remote-bad-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    completeCompanion(f);
    server = await startCredentialServer(f, requestBase);
    const result = run(f, ["uninstall", "--all", "--confirm"], { REMOTE_PREFLIGHT_FAIL_ALIAS: "remote-bad-pi" });
    const requests = existsSync(`${requestBase}.requests`) ? readFileSync(`${requestBase}.requests`, "utf8") : "";
    await t.test("refuses the remote candidate", () => assert.match(result.stderr, /Remote removal preflight failed/));
    await t.test("issues no destructive credential request", () => assert.equal(/credential-revoke/.test(requests), false));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("scoped uninstall preserves another bridge and the shared companion", async (t) => {
  const f = fixture();
  let server;
  try {
    for (const alias of ["remove-pi", "keep-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    server = await startCredentialServer(f, join(f.home, "idle"));
    const result = run(f, ["uninstall", "remove-pi", "--confirm"]);
    const list = JSON.parse(run(f, ["list", "--json"]).stdout);
    await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
    await t.test("preserves the other host", () => assert.deepEqual(list.hosts.map(({ sshAlias }) => sshAlias), ["keep-pi"]));
    await t.test("preserves the shared companion root", () => assert.equal(existsSync(f.bridge), true));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("complete uninstall removes owned bridge state and explains permission history", async (t) => {
  const f = fixture();
  let server;
  try {
    const installed = run(f, ["install", "last-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    server = await startCredentialServer(f, join(f.home, "idle"));
    const result = run(f, ["uninstall", "--all", "--confirm"]);
    const requests = readFileSync(`${join(f.home, "idle")}.requests`, "utf8");
    await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
    await t.test("atomically gates the shared and host credentials", () => assert.equal(requests.match(/^credential-revoke-if-idle /gm)?.length, 2));
    await t.test("removes the shared owned root", () => assert.equal(existsSync(f.bridge), false));
    await t.test("explains retained macOS permission history", () => assert.match(result.stdout, /microphone permission history may remain/i));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("complete uninstall preserves shared files when companion bootout fails", async (t) => {
  const f = fixture();
  let server;
  try {
    const installed = run(f, ["install", "bootout-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const { app } = completeCompanion(f);
    server = await startCredentialServer(f, join(f.home, "idle"));
    const result = run(f, ["uninstall", "--all", "--confirm"], { LAUNCHCTL_FAIL_SHARED: "1" });
    await t.test("reports the bootout failure", () => assert.match(result.stderr, /could not be stopped/));
    await t.test("preserves the shared companion app", () => assert.equal(existsSync(app), true));
    await t.test("preserves the shared LaunchAgent", () => assert.equal(existsSync(join(f.home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist")), true));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("complete uninstall refuses an unprovable artifact before deleting a host", async (t) => {
  const f = fixture();
  let server;
  try {
    const installed = run(f, ["install", "owned-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    writeFileSync(join(f.bridge, "foreign-artifact"), "preserve\n", { mode: 0o600 });
    server = await startCredentialServer(f, join(f.home, "idle"));
    const result = run(f, ["uninstall", "--all", "--confirm"]);
    await t.test("refuses the unprovable artifact", () => assert.match(result.stderr, /unprovable artifact/));
    await t.test("preserves the configured host", () => assert.equal(hostDirectories(f.bridge).length, 1));
    await t.test("preserves the foreign artifact", () => assert.equal(readFileSync(join(f.bridge, "foreign-artifact"), "utf8"), "preserve\n"));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

for (const effect of ["retained", "incomplete"]) {
  test(`uninstall preview requires cancellation for ${effect}-only audio`, async () => {
    const f = fixture();
    const busy = join(f.home, `${effect}-preview`);
    let server;
    try {
      const installed = run(f, ["install", `${effect}-preview-pi`]);
      if (installed.status !== 0) throw new Error(installed.stderr);
      completeCompanion(f);
      writeFileSync(busy, `${effect}\n`);
      server = await startCredentialServer(f, busy);
      const result = run(f, ["uninstall", `${effect}-preview-pi`]);
      assert.match(result.stdout, /--confirm --cancel-active/);
    } finally {
      server?.kill("SIGTERM");
      if (server) await once(server, "exit").catch(() => {});
      rmSync(f.home, { recursive: true, force: true });
    }
  });
}

test("active recording blocks uninstall without explicit cancellation", async (t) => {
  const f = fixture();
  const busy = join(f.home, "active");
  let server;
  try {
    const installed = run(f, ["install", "busy-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanion(f);
    writeFileSync(busy, "active\n");
    server = await startCredentialServer(f, busy);
    const blocked = run(f, ["uninstall", "busy-pi", "--confirm"]);
    const idleRequestUsed = /^credential-revoke-if-idle /m.test(readFileSync(`${busy}.requests`, "utf8"));
    const preserved = hostDirectories(f.bridge).length;
    const cancelled = run(f, ["uninstall", "busy-pi", "--confirm", "--cancel-active"]);
    await t.test("names the affected bridge", () => assert.match(blocked.stderr, /busy-pi/));
    await t.test("uses the atomic idle gate while blocked", () => assert.equal(idleRequestUsed, true));
    await t.test("preserves state while blocked", () => assert.equal(preserved, 1));
    await t.test("confirmed cancellation completes", () => assert.equal(cancelled.status, 0, cancelled.stderr));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("upgrade prechecks every host before changing the shared companion", async (t) => {
  const f = fixture();
  let server;
  try {
    for (const alias of ["reachable-pi", "unreachable-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    const { app } = completeCompanion(f);
    server = await startCredentialServer(f, join(f.home, "idle"));
    const before = createHash("sha256").update(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"))).digest("hex");
    const result = run(f, ["upgrade", "--confirm"], { SSH_UNREACHABLE_ALIAS: "unreachable-pi" });
    const after = createHash("sha256").update(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"))).digest("hex");
    const calls = readFileSync(f.sshLog, "utf8");
    await t.test("fails before upgrade", () => assert.notEqual(result.status, 0));
    await t.test("checks the unreachable destination", () => assert.match(calls, /unreachable-pi.*remote-info/));
    await t.test("leaves the shared executable unchanged", () => assert.equal(after, before));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("idle upgrade atomically refuses a recording that starts after precheck", async (t) => {
  const f = fixture();
  const busy = join(f.home, "raced-upgrade");
  const race = join(f.home, "race-upgrade");
  let server;
  try {
    const installed = run(f, ["install", "upgrade-race-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const { app } = completeCompanion(f);
    writeFileSync(race, "race\n");
    server = await startCredentialServer(f, busy, undefined, race);
    const before = readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"));
    const result = run(f, ["upgrade", "--confirm"]);
    const requests = readFileSync(`${busy}.requests`, "utf8");
    const upgradeStateExists = existsSync(join(f.bridge, "upgrade.json"));
    const stagedCredentialExists = existsSync(join(f.bridge, "credential.next.json"));
    await t.test("uses atomic idle revocation", () => assert.match(requests, /^credential-revoke-if-idle /m));
    await t.test("blocks the raced recording", () => assert.notEqual(result.status, 0));
    await t.test("clears the effect-free upgrade journal so explicit cancellation can restart", () => assert.equal(upgradeStateExists, false));
    await t.test("clears the unused staged credential", () => assert.equal(stagedCredentialExists, false));
    await t.test("does not replace the companion", () => assert.deepEqual(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge")), before));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("multi-host upgrade gates every credential before stopping any process", async (t) => {
  const f = fixture();
  const busy = join(f.home, "multi-host-race");
  const race = join(f.home, "multi-host-race-trigger");
  const launchctlLog = join(f.home, "multi-host-launchctl.log");
  let server;
  try {
    for (const alias of ["first-gate-pi", "second-gate-pi"]) {
      const installed = run(f, ["install", alias], { LAUNCHCTL_LOG: launchctlLog });
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    completeCompanion(f);
    writeFileSync(race, "race\n");
    server = await startCredentialServer(f, busy, undefined, race);
    const bootouts = () => readFileSync(launchctlLog, "utf8").split("\n").filter((line) => line.startsWith("bootout ")).length;
    const before = bootouts();
    const result = run(f, ["upgrade", "--confirm"], { LAUNCHCTL_LOG: launchctlLog });
    const after = bootouts();
    await t.test("blocks on the raced host gate", () => assert.notEqual(result.status, 0));
    await t.test("stops no process before every gate succeeds", () => assert.equal(after, before));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("cancel-active upgrade revokes destructively before a tunnel stop failure", async (t) => {
  const f = fixture();
  const busy = join(f.home, "destructive-upgrade");
  let server;
  try {
    const installed = run(f, ["install", "cancel-upgrade-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const { app } = completeCompanion(f);
    writeFileSync(busy, "active\n");
    server = await startCredentialServer(f, busy);
    const before = readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"));
    const result = run(f, ["upgrade", "--confirm", "--cancel-active"], { LAUNCHCTL_FAIL_BOOTOUT: ".tunnel." });
    const requests = readFileSync(`${busy}.requests`, "utf8");
    await t.test("uses destructive credential revocation", () => assert.match(requests, /^credential-revoke /m));
    await t.test("reports the checked tunnel stop failure", () => assert.match(result.stderr, /tunnel could not be stopped/));
    await t.test("does not replace the companion", () => assert.deepEqual(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge")), before));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("upgrade preserves shared files when companion bootout fails", async (t) => {
  const f = fixture();
  const requestBase = join(f.home, "shared-bootout-upgrade");
  let server;
  try {
    const installed = run(f, ["install", "shared-bootout-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const { app } = completeCompanion(f);
    server = await startCredentialServer(f, requestBase);
    const before = readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"));
    const result = run(f, ["upgrade", "--confirm"], { LAUNCHCTL_FAIL_SHARED: "1" });
    const state = JSON.parse(readFileSync(join(f.bridge, "upgrade.json"), "utf8"));
    await t.test("reports the checked shared bootout failure", () => assert.match(result.stderr, /shared companion LaunchAgent could not be stopped/));
    await t.test("preserves the shared executable", () => assert.deepEqual(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge")), before));
    await t.test("preserves resumable quiescing state", () => assert.deepEqual(state.completed, ["shared-bootout-pi"]));
    await t.test("durably promotes a replacement shared credential", () => assert.equal(state.primary.phase, "promoted"));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("interrupted upgrade keeps durable reconciliation state", async (t) => {
  const f = fixture();
  try {
    const { app } = completeCompanion(f);
    writeFileSync(join(f.bridge, "upgrade.json"), JSON.stringify({
      product: "com.yasuhito.pi-dictation.bridge", phase: "installing", hosts: [],
    }), { mode: 0o600 });
    const result = run(f, ["upgrade", "--confirm"], { PATH: f.tools });
    const state = JSON.parse(readFileSync(join(f.bridge, "upgrade.json"), "utf8"));
    await t.test("reports the failed resumed installation", () => assert.notEqual(result.status, 0));
    await t.test("preserves the installing phase for retry", () => assert.equal(state.phase, "installing"));
    await t.test("preserves the previously installed companion", () => assert.equal(existsSync(app), true));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("active recording blocks upgrade and names the affected bridge", async (t) => {
  const f = fixture();
  const busy = join(f.home, "active-upgrade");
  let server;
  try {
    const installed = run(f, ["install", "recording-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const { app } = completeCompanion(f);
    writeFileSync(busy, "active\n");
    server = await startCredentialServer(f, busy);
    const before = readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"));
    const result = run(f, ["upgrade", "--confirm"]);
    const after = readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"));
    await t.test("names the affected bridge", () => assert.match(result.stderr, /recording-pi/));
    await t.test("requires explicit cancellation", () => assert.match(result.stderr, /--cancel-active/));
    await t.test("leaves the companion unchanged", () => assert.deepEqual(after, before));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("repeated install preserves completed setup stages when authentication later fails", () => {
  const f = fixture();
  try {
    const first = run(f, ["install", "resume-pi"]);
    if (first.status !== 0) throw new Error(first.stderr);
    const second = run(f, ["install", "resume-pi"], { SSH_AUTH_FAIL: "1" });
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const state = JSON.parse(readFileSync(join(host, "setup.json"), "utf8"));
    assert.equal(state.stages.configuration, "ready", second.stderr);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("repeated install refuses an unowned setup state", () => {
  const f = fixture();
  try {
    const first = run(f, ["install", "state-pi"]);
    if (first.status !== 0) throw new Error(first.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    writeFileSync(join(host, "setup.json"), JSON.stringify({ product: "someone-else", stages: {} }), { mode: 0o600 });
    const second = run(f, ["install", "state-pi"]);
    assert.match(second.stderr, /unowned or invalid host setup state/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("remote prepare installs private Recorder endpoint state without a package manager", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-prepare-"));
  const id = "0123456789abcdef";
  const endpoint = { type: "unix", path: join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id, "listener.sock") };
  const credential = { id: "11111111-1111-4111-8111-111111111111", secret: Buffer.alloc(32, 7).toString("base64") };
  try {
    const result = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
    });
    const host = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
    const recorder = JSON.parse(readFileSync(join(host, "endpoint.json"), "utf8"));
    const runtimeConfig = JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-dictation.json"), "utf8"));
    await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
    await t.test("stores a Bridge Recorder endpoint", () => assert.equal(recorder.type, "bridge"));
    await t.test("configures the Recorder file consumed by Pi", () => assert.deepEqual(runtimeConfig.recorder, recorder));
    await t.test("keeps host state private", () => assert.equal(require("node:fs").lstatSync(host).mode & 0o777, 0o700));
    await t.test("keeps the shared credential private", () => assert.equal(require("node:fs").lstatSync(join(host, "credential.json")).mode & 0o777, 0o600));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote uninstall removes only its owned Recorder configuration transaction", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-reinstall-"));
  const firstId = "abcdefabcdefabcd";
  const secondId = "0123012301230123";
  const credential = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secret: Buffer.alloc(32, 17).toString("base64") };
  const prepare = (id) => {
    const endpoint = { type: "unix", path: join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id, "listener.sock") };
    return spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
    });
  };
  try {
    const first = prepare(firstId);
    if (first.status !== 0) throw new Error(first.stderr);
    const removed = spawnSync(process.execPath, [cli, "bridge", "remote-credential-revoke", firstId], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home },
    });
    const configDirectory = join(home, ".pi", "agent");
    const configRemoved = !existsSync(join(configDirectory, "pi-dictation.json")) && !existsSync(join(configDirectory, "pi-dictation.bridge-owner.json"));
    const second = prepare(secondId);
    await t.test("removes the proven-owned configuration and receipt", () => assert.equal(configRemoved, true, removed.stderr));
    await t.test("permits a different host to install afterward", () => assert.equal(second.status, 0, second.stderr));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote uninstall resumes after removing its owned configuration", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-uninstall-resume-"));
  const id = "9999999999999999";
  const endpoint = { type: "unix", path: join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id, "listener.sock") };
  const credential = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secret: Buffer.alloc(32, 18).toString("base64") };
  try {
    const prepared = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
    });
    if (prepared.status !== 0) throw new Error(prepared.stderr);
    const interrupted = spawnSync(process.execPath, [cli, "bridge", "remote-credential-revoke", id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, NODE_ENV: "test", PI_DICTATION_TEST_INTERRUPT: "after-remote-config-removal" },
    });
    const retried = spawnSync(process.execPath, [cli, "bridge", "remote-credential-revoke", id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, NODE_ENV: "test" },
    });
    await t.test("interrupts after the owned configuration removal", () => assert.notEqual(interrupted.status, 0));
    await t.test("retry completes from the private uninstall transaction", () => assert.equal(retried.status, 0, retried.stderr));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote uninstall refuses unexpected host entries before configuration changes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-uninstall-"));
  const id = "abcdefabcdefabcd";
  const host = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
  const endpoint = { type: "unix", path: join(host, "listener.sock") };
  const credential = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secret: Buffer.alloc(32, 17).toString("base64") };
  try {
    const prepared = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
    });
    if (prepared.status !== 0) throw new Error(prepared.stderr);
    writeFileSync(join(host, "foreign"), "preserve\n", { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, "bridge", "remote-credential-revoke", id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home },
    });
    const recorder = JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-dictation.json"), "utf8")).recorder;
    await t.test("refuses the unexpected remote entry", () => assert.match(result.stderr, /unexpected or unprovable entry/));
    await t.test("preserves the Bridge Recorder configuration", () => assert.equal(recorder.type, "bridge"));
    await t.test("preserves the unexpected entry", () => assert.equal(readFileSync(join(host, "foreign"), "utf8"), "preserve\n"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote prepare rejects an oversized endpoint before Base64 decoding", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-endpoint-limit-"));
  try {
    const encoded = Buffer.alloc(13 * 1024, 65).toString("base64");
    const result = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", "0123456789abcdef", encoded], {
      cwd: root, encoding: "utf8", input: "{}", env: { ...process.env, HOME: home },
    });
    assert.match(result.stderr, /Invalid remote endpoint configuration/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote prepare bounds credential stdin before parsing", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-stdin-limit-"));
  const endpoint = { type: "unix", path: join(home, ".local", "share", "pi-dictation", "bridge", "hosts", "0123456789abcdef", "listener.sock") };
  try {
    const result = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", "0123456789abcdef",
      Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: "x".repeat(64 * 1024 + 1), env: { ...process.env, HOME: home },
    });
    assert.match(result.stderr, /Remote request body exceeds the safe limit/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote prepare reconciles an owned Unix endpoint to explicit TCP fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-fallback-"));
  const id = "abcdef0123456789";
  const hostRoot = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
  const credential = { id: "33333333-3333-4333-8333-333333333333", secret: Buffer.alloc(32, 9).toString("base64") };
  const invoke = (endpoint) => spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
    cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
  });
  try {
    const unix = { type: "unix", path: join(hostRoot, "listener.sock") };
    const first = invoke(unix);
    if (first.status !== 0) throw new Error(first.stderr);
    const tcp = { type: "tcp", host: "127.0.0.1", port: 43123 };
    const second = invoke(tcp);
    const recorder = JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-dictation.json"), "utf8")).recorder;
    assert.deepEqual(recorder.endpoint, tcp, second.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote Recorder configuration resumes an interrupted owned transaction", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-transaction-"));
  const id = "1234567890abcdef";
  const hostRoot = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
  const configDirectory = join(home, ".pi", "agent");
  const credential = { id: "44444444-4444-4444-8444-444444444444", secret: Buffer.alloc(32, 10).toString("base64") };
  const invoke = (endpoint) => spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
    cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
  });
  try {
    const unix = { type: "unix", path: join(hostRoot, "listener.sock") };
    const first = invoke(unix);
    if (first.status !== 0) throw new Error(first.stderr);
    const current = JSON.parse(readFileSync(join(configDirectory, "pi-dictation.json"), "utf8"));
    const tcp = { type: "tcp", host: "::1", port: 43124 };
    const next = { ...current, recorder: { ...current.recorder, endpoint: tcp } };
    const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    writeFileSync(join(configDirectory, "pi-dictation.bridge-next.json"), `${JSON.stringify(next)}\n`, { mode: 0o600 });
    writeFileSync(join(configDirectory, "pi-dictation.bridge-owner.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", hostId: id, phase: "pending", previousSha256: digest(current), nextSha256: digest(next) }), { mode: 0o600 });
    const resumed = invoke(tcp);
    assert.equal(resumed.status, 0, resumed.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote Recorder configuration recovers an owned orphaned staging file", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-preparing-"));
  const id = "234567890abcdef1";
  const hostRoot = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
  const configDirectory = join(home, ".pi", "agent");
  const endpoint = { type: "unix", path: join(hostRoot, "listener.sock") };
  const credential = { id: "55555555-5555-4555-8555-555555555555", secret: Buffer.alloc(32, 11).toString("base64") };
  const invoke = () => spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
    cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
  });
  try {
    const first = invoke();
    if (first.status !== 0) throw new Error(first.stderr);
    const current = JSON.parse(readFileSync(join(configDirectory, "pi-dictation.json"), "utf8"));
    const previousSha256 = createHash("sha256").update(JSON.stringify(current)).digest("hex");
    writeFileSync(join(configDirectory, "pi-dictation.bridge-owner.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", hostId: id, phase: "preparing", previousSha256 }), { mode: 0o600 });
    writeFileSync(join(configDirectory, "pi-dictation.bridge-next.json"), JSON.stringify({ recorder: { type: "local" } }), { mode: 0o600 });
    const resumed = invoke();
    assert.equal(resumed.status, 0, resumed.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote listener rejects an SSH TCP forward exposed by GatewayPorts", { skip: process.platform !== "linux" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-gatewayports-"));
  const id = "34567890abcdef12";
  const script = join(home, "wildcard-listener.cjs");
  writeFileSync(script, "const net=require('node:net');const server=net.createServer(s=>s.destroy());server.listen(0,'0.0.0.0',()=>console.log(server.address().port));\n");
  const server = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [chunk] = await once(server.stdout, "data");
    const endpoint = { type: "tcp", host: "127.0.0.1", port: Number(String(chunk).trim()) };
    const credential = { id: "66666666-6666-4666-8666-666666666666", secret: Buffer.alloc(32, 12).toString("base64") };
    const prepared = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
    });
    if (prepared.status !== 0) throw new Error(prepared.stderr);
    const listener = spawnSync(process.execPath, [cli, "bridge", "remote-listener", id], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.match(listener.stderr, /GatewayPorts/);
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
    rmSync(home, { recursive: true, force: true });
  }
});

test("tunnel supervisor establishes listener, health, and bounded safe logging", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-supervisor-"));
  const tools = join(home, "tools");
  const statusPath = join(home, "setup.json");
  const configurationPath = join(home, "tunnel.json");
  mkdirSync(tools, { mode: 0o700 });
  executable(join(tools, "ssh"), "#!/bin/sh\nif [ \"$1\" = tunnel ]; then exec /bin/sleep 30; fi\nexit 0\n");
  writeFileSync(statusPath, JSON.stringify({ stages: { tunnelProcess: "pending", listener: "pending", authenticatedHealth: "pending" } }), { mode: 0o600 });
  writeFileSync(configurationPath, JSON.stringify({
    product: "com.yasuhito.pi-dictation.bridge",
    statusFile: statusPath,
    logFile: join(home, "tunnel.log"),
    stableAfterMs: 1000,
    sshArguments: ["tunnel"],
    listenerProbeArguments: ["listener"],
    healthProbeArguments: ["health"],
  }), { mode: 0o600 });
  const supervisor = spawn(process.execPath, [join(root, "bin", "pi-dictation-tunnel.mjs"), configurationPath], {
    cwd: root, env: { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin` }, stdio: "ignore",
  });
  try {
    let state;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      state = JSON.parse(readFileSync(statusPath, "utf8"));
      if (state.stages.authenticatedHealth === "ready") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const log = readFileSync(join(home, "tunnel.log"), "utf8");
    await t.test("establishes listener and authenticated health", () => {
      assert.deepEqual(state.stages, { tunnelProcess: "running", listener: "established", authenticatedHealth: "ready" });
    });
    await t.test("writes only bounded structured tunnel events", () => {
      assert.equal(Buffer.byteLength(log) <= 1024 * 1024 && !/credential|secret|sshArguments|\/Users\//i.test(log), true);
    });
  } finally {
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
    rmSync(home, { recursive: true, force: true });
  }
});

test("tunnel supervisor aggregates repeated connection failures", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-supervisor-repeat-"));
  const tools = join(home, "tools");
  const statusPath = join(home, "setup.json");
  const configurationPath = join(home, "tunnel.json");
  mkdirSync(tools, { mode: 0o700 });
  executable(join(tools, "ssh"), "#!/bin/sh\nexit 1\n");
  writeFileSync(statusPath, JSON.stringify({ stages: { tunnelProcess: "pending", listener: "pending", authenticatedHealth: "pending" } }), { mode: 0o600 });
  writeFileSync(configurationPath, JSON.stringify({
    product: "com.yasuhito.pi-dictation.bridge",
    statusFile: statusPath,
    logFile: join(home, "tunnel.log"),
    stableAfterMs: 300000,
    sshArguments: ["tunnel"],
    listenerProbeArguments: ["listener"],
    healthProbeArguments: ["health"],
  }), { mode: 0o600 });
  const supervisor = spawn(process.execPath, [join(root, "bin", "pi-dictation-tunnel.mjs"), configurationPath], {
    cwd: root, env: { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin` }, stdio: "ignore",
  });
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 8500));
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
    const records = readFileSync(join(home, "tunnel.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.some((record) => record.code === "repeated" && record.count >= 1) && !/credential|secret|sshArguments|\/Users\//i.test(JSON.stringify(records)), true);
  } finally {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  }
});

test("tunnel supervisor escalates from TERM to KILL only for its owned SSH child", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-supervisor-kill-"));
  const tools = join(home, "tools");
  const childPidPath = join(home, "child.pid");
  const statusPath = join(home, "setup.json");
  const configurationPath = join(home, "tunnel.json");
  mkdirSync(tools, { mode: 0o700 });
  executable(join(tools, "ssh"), "#!/bin/sh\nif [ \"$1\" != tunnel ]; then exit 1; fi\nprintf '%s' $$ > \"$CHILD_PID\"\ntrap '' TERM INT\nwhile :; do sleep 1; done\n");
  writeFileSync(statusPath, JSON.stringify({ stages: { tunnelProcess: "pending", listener: "pending", authenticatedHealth: "pending" } }), { mode: 0o600 });
  writeFileSync(configurationPath, JSON.stringify({
    product: "com.yasuhito.pi-dictation.bridge",
    statusFile: statusPath,
    logFile: join(home, "tunnel.log"),
    stableAfterMs: 1000,
    sshArguments: ["tunnel"],
    listenerProbeArguments: ["listener"],
    healthProbeArguments: ["health"],
  }), { mode: 0o600 });
  const supervisor = spawn(process.execPath, [join(root, "bin", "pi-dictation-tunnel.mjs"), configurationPath], {
    cwd: root, env: { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin`, CHILD_PID: childPidPath }, stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(childPidPath) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    const startedAt = Date.now();
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
    let childExists = true;
    try { process.kill(childPid, 0); } catch { childExists = false; }
    const elapsed = Date.now() - startedAt;
    await t.test("force-terminates the exact owned SSH child", () => {
      assert.equal(childExists, false);
    });
    await t.test("uses the bounded five-second escalation window", () => {
      assert.equal(elapsed >= 4500 && elapsed < 6500, true);
    });
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote prepare refuses to overwrite an existing unowned Pi configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-remote-unowned-"));
  const id = "fedcba9876543210";
  const endpoint = { type: "unix", path: join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id, "listener.sock") };
  const credential = { id: "22222222-2222-4222-8222-222222222222", secret: Buffer.alloc(32, 8).toString("base64") };
  try {
    const configDirectory = join(home, ".pi", "agent");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "pi-dictation.json"), JSON.stringify({ language: "ja" }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, "bridge", "remote-prepare", id, Buffer.from(JSON.stringify(endpoint)).toString("base64")], {
      cwd: root, encoding: "utf8", input: JSON.stringify(credential), env: { ...process.env, HOME: home },
    });
    assert.match(result.stderr, /Refusing to overwrite an unowned remote Pi Dictation configuration/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
