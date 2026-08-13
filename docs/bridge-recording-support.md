# Bridge recording support and certification

## Supported scope

Pi Dictation `0.6.0` at commit `be0aeff` is certified on an Apple M1 Pro MacBook Pro (`MacBookPro18,3`) running macOS `26.5.1 (25F80)`, with a remote Arch Linux x86_64 Pi host and Unix-socket forwarding by default. The exact npm tarball SHA-256 is `f55e41b60532828ab0ad268f8915c0b92ddaecc3fffe02b6a1ac41b2d23ac504`. Real SSH `127.0.0.1` and `::1` forwarding are certified explicit fallbacks.

The project owner accepted one bounded release exception: the disposable clean-macOS-user gate was not run because creating another OS account solely for this initial release was disproportionate. Existing isolated-user install, real-audio preflight, Bridge recording, upgrade, rotation, scoped active-recording uninstall, cleanup, and restoration passed, but they do not prove pre-install absence in a new account or external-artifact preservation during complete uninstall. See the [passing record with accepted exception](./certification/bridge-recording-0.6.0-be0aeff.md). Passing source-checkout tests or synthetic native-companion tests alone remains insufficient. A newly released macOS major version remains unsupported until the required real-device matrix is rerun on that concrete version.

Unsupported environments include Intel Macs, native Windows, non-loopback TCP listeners, wildcard or LAN listeners, automatic TCP fallback, protocol/package version mismatches, and any macOS version absent from a passing certification record. Explicit `127.0.0.1` and `::1` forwarding are compatibility fallbacks, not the default, and both require their own real-SSH certification.

## Mac-originated setup and lifecycle

Run setup on the Mac that owns the microphone. Start with an existing SSH alias that succeeds non-interactively and preserves host-key verification:

```bash
pi-dictation bridge install
pi-dictation bridge preflight
pi-dictation bridge install my-pi
pi-dictation bridge status my-pi
```

The first command installs the native companion. Preflight is interactive and must observe real input rather than process success or digital silence. The host install defaults to a private Unix listener forwarded through the existing SSH alias; it never installs or upgrades the remote package.

Use `bridge list`, `doctor`, and `status` for diagnosis; `logs` for separately requested bounded redacted logs; `repair` for owned LaunchAgent/listener reconciliation; `rotate` and `revoke` for credentials; and `upgrade` or `uninstall` for lifecycle changes. Preview destructive operations before adding `--confirm`. Active recordings block rotation, upgrade, revocation, and uninstall unless the command explicitly supports and receives confirmed cancellation.

A TCP fallback must be exact and explicit:

```bash
pi-dictation bridge install my-pi --transport tcp --allow-loopback --bind 127.0.0.1:43123
pi-dictation bridge install my-pi --transport tcp --allow-loopback --bind '[::1]:43123'
```

Never broaden these binds. If Unix forwarding fails, confirm the remote OpenSSH server permits StreamLocal forwarding before choosing TCP.

## Recovery by typed failure

| Failure | Meaning | Recovery |
| --- | --- | --- |
| `recorder-busy` | Another credential owns the single active Recording lease. | Stop or cancel that recording; do not retry in a tight loop. |
| `recorder-storage-full` | The companion could not physically reserve the bounded maximum WAV. | Let retained results expire or acknowledge/cancel the owning lease, then free disk space and retry. |
| `cancellation-unconfirmed` | Cancellation was not authenticated within five seconds. | Do not transcribe local audio; restore the tunnel and use owner-authenticated status/cancellation before starting again. |
| `outcome-unknown` | The ten-minute reconciliation window ended without a terminal state. | Treat the recording as failed, run doctor, restore authenticated transport, and inspect owner-scoped effects; never reuse partial audio. |
| `duration-limit-reached` | The independent Mac or Pi duration limit finalized capture. | No transcription is allowed; cleanup is acknowledged automatically before another attempt. |
| `bridge-sleep`, `bridge-logout`, `bridge-reboot`, `bridge-session-lock` | The named host lifecycle event terminated capture. | Restore the user session, run doctor, and begin a new recording; interrupted capture never resumes. |
| `bridge-companion-stopped`, `bridge-companion-restarted` | The native capture owner terminated or restarted. | Run doctor/repair, repeat real-audio preflight after replacement, and begin a new recording. |
| `bridge-device-lost` | The selected default input disappeared or changed during capture. | Restore/select the default input, rerun preflight, and start a new recording. |
| `recording-failed` after authentication/version diagnosis | Capture, protocol, or validation failed safely. | Run `bridge doctor`; install the exact package/protocol version on both hosts and rerun preflight rather than bypassing validation. |

## Privacy, retention, credentials, and logs

Each configured host has an independent owner-only credential and Recording lease namespace. Credentials and lease capabilities are never printed by list, doctor, status, or certification evidence. Rotation verifies a staged credential before revoking the old one; revocation deletes only that credential's connections and owned audio.

Completed Bridge WAVs are retained only for authenticated recovery for at most ten minutes. Acknowledgement, cancellation, credential revocation, or expiry deletes audio; a minimal terminal tombstone remains for at most ten further minutes. Pi receives audio into private temporary storage, validates the declared length, SHA-256, and PCM16 mono WAV structure, and deletes it after transcription or failure.

Companion and tunnel logs contain bounded structured safe fields only, rotate across three one-MiB generations, and are never included automatically in doctor output. Certification records must not retain audio, full transcripts, secrets, private paths, raw recording identities, capabilities, or complete SSH commands.

## Release gate

Create the npm tarball once and record its SHA-256. Run the complete automated suite on Linux and Apple Silicon macOS, then run `pi-dictation-bridge-certify` from that exact tarball for:

- recognizable Bridge transcription with actual Live level history;
- cancellation deletion, duration-limit non-transcription, cross-host `busy`, and tunnel-loss termination within fifteen seconds followed by authenticated recovery;
- local Recorder parity;
- sleep, logout, reboot, session lock, companion stop/restart, and default-input loss;
- credential revocation, active-recording upgrade/uninstall, fixed resource limits, and real SSH Unix, IPv4-loopback, and IPv6-loopback forwarding;
- disposable clean-user install, real-audio preflight, idempotent rerun, human and JSON diagnosis, Bridge recording, upgrade, rotation, uninstall, and external-artifact preservation.

A failure blocks release. Preserve the first failure in the record, identify a code fix or external cause, and rerun the complete affected scenario against the byte-identical tarball; do not report only the successful retry. A deliberately omitted gate is not a pass: release requires an explicit project-owner exception, a bounded residual-risk statement, and an `accepted exception` outcome in the certification record.

Use [the certification record template](./certification/bridge-recording-template.md). Its bounded evidence is the auditable release decision; README claims must match the newest passing record exactly.

## Certification records

- [`0.6.0` at `2c7cafe`](./certification/bridge-recording-0.6.0-2c7cafe.md) — blocked before real-device scenarios because the companion socket was unavailable.
- [`0.6.0` at `d6012cf`](./certification/bridge-recording-0.6.0-d6012cf.md) — real microphone, levels, transcription, cleanup, and Unix reconnection passed after fixes, but split tarballs and incomplete lifecycle/clean-user/fallback scenarios block certification.
- [`0.6.0` at `be0aeff`](./certification/bridge-recording-0.6.0-be0aeff.md) — passing release decision for the exact tarball after automated, real-device, lifecycle, networking, maintenance, multi-client, and local Recorder gates, with an explicit project-owner exception for the disposable clean-user gate.
