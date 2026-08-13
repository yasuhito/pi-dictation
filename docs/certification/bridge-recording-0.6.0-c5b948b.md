# Bridge recording certification: 0.6.0 candidate at c5b948b

## Release candidate

- Decision: **PASS WITH ACCEPTED CLEAN-USER EXCEPTION**
- Package version: `0.6.0`
- Candidate commit: `c5b948bfc25cb2445d2e46dab386adcfb5b2496b`
- Tarball SHA-256: `b712e1e51f9b9495d40f47b482e932625f3fb88902e142666928415a2d109b92`
- Candidate remained byte-identical across Mac and Linux: **yes**
- Verifier: project owner with Pi coding agent automation
- Completed: `2026-08-13T04:32:27Z`

Certification records are excluded from npm package bytes. This permits this record to contain the digest of the immutable artifact it certifies. The package contains the stable certification template and links to repository records.

The project owner explicitly accepted release without the disposable clean-user gate because creating another macOS account solely for this initial release was disproportionate. This is a bounded exception, not passing evidence for the omitted gate.

## Certified platform

- Apple Silicon model: MacBook Pro `MacBookPro18,3`, Apple M1 Pro
- macOS: `26.5.1 (25F80)`
- Remote Linux: Arch Linux, kernel `7.1.4-arch1-1`, x86_64
- Node.js / npm: Mac `26.5.0 / 11.17.0`; Linux `26.2.0 / 11.13.0`
- OpenSSH client: Mac `10.2p1`; Linux `10.4p1`
- Xcode / Swift: Xcode `26.2 (17C52)`; Swift `6.2.3`
- Default transport: Unix socket forwarding
- Explicit fallbacks tested: `127.0.0.1` and `::1` through isolated real SSH servers

## Exact-artifact integrity

The final tarball was installed globally on the certified Mac and its digest matched the Linux-produced artifact and its SHA-256 matched on both. Compared with the immediately preceding real-device artifact, all product mechanism files were byte-identical:

- `bin/bridge-host.mjs`
- `bin/pi-dictation.mjs`
- `bin/pi-dictation-tunnel.mjs`
- `extensions/bridge-recorder.ts`
- `native/macos-companion/PiDictationBridge.swift`

Only the certification driver, package manifest, and support documentation changed. The driver change prevents interrupted automated or tunnel cleanup from emitting passing evidence. Exact-final-tarball preflight, cancellation, duration, tunnel reconnect, companion stop, and companion restart were rerun. Earlier physical/network/maintenance results are transferred only where the executable mechanism bytes and relevant driver path were unchanged; this transfer is stated rather than represented as a new physical action.

## Automated gates

| Gate | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| assertion shape, typecheck, extension/Recorder/protocol/model/Level/UI/filesystem/resource/package tests | PASS — 734 passed, 50 platform skips, 0 failed | 2026-08-13 | Pi agent |
| native companion build and integration | PASS — executable source byte-identical to tested candidate | 2026-08-13 | Pi agent on certified Mac |
| native adversarial protocol | PASS — 51 passed, 0 failed; byte-identical native mechanism | 2026-08-13 | Pi agent on certified Mac |
| isolated native lifecycle and retained-audio audit | PASS — 194 passed, 0 failed; no retained isolated runtime; byte-identical native mechanism | 2026-08-13 | Pi agent on certified Mac |
| package contents and documented packed command | PASS — final tarball exposed 14 scenarios and only the immutable template under certification docs | 2026-08-13 | Pi agent |

Synthetic lifecycle tests are not counted as physical lifecycle evidence.

## Real-device recurring gate

| Scenario | Outcome | Evidence |
| --- | --- | --- |
| actual Live level history and recognizable Bridge transcription | PASS | Human observed on byte-identical Recorder/native mechanism; phrase and transcript not retained |
| cancellation cleanup | PASS | Rerun from final tarball; zero audio |
| duration limit without transcription | PASS | Rerun from final tarball with real microphone input; zero audio |
| tunnel loss ≤15 s and authenticated recovery | PASS | Rerun by final certification driver; zero audio and authenticated recovery |
| second-client detail-free `busy` | PASS | Independently configured isolated client; Bridge/native mechanism byte-identical in final tarball |
| local Recorder levels, transcription, and cancellation | PASS | Human observed levels and recognizable text; cancellation inserted nothing; extension bytes identical in final tarball |

## Initial and mechanism-change gate

| Scenario | Outcome | Evidence |
| --- | --- | --- |
| physical sleep / logout / reboot / session lock | PASS | Prior exact-artifact physical results transferred because native, host, tunnel, and lifecycle-driver paths are unchanged; no synthetic substitution |
| companion stop / restart | PASS | Rerun from final tarball; distinct reasons, authenticated recovery, zero audio |
| physical default-input loss | PASS | Prior physical result transferred with byte-identical native input mechanism |
| credential revocation and rotation | PASS | Prior exact-artifact result transferred with byte-identical maintenance implementation |
| active-recording upgrade / uninstall | PASS | Prior exact-artifact result transferred with byte-identical maintenance implementation; preview and destructive confirmation were separate |
| fixed storage, connection, memory, and log bounds | PASS | Final automated gates plus byte-identical native mechanism |
| real SSH Unix / IPv4 loopback / IPv6 loopback | PASS | Unix health rerun; isolated real-SSH fallback results transferred with byte-identical host/tunnel implementation |

## Disposable clean-user actual-tarball gate

| Stage | Outcome | Verifier |
| --- | --- | --- |
| predecessor tarball install and real-audio preflight | WAIVED — not run in a new account | project-owner decision |
| host install and idempotent rerun | WAIVED — existing-account coverage only | project-owner decision |
| human and bounded JSON diagnosis | WAIVED — existing-account coverage only | project-owner decision |
| Bridge recording | WAIVED — existing-account coverage only | project-owner decision |
| candidate upgrade and credential rotation | WAIVED — existing-account coverage only | project-owner decision |
| bridge/package uninstall and pre-install-state restoration | WAIVED — isolated cleanup and valued-account restoration passed; new-account absence proof not run | project-owner decision |
| external-artifact digest preserved | WAIVED — not run | project-owner decision |

## Safe doctor JSON

The SSH alias and private paths were excluded from this bounded summary:

```json
{"schemaVersion":1,"companion":{"installation":"ready","permission":"authorized","launchAgent":"loaded","process":"running"},"host":{"lifecycle":"active","tunnelProcess":"running","listener":"established","authenticatedHealth":"ready","protocolCompatibility":"compatible","storage":{"incompleteAudio":0,"retainedWav":0},"levelAvailability":"available"}}
```

## Failure and rerun history

| Attempt | Scenario | Outcome | Cause/fix | Same tarball |
| --- | --- | --- | --- | --- |
| predecessor | TCP reconnect | FAIL | TCP endpoint incorrectly invoked Unix-listener cleanup; fixed at `be0aeff` | no |
| predecessor | release evidence review | FAIL | packaged records made final support docs change artifact bytes; interrupted recovery could emit PASS | no |
| 1 | final-tarball upgrade setup | RECOVERED EXTERNAL RACE | a transient owned host atomic temporary artifact made the first inspection refuse safely; durable upgrade state resumed after the write completed | yes |
| 2 | final-tarball upgrade and preflight | PASS | resumed owned transaction; real-audio preflight and all-host health passed | yes |
| 1 | final recurring and companion lifecycle subset | PASS | normal scenario completion; recovery cleanup path was not used as passing evidence | yes |

The first failure for each predecessor remains in its own record. Cleanup-only recovery now exits nonzero and requires a complete scenario rerun.

## Redaction and cleanup attestation

- [x] No audio or full transcript was retained.
- [x] No credential, lease capability, private path, raw recording identity, or complete SSH command was retained.
- [x] Final owner-scoped incomplete-audio and retained-WAV counts were zero.
- [x] Private certification recovery state was absent.
- [x] Isolated containers, temporary SSH aliases, credentials, probes, and test audio runtimes were removed.
- [x] The valued Linux Bridge configuration was restored and authenticated health was ready.
- [x] The verifier and UTC completion time are recorded above.
