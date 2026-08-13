# Bridge recording certification: 0.6.0 candidate at f95da1a

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `f95da1a`
- npm tarball SHA-256: `bf284eeb78b1c71c4ffd9d61dd0e7dd9d869c2777eb734d4d3468409a6fdde2c`
- Candidate remained byte-identical across Mac and Linux: **yes**
- Platform: Apple Silicon, macOS `26.5.1 (25F80)`; remote Arch Linux x86_64
- Verifier: existing isolated Mac user, not a disposable clean user

## Exact-tarball outcomes

| Scenario | Outcome | Safe evidence |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | SSH PTY drove interactive GUI preflight; permission authorized and real microphone audio observed |
| physical logout | PASS | Distinct `logout`, no resumed lease, zero incomplete audio and retained WAVs, authenticated post-login health |
| physical reboot | **FAIL** | The Mac boot session changed and the Bridge restarted, but post-login verification observed `logout`, not `reboot` |

Owner-scoped cleanup proved zero incomplete or retained audio before private certification recovery state was removed. The candidate tarball was restored to `/tmp` after reboot and its SHA-256 was rechecked before verification. No audio, full transcript, secret, private path, recording identity, or complete SSH command is retained.

## Failure analysis

macOS restart traverses loginwindow's confirmed logout sequence, so the pre-shutdown process correctly persisted `logout` but could not distinguish the subsequent kernel restart. The successor persists the validated `kern.bootsessionuuid` with each Recording lease. On startup, a changed boot session promotes interrupted or teardown-terminal work to `reboot` before owner status is served, while same-boot physical logout remains `logout`.

Physical reboot must be rerun against the successor exact tarball; no success is inferred here.

## Still incomplete

Physical reboot, input-device loss, second independently configured client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked.
