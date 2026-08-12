# Pi Dictation

[![CI](https://github.com/yasuhito/pi-dictation/actions/workflows/ci.yml/badge.svg)](https://github.com/yasuhito/pi-dictation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-dictation.svg)](https://www.npmjs.com/package/pi-dictation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Push-to-talk dictation for [Pi](https://github.com/badlogic/pi-mono). Press a shortcut, speak, press it again, and the transcription is pasted into Pi's editor.

Pi Dictation supports OpenAI audio transcription and arbitrary local transcription commands. Recorder and transcriber processes are isolated, bounded, and cleaned up on cancellation or session shutdown.

![Pi Dictation demo](https://raw.githubusercontent.com/yasuhito/pi-dictation/main/assets/pi-dictation-demo.gif)

## Requirements

- Linux or macOS with `/bin/sh` and POSIX process-group support
- Pi
- Node.js 22.19 or newer
- One recorder:
  - Linux: `pw-record` on PipeWire systems or `arecord` on ALSA systems
  - macOS: FFmpeg with AVFoundation (`brew install ffmpeg`)
- One transcription backend:
  - an OpenAI API key, or
  - a local command such as `whisper-cli`

On macOS, Pi Dictation records from the system-default audio input and macOS may ask the terminal running Pi for microphone permission. Native Windows support remains on the [roadmap](./TODO.md) until its process-lifecycle safety design is validated.

## Install

From npm:

```bash
pi install npm:pi-dictation
```

From GitHub:

```bash
pi install git:github.com/yasuhito/pi-dictation
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-dictation
```

Restart Pi or run `/reload` after installation.

## Use

Press `Insert` to begin recording. Press it again to stop and transcribe. Mac keyboards commonly lack an Insert key, so macOS users should configure a shortcut such as `f8` and use `fn+F8` when the function-key row controls media features.

While recording, a one-line Dictation strip appears above the editor with a blinking recording marker, recent live microphone levels, and elapsed time. The same strip shows processing, transcription, completion, cancellation, and failure states, then hides automatically. Live levels are available for PCM16 mono WAV recorder output, including custom recorder commands that produce that format. Incomplete or unsupported output uses a flat silent line rather than simulated activity.

Commands:

- `/dictate` — start or stop dictation
- `/dictate-cancel` — cancel recording or transcription
- `/dictate-config` — edit safe settings interactively and inspect privacy-safe recorder/backend status
- `/dictate-help` — show whether recorder selection is automatic or custom, plus the transcription backend

## Diagnose setup

Run the privacy-safe doctor when recording or transcription is not working:

```bash
npx -p pi-dictation pi-dictation-doctor
```

From a source checkout:

```bash
npm run doctor
```

The doctor checks Node.js, Pi, Linux or macOS support, configuration validity, recorder availability, the requested and effective transcription backend, and whether an OpenAI credential source is configured. It does not execute API-key commands or print custom commands or secret values.

## Configure OpenAI transcription

The simplest option is `OPENAI_API_KEY`:

```bash
export OPENAI_API_KEY=...
```

To avoid storing the key in shell configuration, save it in the system keyring.

Linux with Secret Service:

```bash
secret-tool store --label="Pi Dictation OpenAI key" service openai account pi-dictation
```

```json
{
  "$schema": "https://raw.githubusercontent.com/yasuhito/pi-dictation/main/pi-dictation.schema.json",
  "language": "ja",
  "openaiModel": "gpt-4o-mini-transcribe",
  "openaiApiKeyCommand": "secret-tool lookup service openai account pi-dictation"
}
```

macOS Keychain (the command prompts for the key without placing it in shell history):

```bash
security add-generic-password -a "$USER" -s pi-dictation-openai -U -w
```

```json
{
  "$schema": "https://raw.githubusercontent.com/yasuhito/pi-dictation/main/pi-dictation.schema.json",
  "shortcut": "f8",
  "language": "ja",
  "openaiModel": "gpt-4o-mini-transcribe",
  "openaiApiKeyCommand": "security find-generic-password -a \"$USER\" -s pi-dictation-openai -w"
}
```

Audio is sent to the configured OpenAI-compatible endpoint when this backend is used.

## Configure a local transcription command

Commands receive the WAV path through `{file}`:

```json
{
  "$schema": "https://raw.githubusercontent.com/yasuhito/pi-dictation/main/pi-dictation.schema.json",
  "language": "ja",
  "transcribeCommand": "whisper-cli -m ~/models/ggml-small.bin -f {file} -l ja -otxt -of -"
}
```

The command must write only the transcription to standard output.

## Configuration

Configuration lives at `~/.pi/agent/pi-dictation.json`. Run `/dictate-config` to edit the shortcut, language, OpenAI model, duration limits, and spinner through Pi's TUI. The settings screen never displays API keys or custom command contents, preserves fields it does not edit, identifies environment overrides, and saves atomically with `0600` permissions. Shortcut changes require `/reload` or a restart; other saved changes apply to the next recording.

You can also start from [`pi-dictation.example.json`](./pi-dictation.example.json); editors that support JSON Schema can use its `$schema` field for completion and validation. Unknown fields and invalid values are rejected before external work starts.

| Field | Default | Purpose |
| --- | --- | --- |
| `shortcut` | `insert` | Pi shortcut used to toggle dictation |
| `language` | unset | Language passed to the OpenAI backend |
| `recorder` | `{ "type": "local" }` | Discriminated local or Bridge Recorder configuration; local `command` is optional and uses `{file}` as the private staging WAV path |
| `transcribeCommand` | unset | Local transcription command |
| `openaiModel` | `gpt-4o-mini-transcribe` | OpenAI-compatible transcription model |
| `openaiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `openaiApiKey` | unset | API key; prefer an environment variable or keyring command |
| `openaiApiKeyCommand` | unset | Command that prints the API key |
| `timeoutMs` | `120000` | Transcription timeout; accepts `1000`–`3600000` ms |
| `maxRecordingMs` | `600000` | Graceful-stop threshold from `1000`–`3600000` ms, including after an abrupt Pi exit; stubborn processes are force-killed within 5 more seconds |
| `spinner` | `arc` | `cli-spinners` animation name |

Recorder configuration has no environment override. The remaining runtime settings can also be set with environment variables:

- `PI_DICTATION_SHORTCUT`
- `PI_DICTATION_LANGUAGE`
- `PI_DICTATION_TRANSCRIBE_CMD`
- `PI_DICTATION_OPENAI_MODEL`
- `PI_DICTATION_OPENAI_BASE_URL`
- `PI_DICTATION_OPENAI_API_KEY`
- `PI_DICTATION_OPENAI_API_KEY_COMMAND`
- `PI_DICTATION_TIMEOUT_MS`
- `PI_DICTATION_MAX_RECORDING_MS`
- `PI_DICTATION_SPINNER`

Environment variables take precedence over the configuration file. The package-specific `PI_DICTATION_OPENAI_API_KEY` takes precedence over `OPENAI_API_KEY` when both are set.

## Install an SSH bridge

> **Support status:** Bridge recording is not yet certified for a supported release. No macOS version or Mac model should be described as supported until one unchanged npm tarball has a passing [Bridge certification record](./docs/bridge-recording-support.md); source and synthetic test success alone are insufficient. Intel Macs, native Windows, non-loopback listeners, automatic TCP fallback, package/protocol mismatches, and macOS versions absent from a passing record are unsupported.

Run setup on the Mac that owns the microphone. Install and preflight the native companion interactively before installing a host Bridge with the SSH alias already used for the Pi host:

```bash
pi-dictation bridge install
pi-dictation bridge preflight
```

```bash
pi-dictation bridge install my-pi
pi-dictation bridge status my-pi
```

Installation requires successful non-interactive SSH `BatchMode` authentication and an exact Pi Dictation package/protocol match on the remote host. It reuses the alias's host-key and routing configuration, creates a private per-host Unix listener by default, and reports tunnel process, listener establishment, and authenticated companion health independently. Repeat the command for additional aliases; each gets an independent credential, tunnel LaunchAgent, listener, Recorder configuration, and health state while sharing the same Mac companion.

Manage configured bridges without exposing secrets, private paths, SSH commands, or Recording lease identities:

```bash
pi-dictation bridge list
pi-dictation bridge list --json
pi-dictation bridge rotate my-pi
pi-dictation bridge revoke my-pi
pi-dictation bridge revoke my-pi --confirm
```

Rotation stages a new owner-only credential on both hosts, verifies authenticated health through it, and only then revokes the old credential. It refuses to disrupt an unfinished Recording lease or retained WAV and preserves staged state for a safe retry. Revocation previews the target credential's live connections, active lease, incomplete audio, and retained WAV deletion counts unless `--confirm` is supplied; confirmation closes and deletes only that credential's bridge state.

Diagnose and maintain the complete bridge stack from the Mac:

```bash
pi-dictation bridge doctor
pi-dictation bridge doctor --json
pi-dictation bridge logs                 # companion log
pi-dictation bridge logs my-pi           # one tunnel log
pi-dictation bridge repair my-pi          # preview
pi-dictation bridge repair my-pi --confirm
pi-dictation bridge upgrade
pi-dictation bridge uninstall my-pi       # preview
pi-dictation bridge uninstall my-pi --confirm
pi-dictation bridge uninstall --all --delete-retained-wav --delete-credentials --confirm
```

Doctor and list are the only stable JSON interfaces. Doctor is read-only: it does not open the microphone, reload a LaunchAgent, remove a listener, execute a credential command, or repair anything. Logs are requested separately and expose only bounded structured safe fields from three one-MiB rotating generations. Repair previews the exact owned LaunchAgent/listener reconciliation and never changes credentials, permission, or audio.

Upgrade verifies non-interactive reachability, the package/protocol transition, and authenticated effects for every registered destination before stopping the shared companion. An active recording blocks it unless the named bridges are explicitly cancelled with `--cancel-active --confirm`; successful replacement clears readiness and requires a fresh interactive real-audio preflight followed by doctor confirmation of all-host health.

Scoped uninstall revokes and removes only the selected host's tunnel, listener, credential, and Recorder configuration. The last-host or `--all` path additionally requires separate retained-WAV and credential-deletion flags before the shared companion is removed. Active recording deletion requires `--cancel-active`. Every maintenance command refuses symlinks, unexpected types, unsafe ownership or permissions, and unprovable artifacts. macOS microphone permission history can remain after complete uninstall and may be removed manually in Privacy & Security.

A TCP listener is never selected automatically. If the SSH server cannot forward Unix sockets, explicitly opt in to one exact loopback bind:

```bash
pi-dictation bridge install my-pi --transport tcp --allow-loopback --bind 127.0.0.1:43123
# or: --bind '[::1]:43123'
```

Wildcard and non-loopback binds are refused. The installer does not install or update packages remotely; an incompatible remote package produces the exact `npm install` command needed before rerunning the same install.

See [Bridge recording support and certification](./docs/bridge-recording-support.md) for the exact support boundary, typed-error recovery, credential and log handling, retention/deletion rules, complete certification matrix, and redacted evidence policy.

### Bridge smoke test

1. On the Mac, confirm `pi-dictation bridge status my-pi` reports the tunnel, listener, and authenticated health as ready.
2. In an interactive Pi session on `my-pi`, run `/dictate`, speak a recognizable phrase into the Mac microphone, then run `/dictate` again.
3. Confirm the phrase is inserted into Pi. A successful stop means Pi authenticated the companion, bounded and verified the complete WAV, transcribed it on the Pi host, acknowledged Mac cleanup, and removed its own temporary audio.

### Real-device certification

The npm package includes a self-contained certification command; it does not depend on repository test fixtures. List the deterministic guided and lifecycle scenarios from the exact packed candidate:

```bash
pi-dictation-bridge-certify list
```

Run a guided recurring-gate scenario with its configured SSH alias, follow only the displayed microphone or Pi UI actions, and confirm the result:

```bash
pi-dictation-bridge-certify prepare bridge-level-transcription my-pi
pi-dictation-bridge-certify verify --confirm
```

The gate covers Bridge levels and recognizable transcription, automated cancellation cleanup, an automated native duration limit that has no transcription interface, automated cross-host single-lease exclusion, staged tunnel-loss termination and authenticated reconnect, and the local Recorder contract. Tunnel fault injection owns its Recording lease, measures the fifteen-second bound from the fault, and runs authenticated remote health after restarting the exact tunnel LaunchAgent. Only microphone speech and observations in Pi's UI are manual; the command performs protocol, cleanup, duration, arbitration, and owned LaunchAgent fault steps itself. Lifecycle preparations cover sleep, logout, reboot, session lock, companion stop or restart, and default-input loss. Preparations that survive logout or reboot keep a private recovery capability only until `verify`; every control connection has a five-second deadline, and successful verification checks owner-scoped retained-audio counts, removes recovery state, and prints bounded JSON evidence containing neither credentials, capabilities, audio, transcripts, private paths, nor recording identities.

From a disposable clean macOS user, the staged actual-tarball gate installs the predecessor, verifies its real-audio preflight and Bridge recording, then installs the byte-identical candidate on both Mac and remote Pi. It upgrades the companion, requires a second candidate preflight and candidate Bridge recording, rotates credentials, previews the exact uninstall effects, requires a separate deletion confirmation, uninstalls the package, proves Bridge state returned to its pre-install absence, and verifies a pre-existing external artifact stayed byte-identical.

Start the gate once:

```bash
npx --yes --package /absolute/path/pi-dictation-CANDIDATE.tgz pi-dictation-bridge-certify prepare clean-user-tarball /absolute/path/pi-dictation-CANDIDATE.tgz /absolute/path/pi-dictation-PREDECESSOR.tgz my-pi /absolute/path/external-artifact
```

Run the following only when each displayed human step has succeeded. The command prints the next required observation before returning:

```bash
npx --yes --package /absolute/path/pi-dictation-CANDIDATE.tgz pi-dictation-bridge-certify advance --confirm  # predecessor preflight
npx --yes --package /absolute/path/pi-dictation-CANDIDATE.tgz pi-dictation-bridge-certify advance --confirm  # predecessor recording
npx --yes --package /absolute/path/pi-dictation-CANDIDATE.tgz pi-dictation-bridge-certify advance --confirm  # candidate preflight
npx --yes --package /absolute/path/pi-dictation-CANDIDATE.tgz pi-dictation-bridge-certify advance --confirm  # candidate recording; prints uninstall preview
npx --yes --package /absolute/path/pi-dictation-CANDIDATE.tgz pi-dictation-bridge-certify advance --confirm  # separately confirm reviewed deletion
```

If candidate upgrade or uninstall is interrupted, rerun the same `advance --confirm` command; private recovery state resumes the committed transition. `verify` intentionally cannot skip clean-user stages.

## Safety

Pi Dictation:

- prevents shortcut races from starting multiple recorders;
- terminates entire recorder and transcriber process groups;
- uses an independent process-group watchdog to stop recordings after 10 minutes by default, even if Pi is killed, then force-kills stubborn processes within 5 more seconds;
- bounds subprocess output retained in memory;
- aborts transcription on cancellation and session shutdown;
- creates recordings in private (`0700`) temporary directories;
- commits only validated PCM16 mono WAV output for transcription;
- recovers owner-authenticated completed Bridge WAVs across transport loss or companion restart for at most ten minutes;
- deletes Bridge audio on acknowledgement, cancellation, or expiry and removes its minimal retry tombstone ten minutes later;
- removes temporary recordings after normal use, cancellation, failure, and graceful shutdown.

An uncatchable Pi crash (for example, `SIGKILL`) can leave the private recording directory behind for the operating system's temporary-file cleanup.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT
