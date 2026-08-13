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

The candidate tarball was restored to `/tmp` after reboot and its SHA-256 was rechecked before verification. Reboot verification initially completed while authenticated health was still starting; the bounded follow-up reported protocol v3, authorized input, established listener, authenticated health, and zero audio. No audio, full transcript, secret, private path, recording identity, or complete SSH command is retained.

A later attempted companion-stop invocation was invalid evidence: the SSH harness itself timed out and terminated the waiting certification process before fault injection, producing `cancelled`. Its private state was removed only after zero-audio diagnosis. It is not counted as a candidate failure or pass and must be rerun with a detached harness.

## Still incomplete

Input-device loss, companion stop/restart rerun, duration limit, tunnel reconnect, recognizable transcription and Live level history, second independently configured client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked.
