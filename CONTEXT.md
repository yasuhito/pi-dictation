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
