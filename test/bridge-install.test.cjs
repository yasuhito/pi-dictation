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
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-host-install-"));
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

test("tunnel supervisor establishes listener and authenticated health through probes", async () => {
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
    assert.deepEqual(state.stages, { tunnelProcess: "running", listener: "established", authenticatedHealth: "ready" });
  } finally {
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
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
