# Bridge recording certification: 0.6.0 candidate at 79cc850

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `79cc850`
- npm tarball SHA-256: `2f1f633e67071eb3fdc10c60ba542d8d2389333ffa357b2d7ff173e0f812bbfd`
- Candidate remained byte-identical across Mac and Linux: **yes**

This candidate corrected companion-stop recovery and passed the recurring real-device gates below. It failed during companion-restart certification because one run emitted passing bounded evidence and then returned a transport EOF with exit status 1. A later diagnostic run returned the EOF without passing evidence. Both are incoherent certification outcomes; neither can certify a release.

## Platform observed

- Apple Silicon Mac, macOS `26.5.1 (25F80)`
- Remote Arch Linux x86_64, kernel `7.1.4-arch1-1`
- Existing isolated Mac user; not a disposable clean user
- Unix socket forwarding
- Evidence date: `2026-08-12`

## Automated gates

- Linux check before this candidate: PASS, 706 passed, 47 skipped, 0 failed.
- Certification-recovery follow-up check: PASS, 713 passed, 47 skipped, 0 failed.
- Typecheck and assertion-shape gates: PASS.

## Exact-tarball real-device outcomes

| Scenario | Outcome | Safe evidence |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | Protocol v3, authorized permission, real input, authenticated health |
| companion stop | PASS | Explicit owned restart returned authenticated readiness; `companion-stop` attribution; no retained audio |
| cancellation | PASS | No retained audio or secret |
| tunnel loss and reconnect | PASS | Terminated within owner-liveness bound; authenticated reconnect; no retained audio |
| native duration limit | PASS | Real microphone, `duration-limit`, no transcription, no retained audio |
| Live level history and recognizable transcription | PASS | Human confirmed changing truthful history and an identifiable generated token; phrase not retained |
| companion restart | **FAIL** | Lifecycle attribution and audio cleanup occurred, but CLI evidence and process exit disagreed during a transient EOF |

## Failure analysis

The lifecycle catch path always rethrew its original transport error even when a second owner-scoped cleanup fully proved the expected lifecycle reason and emitted PASS evidence. It also cleared private recovery state before checking that expected reason. The fix after this candidate gives successful recovery ownership of the verdict, retains state until reason and cleanup are proven, and tests both recovery outcomes at a dedicated seam.

A first minimized script killed the companion as soon as certification state appeared, before `start` had necessarily committed the Recording lease; that harness was invalid and is not evidence. The corrected harness waits for start to settle. Ten corrected runs on this candidate and ten on the fixed package completed coherently, so the original EOF is treated as an intermittent transport race guarded by deterministic recovery-unit tests rather than a deterministic physical failure.

## Final safe state

- Companion, tunnel, listener, authenticated health, and Level transport: ready
- Owner-scoped incomplete audio: 0
- Owner-scoped retained WAV: 0
- No audio, full transcript, secret, private path, recording identity, or complete SSH command retained

## Still incomplete

Physical sleep, logout, reboot, session lock, input-device loss, second independently configured client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked regardless of the companion-restart fix.
