# Bridge recording certification: 0.6.0 candidate at fb6460e

## Release candidate

- Decision: **INCOMPLETE — release blocked**
- Package version: `0.6.0`
- Source commit: `fb6460e`
- npm tarball SHA-256: `6405a478631e1cfa627c3b5716197b06520ff2a00f63529bc978ed181e92af48`
- Candidate remained byte-identical across Mac and Linux: **yes**
- Platform: Apple Silicon, macOS `26.5.1 (25F80)`; remote Arch Linux x86_64
- Verifier: existing isolated Mac user, not a disposable clean user

## Exact-tarball outcomes

| Scenario | Outcome | Safe evidence |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | SSH PTY drove interactive GUI preflight; permission authorized and real microphone audio observed |
| physical reboot | PASS | Distinct `reboot`, no resumed lease, zero incomplete audio and retained WAVs, authenticated post-login health |
| Bridge cancellation | PASS | Owner cancellation left zero audio |
| companion stop | PASS | Distinct `companion-stop`, authenticated readiness restored, zero audio |
| companion restart | PASS | Distinct `companion-restart`, authenticated readiness restored, zero audio |
| duration limit | PASS | Independent limit terminated real microphone capture without transcription and left zero audio |
| tunnel reconnect | PASS | Owner-liveness termination and authenticated reconnect completed with zero audio |
| physical input-device loss | PASS | Disconnecting the selected iPhone microphone produced distinct `device-loss`, no resume, and zero audio |
| recognizable transcription and Live level history | PASS | Human confirmed recognizable phrase insertion and changing levels on the fixed scale; zero audio remained |
| two-credential single lease arbitration | PASS with qualification | A second independent companion credential received detail-free `busy`; its remote endpoint setup did not complete, so this is not yet evidence for the required independently configured second client |

The candidate tarball was restored to `/tmp` after reboot and its SHA-256 was rechecked before verification. Reboot verification initially completed while authenticated health was still starting; the bounded follow-up reported protocol v3, authorized input, established listener, authenticated health, and zero audio. No audio, full transcript, secret, private path, recording identity, or complete SSH command is retained.

An initial companion-stop invocation was invalid evidence: the SSH harness itself timed out and terminated the waiting certification process before fault injection, producing `cancelled`. Its private state was removed only after zero-audio diagnosis. It is not counted; the detached rerun listed above is the valid result.

## Still incomplete

A fully configured second client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked.
