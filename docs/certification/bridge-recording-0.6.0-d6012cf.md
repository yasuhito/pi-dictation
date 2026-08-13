# Bridge recording certification: 0.6.0 candidate at d6012cf

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `d6012cf43c6bebb562d58fc5605b4d9fea1a0e2c`
- Companion/preflight tarball SHA-256: `685fe6a9ec24023f7af0bc5acc7d6d3ea529f3395807de6dea393703ded36a29`
- Final Linux-extension tarball SHA-256: `7190ef0462c68369840d4d33040e6baa0b1b15fb6532949907e54a9d1bbacf59`
- Candidate remained byte-identical end to end: **no**

This record does not certify Bridge support. Real microphone recording, Live level history, recognizable transcription, cleanup, and Unix forwarding succeeded after mechanism fixes, but the final observation used different tarballs for the Mac companion and Linux extension. Required physical lifecycle, disposable-clean-user, fallback-transport, and maintenance scenarios also remain incomplete, so the release gate remains blocked.

## Platform observed

- Mac: Apple Silicon arm64
- macOS: `26.5.1 (25F80)`
- Remote Linux: Arch Linux x86_64, kernel `7.1.4-arch1-1`
- Node.js: `26.5.0` on Mac; `26.2.0` on Linux
- npm: `11.13.0` on Linux
- Evidence checked: `2026-08-12T04:40:37Z`
- Verifier: existing Mac user; not a disposable clean user
- Default transport: Unix socket forwarding
- Explicit IPv4/IPv6 fallbacks: not run against real SSH

## Automated gates

| Gate | Outcome | Evidence |
| --- | --- | --- |
| Linux `npm run check` | PASS | 681 passed, 45 skipped |
| macOS native companion integration | PASS | 173 passed, 0 failed |
| lifecycle, owner-liveness, multi-owner/busy, revocation, upgrade cancellation, and resource behavior | PASS as synthetic integration only | Covered by the native integration suite; not claimed as physical lifecycle certification |

## Real-device and real-SSH evidence

| Scenario | Outcome | Notes |
| --- | --- | --- |
| Unix socket forwarding and authenticated health | PASS | Protocol v3 compatible; tunnel running; listener established; health ready; Level available |
| actual Live level history | PASS | Fixed scale distinguished ordinary speech; minor display latency did not affect truthfulness |
| recognizable Bridge transcription | PASS | Recognizable result confirmed without retaining the phrase or full transcript |
| normal-stop cleanup | PASS | Final owner-scoped `incompleteAudio=0`, `retainedWav=0` |
| disconnected Level subscriber | PASS after fix | Real Mac reproduced SIGPIPE termination; `SO_NOSIGPIPE` prevented recurrence and the companion remained running |
| stale Unix listener reconnect | PASS after fix | Real environment reproduced failure; `StreamLocalBindUnlink=yes` restored listener and authenticated health |
| tarball upgrade and real-audio preflight | PASS on existing isolated user | Not a fresh disposable-user install |
| human status and bounded JSON doctor | PASS | Safe statuses summarized below; raw private output not retained |

## Safe doctor summary

- Protocol: version 3 compatible
- Microphone permission: authorized
- Tunnel: running
- Listener: established
- Authenticated companion health: ready
- Level transport: available
- Incomplete audio owned by credential: 0
- Retained WAV owned by credential: 0

No raw doctor payload is retained because the summary is sufficient and avoids preserving private deployment detail.

## Required scenarios not completed

- real-device explicit cancellation cleanup;
- real-device duration-limit failure without transcription;
- fully timed tunnel-loss termination within fifteen seconds;
- real-device second-client `busy` isolation;
- physical sleep, logout, reboot, session lock, companion stop/restart, and input-device loss;
- fresh install in a disposable clean Apple Silicon macOS user;
- real SSH IPv4 and IPv6 loopback fallbacks;
- real credential rotation;
- real active-recording upgrade and uninstall;
- uninstall with restoration of the pre-install state and external-artifact digest proof;
- a complete rerun using one byte-identical tarball on both hosts.

## Failure and rerun history

| Attempt | Scenario | Outcome | Cause/fix | Same tarball |
| --- | --- | --- | --- | --- |
| 1 | Level subscription disconnect | FAIL | SIGPIPE terminated the companion; fixed with `SO_NOSIGPIPE` | no |
| 2 | Unix listener reconnect | FAIL | stale listener blocked re-forward; fixed with `StreamLocalBindUnlink=yes` | no |
| 3 | real microphone, levels, transcription, cleanup | PASS with split deployment | timeline fix changed the Linux extension tarball after the Mac companion tarball was installed | no |

These failures remain part of the record. Safe recovery is to pack commit `d6012cf43c6bebb562d58fc5605b4d9fea1a0e2c` once, install that exact digest on both hosts, and run the complete matrix above without changing the candidate.

## Redaction and cleanup attestation

- No audio or full transcript was retained.
- No credential, lease capability, private path, raw recording identity, or complete SSH command is present.
- Final owner-scoped incomplete-audio and retained-WAV counts were zero.
- No claim is made for scenarios that were synthetic, incomplete, or run with split candidate bytes.
