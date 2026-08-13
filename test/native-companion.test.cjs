const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");

const macOnly = process.platform === "darwin" ? {} : { skip: "requires the macOS Swift toolchain" };

test("production logout attribution observes confirmed loginwindow teardown", () => {
  const source = readFileSync(join(root, "native", "macos-companion", "PiDictationBridge.swift"), "utf8");
  assert.equal(source.includes("com.apple.logoutContinued") && source.includes("com.apple.logoutCancelled"), true);
});

test("production logout confirmation wins before console-lock attribution", () => {
  const source = readFileSync(join(root, "native", "macos-companion", "PiDictationBridge.swift"), "utf8");
  assert.match(source, /terminationRequest[\s\S]*logoutAttribution\.isContinued\(\)[\s\S]*failActive\(reason: "logout"\)[\s\S]*milliseconds\(750\)/);
});

test("production termination fallback leaves time for authoritative logout attribution", () => {
  const source = readFileSync(join(root, "native", "macos-companion", "PiDictationBridge.swift"), "utf8");
  assert.match(source, /terminationRequest[\s\S]*milliseconds\(750\)[\s\S]*failActive\(reason: "companion-stop"\)/);
});

test("the companion LaunchAgent bypasses post-login app-bundle xpcproxy stalls", () => {
  const source = readFileSync(join(root, "bin", "pi-dictation.mjs"), "utf8");
  assert.match(source, /<string>\/bin\/sh<\/string><string>-c<\/string><string>exec &quot;\$1&quot;<\/string>/);
});

test("production lifecycle wiring distinguishes logout from restart and shutdown", macOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-lifecycle-wiring-"));
  const harness = join(directory, "LifecycleWiring.swift");
  const executable = join(directory, "LifecycleWiring");
  writeFileSync(harness, `
import Foundation

@main
struct LifecycleWiring {
    static func main() throws {
        let values = ["logout", "restart", "shutdown"].map { ownerVisibleLifecycleReason(systemEvent: $0)! }
        print(values.joined(separator: ","))
    }
}
`);
  try {
    const compilation = spawnSync("swiftc", [
      "-D", "PI_DICTATION_TESTING",
      join(root, "native", "macos-companion", "PiDictationBridge.swift"), harness,
      "-o", executable,
      "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "CryptoKit", "-framework", "Security",
      "-framework", "CoreMedia", "-framework", "AudioToolbox",
    ], { encoding: "utf8" });
    if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    if (execution.status !== 0) throw new Error(execution.stderr || execution.stdout);
    assert.equal(execution.stdout.trim(), "logout,reboot,reboot");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production console-lock state maps IOKit Booleans and rejects absence", macOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-console-lock-"));
  const harness = join(directory, "ConsoleLock.swift");
  const executable = join(directory, "ConsoleLock");
  writeFileSync(harness, `
import Foundation

@main
struct ConsoleLock {
    static func main() {
        print([consoleLockState(kCFBooleanTrue), consoleLockState(kCFBooleanFalse), consoleLockState(nil)])
    }
}
`);
  try {
    const compilation = spawnSync("swiftc", [
      "-D", "PI_DICTATION_TESTING",
      join(root, "native", "macos-companion", "PiDictationBridge.swift"), harness,
      "-o", executable,
      "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "CryptoKit", "-framework", "Security",
      "-framework", "CoreMedia", "-framework", "AudioToolbox", "-framework", "IOKit",
    ], { encoding: "utf8" });
    if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    if (execution.status !== 0) throw new Error(execution.stderr || execution.stdout);
    assert.equal(execution.stdout.trim(), "[true, false, false]");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production input wiring gives capture and device-loss observation the same selected device", macOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-device-wiring-"));
  const harness = join(directory, "DeviceWiring.swift");
  const executable = join(directory, "DeviceWiring");
  writeFileSync(harness, `
import Foundation

final class Device {}

@main
struct DeviceWiring {
    static func main() throws {
        let selected = Device()
        var capture: ObjectIdentifier?
        var observation: ObjectIdentifier?
        _ = try withPinnedDefaultInput(
            select: { selected },
            identity: { _ in "selected-device" },
            observe: { observation = ObjectIdentifier($0) },
            capture: { capture = ObjectIdentifier($0) }
        )
        print(capture == observation)
    }
}
`);
  try {
    const compilation = spawnSync("swiftc", [
      "-D", "PI_DICTATION_TESTING",
      join(root, "native", "macos-companion", "PiDictationBridge.swift"), harness,
      "-o", executable,
      "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "CryptoKit", "-framework", "Security",
      "-framework", "CoreMedia", "-framework", "AudioToolbox",
    ], { encoding: "utf8" });
    if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    if (execution.status !== 0) throw new Error(execution.stderr || execution.stdout);
    assert.equal(execution.stdout.trim(), "true");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production capture closes before the exact duration watchdog deadline", macOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-capture-duration-"));
  const harness = join(directory, "CaptureDuration.swift");
  const executable = join(directory, "CaptureDuration");
  writeFileSync(harness, `
import Foundation

@main
struct CaptureDuration {
    static func main() {
        print(captureDurationSeconds(maximumDurationMs: 1000))
    }
}
`);
  try {
    const compilation = spawnSync("swiftc", [
      "-D", "PI_DICTATION_TESTING",
      join(root, "native", "macos-companion", "PiDictationBridge.swift"), harness,
      "-o", executable,
      "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "CryptoKit", "-framework", "Security",
      "-framework", "CoreMedia", "-framework", "AudioToolbox",
    ], { encoding: "utf8" });
    if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    if (execution.status !== 0) throw new Error(execution.stderr || execution.stdout);
    assert.equal(Number(execution.stdout.trim()) > 0 && Number(execution.stdout.trim()) < 1, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("duration watchdog requests only its exact parent then force-terminates it after the grace bound", macOnly, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-watchdog-test-"));
  const executable = join(directory, "PiDictationDurationWatchdog");
  const marker = join(directory, "requested");
  try {
    const compilation = spawnSync("swiftc", [
      "-D", "WATCHDOG_TESTING", "-parse-as-library",
      join(root, "native", "macos-companion", "PiDictationDurationWatchdog.swift"),
      "-o", executable,
    ], { encoding: "utf8" });
    if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout);
    const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const target = spawn("/bin/sh", ["-c", `printf '%s\\n' '${token}' | ${executable} $$ 80 1500 > '${marker}' & while :; do sleep 1; done`], {
      stdio: "ignore",
    });
    const [, signal] = await once(target, "exit");
    await t.test("delivers the instance-bound termination request to its parent", () => {
      assert.equal(readFileSync(marker, "utf8").trim(), token);
    });
    await t.test("force-terminates that still-running parent after the testing grace bound", () => {
      assert.equal(signal, "SIGKILL");
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duration watchdog receives its instance token only through its inherited private pipe", () => {
  const source = readFileSync(join(root, "native", "macos-companion", "PiDictationDurationWatchdog.swift"), "utf8");
  assert.equal(source.includes("instanceToken = CommandLine.arguments"), false);
});

test("failed-state persistence failure keeps audio until durable cleanup can retry", macOnly, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-native-test-"));
  const harness = join(directory, "FailureInjection.swift");
  const executable = join(directory, "FailureInjection");
  writeFileSync(harness, `
import Foundation

enum InjectedFailure: Error { case persistence }

@main
struct FailureInjection {
    static func main() {
        var removals = 0
        var retries = 0
        do {
            try initializeCapture(
                attempt: { throw InjectedFailure.persistence },
                onFailure: {
                    commitFailedRecordingState(
                        persist: { throw InjectedFailure.persistence },
                        removeAudio: { removals += 1 },
                        scheduleRetry: { retries += 1 }
                    )
                }
            )
        } catch {}
        let data = try! JSONSerialization.data(withJSONObject: ["removals": removals, "retries": retries])
        print(String(data: data, encoding: .utf8)!)
    }
}
`);
  try {
    const compilation = spawnSync("swiftc", [
      "-DPI_DICTATION_TESTING",
      join(root, "native", "macos-companion", "PiDictationBridge.swift"), harness,
      "-o", executable,
      "-framework", "AVFoundation", "-framework", "AppKit", "-framework", "CryptoKit", "-framework", "Security",
      "-framework", "CoreMedia", "-framework", "AudioToolbox",
    ], { encoding: "utf8" });
    if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    if (execution.status !== 0) throw new Error(execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout);

    await t.test("schedules durable cleanup retry", () => {
      assert.equal(result.retries, 1);
    });
    await t.test("does not remove audio before failed metadata is durable", () => {
      assert.equal(result.removals, 0);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
