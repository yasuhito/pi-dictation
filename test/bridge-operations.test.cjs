const assert = require("node:assert/strict");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = resolve(__dirname, "..");
const cli = join(root, "bin", "pi-dictation.mjs");
function run(home, args, env = {}) { return spawnSync(process.execPath, [cli, "bridge", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, ...env } }); }
function executable(path, body) { writeFileSync(path, body, { mode: 0o700 }); chmodSync(path, 0o700); }
function ownedInstallation(home) {
  const installId = "11111111-1111-4111-8111-111111111111";
  const bridge = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const app = join(bridge, "PiDictationBridge.app");
  const runtime = join(home, "Library", "Caches", "pi-dictation", "bridge");
  const plist = join(home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist");
  for (const directory of [join(app, "Contents", "MacOS"), join(app, "Contents", "Resources"), runtime, join(home, "Library", "LaunchAgents")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const directory of [bridge, app, join(app, "Contents"), join(app, "Contents", "MacOS"), join(app, "Contents", "Resources"), runtime]) chmodSync(directory, 0o700);
  writeFileSync(join(bridge, "ownership.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId }), { mode: 0o600 });
  writeFileSync(join(bridge, "credential.json"), JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", secret: Buffer.alloc(32, 2).toString("base64") }), { mode: 0o600 });
  writeFileSync(join(app, "Contents", "Info.plist"), "plist\n", { mode: 0o600 });
  executable(join(app, "Contents", "MacOS", "PiDictationBridge"), "#!/bin/sh\n");
  executable(join(app, "Contents", "MacOS", "PiDictationDurationWatchdog"), "#!/bin/sh\n");
  writeFileSync(join(app, "Contents", "Resources", "ownership.json"), JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId }), { mode: 0o600 });
  writeFileSync(plist, `<!-- pi-dictation-install-id:${installId} -->\n`, { mode: 0o600 });
  return { bridge, plist };
}

test("bridge doctor exposes stable bounded JSON without creating installation state", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-operations-"));
  try {
    const result = run(home, ["doctor", "--json"]); const report = JSON.parse(result.stdout);
    await t.test("uses the first doctor schema", () => assert.equal(report.schemaVersion, 1));
    await t.test("reports installation separately", () => assert.equal(report.companion.installation.status, "not-installed"));
    await t.test("keeps output bounded", () => assert.equal(Buffer.byteLength(result.stdout) <= 256 * 1024, true));
    await t.test("does not create the bridge root", () => assert.equal(require("node:fs").existsSync(join(home, "Library")), false));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bridge logs are separately requested, bounded, and redact unsafe records", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-operations-")); const runtime = join(home, "Library", "Caches", "pi-dictation", "bridge");
  try {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    writeFileSync(join(runtime, "companion.log"), `${JSON.stringify({ component: "companion", code: "ready", stage: "startup" })}\n${JSON.stringify({ component: "companion", code: "bad", stage: "/private/path", secret: "do-not-print" })}\n`, { mode: 0o600 });
    const result = run(home, ["logs"]);
    await t.test("returns the safe event", () => assert.match(result.stdout, /companion ready stage=startup/));
    await t.test("does not return rejected fields", () => assert.doesNotMatch(result.stdout, /do-not-print|private\/path/));
    await t.test("keeps output bounded", () => assert.equal(Buffer.byteLength(result.stdout) <= 64 * 1024, true));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bridge repair is preview-only until confirmed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-operations-")); const tools = join(home, "tools"); const launchLog = join(home, "launchctl.log");
  try {
    mkdirSync(tools, { mode: 0o700 }); executable(join(tools, "launchctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LAUNCH_LOG\"\n");
    const result = run(home, ["repair"], { PATH: tools, LAUNCH_LOG: launchLog });
    await t.test("prints a preview", () => assert.match(result.stdout, /Preview only/));
    await t.test("does not invoke launchctl", () => assert.equal(require("node:fs").existsSync(launchLog), false));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("complete uninstall refuses unexpected artifacts rather than deleting them", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-operations-")); const bridge = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  try {
    mkdirSync(bridge, { recursive: true, mode: 0o700 }); writeFileSync(join(bridge, "unexpected.txt"), "external\n", { mode: 0o600 });
    const result = run(home, ["uninstall", "--all", "--confirm"]);
    await t.test("refuses the unprovable artifact", () => assert.match(result.stderr, /Refusing|ownership cannot be proven/i));
    await t.test("preserves the artifact", () => assert.equal(readFileSync(join(bridge, "unexpected.txt"), "utf8"), "external\n"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("complete uninstall separately confirms WAV and credential deletion", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-operations-"));
  try {
    const owned = ownedInstallation(home);
    const preview = run(home, ["uninstall", "--all", "--confirm"]);
    await t.test("requests retained WAV confirmation", () => assert.match(preview.stdout, /--delete-retained-wav/));
    await t.test("requests credential confirmation", () => assert.match(preview.stdout, /--delete-credentials/));
    await t.test("preserves the companion during preview", () => assert.equal(require("node:fs").existsSync(owned.bridge), true));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("confirmed complete uninstall removes only proven bridge artifacts", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-dictation-operations-"));
  try {
    const owned = ownedInstallation(home);
    const result = run(home, ["uninstall", "--all", "--delete-retained-wav", "--delete-credentials", "--confirm"]);
    await t.test("succeeds", () => assert.equal(result.status, 0, result.stderr));
    await t.test("removes the bridge root", () => assert.equal(require("node:fs").existsSync(owned.bridge), false));
    await t.test("removes the owned LaunchAgent", () => assert.equal(require("node:fs").existsSync(owned.plist), false));
    await t.test("explains retained permission history", () => assert.match(result.stdout, /permission history may remain/));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
