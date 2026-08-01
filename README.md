# Pi Dictation

Push-to-talk dictation for [Pi](https://github.com/badlogic/pi-mono). Press a shortcut, speak, press it again, and the transcription is pasted into Pi's editor.

Pi Dictation supports OpenAI audio transcription and arbitrary local transcription commands. Recorder and transcriber processes are isolated, bounded, and cleaned up on cancellation or session shutdown.

## Requirements

- Linux with `/bin/sh` and POSIX process-group support
- Pi
- Node.js 22.19 or newer
- One recorder:
  - `pw-record` on PipeWire systems, or
  - `arecord` on ALSA systems
- One transcription backend:
  - an OpenAI API key, or
  - a local command such as `whisper-cli`

## Install

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

Press `Insert` to begin recording. Press it again to stop and transcribe.

While recording, a one-line Dictation strip appears below the editor with a blinking recording marker, recent live microphone levels, and elapsed time. The same strip shows processing, transcription, completion, cancellation, and failure states, then hides automatically. Live levels are available for PCM16 mono WAV recorder output, including custom recorder commands that produce that format. Incomplete or unsupported output uses a flat silent line rather than simulated activity.

Commands:

- `/dictate` — start or stop dictation
- `/dictate-cancel` — cancel recording or transcription
- `/dictate-help` — show whether recorder selection is automatic or custom, plus the transcription backend

## Configure OpenAI transcription

The simplest option is `OPENAI_API_KEY`:

```bash
export OPENAI_API_KEY=...
```

To avoid storing the key in shell configuration, save it in the system keyring:

```bash
secret-tool store --label="Pi Dictation OpenAI key" service openai account pi-dictation
```

Then create `~/.pi/agent/pi-dictation.json`:

```json
{
  "language": "ja",
  "openaiModel": "gpt-4o-mini-transcribe",
  "openaiApiKeyCommand": "secret-tool lookup service openai account pi-dictation"
}
```

Audio is sent to the configured OpenAI-compatible endpoint when this backend is used.

## Configure a local transcription command

Commands receive the WAV path through `{file}`:

```json
{
  "language": "ja",
  "transcribeCommand": "whisper-cli -m ~/models/ggml-small.bin -f {file} -l ja -otxt -of -"
}
```

The command must write only the transcription to standard output.

## Configuration

Configuration lives at `~/.pi/agent/pi-dictation.json`.

| Field | Default | Purpose |
| --- | --- | --- |
| `shortcut` | `insert` | Pi shortcut used to toggle dictation |
| `language` | unset | Language passed to the OpenAI backend |
| `recordCommand` | auto-detected | Recorder command; `{file}` is replaced with the WAV path |
| `transcribeCommand` | unset | Local transcription command |
| `openaiModel` | `gpt-4o-mini-transcribe` | OpenAI-compatible transcription model |
| `openaiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `openaiApiKey` | unset | API key; prefer an environment variable or keyring command |
| `openaiApiKeyCommand` | unset | Command that prints the API key |
| `timeoutMs` | `120000` | Transcription timeout |
| `maxRecordingMs` | `600000` | Graceful-stop threshold, including after an abrupt Pi exit; stubborn processes are force-killed within 5 more seconds |
| `spinner` | `arc` | `cli-spinners` animation name |

Every field can also be set with an environment variable:

- `PI_DICTATION_SHORTCUT`
- `PI_DICTATION_LANGUAGE`
- `PI_DICTATION_RECORD_CMD`
- `PI_DICTATION_TRANSCRIBE_CMD`
- `PI_DICTATION_OPENAI_MODEL`
- `PI_DICTATION_OPENAI_BASE_URL`
- `PI_DICTATION_OPENAI_API_KEY`
- `PI_DICTATION_OPENAI_API_KEY_COMMAND`
- `PI_DICTATION_TIMEOUT_MS`
- `PI_DICTATION_MAX_RECORDING_MS`
- `PI_DICTATION_SPINNER`

Environment variables take precedence over the configuration file. The package-specific `PI_DICTATION_OPENAI_API_KEY` takes precedence over `OPENAI_API_KEY` when both are set.

## Safety

Pi Dictation:

- prevents shortcut races from starting multiple recorders;
- terminates entire recorder and transcriber process groups;
- uses an independent process-group watchdog to stop recordings after 10 minutes by default, even if Pi is killed, then force-kills stubborn processes within 5 more seconds;
- bounds subprocess output retained in memory;
- aborts transcription on cancellation and session shutdown;
- creates recordings in private (`0700`) temporary directories;
- removes temporary recordings after normal use, cancellation, and graceful shutdown.

An uncatchable Pi crash (for example, `SIGKILL`) can leave the private recording directory behind for the operating system's temporary-file cleanup.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT
