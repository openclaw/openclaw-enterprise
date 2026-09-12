# Milestone 1.3: PostgreSQL Persistence: restart safe queue

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

## Restart-safe queue protocol

### Claim

Each claim atomically selects and leases at most one eligible item, using
PostgreSQL time as the lease authority. The caller supplies an unguessable UUID
claim token, a 60-second lease, and the validated controller-wide attempt limit:

```sql
WITH candidate AS (
  SELECT w.idempotency_key
  FROM occ.controller_work AS w
  WHERE w.state = 'queued'
    AND w.available_at <= clock_timestamp()
    AND w.attempt_count < $2
    AND NOT EXISTS (
      SELECT 1
      FROM occ.controller_work AS in_flight
      WHERE in_flight.state = 'claimed'
        AND COALESCE(in_flight.agent_id, in_flight.namespace_id) =
              COALESCE(w.agent_id, w.namespace_id)
    )
  ORDER BY w.available_at, w.created_at, w.idempotency_key
  FOR UPDATE OF w SKIP LOCKED
  LIMIT 1
)
UPDATE occ.controller_work AS w
SET state = 'claimed',
    attempt_count = w.attempt_count + 1,
    claim_token = $1,
    lease_expires_at = clock_timestamp() + interval '60 seconds',
    updated_at = clock_timestamp()
FROM candidate
WHERE w.idempotency_key = candidate.idempotency_key
RETURNING w.*;
```

`$2` is the positive, controller-wide `MAX_QUEUE_ATTEMPTS` setting defined
below. The queue constructor validates this injected setting; it never comes
from requests, Namespaces, or individual jobs. Persisted `attempt_count`
preserves claim and recovery decisions across process restarts.

The claim query skips resources that already have claimed work, allowing other
ready resources to make progress; the partial unique index remains the
concurrency-race backstop and allows at most one claimed row per derived
`COALESCE(agent_id, namespace_id)` resource. Eligible items are selected by
availability, but strict FIFO among siblings is not required: a ready operation
may pass an earlier delayed retry once no sibling is claimed. Exactly two
states are terminal: `succeeded` and `failed_permanent`. Adding a state requires
classifying it and updating the table constraint in the same migration.

PostgreSQL documents `SKIP LOCKED` for multiple consumers of queue-like tables;
it does not guarantee a generally consistent view or exactly-once execution.
The partial unique index remains a backstop against implementation or isolation
mistakes. Handle SQLSTATE `23505`, `40001`, and `40P01` during claiming with
bounded claim retries; never mark the queued operation failed for these races.

### Heartbeat and fencing

Only the current, unexpired claim may renew its lease. The harness sends a
heartbeat every 15 seconds:

```sql
UPDATE occ.controller_work
SET lease_expires_at = clock_timestamp() + interval '60 seconds',
    updated_at = clock_timestamp()
WHERE idempotency_key = $1
  AND state = 'claimed'
  AND claim_token = $2
  AND lease_expires_at > clock_timestamp()
RETURNING idempotency_key;
```

If the update returns zero rows, ownership is lost: the worker cancels its work,
performs no further side effects, and cannot finalize. Every success, retry, or
failure update uses the same idempotency key + state + token + unexpired-lease
predicate. Claim tokens are unguessable and scoped by the work primary key;
global token uniqueness is unnecessary. Worker identity and heartbeat timestamps
need not be persisted.

The token fences database completion, not external effects that have already
started. Source Milestone 5 must pass the stable work/effect identity to an
idempotent Driver ensure operation or observe an ambiguous result before
retrying.

### Retry and terminal failure

Classify each error before changing the work state:

- Transient dependency, timeout, rate-limit, and serialization failures enter
  `queued` with an `available_at` timestamp after the retry delay.
- Permanent validation, scope, authorization, unsupported-operation, and
  invariant failures enter `failed_permanent` immediately.
- A claimed attempt at the configured `MAX_QUEUE_ATTEMPTS` enters
  `failed_permanent` after any failure or stale recovery.

Each retry clears the claim token and lease expiry, then appends a failure audit
in the same transaction. The audit's optional `details` object contains a
server-authored reason code and redacted context. This milestone does not
introduce a separate revision-runtime or failure-status table.

`available_at` uses capped, full-jitter exponential backoff:
`random(0, min(300 seconds, 1 second * 2^(attempt_count - 1)))`. An injected RNG
makes the selected delay deterministic in unit tests; PostgreSQL stores it as
an absolute timestamp. The validated controller-wide default is
`MAX_QUEUE_ATTEMPTS = 10`; the queue constructor accepts an explicit override.
Deployment-level configuration belongs to the later controller milestone and
must never allow retry policy per request, tenant, or queued row.

Terminal rows set `completed_at`, retain their idempotency key, and atomically
commit attributable failure audit evidence. Creating a new semantic effect
requires explicit operator action; terminal work is never silently requeued.
Queue state and audit records provide durable, actionable failure visibility
without storing error details on queue rows.

### Stale-claim recovery

A stale claim must either become eligible for retry or reach terminal failure.
On harness startup and every 5 seconds, a bounded reaper selects expired
`claimed` rows in lease-expiry order with `FOR UPDATE SKIP LOCKED`. For each
row, one transaction:

1. Clears the claim token and lease expiry.
2. Returns the row to `queued` with persisted `available_at` backoff, or to
   `failed_permanent` when `attempt_count >= MAX_QUEUE_ATTEMPTS`.
3. Appends an attributable failure audit with safe `LEASE_EXPIRED` details.
4. Commits; the next periodic poll can discover newly eligible work.

A second sweep compares unclaimed `queued` rows against the same controller-wide
attempt limit. It atomically marks exhausted work `failed_permanent` and records
durable failure audit evidence, preventing stranded rows. Record recovery counts
as metrics or structured logs, not queue columns. Recovery is repeatable and
safe when multiple reapers run concurrently.

### Idempotency contract

The queue guarantees at-least-once processing. Its stable key derives from the
single `reconcile` action, the exact Namespace/Agent resource owner tuple, and
the immutable desired generation or revision identity. That key is both the
work primary key and the effect identity; retries never create a second
identifier. Attempt count, claim token, and timestamps never affect effect
identity.

Queue deduplication prevents one committed desired-state change from producing
duplicate work. It does not add HTTP request idempotency to the source
Milestone 2 API; duplicate create requests remain governed by the existing
ID/name uniqueness contract.

When source Milestone 5 begins external dispatch:

- A Driver must accept the stable effect key or implement an idempotent
  `ensure/observe` operation against stable OCC-owned external identity.
- Ambiguous timeout retries observe before changing external state again.
- A non-idempotent and non-observable effect fails closed for operator review.
- “Exactly once in effect” is proven per Driver; it is never inferred from a
  database lease.

### Crash and race outcomes

| Crash or race                        | Required result                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Before request transaction commit    | No resource, success audit, or work exists.                                            |
| After commit but before next poll    | Periodic scanning finds the durable work row.                                          |
| Two workers claim concurrently       | Row locks divide candidates; serialization unique index rejects same-resource overlap. |
| After claim commit, before work      | Lease expires and stale recovery schedules the same work identity.                     |
| During future Driver call            | Outcome is ambiguous; next attempt observes/deduplicates before acting.                |
| External success before finalization | Same stable effect identity is retried; old token cannot finalize after lease loss.    |
| Heartbeat loses its lease            | Zero-row update stops the old worker and fences every DB state transition.             |
| Finalization transaction fails       | Resource observation, audit, follow-up work, and work completion all roll back.        |
| Attempts exhausted                   | Work becomes `failed_permanent`, emits evidence, and is not automatically requeued.    |

The harness polls for eligible work every five seconds. A later effectful
controller may add notification-based wake-up as an optimization, but that
behavior, its listeners, and its metrics belong to source Milestone 5.

