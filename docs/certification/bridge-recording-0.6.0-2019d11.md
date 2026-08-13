# Bridge recording certification: 0.6.0 candidate at 2019d11

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `2019d11`
- npm tarball SHA-256: `9f741a1d33745dcc411d72293c08b40f20e4bce53728b8c612fb5ebf3573a5f8`
- Candidate remained byte-identical across Mac and Linux: **yes**
- Platform: Apple Silicon, macOS `26.5.1 (25F80)`; remote Arch Linux x86_64
- Verifier: existing isolated Mac user, not a disposable clean user

## Exact-tarball outcomes

| Scenario | Outcome | Safe evidence |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | SSH PTY drove the interactive GUI preflight; permission authorized and real microphone audio observed |
| post-login LaunchAgent | PASS after bounded startup | Job initially reported `xpcproxy`, then reached `running` and created the private companion socket without reinstall or manual app launch |
| physical logout | **FAIL** | Post-login verification observed `session-lock`, not `logout` |

Owner-scoped cleanup proved zero incomplete or retained audio before private certification recovery state was removed. No audio, full transcript, secret, private path, recording identity, or complete SSH command is retained.

## Failure analysis

The fixed shell argument vector removed the persistent post-login launch stall. The apparent initial `xpcproxy` state was a bounded launch phase: unified diagnostics showed constraint evaluation and the exact job reached `running` after approximately fifteen seconds.

Logout still lost attribution to console lock. Unified diagnostics showed loginwindow publishing `com.apple.logoutContinued` after confirmation, followed by LaunchAgent termination; the existing fixed 500 ms console-lock timer committed `session-lock` before the delayed `SIGTERM` fallback exited. The successor records confirmed/cancelled loginwindow teardown and lets confirmed logout commit immediately when LaunchAgent termination arrives, before console-lock attribution. Physical logout must be rerun against that exact tarball; no success is inferred here.

## Still incomplete

Physical logout and reboot, input-device loss, second independently configured client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked.
