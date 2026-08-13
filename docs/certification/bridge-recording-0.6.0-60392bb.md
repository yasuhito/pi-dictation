# Bridge recording certification: 0.6.0 candidate at 60392bb

## Release candidate

- Decision: **FAIL — release blocked**
- Package version: `0.6.0`
- Source commit: `60392bb`
- npm tarball SHA-256: `0cb69070ca5a42d3693c6339c4440dbbc9e0307dd99a489d63a4a587eed0867f`
- Candidate remained byte-identical across Mac and Linux: **yes**
- Platform: Apple Silicon, macOS `26.5.1 (25F80)`; remote Arch Linux x86_64
- Verifier: existing isolated Mac user, not a disposable clean user

## Exact-tarball outcomes

| Scenario | Outcome | Safe evidence |
| --- | --- | --- |
| actual-tarball real-audio preflight | PASS | Protocol v3, authorized permission, real input, authenticated health |
| physical logout | **FAIL** | Cleanup-race fix retained private recovery state as intended, but post-login verification observed `companion-stop`, not `logout`. The LaunchAgent again remained at `xpcproxy` without a companion socket. |

Owner-scoped cleanup proved zero incomplete or retained audio before private certification recovery state was removed. No audio, full transcript, secret, private path, recording identity, or complete SSH command is retained.

## Failure analysis

The preparing process no longer cancelled during teardown, so the prior certification-process race was fixed. Two independent production problems remained:

1. The production companion did not receive an authoritative logout event before launchd termination, leaving the `SIGTERM` fallback to record `companion-stop`.
2. A LaunchAgent targeting the app-bundle executable directly remained in `xpcproxy` after GUI login. An isolated fixed-argument `/bin/sh -c 'exec "$1"'` launch of the same executable immediately reached launchd `running` state and created the private companion socket; the certification CLI correctly rejected the modified unmanaged plist until this mechanism is represented by packed code.

The successor adds bounded workspace power-off/SIGTERM attribution grace and the fixed-argument supervised launch vector. Physical logout must be rerun against that exact tarball; no success is inferred here.

## Still incomplete

Physical logout and reboot, input-device loss, second independently configured client, clean disposable user, IPv4/IPv6 loopback fallback, credential rotation, active-recording upgrade/uninstall, local Recorder guided certification, and final restoration remain incomplete. Release remains blocked.
