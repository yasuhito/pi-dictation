const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
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
case "$*" in
  *" -G "*) printf 'host %s\\nhostname pi.example.test\\nuser pi\\nport 22\\nstricthostkeychecking true\\nuserknownhostsfile ~/.ssh/known_hosts\\nproxyjump bastion\\nidentityfile ~/.ssh/id_ed25519\\n' "$*"; exit 0 ;;
  *" true") if [ "$SSH_AUTH_FAIL" = 1 ]; then echo denied >&2; exit 255; fi; exit 0 ;;
  *" remote-info") if [ "$SSH_WRONG_VERSION" = 1 ]; then version=9.9.9; else version=0.6.0; fi; printf '{"packageVersion":"%s","protocolVersion":3,"home":"/srv/pi"}\\n' "$version"; exit 0 ;;
  *" remote-prepare "*) cat >/dev/null; printf '{"configured":true}\\n'; exit 0 ;;
  *" remote-listener "*) printf '{"listener":"established"}\\n'; exit 0 ;;
  *" remote-health "*) printf '{"protocolVersion":3,"authenticatedHealth":"ok"}\\n'; exit 0 ;;
  *" remote-credential-commit "*) printf '{"committed":true}\\n'; exit 0 ;;
  *" remote-credential-revoke "*) if [ "$SSH_REMOTE_REVOKE_FAIL" = 1 ]; then exit 1; fi; printf '{"revoked":true}\\n'; exit 0 ;;
esac
exit 2
`);
  executable(join(tools, "launchctl"), "#!/bin/sh\nexit 0\n");
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

async function startCredentialServer(f, busyFile, dropFile) {
  const script = join(f.home, "credential-server.cjs");
  const socket = join(f.home, "Library", "Caches", "pi-dictation", "bridge", "companion.sock");
  mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(script, String.raw`
const { createHmac, randomBytes } = require("node:crypto");
const { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const net = require("node:net");
const [bridge, socket, busyFile, dropFile] = process.argv.slice(2);
const outcomes = new Map();
function encode(fields) { const pieces=[Buffer.from("pi-dictation-bridge-auth-v1\0")]; for (const field of fields) { const value=Buffer.isBuffer(field)?field:Buffer.from(String(field)); const length=Buffer.alloc(4); length.writeUInt32BE(value.length); pieces.push(length,value); } return Buffer.concat(pieces); }
function tag(secret, fields) { return createHmac("sha256", Buffer.from(secret,"base64")).update(encode(fields)).digest(); }
function frame(value) { const body=Buffer.from(JSON.stringify(value)); const header=Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header,body]); }
function credentials() { const result=new Map(); for (const id of readdirSync(join(bridge,"hosts"))) for (const name of ["credential.json","credential.next.json"]) { try { const value=JSON.parse(readFileSync(join(bridge,"hosts",id,name))); result.set(value.id,value); } catch {} } return result; }
const server=net.createServer({allowHalfOpen:true}, client => { const challenge=randomBytes(32); client.write(frame({type:"challenge",challenge:challenge.toString("base64")})); let buffered=Buffer.alloc(0); client.on("data", chunk => { buffered=Buffer.concat([buffered,chunk]); if(buffered.length<4)return; const length=buffered.readUInt32BE(0); if(buffered.length!==length+4)return; const request=JSON.parse(buffered.subarray(4)); const credential=credentials().get(request.credentialId); if(!credential)return client.destroy(); const payload=Buffer.from(request.payload,"base64"); const expected=tag(credential.secret,["request",3,challenge,credential.id,request.requestId,request.operation,payload]); if(Buffer.from(request.hmac,"hex").compare(expected)!==0)return client.destroy(); const key=credential.id+":"+request.requestId; let outcome=outcomes.get(key); if(!outcome) { const rejected=request.operation==="credential-revoke-if-idle"&&existsSync(busyFile); outcome={status:rejected?"invalid-state":"ok",payload:rejected?{}:{connections:0,activeRecordingLease:existsSync(busyFile)?1:0,incompleteAudio:existsSync(busyFile)?1:0,retainedWav:0}}; outcomes.set(key,outcome); appendFileSync(busyFile+".requests",request.operation+" "+request.requestId+"\n"); } if(request.operation==="credential-revoke"&&existsSync(dropFile)){rmSync(dropFile);return client.destroy();} const output=Buffer.from(JSON.stringify(outcome.payload)); const responseTag=tag(credential.secret,["response",3,3,challenge,credential.id,request.requestId,request.operation+":"+outcome.status,output]); client.end(frame({type:"response",version:3,requestId:request.requestId,status:outcome.status,payload:output.toString("base64"),hmac:responseTag.toString("hex")})); }); });
rmSync(socket,{force:true}); server.listen(socket,()=>{chmodSync(socket,0o600);if(process.send)process.send("ready");});
`);
  const child = spawn(process.execPath, [script, f.bridge, socket, busyFile, dropFile || `${busyFile}.never-drop`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
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
    await t.test("replaces only stale Unix listeners inside the private managed host directory", () => assert.ok(values.includes("StreamLocalBindUnlink=yes")));
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

test("remote listener cleanup is a no-op for a managed TCP fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-tcp-cleanup-"));
  const id = "1234567890abcdef";
  const hostRoot = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
  mkdirSync(hostRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(hostRoot, "endpoint.json"), JSON.stringify({ endpoint: { type: "tcp", host: "127.0.0.1", port: 43123 } }), { mode: 0o600 });
  try {
    const cleanup = spawnSync(process.execPath, [cli, "bridge", "remote-listener-cleanup", id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home },
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("remote listener cleanup removes only a stale managed Unix socket", { skip: process.platform !== "linux" }, async (t) => {
  const home = mkdtempSync(join("/tmp", "pd-stale-"));
  const id = "234567890abcdef1";
  const hostRoot = join(home, ".local", "share", "pi-dictation", "bridge", "hosts", id);
  const socketPath = join(hostRoot, "listener.sock");
  const script = join(home, "stale-listener.cjs");
  mkdirSync(hostRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(hostRoot, "endpoint.json"), JSON.stringify({ endpoint: { type: "unix", path: socketPath } }), { mode: 0o600 });
  writeFileSync(script, `const net=require("node:net");net.createServer().listen(${JSON.stringify(socketPath)},()=>console.log("ready"));\n`);
  const server = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(server.stdout, "data");
    server.kill("SIGKILL");
    await once(server, "exit");
    chmodSync(socketPath, 0o600);
    const cleanup = spawnSync(process.execPath, [cli, "bridge", "remote-listener-cleanup", id], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home },
    });
    await t.test("accepts the owned stale socket", () => {
      assert.equal(cleanup.status, 0, cleanup.stderr);
    });
    await t.test("removes the stale socket before reverse forwarding", () => {
      assert.equal(existsSync(socketPath), false);
    });
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
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
  const cleanupMarker = join(home, "listener-cleaned");
  mkdirSync(tools, { mode: 0o700 });
  executable(join(tools, "ssh"), "#!/bin/sh\nif [ \"$1\" = cleanup ]; then : > \"$CLEANUP_MARKER\"; exit 0; fi\nif [ \"$1\" = tunnel ]; then test -f \"$CLEANUP_MARKER\" || exit 42; exec /bin/sleep 30; fi\nexit 0\n");
  writeFileSync(statusPath, JSON.stringify({ stages: { tunnelProcess: "pending", listener: "pending", authenticatedHealth: "pending" } }), { mode: 0o600 });
  writeFileSync(configurationPath, JSON.stringify({
    product: "com.yasuhito.pi-dictation.bridge",
    statusFile: statusPath,
    logFile: join(home, "tunnel.log"),
    stableAfterMs: 1000,
    sshArguments: ["tunnel"],
    listenerCleanupArguments: ["cleanup"],
    listenerProbeArguments: ["listener"],
    healthProbeArguments: ["health"],
  }), { mode: 0o600 });
  const supervisor = spawn(process.execPath, [join(root, "bin", "pi-dictation-tunnel.mjs"), configurationPath], {
    cwd: root, env: { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin`, CLEANUP_MARKER: cleanupMarker }, stdio: "ignore",
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
    await t.test("cleans the managed remote listener before opening the tunnel", () => {
      assert.equal(existsSync(cleanupMarker), true);
    });
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
    listenerCleanupArguments: ["cleanup"],
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
  executable(join(tools, "ssh"), "#!/bin/sh\nif [ \"$1\" = cleanup ]; then exit 0; fi\nif [ \"$1\" != tunnel ]; then exit 1; fi\nprintf '%s' $$ > \"$CHILD_PID\"\ntrap '' TERM INT\nwhile :; do sleep 1; done\n");
  writeFileSync(statusPath, JSON.stringify({ stages: { tunnelProcess: "pending", listener: "pending", authenticatedHealth: "pending" } }), { mode: 0o600 });
  writeFileSync(configurationPath, JSON.stringify({
    product: "com.yasuhito.pi-dictation.bridge",
    statusFile: statusPath,
    logFile: join(home, "tunnel.log"),
    stableAfterMs: 1000,
    sshArguments: ["tunnel"],
    listenerCleanupArguments: ["cleanup"],
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

test("bridge doctor diagnoses every layer without mutating LaunchAgents", async (t) => {
  const f = fixture();
  const effectsFile = join(f.home, "doctor-effects");
  const launchLog = join(f.home, "doctor-launchctl.log");
  let server;
  try {
    const installed = run(f, ["install", "doctor-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    server = await startCredentialServer(f, effectsFile);
    executable(join(f.tools, "launchctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DOCTOR_LAUNCH_LOG\"\ncase \"$1\" in print) exit 0;; *) exit 99;; esac\n");
    const result = run(f, ["doctor", "--json"], { DOCTOR_LAUNCH_LOG: launchLog });
    const report = JSON.parse(result.stdout);
    const host = report.hosts[0];
    await t.test("reports tunnel process separately", () => assert.equal(host.tunnelProcess.status, "running"));
    await t.test("reports listener separately", () => assert.equal(host.listener.status, "established"));
    await t.test("reports authenticated health separately", () => assert.equal(host.authenticatedHealth.status, "ready"));
    await t.test("reports exact protocol compatibility separately", () => assert.equal(host.protocolCompatibility.status, "compatible"));
    await t.test("reports bounded storage separately", () => assert.equal(host.storage.status, "bounded"));
    await t.test("reports bounded connections separately", () => assert.equal(host.connections.status, "bounded"));
    await t.test("reports Level availability separately", () => assert.equal(host.levelAvailability.status, "available"));
    await t.test("uses only read-only launchctl print", () => assert.equal(readFileSync(launchLog, "utf8").trim().split("\n").every((line) => line.startsWith("print ")), true));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("remote revocation removes a partial host without changing another owned Recorder", async (t) => {
  const f = fixture();
  try {
    const partialId = "2222222222222222";
    const ownerId = "1111111111111111";
    const remoteRoot = join(f.home, ".local", "share", "pi-dictation", "bridge", "hosts", partialId);
    const configRoot = join(f.home, ".pi", "agent");
    mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(remoteRoot, "ownership.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", hostId: partialId }), { mode: 0o600 });
    writeFileSync(join(remoteRoot, "credential.json"), JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", secret: Buffer.alloc(32, 2).toString("base64") }), { mode: 0o600 });
    const config = { recorder: { type: "local" } };
    writeFileSync(join(configRoot, "pi-dictation.json"), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(configRoot, "pi-dictation.bridge-owner.json"), JSON.stringify({
      product: "com.yasuhito.pi-dictation.bridge", hostId: ownerId, phase: "ready",
      sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    }), { mode: 0o600 });
    const result = run(f, ["remote-credential-revoke", partialId]);
    await t.test("completes partial cleanup", () => assert.equal(result.status, 0, result.stderr));
    await t.test("removes only the partial host", () => assert.equal(existsSync(remoteRoot), false));
    await t.test("preserves the other owned Recorder", () => assert.deepEqual(JSON.parse(readFileSync(join(configRoot, "pi-dictation.json"))), config));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("scoped uninstall removes only the selected host bridge", async (t) => {
  const f = fixture();
  const effectsFile = join(f.home, "scoped-effects");
  let server;
  try {
    for (const alias of ["remove-pi", "keep-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    server = await startCredentialServer(f, effectsFile);
    const runtime = join(f.home, "Library", "Caches", "pi-dictation", "bridge");
    writeFileSync(join(runtime, "request-receipts.json"), JSON.stringify({ schemaVersion: 4, receipts: [] }), { mode: 0o600 });
    const result = run(f, ["uninstall", "remove-pi", "--confirm"]);
    const listed = run(f, ["list", "--json"]);
    const remaining = JSON.parse(listed.stdout).hosts.map((host) => host.sshAlias);
    await t.test("completes the scoped uninstall", () => assert.equal(result.status, 0, result.stderr));
    await t.test("preserves the other host", () => assert.deepEqual(remaining, ["keep-pi"]));
    await t.test("preserves the shared companion receipt", () => assert.equal(existsSync(join(f.bridge, "ownership.json")), true));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("active recording blocks uninstall without explicit cancellation", async (t) => {
  const f = fixture();
  const effectsFile = join(f.home, "active-effects");
  let server;
  try {
    const installed = run(f, ["install", "active-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    writeFileSync(effectsFile, "active\n");
    server = await startCredentialServer(f, effectsFile);
    const result = run(f, ["uninstall", "active-pi", "--confirm"]);
    await t.test("names the affected bridge", () => assert.match(result.stderr, /active-pi/));
    await t.test("requires explicit cancellation", () => assert.match(result.stderr, /--cancel-active/));
    await t.test("preserves the host bridge", () => assert.equal(hostDirectories(f.bridge).length, 1));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("uninstall reconciles a partial remote-cleanup failure", async (t) => {
  const f = fixture();
  const effectsFile = join(f.home, "partial-effects");
  let server;
  try {
    for (const alias of ["partial-pi", "keep-partial-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    server = await startCredentialServer(f, effectsFile);
    const interrupted = run(f, ["uninstall", "partial-pi", "--confirm"], { SSH_REMOTE_REVOKE_FAIL: "1" });
    const pending = run(f, ["list", "--json"]);
    const lifecycle = JSON.parse(pending.stdout).hosts.find((host) => host.sshAlias === "partial-pi").status.lifecycle;
    const retried = run(f, ["uninstall", "partial-pi", "--confirm"]);
    await t.test("reports the interrupted cleanup", () => assert.notEqual(interrupted.status, 0));
    await t.test("records a pending lifecycle", () => assert.equal(lifecycle, "revocation-pending"));
    await t.test("finishes from durable intent", () => assert.equal(retried.status, 0, retried.stderr));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

function completeCompanionFixture(f) {
  const installId = "11111111-1111-1111-1111-111111111111";
  const app = join(f.bridge, "PiDictationBridge.app");
  const runtime = join(f.home, "Library", "Caches", "pi-dictation", "bridge");
  for (const directory of [join(app, "Contents", "MacOS"), join(app, "Contents", "Resources"), runtime]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const directory of [app, join(app, "Contents"), join(app, "Contents", "MacOS"), join(app, "Contents", "Resources"), runtime]) chmodSync(directory, 0o700);
  writeFileSync(join(f.bridge, "credential.json"), JSON.stringify({ id: "99999999-9999-4999-8999-999999999999", secret: Buffer.alloc(32, 19).toString("base64") }), { mode: 0o600 });
  writeFileSync(join(app, "Contents", "Info.plist"), "plist\n", { mode: 0o600 });
  executable(join(app, "Contents", "MacOS", "PiDictationBridge"), "#!/bin/sh\nexit 0\n");
  executable(join(app, "Contents", "MacOS", "PiDictationDurationWatchdog"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(app, "Contents", "Resources", "ownership.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId }), { mode: 0o600 });
  writeFileSync(join(f.home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist"), `<!-- pi-dictation-install-id:${installId} -->\n`, { mode: 0o600 });
  writeFileSync(join(f.bridge, "preflight.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId, executableSha256: createHash("sha256").update(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"))).digest("hex") }), { mode: 0o600 });
  return app;
}

test("upgrade checks every destination before modifying the shared companion", async (t) => {
  const f = fixture();
  try {
    for (const alias of ["reachable-pi", "unreachable-pi"]) {
      const installed = run(f, ["install", alias]);
      if (installed.status !== 0) throw new Error(installed.stderr);
    }
    const app = completeCompanionFixture(f);
    const before = createHash("sha256").update(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"))).digest("hex");
    const result = run(f, ["upgrade"], { SSH_AUTH_FAIL: "1" });
    const after = createHash("sha256").update(readFileSync(join(app, "Contents", "MacOS", "PiDictationBridge"))).digest("hex");
    await t.test("stops when a destination is unreachable", () => assert.notEqual(result.status, 0));
    await t.test("does not change the shared companion", () => assert.equal(after, before));
    await t.test("preserves real-audio readiness", () => assert.equal(existsSync(join(f.bridge, "preflight.json")), true));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("active recording blocks upgrade and names the affected bridge", async (t) => {
  const f = fixture();
  const effectsFile = join(f.home, "upgrade-active-effects");
  let server;
  try {
    const installed = run(f, ["install", "upgrade-active-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    completeCompanionFixture(f);
    writeFileSync(effectsFile, "active\n");
    server = await startCredentialServer(f, effectsFile);
    const result = run(f, ["upgrade"]);
    await t.test("blocks before companion replacement", () => assert.notEqual(result.status, 0));
    await t.test("names the active bridge", () => assert.match(result.stderr, /upgrade-active-pi/));
    await t.test("requires explicit confirmed cancellation", () => assert.match(result.stderr, /--cancel-active --confirm/));
    await t.test("preserves real-audio readiness", () => assert.equal(existsSync(join(f.bridge, "preflight.json")), true));
  } finally {
    server?.kill("SIGTERM");
    if (server) await once(server, "exit").catch(() => {});
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("uninstall refuses an unexpected artifact inside an owned host directory", async (t) => {
  const f = fixture();
  try {
    const installed = run(f, ["install", "artifact-pi"]);
    if (installed.status !== 0) throw new Error(installed.stderr);
    const host = join(f.bridge, "hosts", hostDirectories(f.bridge)[0]);
    const artifact = join(host, "external.txt");
    writeFileSync(artifact, "external\n", { mode: 0o600 });
    const result = run(f, ["uninstall", "artifact-pi", "--confirm"]);
    await t.test("refuses the artifact", () => assert.match(result.stderr, /unexpected host artifact/));
    await t.test("preserves the artifact", () => assert.equal(readFileSync(artifact, "utf8"), "external\n"));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
