# ADR: Recording lease protocol version 3

## Decision

Bridge protocol version 3 makes each Bridge recording a capability-owned **Recording lease**. Pi generates a UUID recording identity and a cryptographically random 32-byte lease secret before `start`. The companion binds the lease to the authenticated client credential and retains only `SHA-256(lease secret)`.

The unauthenticated challenge contains only its type and 32 random bytes. The request HMAC binds the client's claimed protocol version; only after authentication does the companion compare it with its own exact version. An authenticated mismatch returns only `clientVersion` and `companionVersion`, while every unauthenticated failure closes without disclosing either version or companion state. JSON objects reject duplicate fields recursively, and binary fields use one canonical Base64 or lowercase hexadecimal encoding.

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

The operation statuses are `ok`, `busy`, `not-found`, `request-conflict`, `invalid-state`, and `failed`. Before operation dispatch, an authenticated version mismatch uses `version-mismatch { clientVersion, companionVersion }` and performs no operation.

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

A duration limit follows the same recording → finalizing → result-ready path as `stop`, with `completion: duration-limit`. Pi may fetch, validate, and acknowledge that result for cleanup, but must never commit or transcribe it. The companion and Pi independently enforce the same configured deadline. Result retention expiry removes audio and produces an `expired` tombstone. Finalization failure removes partial audio and produces `failed`.

Cancellation is serialized with acknowledgement by the companion lock: whichever authenticated operation is accepted first determines the terminal state. Pi records cancellation intent synchronously before opening its separate cancel connection and must not begin acknowledgement after that intent. It aborts finalization polling and transfer immediately. If authenticated cancellation cannot be confirmed within five seconds, Pi removes local partial audio, reports that the recording owner may remain live, and never submits audio for transcription.

## Consequences

Protocol version 3 is intentionally incompatible with earlier versions. Stop and transfer are separate, so an ambiguous network failure can be reconciled through status and a repeated fetch. A result is acknowledged only after Pi validates its bounded length, SHA-256 digest, and PCM16 mono WAV structure, and `status` metadata must agree exactly with `fetch` metadata.
