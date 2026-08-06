# ADR: Ephemeral raw-transcript handoff for Think-aloud sessions

## Decision

Pi Dictation will provide a **Think-aloud session** as a separately configured keyboard shortcut. It is explicitly started and explicitly ended; silence never ends it.

During the session, a Realtime model is a restrained conversation partner: it primarily listens, may offer short acknowledgements, and asks only when it finds an important contradiction or an irreversible decision. The model does not produce an end-of-session summary or infer a record of decisions.

At explicit end, Pi Dictation inserts a **Conversation handoff** into Pi's editor. The handoff contains the complete, speaker-labelled transcript and fixed instructions that distinguish Yasuhito's statements from the Realtime model's proposals. Pi Dictation never submits that editor content; the user decides whether and how to send it to the Pi agent.

Conversation transcripts exist only in process memory. They are discarded after handoff, discard, cancellation, or session shutdown. Durable outputs belong to the Pi agent's subsequently reviewed work, such as an ADR or issue, rather than to Pi Dictation.

The Think-aloud session begins as a Realtime-only conversation. It does not receive Pi-agent context or automate issue creation, implementation, or agent handoff.

## Consequences

The user can speak freely without a hidden summarization step losing context or treating an AI proposal as a human decision. The Pi agent receives the original interaction and can reason about it using its own current repository context.

The feature needs bounded in-memory transcript handling and robust cancellation cleanup, but no transcript store, transcript permissions model, or history UI.

Speaker-based use is a product requirement. The audio-capture implementation is deliberately undecided until a small local proof establishes that an echo-cancelled microphone path prevents the model's playback from being treated as user speech. Headphones are not a v1 requirement.

## Alternatives considered

- **AI-generated summary and decision extraction:** rejected because it adds an opaque, lossy transformation and can misattribute the model's proposals to the user.
- **Persistent local conversation logs:** rejected because the useful durable output is the reviewed downstream ADR or issue, while storing raw conversation adds privacy and permission complexity.
- **Always-on voice companion:** deferred because it combines turn-taking, microphone lifecycle, cost, and Pi-agent coexistence before the focused session experience is proven.
- **Headphones-only v1:** rejected because speaker conversation is the intended everyday use case.
