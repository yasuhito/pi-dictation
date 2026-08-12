# Bridge recording certification: 0.6.0 candidate at 7f9deee

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `7f9deee`
- npm tarball SHA-256: `55ed9c63ce902895e2345b6ac4ed957a46c769a26e36a05f9649b32401d00582`
- Candidate remained byte-identical across the Mac and Linux installations: **yes**

This candidate passed real microphone Bridge recording, Live level history, recognizable transcription, explicit cancellation, the native duration limit, and timed tunnel-loss recovery. It is not certified for release because the physical companion-stop scenario exposed a restart/recovery failure, and other required physical, clean-user, fallback, multi-host, and maintenance scenarios remain incomplete.

## Platform observed

- Mac: Apple Silicon arm64
- macOS: `26.5.1 (25F80)`
- Remote Linux: Arch Linux x86_64, kernel `7.1.4-arch1-1`
- Verifier: existing isolated Mac user; not a disposable clean user
- Default transport: Unix socket forwarding
- Evidence checked: `2026-08-12`

## Automated gates

| Gate | Outcome | Evidence |
| --- | --- | --- |
| Linux `npm run check` | PASS | 703 passed, 47 skipped, 0 failed |
| macOS native companion integration | PASS with rerun caveat | New effects-polling regression test passed; the full run had one unrelated owner-liveness EOF, and that named test passed immediately in isolation |
| assertion-shape and type checking | PASS | Every named test has at most one assertion; TypeScript emitted no errors |

Synthetic integration results are not claimed as physical lifecycle certification.

## Real-device and real-SSH evidence on the exact tarball

| Scenario | Outcome | Notes |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | Permission authorized, real input observed, protocol v3 and all-host authenticated health ready |
| Unix forwarding and authenticated health | PASS | Tunnel running, listener established, Level transport available |
| explicit cancellation | PASS | Owner-scoped cleanup proved no incomplete or retained audio |
| native duration limit | PASS | Real microphone input reached `duration-limit`; no transcription interface used; cleanup passed |
| Live level history | PASS | Human confirmed actual changes corresponding to speech on the fixed scale |
| recognizable transcription | PASS | A generated recognizable token remained identifiable; no phrase or full transcript is retained here |
| tunnel loss and reconnect | PASS | Recording lease ended within the fifteen-second owner-liveness bound; stale managed Unix listener was safely removed; authenticated health returned; cleanup passed |
| companion stop | **FAIL** | The Recording lease was attributed as `companion-stop` and its WAV was removed, but the certification flow only waited for launchd to restart a cleanly exited companion. A minimized real-device loop proved that `KeepAlive` did not restore authenticated health after this intentional stop; an explicit owned `kickstart` did. Removing the private request-receipt registry coincided with an early recovery attempt, but later minimized runs disproved it as a required recovery step. This candidate remains failed because it lacked the explicit restart and readiness proof. |

## Safe final doctor summary

- Protocol: version 3 compatible
- Microphone permission: authorized
- Companion process: running
- Tunnel: running
- Listener: established
- Authenticated health: ready
- Level transport: available
- Incomplete audio owned by credential: 0
- Retained WAV owned by credential: 0
- Certification transition state: absent

No raw doctor payload is retained.

## Candidate-lineage failures found before the exact-tarball run

| Failure | Resolution in this candidate |
| --- | --- |
| duration-limited AVAudioRecorder exceeded its exact PCM admission bound | Capture closes 250 ms before the independent watchdog deadline |
| stale remote Unix socket blocked reverse-forward recovery | Supervisor performs an ownership-checked inactive-socket cleanup before opening the tunnel |
| upgrade kept a supervisor path from an ephemeral npm execution directory | Upgrade rewrites and reloads each owned tunnel supervisor |
| launchd unload and immediate bootstrap raced | Bootstrap uses a bounded five-second retry |
| certification effects polling exhausted the control-receipt allowance and blocked cleanup | Read-only `credential-effects` requests use the observation allowance |

These earlier attempts used different tarball bytes and are diagnostic history, not passing certification evidence for this candidate.

## Required scenarios not completed or not passed

- physical companion-stop recovery: failed as described above;
- physical sleep, logout, reboot, session lock, companion restart, and input-device loss;
- real second independently configured client returning isolated `busy`;
- fresh install in a disposable clean Apple Silicon macOS user;
- real SSH IPv4 and IPv6 loopback fallbacks;
- real credential rotation;
- active-recording upgrade and uninstall;
- destructive uninstall with external-artifact digest proof and final restoration;
- local Recorder guided certification.

## Redaction and cleanup attestation

- No audio or full transcript is retained.
- No credential, lease capability, recording identity, private path, or complete SSH command is recorded.
- Final owner-scoped incomplete-audio and retained-WAV counts were zero.
- Temporary recovery material used during companion-stop diagnosis was deleted.
- Follow-up diagnosis preserved the original failure while correcting the initial request-receipt suspicion: the minimized failure reproduced independently of registry removal.
- No claim is made for synthetic, incomplete, or failed scenarios.
