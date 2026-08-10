# ADR: Recording lease and Level subscription protocol version 3

## Decision

Bridge protocol version 3 makes each Bridge recording a capability-owned **Recording lease** and carries Live level history on a separate authenticated Level subscription. Pi generates a UUID recording identity and a cryptographically random 32-byte lease secret before `start`. The companion binds the lease to the authenticated client credential and retains only `SHA-256(lease secret)`.

The unauthenticated challenge contains only its type and 32 random bytes. The request HMAC binds the client's claimed protocol version; only after authentication does the companion compare it with its own exact version. An authenticated mismatch returns only `clientVersion` and `companionVersion`, while every unauthenticated failure closes without disclosing either version or companion state. JSON objects reject duplicate fields recursively, and binary fields use one canonical Base64 or lowercase hexadecimal encoding.

Every request has an authenticated UUID request identity. The response HMAC covers the actual response status. The replay fingerprint binds the claimed protocol version, operation, and payload. Reusing a registered request identity with the same fingerprint during the ten-minute reconciliation lifecycle is replay-safe; changing any fingerprint field returns `request-conflict` without applying an operation. Durable receipts are bounded independently for each credential: up to 16,384 observation requests (`health`, `levels`, `subscribe-levels`, and `status`) and 64 control requests, so one credential's polling or busy-start flood cannot evict live receipts. A credential at either bound receives `failed` for new identities until receipts expire. Control receipts retain their original outcome, including credential-administration outcomes after the request revokes its credential; read-only observation receipts retain a compact fingerprint and safely re-execute exact retries, so their potentially large Level payloads cannot inflate the durable registry. The observation bound covers repeated Level subscription recovery throughout the reconciliation lifecycle, and persistence reserves bounded response space before any control operation executes.

## Operations

- `start { recordingId, leaseSecret, maxDurationMs }`
- `status { recordingId, leaseSecret }`
- `levels { recordingId, leaseSecret, afterSequence }` returns a bounded authenticated snapshot for adversarial protocol diagnosis
- `subscribe-levels { recordingId, leaseSecret, afterSequence }` opens the separate Level connection, returns explicit replay bounds, then streams retained observations before live delivery
- `stop { recordingId, leaseSecret }`
- `fetch { recordingId, leaseSecret }`
- `cancel { recordingId, leaseSecret }`
- `acknowledge { recordingId, leaseSecret }`

Credential administration is a separate owner-authenticated plane:

- `credential-effects {}` previews the calling credential's connections and owned audio.
- `credential-revoke {}` durably revokes the calling credential and deletes only its owned audio.
- `credential-revoke-if-idle {}` performs that revocation only when the preview has no owned audio or active Recording lease.

Recording lifecycle operations other than `start` require both capability fields. Authenticated `health` and credential administration require no recording capability because they address the calling credential rather than a Recording lease. An idle rejection is a completed control outcome; a rotation retry after the owned work is cleared uses a new request identity, while ambiguous retries preserve the original identity. Unknown identities, wrong secrets, and cross-owner requests all return the identical authenticated `not-found {}` response. `busy {}` never identifies the active owner or lease.

The operation statuses are `ok`, `busy`, `not-found`, `request-conflict`, `invalid-state`, and `failed`. Before operation dispatch, an authenticated version mismatch uses `version-mismatch { clientVersion, companionVersion }` and performs no operation.

Connection establishment and the `start`, `status`, `cancel`, and `acknowledge` control operations each have a fixed five-second deadline. Finalization has a thirty-second deadline. A fetch has a resettable ten-second no-progress deadline, and recovery of a terminal result is bounded by a ten-minute overall window. After a timeout, disconnect, or lost response, Pi repeats the same idempotent operation with the same request identity and reconciles its effect through owner-authenticated `status`; a partial fetch is deleted and its retry begins at byte zero. Only exhausting the applicable reconciliation window without learning a terminal state produces `outcome-unknown`. Protocol, ownership, and validated terminal failures remain deterministic errors.

## States and disclosure

Owner-authenticated `status` returns `recordingId` and one of `recording`, `finalizing`, `result-ready`, `acknowledged`, `cancelled`, `expired`, or `failed`. Only `result-ready` adds `length`, `sha256`, and `completion`, where `completion` is `stopped` or `duration-limit`. `fetch` returns those result metadata followed by the WAV bytes; other operations do not transfer audio.

The active slot is occupied only by `recording` and `finalizing`. A completed result releases it after the WAV is safely finalized. Before accepting another start, the companion checks that storage can reserve that request's maximum result size. There is no wait queue.

## Transition table

`ok` includes an idempotent replay of the already-reached state.

| Current state | status | levels / subscribe-levels | stop | fetch | cancel | acknowledge |
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

Protocol version 3 is intentionally incompatible with earlier versions. Stop and transfer are separate, so an ambiguous network failure can be reconciled through status and a repeated fetch. A result is acknowledged only after Pi validates its bounded length, SHA-256 digest, and PCM16 mono WAV structure, and `status` metadata must agree exactly with `fetch` metadata.

The companion accepts at most sixteen simultaneous connections and at most four authenticated connections per credential, releasing both bounds on every exit so one host cannot exhaust the shared companion.

The companion retains exactly 600 consecutive 50 ms Level slots (thirty seconds) per active lease. One credential-and-capability-authenticated subscriber is active per lease; reconnect replaces it, replay begins after the last contiguous confirmed sequence, explicit bounds expose unrecoverable gaps, and a fixed bounded live queue disconnects slow readers without blocking PCM capture or finalization. Stream events are HMAC-bound to both protocol versions, challenge, credential, request, frame sequence, and canonical payload; Level transport failure never changes Recording lease or WAV recovery state.

The companion transactionally commits a private per-lease metadata record before capture begins and after every transition. Credential revocation first commits an owner-scoped cleanup record, then closes that owner's connections and removes its audio and metadata; startup completes interrupted cleanup before serving unrelated owners. It persists only the hashed lease capability, never the plaintext lease secret. On startup it restores valid terminal records and WAVs, deletes orphan or incomplete audio, converts interrupted `recording` or `finalizing` work into an owner-attributable `failed` tombstone, and reapplies the remaining retention interval. Earlier request-receipt schemas are discarded during the version 3 upgrade because their fingerprints did not bind the protocol version.
