# Pi Dictation roadmap

## 1. macOS support

macOS is the next platform target because Pi already runs there and its POSIX process model is close to the current Linux implementation.

- [x] Isolate platform-specific recorder selection behind one module interface.
- [ ] Introduce a process-owner module before adding Windows-specific lifecycle behavior.
- [x] Add automatic macOS recording through FFmpeg's AVFoundation audio device `:0`.
- [ ] Add microphone discovery and selection without requiring users to write recorder commands.
- [ ] Preserve PCM16 mono WAV output so the existing truthful live-level history keeps working.
- [x] Run lifecycle, cancellation, descendant-cleanup, and abrupt-Pi-exit tests on `macos-latest` CI.
- [x] Update the doctor for macOS and its FFmpeg dependency.
- [ ] Update the schema, example, and README support claim after live-device validation passes.

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

- [ ] Add a focused `/dictate-config` settings screen after the platform-specific recorder interface has settled, so the UI does not need to be redesigned for each operating system.
