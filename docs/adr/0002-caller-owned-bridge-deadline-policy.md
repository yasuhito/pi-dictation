# Bridge deadline policy belongs to the caller, not to the Bridge protocol

The shared Bridge protocol module accepts three timing kinds (`absolute`, `phase`, `no-progress`) and the two production callers use different ones: the Bridge Recorder anchors one budget at the start of an operation and shares it across transport retries, while the Bridge management CLI re-anchors a fixed budget when each protocol phase begins. This looks like an unfinished consolidation, so it is recorded deliberately: what Pi Dictation promises is bounded at the level of a command or a Recorder operation, and how that bound is divided across connection, challenge, request, and response is caller policy. Recording control must fail fast because a slow `stop` is a broken dictation experience, whereas a management command run over a congested SSH tunnel should be allowed to finish, so the two callers legitimately want different failure behaviour from the same protocol.

## Consequences

- The Bridge protocol module never converts one timing kind into another and never supplies a default. A caller that crosses the seam states its own policy.
- Timing kinds are implementation vocabulary and are deliberately absent from `CONTEXT.md`. Only the user-facing promise is named there, as **Command bound**.
- The Command bound is a property, not a number: a management command returns in finite time and still reports every destination it was asked about when one destination is slow. Per-host and per-phase second values are internal and may change without breaking the promise.
- A future reader who unifies the three kinds to remove apparent duplication would change observable behaviour for one caller. Issues #41 and #43 both arose from that impression and were closed by this decision.
- This decision does not license every existing budget. Where a Recorder budget affects Recording lease reconciliation rather than only elapsed time, the version 3 Recording lease ADR governs; issue #44 tracks the one known case.
