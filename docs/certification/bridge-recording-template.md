# Bridge recording certification: VERSION

## Release candidate

- Decision: `PASS | FAIL`
- Package version: `VERSION`
- Commit: `FULL_SHA`
- Tarball SHA-256: `SHA256`
- Candidate remained byte-identical on rerun: `yes | no | not rerun`

## Certified platform

- Apple Silicon model: `MODEL`
- macOS: `PRODUCT_VERSION (BUILD)`
- Remote Linux: `DISTRIBUTION VERSION, ARCHITECTURE`
- Node.js / npm: `VERSIONS`
- OpenSSH client / server: `VERSIONS`
- Xcode / Swift: `VERSIONS`
- Default transport: `Unix socket forwarding`
- Explicit fallbacks tested: `127.0.0.1 | ::1 | both | none`

## Automated gates

Record the command, outcome, timestamp, and verifier for each gate. Keep output outside the repository if it contains private paths; retain only bounded safe summaries here.

| Gate | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| assertion shape, typecheck, extension/Recorder/protocol/model/Level/UI/filesystem/resource/package tests | `PASS | FAIL` | `TIME` | `NAME` |
| native companion build and integration | `PASS | FAIL` | `TIME` | `NAME` |
| native adversarial protocol | `PASS | FAIL` | `TIME` | `NAME` |
| isolated native lifecycle and retained-audio audit | `PASS | FAIL` | `TIME` | `NAME` |
| package contents and documented tarball commands | `PASS | FAIL` | `TIME` | `NAME` |

## Real-device recurring gate

| Scenario | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| actual Live level history and recognizable Bridge transcription | `PASS | FAIL` | `TIME` | `NAME` |
| cancellation cleanup | `PASS | FAIL` | `TIME` | `NAME` |
| duration limit without transcription | `PASS | FAIL` | `TIME` | `NAME` |
| tunnel loss ≤15 s and authenticated recovery | `PASS | FAIL` | `TIME` | `NAME` |
| second-client detail-free `busy` | `PASS | FAIL` | `TIME` | `NAME` |
| local Recorder levels, transcription, and cancellation | `PASS | FAIL` | `TIME` | `NAME` |

## Initial and mechanism-change gate

| Scenario | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| sleep / logout / reboot / session lock | `PASS | FAIL` | `TIME` | `NAME` |
| companion stop / restart / default-input loss | `PASS | FAIL` | `TIME` | `NAME` |
| credential revocation | `PASS | FAIL` | `TIME` | `NAME` |
| active-recording upgrade / uninstall | `PASS | FAIL` | `TIME` | `NAME` |
| fixed storage, connection, memory, and log bounds | `PASS | FAIL` | `TIME` | `NAME` |
| real SSH Unix / IPv4 loopback / IPv6 loopback | `PASS | FAIL` | `TIME` | `NAME` |

## Disposable clean-user actual-tarball gate

| Stage | Outcome | Time (UTC) | Verifier |
| --- | --- | --- | --- |
| predecessor tarball install and real-audio preflight | `PASS | FAIL` | `TIME` | `NAME` |
| host install and idempotent rerun | `PASS | FAIL` | `TIME` | `NAME` |
| human and bounded JSON diagnosis | `PASS | FAIL` | `TIME` | `NAME` |
| Bridge recording | `PASS | FAIL` | `TIME` | `NAME` |
| candidate upgrade and credential rotation | `PASS | FAIL` | `TIME` | `NAME` |
| bridge/package uninstall and pre-install-state restoration | `PASS | FAIL` | `TIME` | `NAME` |
| external-artifact digest preserved | `PASS | FAIL` | `TIME` | `NAME` |

## Safe doctor JSON

Include the bounded JSON object emitted by `pi-dictation bridge doctor --json` only after manually confirming it contains no secret, capability, private path, recording identity, audio, transcript, or complete SSH command.

```json
{}
```

## Failure and rerun history

Preserve the first failure. For every rerun, state whether the cause was a code fix or external condition and prove the candidate tarball SHA-256 was unchanged. A changed tarball is a new release candidate and starts a new record.

| Attempt | Scenario | Outcome | Cause/fix | Same tarball |
| --- | --- | --- | --- | --- |
| 1 | `SCENARIO` | `PASS | FAIL` | `DETAIL` | `yes | no` |

## Redaction and cleanup attestation

- [ ] No audio or full transcript was retained.
- [ ] No credential, lease capability, private path, raw recording identity, or complete SSH command was retained.
- [ ] Owner-scoped active, incomplete-audio, and retained-WAV counts were zero after every scenario.
- [ ] Private certification recovery state was removed.
- [ ] The verifier and UTC completion time are recorded above.
