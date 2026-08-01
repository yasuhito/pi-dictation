# Pi Dictation roadmap

## 1. macOS support

macOS support is validated because Pi already runs there and its POSIX process model preserves the lifecycle guarantees established on Linux.

- [x] Isolate platform-specific recorder selection behind one module interface.
- [ ] Introduce a process-owner module before adding Windows-specific lifecycle behavior.
- [x] Add automatic macOS recording through FFmpeg's AVFoundation system-default audio input.
- [ ] Add microphone discovery and selection without requiring users to write recorder commands.
- [x] Preserve PCM16 mono WAV output so the existing truthful live-level history keeps working.
- [x] Run lifecycle, cancellation, descendant-cleanup, and abrupt-Pi-exit tests on `macos-latest` CI.
- [x] Update the doctor for macOS and its FFmpeg dependency.
- [x] Update the schema, example, and README support claim after live-device validation passes.

Validation on an Apple Silicon Mac confirmed that `:default` selects the macOS system input, the WAV grows incrementally as PCM16 mono at 16 kHz, spoken audio drives the truthful live-level history, the complete Pi recording lifecycle reaches `Dictation ready`, and the doctor is ready. The same lifecycle and package contracts pass on `macos-latest` CI.

## 2. Native Windows support

Pi supports native Windows when a bash shell is available; Git for Windows is sufficient for most users. See Pi's official [Windows setup documentation](https://pi.dev/docs/latest/windows).

Windows support requires a separate process-lifecycle design rather than pretending POSIX process groups work there.

- [ ] Prototype recording through FFmpeg's DirectShow input.
- [ ] Design a Windows process-tree owner and independent recording timeout.
- [ ] Verify cancellation and force-stop clean up recorder descendants.
- [ ] Verify the recording limit still works after Pi is terminated abruptly.
- [ ] Run the full contract suite on `windows-latest` with the same safety guarantees as Linux and macOS.
- [ ] Add microphone discovery and selection.
- [ ] Claim Windows support only after these checks pass.

## 3. WSL documentation

- [ ] Test WSL microphone access separately from native Windows.
- [ ] Document the supported audio path instead of assuming every WSL installation exposes a Linux recorder.

## Later

- [x] Add a focused `/dictate-config` settings screen for safe fields, privacy-safe status, environment-override visibility, and atomic private saves.
