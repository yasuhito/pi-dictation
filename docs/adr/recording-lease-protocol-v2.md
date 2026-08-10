# ADR: Recording lease protocol version 2

## Decision

Bridge protocol version 2 makes each Bridge recording a capability-owned **Recording lease**. Pi generates a UUID recording identity and a cryptographically random 32-byte lease secret before `start`. The companion binds the lease to the authenticated client credential and retains only `SHA-256(lease secret)`.

Every request has an authenticated UUID request identity. The response HMAC covers the actual response status. Reusing a request identity with identical operation and payload is replay-safe; changing either returns `request-conflict` without applying an operation.

## Operations

- `start { recordingId, leaseSecret, maxDurationMs }`
- `status { recordingId, leaseSecret }`
- `levels { recordingId, leaseSecret, afterSequence }`
- `stop { recordingId, leaseSecret }`
- `fetch { recordingId, leaseSecret }`
- `cancel { recordingId, leaseSecret }`
- `acknowledge { recordingId, leaseSecret }`

Except for `start` and authenticated `health`, every operation requires both capability fields. Unknown identities, wrong secrets, and cross-owner requests all return the identical authenticated `not-found {}` response. `busy {}` never identifies the active owner or lease.

The statuses are `ok`, `busy`, `not-found`, `request-conflict`, `invalid-state`, and `failed`.

Connection establishment and the `start`, `status`, `cancel`, and `acknowledge` control operations each have a fixed five-second deadline. Finalization has a thirty-second deadline. A fetch has a resettable ten-second no-progress deadline, and recovery of a terminal result is bounded by a ten-minute overall window. After a timeout, disconnect, or lost response, Pi repeats the same idempotent operation with the same request identity and reconciles its effect through owner-authenticated `status`; a partial fetch is deleted and its retry begins at byte zero. Only exhausting the applicable reconciliation window without learning a terminal state produces `outcome-unknown`. Protocol, ownership, and validated terminal failures remain deterministic errors.

## States and disclosure

Owner-authenticated `status` returns `recordingId` and one of `recording`, `finalizing`, `result-ready`, `acknowledged`, `cancelled`, `expired`, or `failed`. Only `result-ready` adds `length`, `sha256`, and `completion`, where `completion` is `stopped` or `duration-limit`. `fetch` returns those result metadata followed by the WAV bytes; other operations do not transfer audio.

The active slot is occupied only by `recording` and `finalizing`. A completed result releases it after the WAV is safely finalized. Before accepting another start, the companion checks that storage can reserve that request's maximum result size. There is no wait queue.

## Transition table

`ok` includes an idempotent replay of the already-reached state.

| Current state | status | levels | stop | fetch | cancel | acknowledge |
|---|---|---|---|---|---|---|
| recording | ok | ok | result-ready | invalid-state | cancelled | invalid-state |
| finalizing | ok | invalid-state | invalid-state | invalid-state | cancelled | invalid-state |
| result-ready | ok | invalid-state | ok | ok | cancelled | acknowledged |
| acknowledged | ok | invalid-state | invalid-state | invalid-state | invalid-state | ok |
| cancelled | ok | invalid-state | invalid-state | invalid-state | ok | invalid-state |
| expired | ok | invalid-state | invalid-state | invalid-state | invalid-state | invalid-state |
| failed | ok | invalid-state | invalid-state | invalid-state | invalid-state | invalid-state |

A duration limit follows the same recording → finalizing → result-ready path as `stop`, with `completion: duration-limit`. Pi may fetch, validate, and acknowledge that result for cleanup, but must never commit or transcribe it. The companion and Pi independently enforce the same configured deadline. An unacknowledged result is retained for at most ten minutes from completion, including across companion restart. Result retention expiry removes audio and produces an `expired` tombstone. Acknowledgement and cancellation also remove audio; finalization failure removes incomplete audio and produces `failed`. These four minimal terminal tombstones retain only identity, owner, lease hash, state, and transition time for a further ten minutes, then become `not-found` even to the former owner.

Cancellation is serialized with acknowledgement by the companion lock: whichever authenticated operation is accepted first determines the terminal state. Pi records cancellation intent synchronously before opening its separate cancel connection and must not begin acknowledgement after that intent. It aborts finalization polling and transfer immediately. If authenticated cancellation cannot be confirmed within five seconds, Pi removes local partial audio, reports that the recording owner may remain live, and never submits audio for transcription.

## Consequences

Protocol version 2 is intentionally incompatible with version 1. Stop and transfer are separate, so an ambiguous network failure can be reconciled through status and a repeated fetch. A result is acknowledged only after Pi validates its bounded length, SHA-256 digest, and PCM16 mono WAV structure.

The companion transactionally commits a private per-lease metadata record before capture begins and after every transition. It persists only the hashed lease capability, never the plaintext lease secret. On startup it restores valid terminal records and WAVs, deletes orphan or incomplete audio, converts interrupted `recording` or `finalizing` work into an owner-attributable `failed` tombstone, and reapplies the remaining retention interval.
