const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const packageRoot = resolve(__dirname, "..");
const cliPath = join(packageRoot, "bin", "pi-dictation.mjs");
const certificationPath = join(packageRoot, "bin", "pi-dictation-bridge-certify.cjs");
const { commitProvenLifecycle, recoverLifecycleOrRethrow, recoversLifecycleInlineAfterError } = require("../bin/certification-recovery.cjs");

function temporaryHome() {
  const base = process.platform === "darwin" ? "/tmp" : tmpdir();
  return mkdtempSync(join(base, "pi-dictation-bridge-"));
}

function runBridge(home, args, env = {}) {
  return spawnSync(process.execPath, [cliPath, "bridge", ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...env },
  });
}

function runInPseudoTerminal(args, options) {
  if (process.platform === "darwin") {
    const command = args.map((argument) => `{${argument.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`).join(" ");
    const program = `set timeout -1; spawn ${command}; expect eof; set result [wait]; exit [lindex $result 3]`;
    return spawnSync("/usr/bin/expect", ["-c", program], options);
  }
  const command = args.map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`).join(" ");
  return spawnSync("/usr/bin/script", ["-q", "-e", "-c", command, "/dev/null"], options);
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fakeToolchain(home) {
  const tools = join(home, "tools");
  mkdirSync(tools, { mode: 0o700 });
  const swiftc = join(tools, "swiftc");
  writeExecutable(
    swiftc,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 'Apple Swift version 6.0.3 (swiftlang-6.0.3 clang-1600.0.26.6)'
  echo 'Target: arm64-apple-macosx15.0'
  exit 0
fi
out=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '-o' ]; then out="$argument"; fi
  previous="$argument"
done
printf '#!/bin/sh\\nexit 0\\n' > "$out"
/bin/chmod 700 "$out"
`
  );
  writeExecutable(
    join(tools, "xcrun"),
    `#!/bin/sh
if [ "$1" = '--find' ] && [ "$2" = 'swiftc' ]; then echo '${swiftc}'; exit 0; fi
if [ "$1" = '--sdk' ] && [ "$2" = 'macosx' ] && [ "$3" = '--show-sdk-path' ]; then echo '/fake/MacOSX.sdk'; exit 0; fi
exit 1
`
  );
  writeExecutable(join(tools, "codesign"), "#!/bin/sh\nexit 0\n");
  return tools;
}

function enableFakePreflight(tools) {
  writeExecutable(
    join(tools, "open"),
    `#!/bin/sh
previous=''
result=''
for argument in "$@"; do
  if [ "$previous" = '--preflight-result' ]; then result="$argument"; fi
  previous="$argument"
done
if [ "$FAKE_CAPTURE" = 'silence' ]; then capture='digital-silence'; else capture='observed'; fi
printf '{"permission":"authorized","capture":"%s"}\\n' "$capture" > "$result"
/bin/chmod 600 "$result"
`
  );
  writeExecutable(
    join(tools, "launchctl"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\nexit 0\n"
  );
}

test("package exposes the unified Pi Dictation CLI and native companion source", async (t) => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

  await t.test("maps pi-dictation to the unified CLI", () => {
    assert.equal(manifest.bin?.["pi-dictation"], "bin/pi-dictation.mjs");
  });
  await t.test("ships native companion files", () => {
    assert.ok(manifest.files.includes("native"));
  });
  await t.test("maps the packaged real-device certification command", () => {
    assert.equal(manifest.bin?.["pi-dictation-bridge-certify"], "bin/pi-dictation-bridge-certify.cjs");
  });
});

test("lifecycle recovery owns the verdict after an interrupted request", async (t) => {
  const original = new Error("transport-eof");
  await t.test("returns successfully when recovery proves the scenario", async () => {
    assert.equal(await recoverLifecycleOrRethrow(original, async () => "passed"), "passed");
  });
  await t.test("preserves the original error when recovery cannot prove the scenario", async () => {
    await assert.rejects(recoverLifecycleOrRethrow(original, async () => { throw new Error("unavailable"); }), original);
  });
});

test("logout and reboot retain recovery state after teardown errors", async (t) => {
  await t.test("logout defers cleanup until post-login verification", () => {
    assert.equal(recoversLifecycleInlineAfterError("logout"), false);
  });
  await t.test("reboot defers cleanup until post-login verification", () => {
    assert.equal(recoversLifecycleInlineAfterError("reboot"), false);
  });
  await t.test("session lock still recovers inline", () => {
    assert.equal(recoversLifecycleInlineAfterError("session-lock"), true);
  });
  await t.test("keeps heartbeat polling before the teardown error", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes("while (true)") && !source.includes("if (!waitsForLifecycleInline(name)) return"), true);
  });
});

test("lifecycle evidence commits recovery cleanup only after proving its reason", async (t) => {
  await t.test("commits when the observed reason matches", () => {
    let committed = false;
    commitProvenLifecycle("companion-restart", "companion-restart", "failed", () => { committed = true; });
    assert.equal(committed, true);
  });
  await t.test("retains recovery state when the observed reason differs", () => {
    let committed = false;
    try { commitProvenLifecycle(undefined, "companion-restart", "recording", () => { committed = true; }); } catch {}
    assert.equal(committed, false);
  });
});

test("packaged real-device certification lists every required gate scenario without repository fixtures", async (t) => {
  const result = spawnSync(process.execPath, [certificationPath, "list", "--json"], {
    cwd: packageRoot, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  const output = JSON.parse(result.stdout);
  await t.test("lists every recurring and lifecycle scenario", () => {
    assert.deepEqual(output.scenarios.map(({ name }) => name), [
      "bridge-level-transcription", "bridge-cancellation", "bridge-duration-limit", "bridge-tunnel-reconnect",
      "bridge-single-lease", "local-recording", "clean-user-tarball", "sleep", "logout", "reboot", "session-lock",
      "companion-stop", "companion-restart", "device-loss",
    ]);
  });
  await t.test("declares the exact production protocol version", () => {
    assert.equal(output.protocolVersion, 3);
  });
  await t.test("automates cancellation and arbitration without human actions", () => {
    assert.deepEqual(output.scenarios.filter(({ requiresHumanAction }) => !requiresHumanAction).map(({ name }) => name), [
      "bridge-cancellation", "bridge-single-lease",
    ]);
  });
  await t.test("requires real microphone input for the duration-limit WAV", () => {
    assert.equal(output.scenarios.find(({ name }) => name === "bridge-duration-limit").requiresHumanAction, true);
  });
  await t.test("requires two independently configured hosts for arbitration", () => {
    assert.equal(output.scenarios.find(({ name }) => name === "bridge-single-lease").requiredHostAliases, 2);
  });
  await t.test("enumerates every clean-user actual-tarball certification stage", () => {
    assert.deepEqual(output.scenarios.find(({ name }) => name === "clean-user-tarball").stages, [
      "tarball-install", "real-audio-preflight", "idempotent-install", "human-diagnosis", "json-diagnosis",
      "bridge-recording", "upgrade", "credential-rotation", "uninstall", "external-artifact-preservation",
    ]);
  });
  await t.test("declares tunnel-loss termination at the fifteen-second owner-liveness bound", () => {
    assert.equal(output.scenarios.find(({ name }) => name === "bridge-tunnel-reconnect").livenessBoundMilliseconds, 15000);
  });
  await t.test("declares authenticated remote health as the reconnect proof", () => {
    assert.equal(output.scenarios.find(({ name }) => name === "bridge-tunnel-reconnect").reconnectValidation, "authenticated-remote-health");
  });
  await t.test("classifies companion stop and restart through one lifecycle predicate", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('const companionLifecycleScenarios = new Set(["companion-stop", "companion-restart"])'), true);
  });
  await t.test("actively restores the owned companion before lifecycle verification", () => {
    assert.equal(readFileSync(certificationPath, "utf8").includes("restartCompanionForLifecycleVerification"), true);
  });
  await t.test("retains recovery state until the expected lifecycle reason is proven", () => {
    assert.equal(readFileSync(certificationPath, "utf8").includes("commitProvenLifecycle(observedReason, expected.reason, status.payload.state, clearState)"), true);
  });
  await t.test("requires authenticated readiness rather than only a successful launchctl submission", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes("await assertReady(credential)") && source.includes("Companion restart did not return authenticated readiness"), true);
  });
  await t.test("bounds each certification protocol control connection and destroys it in finally", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes("connection.setTimeout(controlDeadlineMilliseconds") && source.includes("finally {\n    connection.destroy();"), true);
  });
  await t.test("requires a distinct predecessor before upgrading to the candidate tarball", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('certificationCommand("npm", ["install", "--global", predecessor]') &&
      source.includes("packagedPiCommand(state.predecessor") &&
      source.includes("state.predecessorSha256 === state.tarballSha256"), true);
  });
  await t.test("uses human and JSON doctor diagnosis from packed bytes", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('["bridge", "doctor"]') && source.includes('["bridge", "doctor", "--json"]'), true);
  });
  await t.test("installs the exact candidate digest on both hosts before candidate upgrade and recording", async (stage) => {
    const source = readFileSync(certificationPath, "utf8");
    await stage.test("transfers the selected candidate", () => {
      assert.equal(source.includes("installRemoteCandidate(state.alias, state.tarball, state.tarballSha256)"), true);
    });
    await stage.test("checks the remote candidate digest", () => {
      assert.equal(source.includes('["--", alias, "sha256sum", remoteTarball]'), true);
    });
    await stage.test("installs the remote candidate globally", () => {
      assert.equal(source.includes('["--", alias, "npm", "install", "--global", remoteTarball]'), true);
    });
    await stage.test("upgrades the configured Bridge", () => {
      assert.equal(source.includes('["bridge", "upgrade"]'), true);
    });
    await stage.test("requires candidate real-audio preflight", () => {
      assert.equal(source.includes('phase: "awaiting-candidate-preflight"'), true);
    });
    await stage.test("requires candidate Bridge recording", () => {
      assert.equal(source.includes('phase: "awaiting-candidate-recording"'), true);
    });
  });
  await t.test("interrupted automated certification cleanup cannot emit passing evidence", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes("Rerun the complete scenario; recovery is not passing evidence."), true);
  });
  await t.test("keeps recovery state outside the Bridge runtime removed by uninstall", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('"Caches", "pi-dictation-certification"') &&
      source.includes('const statePath = join(certificationRuntime, "state.json")'), true);
  });
  await t.test("commits every recovery transition through an atomic private rename", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes("function atomicState") && source.includes("renameSync(temporary, statePath)"), true);
  });
  await t.test("removes the empty certification directory with directory semantics", () => {
    assert.equal(readFileSync(certificationPath, "utf8").includes("rmdirSync(certificationRuntime)"), true);
  });
  await t.test("separates the Bridge uninstall preview from final deletion confirmation", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('["bridge", "uninstall", state.alias, "--delete-retained-wav", "--delete-credentials"]') &&
      source.includes('phase: "awaiting-uninstall-confirmation"') &&
      source.includes('["bridge", "uninstall", state.alias, "--delete-retained-wav", "--delete-credentials", "--confirm"]'), true);
  });
  await t.test("persists resumable states before predecessor install, candidate upgrade, and confirmed uninstall", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('phase: "preparing-predecessor"') &&
      source.includes('phase: "upgrading-candidate"') && source.includes('phase: "uninstalling"'), true);
  });
  await t.test("replays idempotent installs and destructive cleanup from transitional phases", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes('if (state.phase === "preparing-predecessor")') &&
      source.includes('if (state.phase === "upgrading-candidate")') &&
      source.includes('["bridge", "uninstall", state.alias, "--delete-retained-wav", "--delete-credentials", "--confirm"]'), true);
  });
  await t.test("requires a new reviewed confirmation if uninstall effects change", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.equal(source.includes("uninstallPreviewSha256") &&
      source.includes("Uninstall effects changed. Review the new preview"), true);
  });
  await t.test("does not let verify bypass clean-user staged gates", () => {
    const source = readFileSync(certificationPath, "utf8");
    assert.match(source, /scenario\.kind === "clean-user"\) fail\("Clean-user certification must resume with `advance --confirm`/);
  });
  await t.test("does not import a repository test fixture", () => {
    assert.equal(readFileSync(certificationPath, "utf8").includes("test/fixtures"), false);
  });
});

test("bridge build stops before creating output when Swift is unavailable", async (t) => {
  const home = temporaryHome();
  const output = join(home, "PiDictationBridge.app");
  try {
    const result = runBridge(home, ["build", "--output", output], { PATH: "/nonexistent" });

    await t.test("fails", () => {
      assert.notEqual(result.status, 0);
    });
    await t.test("gives actionable Xcode command line tools guidance", () => {
      assert.match(result.stderr, /xcode-select --install/);
    });
    await t.test("does not create build output", () => {
      assert.equal(existsSync(output), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge build rejects an unsuitable Swift toolchain before creating output", async (t) => {
  const home = temporaryHome();
  const output = join(home, "PiDictationBridge.app");
  const tools = fakeToolchain(home);
  writeExecutable(join(tools, "swiftc"), "#!/bin/sh\necho 'Swift version 5.8.1'\necho 'Target: arm64-apple-macosx13.0'\n");
  try {
    const result = runBridge(home, ["build", "--output", output], { PATH: tools });

    await t.test("fails with the required version", () => {
      assert.match(result.stderr, /Swift 5\.9 or newer is required/);
    });
    await t.test("does not create build output", () => {
      assert.equal(existsSync(output), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge build creates a fixed hidden native app bundle", async (t) => {
  const home = temporaryHome();
  const output = join(home, "PiDictationBridge.app");
  const tools = fakeToolchain(home);
  try {
    const result = runBridge(home, ["build", "--output", output], { PATH: tools });
    const info = readFileSync(join(output, "Contents", "Info.plist"), "utf8");

    await t.test("succeeds", () => {
      assert.equal(result.status, 0, result.stderr);
    });
    await t.test("uses the fixed bundle identity", () => {
      assert.match(info, /<string>com\.yasuhito\.pi-dictation\.bridge<\/string>/);
    });
    await t.test("declares microphone purpose", () => {
      assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/);
    });
    await t.test("is hidden from ordinary app UI", () => {
      assert.match(info, /<key>LSUIElement<\/key>\s*<true\/>/);
    });
    await t.test("contains the companion executable", () => {
      assert.equal(lstatSync(join(output, "Contents", "MacOS", "PiDictationBridge")).isFile(), true);
    });
    await t.test("contains the independent duration watchdog executable", () => {
      assert.equal(lstatSync(join(output, "Contents", "MacOS", "PiDictationDurationWatchdog")).isFile(), true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge install refuses a symlinked managed root", () => {
  const home = temporaryHome();
  const outside = temporaryHome();
  const support = join(home, "Library", "Application Support", "pi-dictation");
  const tools = fakeToolchain(home);
  try {
    mkdirSync(join(home, "Library", "Application Support"), { recursive: true });
    symlinkSync(outside, support);
    const result = runBridge(home, ["install"], { PATH: tools });
    assert.match(result.stderr, /refusing symlink/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("bridge install refuses a dangling symlink at a managed artifact", () => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    const credential = join(home, "Library", "Application Support", "pi-dictation", "bridge", "credential.json");
    rmSync(credential);
    symlinkSync(join(home, "missing-credential"), credential);
    const result = runBridge(home, ["install"], { PATH: tools });
    assert.match(result.stderr, /refusing symlink/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge install refuses an existing app whose ownership cannot be proven", () => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    const marker = join(home, "Library", "Application Support", "pi-dictation", "bridge", "PiDictationBridge.app", "Contents", "Resources", "ownership.json");
    writeFileSync(marker, JSON.stringify({ product: "someone-else", installId: "00000000-0000-0000-0000-000000000000" }), { mode: 0o600 });
    const result = runBridge(home, ["install"], { PATH: tools });
    assert.match(result.stderr, /ownership cannot be proven/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge install creates private owned artifacts without loading before preflight", async (t) => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  try {
    const result = runBridge(home, ["install"], { PATH: tools });
    const root = join(home, "Library", "Application Support", "pi-dictation", "bridge");
    const credential = join(root, "credential.json");
    const plist = join(home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist");

    await t.test("succeeds", () => {
      assert.equal(result.status, 0, result.stderr);
    });
    await t.test("makes the managed root owner-only", () => {
      assert.equal(lstatSync(root).mode & 0o777, 0o700);
    });
    await t.test("makes the credential owner-only", () => {
      assert.equal(lstatSync(credential).mode & 0o777, 0o600);
    });
    await t.test("writes the user LaunchAgent configuration", () => {
      assert.match(readFileSync(plist, "utf8"), /com\.yasuhito\.pi-dictation\.bridge/);
    });
    await t.test("keeps the LaunchAgent inactive before real-audio preflight", () => {
      assert.doesNotMatch(readFileSync(plist, "utf8"), /<key>RunAtLoad<\/key>/);
    });
    await t.test("does not mark the companion ready", () => {
      assert.equal(existsSync(join(root, "preflight.json")), false);
    });
    await t.test("directs the user to interactive preflight", () => {
      assert.match(result.stdout, /pi-dictation bridge preflight/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge preflight refuses a non-interactive invocation", async (t) => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    const result = runBridge(home, ["preflight"], { PATH: tools });

    await t.test("fails", () => {
      assert.notEqual(result.status, 0);
    });
    await t.test("reports permission separately", () => {
      assert.match(result.stdout, /Microphone permission: not checked/);
    });
    await t.test("reports capture separately", () => {
      assert.match(result.stdout, /Real-audio capture: not checked/);
    });
    await t.test("requires an interactive terminal", () => {
      assert.match(result.stderr, /interactive terminal/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge preflight requires and records interactive real-audio observation before loading the LaunchAgent", async (t) => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  enableFakePreflight(tools);
  const launchctlLog = join(home, "launchctl.log");
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    const result = runInPseudoTerminal([process.execPath, cliPath, "bridge", "preflight"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: tools, LAUNCHCTL_LOG: launchctlLog },
    });
    const ready = join(home, "Library", "Application Support", "pi-dictation", "bridge", "preflight.json");

    await t.test("succeeds only after real audio is observed", () => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
    await t.test("reports authorized permission", () => {
      assert.match(result.stdout, /Microphone permission: authorized/);
    });
    await t.test("reports real audio separately", () => {
      assert.match(result.stdout, /Real-audio capture: real audio observed/);
    });
    await t.test("records readiness for the installed build", () => {
      assert.equal(existsSync(ready), true);
    });
    await t.test("enables supervision after preflight", () => {
      const plist = join(home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist");
      assert.match(readFileSync(plist, "utf8"), /<key>RunAtLoad<\/key><true\/>/);
    });
    await t.test("keeps the companion alive after an unexpected exit", () => {
      const plist = join(home, "Library", "LaunchAgents", "com.yasuhito.pi-dictation.bridge.plist");
      assert.match(readFileSync(plist, "utf8"), /<key>KeepAlive<\/key><true\/>/);
    });
    await t.test("loads the user LaunchAgent after preflight", () => {
      assert.match(readFileSync(launchctlLog, "utf8"), /bootstrap gui\/\d+/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge preflight removes readiness when LaunchAgent loading fails", () => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  enableFakePreflight(tools);
  writeExecutable(join(tools, "launchctl"), "#!/bin/sh\nexit 1\n");
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    runInPseudoTerminal([process.execPath, cliPath, "bridge", "preflight"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: tools },
    });
    const ready = join(home, "Library", "Application Support", "pi-dictation", "bridge", "preflight.json");
    assert.equal(existsSync(ready), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge preflight does not mark digital silence ready", () => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  enableFakePreflight(tools);
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    runInPseudoTerminal([process.execPath, cliPath, "bridge", "preflight"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: tools, FAKE_CAPTURE: "silence", LAUNCHCTL_LOG: join(home, "launchctl.log") },
    });
    const ready = join(home, "Library", "Application Support", "pi-dictation", "bridge", "preflight.json");
    assert.equal(existsSync(ready), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function markPreflightReady(home) {
  const root = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const receipt = JSON.parse(readFileSync(join(root, "ownership.json"), "utf8"));
  const executable = join(root, "PiDictationBridge.app", "Contents", "MacOS", "PiDictationBridge");
  const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  writeFileSync(
    join(root, "preflight.json"),
    JSON.stringify({ product: "com.yasuhito.pi-dictation.bridge", installId: receipt.installId, executableSha256 }) + "\n",
    { mode: 0o600 }
  );
}

async function startHealthServer(home, mode = "ok") {
  const script = join(home, "health-server.cjs");
  writeFileSync(script, String.raw`
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { chmodSync, readFileSync, rmSync } = require("node:fs");
const net = require("node:net");
const [credentialPath, socketPath, mode, eventPath] = process.argv.slice(2);
const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
const secret = Buffer.from(credential.secret, "base64");
function encode(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length); pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}
function tag(fields) { return createHmac("sha256", secret).update(encode(fields)).digest(); }
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  const challenge = randomBytes(32);
  const challengeFrame = frame({ type: "challenge", challenge: challenge.toString("base64") });
  if (mode === "phase-delays") setTimeout(() => socket.write(challengeFrame), 2700);
  else socket.write(challengeFrame);
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 4) return;
    const length = buffered.readUInt32BE(0); if (buffered.length !== length + 4) return;
    const request = JSON.parse(buffered.subarray(4));
    if (eventPath) require("node:fs").appendFileSync(eventPath, request.operation + ":" + request.requestId + "\n");
    const payload = Buffer.from(request.payload, "base64");
    const expected = tag(["request", 3, challenge, credential.id, request.requestId, "health", payload]);
    const actual = Buffer.from(request.hmac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return socket.destroy();
    const responseVersion = mode === "wrong-version" ? 2 : 3;
    const status = mode === "wrong-version" ? "version-mismatch" : mode === "authenticated-busy" ? "busy" : "ok";
    const body = mode === "wrong-version"
      ? { clientVersion: 3, companionVersion: 2 }
      : mode === "authenticated-busy" ? {}
      : {
          permission: mode === "control-permission" ? "authorized\u001b[31m" :
            mode === "unknown-permission" ? "unexpected" : "authorized",
          defaultInputAvailable: true,
        };
    const responsePayload = Buffer.from(JSON.stringify(body));
    const responseTag = mode === "bad-response-hmac"
      ? Buffer.alloc(32)
      : tag(["response", 3, responseVersion, challenge, credential.id, request.requestId, "health:" + status, responsePayload]);
    const response = frame({ type: "response", version: responseVersion, requestId: request.requestId, status, payload: responsePayload.toString("base64"), hmac: responseTag.toString("hex") });
    if (mode === "trailing-response") {
      socket.write(response);
      setTimeout(() => socket.end(Buffer.from("x")), 10);
    } else if (mode === "phase-delays") {
      setTimeout(() => socket.end(response), 2700);
    } else {
      socket.end(response);
    }
  });
  socket.on("close", () => server.close());
});
rmSync(socketPath, { force: true });
server.listen(socketPath, () => { chmodSync(socketPath, 0o600); process.stdout.write("ready\\n"); });
`);
  const root = join(home, "Library", "Application Support", "pi-dictation", "bridge");
  const socket = join(home, "Library", "Caches", "pi-dictation", "bridge", "companion.sock");
  const child = spawn(process.execPath, [script, join(root, "credential.json"), socket, mode, join(home, "health-events.log")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");
  return child;
}

test("bridge health authenticates an exact-version request and response over the private Unix socket", async (t) => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  let server;
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    markPreflightReady(home);
    server = await startHealthServer(home);
    const result = runBridge(home, ["health"]);

    await t.test("succeeds", () => {
      assert.equal(result.status, 0, result.stderr);
    });
    await t.test("reports exact protocol compatibility", () => {
      assert.match(result.stdout, /Protocol: ok \(exact version 3\)/);
    });
    await t.test("reports authenticated health", () => {
      assert.match(result.stdout, /Authenticated health: ok/);
    });
    await t.test("reports permission without opening the microphone", () => {
      assert.match(result.stdout, /Microphone permission: authorized/);
    });
  } finally {
    server?.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge health resets its five-second deadline between authentication phases", async (t) => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  let server;
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    markPreflightReady(home);
    server = await startHealthServer(home, "phase-delays");
    const startedAt = Date.now();
    const result = runBridge(home, ["health"]);
    const elapsed = Date.now() - startedAt;

    await t.test("allows the combined challenge and response phases to exceed five seconds", () => {
      assert.equal(result.status === 0 && elapsed >= 5200 && elapsed < 7000, true, result.stderr);
    });
    await t.test("performs one management request without retrying", () => {
      assert.equal(readFileSync(join(home, "health-events.log"), "utf8").trim().split("\n").length, 1);
    });
  } finally {
    server?.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge health maps an authenticated non-success status without retrying", async (t) => {
  const home = temporaryHome();
  const tools = fakeToolchain(home);
  let server;
  try {
    const installed = runBridge(home, ["install"], { PATH: tools });
    if (installed.status !== 0) throw new Error(installed.stderr);
    markPreflightReady(home);
    server = await startHealthServer(home, "authenticated-busy");
    const result = runBridge(home, ["health"]);

    await t.test("preserves the existing user-facing status message", () => {
      assert.match(result.stderr, /The companion rejected health with authenticated status busy\./);
    });
    await t.test("does not retry the rejected management request", () => {
      assert.equal(readFileSync(join(home, "health-events.log"), "utf8").trim().split("\n").length, 1);
    });
  } finally {
    server?.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge health rejects an unauthenticated response", () => {
  return (async () => {
    const home = temporaryHome();
    const tools = fakeToolchain(home);
    let server;
    try {
      const installed = runBridge(home, ["install"], { PATH: tools });
      if (installed.status !== 0) throw new Error(installed.stderr);
      markPreflightReady(home);
      server = await startHealthServer(home, "bad-response-hmac");
      const result = runBridge(home, ["health"]);
      assert.match(result.stderr, /could not be authenticated/);
    } finally {
      server?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  })();
});

for (const [mode, description] of [
  ["control-permission", "control characters in permission diagnostics"],
  ["unknown-permission", "unknown permission diagnostics"],
]) {
  test(`bridge health rejects ${description}`, async () => {
    const home = temporaryHome();
    const tools = fakeToolchain(home);
    let server;
    try {
      const installed = runBridge(home, ["install"], { PATH: tools });
      if (installed.status !== 0) throw new Error(installed.stderr);
      markPreflightReady(home);
      server = await startHealthServer(home, mode);
      const result = runBridge(home, ["health"]);
      assert.match(result.stderr, /invalid health data/);
    } finally {
      server?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("bridge health rejects trailing response bytes delivered separately", () => {
  return (async () => {
    const home = temporaryHome();
    const tools = fakeToolchain(home);
    let server;
    try {
      const installed = runBridge(home, ["install"], { PATH: tools });
      if (installed.status !== 0) throw new Error(installed.stderr);
      markPreflightReady(home);
      server = await startHealthServer(home, "trailing-response");
      const result = runBridge(home, ["health"]);
      assert.match(result.stderr, /trailing protocol bytes/);
    } finally {
      server?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  })();
});

test("bridge health rejects any other protocol version", () => {
  return (async () => {
    const home = temporaryHome();
    const tools = fakeToolchain(home);
    let server;
    try {
      const installed = runBridge(home, ["install"], { PATH: tools });
      if (installed.status !== 0) throw new Error(installed.stderr);
      markPreflightReady(home);
      server = await startHealthServer(home, "wrong-version");
      const result = runBridge(home, ["health"]);
      assert.match(result.stderr, /Authenticated protocol mismatch: Pi uses version 3; companion uses version 2/);
    } finally {
      server?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  })();
});

test("the npm tarball includes the bridge CLI and companion source", async (t) => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map((entry) => entry.path);

  await t.test("includes the unified CLI", () => {
    assert.ok(files.includes("bin/pi-dictation.mjs"));
  });
  await t.test("includes the self-contained real-device certification command", () => {
    assert.ok(files.includes("bin/pi-dictation-bridge-certify.cjs"));
  });
  await t.test("includes the companion Swift source", () => {
    assert.ok(files.includes("native/macos-companion/PiDictationBridge.swift"));
  });
  await t.test("includes the least-privilege duration watchdog source", () => {
    assert.ok(files.includes("native/macos-companion/PiDictationDurationWatchdog.swift"));
  });
});
