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

## States and disclosure

Owner-authenticated `status` returns `recordingId` and one of `recording`, `finalizing`, `result-ready`, `acknowledged`, `cancelled`, `expired`, or `failed`. Only `result-ready` adds `length` and `sha256`. `fetch` returns those result metadata followed by the WAV bytes; other operations do not transfer audio.

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

A duration limit follows the same recording → finalizing → result-ready path as `stop`. Result retention expiry removes audio and produces an `expired` tombstone. Finalization failure removes partial audio and produces `failed`.

## Consequences

Protocol version 2 is intentionally incompatible with version 1. Stop and transfer are separate, so an ambiguous network failure can be reconciled through status and a repeated fetch. A result is acknowledged only after Pi validates its bounded length, SHA-256 digest, and PCM16 mono WAV structure.
