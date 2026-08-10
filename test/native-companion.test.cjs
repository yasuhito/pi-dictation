const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");

const macOnly = process.platform === "darwin" ? {} : { skip: "requires the macOS Swift toolchain" };

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
      "-framework", "AVFoundation", "-framework", "CryptoKit", "-framework", "Security",
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
