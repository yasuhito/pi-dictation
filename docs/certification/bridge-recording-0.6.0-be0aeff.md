# Bridge recording certification: 0.6.0 candidate at be0aeff

## Release candidate

- Decision: **PASS WITH ACCEPTED CLEAN-USER EXCEPTION**
- Package version: `0.6.0`
- Commit: `be0aeff96e3216564e5e3c6c029d3f5c10530410`
- Tarball SHA-256: `f55e41b60532828ab0ad268f8915c0b92ddaecc3fffe02b6a1ac41b2d23ac504`
- Candidate remained byte-identical on rerun and across Mac and Linux: **yes**
- Verifier: project owner with Pi coding agent automation
- Completed: `2026-08-13T04:18:38Z`

The project owner explicitly accepted release without the disposable clean-user gate because creating another macOS account solely for certification was disproportionate for this initial release. This is a bounded exception, not evidence that the omitted gate passed. Install, upgrade, maintenance, real-audio, and restoration checks were instead run in an existing isolated macOS account. A clean-user defect reported after release remains actionable.

## Certified platform

- Apple Silicon model: MacBook Pro `MacBookPro18,3`, Apple M1 Pro
- macOS: `26.5.1 (25F80)`
- Remote Linux: Arch Linux, kernel `7.1.4-arch1-1`, x86_64
- Node.js / npm: Mac `26.5.0 / 11.17.0`; Linux `26.2.0 / 11.13.0`
- OpenSSH client: Mac `10.2p1`; Linux `10.4p1`
- Xcode / Swift: Xcode `26.2 (17C52)`; Swift `6.2.3`
- Default transport: Unix socket forwarding
- Explicit fallbacks tested: `127.0.0.1` and `::1` through isolated real SSH servers

## Automated gates

| Gate | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| assertion shape, typecheck, extension/Recorder/protocol/model/Level/UI/filesystem/resource/package tests | PASS — 727 passed, 50 platform skips, 0 failed | 2026-08-13 | Pi agent |
| native companion build and integration | PASS | 2026-08-13 | Pi agent on certified Mac |
| native adversarial protocol | PASS — 51 passed, 0 failed | 2026-08-13 | Pi agent on certified Mac |
| isolated native lifecycle and retained-audio audit | PASS — 194 passed, 0 failed; no retained isolated runtime | 2026-08-13 | Pi agent on certified Mac |
| package contents and documented tarball commands | PASS | 2026-08-13 | Pi agent |

Synthetic lifecycle tests are not counted as physical lifecycle evidence.

## Real-device recurring gate

| Scenario | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| actual Live level history and recognizable Bridge transcription | PASS | 2026-08-13 | human observation |
| cancellation cleanup | PASS | 2026-08-13 | Pi agent |
| duration limit without transcription | PASS | 2026-08-13 | Pi agent with real microphone input |
| tunnel loss ≤15 s and authenticated recovery | PASS | 2026-08-13 | Pi agent |
| second-client detail-free `busy` | PASS | 2026-08-13 | Pi agent with independently configured isolated client |
| local Recorder levels, transcription, and cancellation | PASS | 2026-08-13 | human observation; bounded phrase not retained |

## Initial and mechanism-change gate

| Scenario | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| physical sleep / logout / reboot / session lock | PASS | 2026-08-12–13 | human action and Pi agent verification |
| companion stop / restart / physical default-input loss | PASS | 2026-08-12–13 | human action and Pi agent verification |
| credential revocation and rotation | PASS | 2026-08-13 | Pi agent |
| active-recording upgrade / uninstall | PASS | 2026-08-13 | Pi agent; preview and destructive confirmation were separate |
| fixed storage, connection, memory, and log bounds | PASS | 2026-08-13 | automated and native gates |
| real SSH Unix / IPv4 loopback / IPv6 loopback | PASS | 2026-08-13 | Pi agent; isolated SSH targets for TCP fallbacks |

The active-recording uninstall used an isolated configured client and preserved the existing Unix Bridge. Both maintenance scenarios ended with authenticated health and zero owned audio.

## Disposable clean-user actual-tarball gate

| Stage | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| predecessor tarball install and real-audio preflight | WAIVED — not run in a new account | 2026-08-13 | project-owner decision |
| host install and idempotent rerun | WAIVED — existing-account coverage only | 2026-08-13 | project-owner decision |
| human and bounded JSON diagnosis | WAIVED — existing-account coverage only | 2026-08-13 | project-owner decision |
| Bridge recording | WAIVED — existing-account coverage only | 2026-08-13 | project-owner decision |
| candidate upgrade and credential rotation | WAIVED — existing-account coverage only | 2026-08-13 | project-owner decision |
| bridge/package uninstall and pre-install-state restoration | WAIVED — isolated host cleanup and valued-account restoration passed; clean-account absence proof not run | 2026-08-13 | project-owner decision |
| external-artifact digest preserved | WAIVED — not run | 2026-08-13 | project-owner decision |

## Safe doctor JSON

The SSH alias and private paths were excluded. The retained bounded status summary is:

```json
{"schemaVersion":1,"companion":{"installation":"ready","permission":"authorized","launchAgent":"loaded","process":"running"},"host":{"lifecycle":"active","tunnelProcess":"running","listener":"established","authenticatedHealth":"ready","protocolCompatibility":"compatible","storage":{"incompleteAudio":0,"retainedWav":0},"levelAvailability":"available"}}
```

## Failure and rerun history

| Attempt | Scenario | Outcome | Cause/fix | Same tarball |
| --- | --- | --- | --- | --- |
| 1 | IPv4 tunnel reconnect | FAIL on predecessor candidate | managed TCP fallback incorrectly invoked Unix-listener cleanup; fixed in `be0aeff` | no — new candidate |
| 2 | IPv4 and IPv6 real SSH fallback | PASS | permissions corrected in isolated target; each alias used an independently prepared Recorder home | yes |
| 1 | active-recording upgrade harness | INVALID EVIDENCE | the ad-hoc client did not maintain owner-liveness and produced a recoverable result before upgrade inspection | yes |
| 2 | active-recording upgrade | PASS | client maintained owner-liveness; preview, confirmed cancellation, replacement, real-audio preflight, and zero-audio health passed | yes |
| 1 | active-recording uninstall | PASS | isolated configured client; exact preview reviewed before confirmation | yes |

The invalid harness run was cleaned and is not counted as passing evidence. Earlier candidate failures remain preserved in their own records and are not attributed to this tarball.

## Redaction and cleanup attestation

- [x] No audio or full transcript was retained.
- [x] No credential, lease capability, private path, raw recording identity, or complete SSH command was retained.
- [x] Owner-scoped active, incomplete-audio, and retained-WAV counts were zero after the final scenarios.
- [x] Private certification recovery state was removed.
- [x] Isolated containers, temporary SSH aliases, temporary credentials, probes, and test audio runtimes were removed.
- [x] The valued Linux Bridge configuration was restored and authenticated health was ready.
- [x] The verifier and UTC completion time are recorded above.
