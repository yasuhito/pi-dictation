# Pi Dictation

[日本語](./README.ja.md)

[![CI](https://github.com/yasuhito/pi-dictation/actions/workflows/ci.yml/badge.svg)](https://github.com/yasuhito/pi-dictation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-dictation.svg)](https://www.npmjs.com/package/pi-dictation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Push-to-talk dictation for [Pi](https://github.com/badlogic/pi-mono). Press a shortcut, speak, press it again, and the transcription is pasted into Pi's editor.

Pi Dictation supports OpenAI audio transcription and arbitrary local transcription commands. Failed or cancelled work does not leave background commands running or consuming resources indefinitely: recording and transcription run in separate, bounded process groups that are terminated on cancellation or session shutdown.

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

## Install and set up

1. Install one of the recorder commands listed in [Requirements](#requirements).
2. Install Pi Dictation from npm:

   ```bash
   pi install npm:pi-dictation
   ```

3. Configure a transcription backend. For OpenAI, set the API key before starting Pi:

   ```bash
   export OPENAI_API_KEY=...
   ```

   To retrieve the key from a credential manager instead, see [Configure OpenAI transcription](#configure-openai-transcription). To keep audio on your machine, see [Configure a local transcription command](#configure-a-local-transcription-command).

4. Restart Pi or run `/reload`.
5. Run `/dictate-config` to review the Recorder and settings. On macOS, change the shortcut to `f8` because Mac keyboards commonly lack an Insert key, then run `/reload` again.

## Use

Press the configured shortcut (`Insert` by default) to begin recording. Press it again to stop and transcribe. If the macOS function-key row controls media features, use `fn+F8` for an `f8` shortcut.

While recording, a one-line Dictation strip appears above the editor with a blinking recording marker, recent live microphone levels, and elapsed time. The same strip shows processing, transcription, completion, cancellation, and failure states, then hides automatically. Live levels are available for PCM16 mono WAV recorder output, including custom recorder commands that produce that format. Incomplete or unsupported output uses a flat silent line rather than simulated activity.

Commands:

- `/dictate` — start or stop dictation
- `/dictate-cancel` — cancel recording or transcription
- `/dictate-config` — switch non-destructively between Local recording and a configured Bridge recording, edit safe settings, and inspect privacy-safe availability/backend status
- `/dictate-help` — show the current Recorder selection and transcription backend

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

Pi Dictation's transcription credential is separate from Pi's model-provider login. Running `/login` or having an OpenAI or ChatGPT model available does not configure audio transcription. Set `OPENAI_API_KEY`, `PI_DICTATION_OPENAI_API_KEY`, or `openaiApiKeyCommand` before using this backend.

For stronger protection at rest, `openaiApiKeyCommand` can retrieve the key from a credential manager. Any trusted, non-interactive command that writes only the key to standard output can be used.

Linux desktop with `secret-tool` and a running, unlocked Secret Service keyring:

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

Secret Service is often unavailable on headless or SSH-only Linux hosts. Use an injected environment variable or another non-interactive credential-manager command in those environments.

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

Configuration lives at `~/.pi/agent/pi-dictation.json`. Run `/dictate-config` to choose the Local Recorder or one configured Bridge Recorder and to edit the shortcut, language, OpenAI model, duration limits, and spinner through Pi's TUI. Recorder selection is non-destructive: both profiles remain configured, no automatic fallback occurs, and Bridge installation or removal remains the responsibility of `pi-dictation bridge`. The settings screen never displays API keys, Bridge connection details, or custom command contents; it preserves fields it does not edit, identifies environment overrides, and saves atomically with `0600` permissions. Shortcut changes require `/reload` or a restart; other saved changes apply to the next recording.

You can also start from [`pi-dictation.example.json`](./pi-dictation.example.json); editors that support JSON Schema can use its `$schema` field for completion and validation. Unknown fields and invalid values are rejected before external work starts.

| Field | Default | Purpose |
| --- | --- | --- |
| `shortcut` | `insert` | Pi shortcut used to toggle dictation |
| `language` | unset | Language passed to the OpenAI backend |
| `recorders` | `{ "selected": "local" }` | Persisted Recorder selection plus optional `local` and installer-managed `bridge` profiles; local `command` is optional and uses `{file}` as the private staging WAV path |
| `recorder` | unset | Legacy single-Recorder configuration, migrated when `/dictate-config` next saves settings |
| `transcribeCommand` | unset | Local transcription command |
| `openaiModel` | `gpt-4o-mini-transcribe` | OpenAI-compatible transcription model |
| `openaiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `openaiApiKey` | unset | API key stored as plaintext in the private configuration file; prefer an environment variable or credential-manager command |
| `openaiApiKeyCommand` | unset | Command that prints the API key |
| `timeoutMs` | `120000` | Transcription timeout; accepts `1000`–`3600000` ms |
| `maxRecordingMs` | `600000` | Graceful-stop threshold from `1000`–`3600000` ms, including after an abrupt Pi exit; stubborn processes are force-killed within 5 more seconds |
| `spinner` | `arc` | `cli-spinners` animation name |

Recorder selection and profiles have no environment override. The remaining runtime settings can also be set with environment variables:

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

## Use an SSH bridge

An SSH bridge lets Pi use a microphone attached to a different Mac. For example, Pi can run on a remote Linux host while recording from the Mac in front of you.

> **Support status:** Pi Dictation `0.6.0` is certified on an Apple M1 Pro MacBook Pro (`MacBookPro18,3`) running macOS `26.5.1 (25F80)`. Intel Macs, native Windows, non-loopback listeners, automatic TCP fallback, package/protocol mismatches, and macOS versions without a passing certification record are unsupported. See [Bridge recording support and certification](./docs/bridge-recording-support.md) for the complete support boundary and current release exception.

The Bridge CLI must be available in the shell on both the Mac and the Pi host. Install the same package version globally on both hosts:

```bash
npm install --global pi-dictation@0.6.0
```

On the Mac that owns the microphone, install and preflight the native companion. Then install a Bridge for the SSH alias you already use to reach the Pi host:

```bash
pi-dictation bridge install
pi-dictation bridge preflight
pi-dictation bridge install my-pi
pi-dictation bridge status my-pi
```

Bridge installation requires non-interactive SSH `BatchMode` authentication and matching Pi Dictation package and protocol versions on both hosts. It adds a Bridge Recorder profile but does not select it. In Pi on the remote host, run `/dictate-config` and select Bridge recording.

Useful maintenance commands:

```bash
pi-dictation bridge list
pi-dictation bridge doctor
pi-dictation bridge logs my-pi
pi-dictation bridge repair my-pi          # preview
pi-dictation bridge repair my-pi --confirm
pi-dictation bridge rotate my-pi
pi-dictation bridge revoke my-pi           # preview
pi-dictation bridge uninstall my-pi        # preview
```

`repair`, `revoke`, and `uninstall` preview their effects before requiring `--confirm`. `list` and `doctor` are the only stable JSON interfaces. For credential handling, recovery, TCP fallback, upgrades, uninstallation, retention, typed errors, and certification, see [Bridge recording support and certification](./docs/bridge-recording-support.md).

### Bridge smoke test

1. On the Mac, confirm `pi-dictation bridge status my-pi` reports the tunnel, listener, and authenticated health as ready.
2. In Pi on `my-pi`, run `/dictate-config`, choose Bridge recording, and save.
3. Run `/dictate`, speak a recognizable phrase into the Mac microphone, then run `/dictate` again.
4. Confirm the phrase is inserted into Pi.

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
