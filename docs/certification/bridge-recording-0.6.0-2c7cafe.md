# Bridge recording certification: 0.6.0 candidate at 2c7cafe

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Commit: `2c7cafef1860e66ec2622cb4a6dc58d72ccc08f6`
- Tarball SHA-256: `73d9deca66658392a036c261358f5fe750b6e80e4683ccf27b05922e70322e1b`
- Candidate remained byte-identical on rerun: not rerun

This record deliberately does not certify Bridge support. The complete automated gates passed, but the installed real-device companion socket was unavailable before the recurring and clean-user gates; no microphone or Pi UI observation was claimed. Per the release policy, this first failure is retained and blocks this candidate until the complete scenarios pass against the unchanged tarball.

## Platform observed

- Mac: MacBook Pro (`MacBookPro18,3`), Apple M1 Pro
- macOS: `26.5.1 (25F80)`
- Remote automated-test host: the same Apple Silicon Mac; real remote Linux Bridge gate not run
- Node.js / npm: `26.5.0 / 11.17.0` on Mac; `26.2.0 / 11.13.0` on Linux check host
- OpenSSH client: `OpenSSH_10.2p1, LibreSSL 3.3.6`
- Xcode / Swift: `Xcode 26.2 (17C52) / Apple Swift 6.2.3`
- Default transport: not certified
- Explicit fallbacks tested with real SSH: none

## Outcomes

| Gate | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| Linux assertion shape, typecheck, extension/Recorder/protocol/model/Level/UI/filesystem/resource tests | PASS (679 passed, 44 macOS-only skipped) | 2026-08-11 | deadloop worker |
| Apple Silicon assertion shape, typecheck, extension/Recorder/protocol/model/Level/UI/filesystem/resource/native companion tests | PASS (858 passed, 2 skipped) | 2026-08-11 | deadloop worker |
| native adversarial protocol | PASS (51 passed) | 2026-08-11 | deadloop worker |
| isolated native lifecycle and retained-audio audit | PASS (181 passed; no retained isolated runtime) | 2026-08-11 | deadloop worker |
| package contents | PASS (21 files; 98.7 kB packed) | 2026-08-11 | deadloop worker |
| candidate companion health before real-device scenarios | **FAIL** (`The companion Unix socket is unavailable.`) | 2026-08-11T07:18Z | deadloop worker |
| recurring real-device gate | BLOCKED by first failure | 2026-08-11 | deadloop worker |
| initial/mechanism-change gate | BLOCKED by first failure | 2026-08-11 | deadloop worker |
| disposable clean-user actual-tarball gate | BLOCKED; current account was not disposable and contained pre-existing Bridge state | 2026-08-11 | deadloop worker |

## Safe doctor evidence

No doctor JSON was retained because the candidate could not connect to the companion socket. The bounded safe failure was:

```text
Error: The companion Unix socket is unavailable.
```

## Failure and required rerun

| Attempt | Scenario | Outcome | Cause/fix | Same tarball |
| --- | --- | --- | --- | --- |
| 1 | candidate companion health | FAIL | Pre-existing companion state had no available control socket; no repair or replacement was claimed as certification | yes |

Safe recovery is to use a disposable clean macOS user, run the candidate's staged actual-tarball gate, perform only the requested microphone and Pi UI actions, and then rerun every recurring, lifecycle, and real-SSH scenario. If any code changes, create a new tarball and a new record instead of marking this one passed.

## Redaction and cleanup attestation

- No audio or transcript was retained.
- No credential, lease capability, private path, raw recording identity, or complete SSH command is present in this record.
- The automated isolated lifecycle gate reported no retained audio runtime.
- Owner-scoped cleanup for a production scenario was not claimed because no production scenario started.
