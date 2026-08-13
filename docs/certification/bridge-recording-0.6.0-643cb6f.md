# Bridge recording certification: 0.6.0 candidate at 643cb6f

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `643cb6f`
- npm tarball SHA-256: `c707029db94ffe9adca4cd9e06e6f96b8a095e5790a1a84d0b2ad7e82b069571`
- Candidate remained byte-identical across Mac and Linux: **yes**
- Platform: Apple Silicon, macOS `26.5.1 (25F80)`; remote Arch Linux x86_64
- Verifier: existing isolated Mac user, not a disposable clean user

## Exact-tarball outcomes

| Scenario | Outcome | Safe evidence |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | Protocol v3, authorized permission, real input, authenticated health |
| physical sleep | PASS | Distinct `sleep`; no retained audio or secret |
| physical session lock | PASS | Distinct `session-lock`; no retained audio or secret |
| physical logout | **FAIL** | Preparing process attempted inline cleanup during session teardown and produced `cancelled` before native `logout` attribution. After login the LaunchAgent remained in `xpcproxy` without a companion socket until idempotent install plus interactive preflight restored service. |

Final owner-scoped incomplete-audio and retained-WAV counts were zero. Private certification recovery state from the failed logout attempt was removed after owner-scoped cleanup. No audio, full transcript, secret, private path, recording identity, or complete SSH command is retained.

## Failure analysis

The logout/reboot lifecycle command waited inline and treated teardown transport loss like an ordinary recoverable failure. Its catch path could therefore cancel the Recording lease while logout attribution was still in progress. The follow-up fix keeps owner-liveness proof active while waiting, but never performs inline cancellation after transport loss for logout or reboot; post-login `verify` exclusively checks reason and cleanup.

The post-login `xpcproxy` stall remains physical failure evidence for this candidate. Idempotent reinstall and real-audio preflight restored authenticated health. The next unchanged candidate must rerun logout to determine whether the clean staged teardown also avoids this startup condition; no success is inferred here.

## Still incomplete

Physical logout and reboot, input-device loss, second independently configured client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked.
