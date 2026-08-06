# Pi Dictation

Pi Dictation provides visible, cancellable push-to-talk recording and transcription inside Pi's interactive terminal UI.

## Language

**Live level history**:
A recent history of actual microphone amplitude, rendered as bottom-aligned bars that scroll from right to left while recording.
_Avoid_: Decorative waveform, symmetric waveform

**Dictation strip**:
The single-line dictation status shown from recording through transcription and completion; while recording it contains an on/off blinking recording marker, the live level history, and elapsed time.
_Avoid_: Footer status, recording badge

**Silent line**:
A flat visual baseline shown when microphone amplitude cannot be derived; it must not imply detected audio activity.
_Avoid_: Error message, decorative animation

**Level scale**:
A fixed logarithmic amplitude scale with a noise gate, preserving the distinction between silence, quiet speech, normal speech, and loud input.
_Avoid_: Automatic normalization

**Level observation**:
A time-positioned measurement of actual microphone amplitude. Digital silence, unavailable measurement, and a missing observation remain distinct even when the Dictation strip renders each as the Silent line.
_Avoid_: Waveform sample, activity estimate

**Bridge recording**:
A recording whose microphone is attached to a different host from the host running Pi.
_Avoid_: Remote input, remote microphone

**Recorder**:
The module that starts a recording and returns a common handle for stopping it successfully or cancelling it, regardless of where the microphone is attached.
_Avoid_: Recording command, capture service

**Recording lease**:
The exclusive, capability-owned right to control one active bridge recording. Only the client holding that recording's secret capability may stop, cancel, or retrieve it.
_Avoid_: Global recording session, active flag
