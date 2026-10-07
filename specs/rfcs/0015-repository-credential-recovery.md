---
author: kevinlin-openai
implementation_status: Partially implemented
status: Proposed
status_note: "The incremental implementation is under review; the broader recovery design remains proposed."
---

# Recover repository credential cleanup after broker loss

**Status: Implementing.** The incremental terminal-receipt path is under review;
the broader action-recovery design remains proposed. The current
[repository credential reference](../../docs/reference/repository-credentials.md)
and [service flow](../../docs/flows/repository-credentials.md) own supported behavior.

## Problem and proposed outcome

An Agent revision has an admitted repository session and may cause the broker to
issue an installation token. If the broker exits before the worker records
cleanup, the broker loses its admission, session, token and provider-operation
inventory. The worker invalidates the attempt and retains cleanup because it
cannot establish the token's disposition.

Explore nonsecret evidence tied to the original admission, session, grant,
selected Driver and Backend, and provider operation. A restarted broker must
close recovered sessions to new traffic and must not recreate their bearer.
An issuance without a durable capture receipt, an unsettled provider action,
or a historical invalidated attempt without matching evidence remains unknown.

A GitHub-specific lifetime-elapsed observation is a candidate for further
review, not an established cleanup outcome. A fresh wait after restart does not
recreate the captured in-memory custody and monotonic observation required by
the existing `expired` outcome. This proposal does not authorize mapping that
observation to `expired` or `disposed`, or rewriting invalidated attempts.

This proposal does not recover the credential bytes or promise immediate
revocation after restart. It does not replay Git or API mutations. Ordinary
credential closure, Agent retirement, authorization and cleanup work remain with
their existing owners.

## Evidence and limits

The [GitHub Backend lifetime](../../apps/controller/src/drivers/repo/github/credentials/driver/lifetime.ts)
sets a one-hour cleanup bound from response receipt. Its
[response observer](../../apps/controller/src/drivers/repo/github/credentials/driver/acquisition-response.ts)
captures a token before the response body is discarded. The
[common lifecycle](../../apps/controller/src/drivers/repo/credentials/lifecycle.ts)
measures the captured token's cleanup lifetime using monotonic time, separates
`expired` from `revoked`, and retains uncertain issuance. GitHub documents that
[installation access tokens expire after one hour](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

The existing service-loss tests exercise a real broker process and a controlled
provider. They show that a provider can issue a token before its response is lost,
that a lost revocation response is not revocation evidence, that a wall-clock
jump does not advance the current process's monotonic cleanup bound, and that
that standalone process-local inventory is lost on replacement. Separate tests
exercise the durable receipt path against PostgreSQL; neither proves live GitHub behavior.

## Broader recovery contract

The following describes the broader candidate, including recovery of individual
provider actions. The narrower first delivery below need not persist each
provider action if it records only an already-established terminal result.

1. Before delivering client material, persist the admission input and its exact
   admission ID, session ID, original deadline, provider instance, repository
   and grant identity. Replays must match the original input. Missing or
   unverifiable recovery storage fails closed; it is not an empty inventory.
2. Before issuing a provider request, durably reserve its unique action against
   that exact session and grant. Dispatch is forbidden until the reservation's
   commit is known. An ambiguous commit requires an authoritative read before
   dispatch. The reservation consumes bounded capacity while unresolved.
3. Record a nonsecret capture receipt bound to the exact issuance, original
   admission, session, grant, Driver and Backend. Record the original action's
   settlement separately. Receipt alone does not settle an in-flight provider
   action. If those records do not commit, retain an unknown obligation. Never
   put tokens, gateway bearers, App keys or JWTs in State, journal messages,
   status, logs or audit records.
4. Explore a distinct GitHub lifetime-elapsed observation only after defining an
   explicit provider-specific contract and verifying its authoritative bound.
   It would require the matching durable capture and settled action, an
   authenticated observation, a verified broker generation and death boundary,
   and fencing that prevents the old owner from issuing more authority. A lease
   expiry, missing socket or Pod replacement alone does not prove process death
   or prevent an old owner that passed its dispatch gate from minting later.
   The time calculation must conservatively handle clock changes and repeated
   restarts; a full new monotonic wait is insufficient without these conditions.
   This observation would not prove revocation or settle an uncaptured issuance.
5. Record `revoked` only after positive provider confirmation is durably
   recorded. An unconfirmed DELETE does not prove revocation. Define terminal
   evidence retention and acknowledgement against the worker's exact persisted
   attempt, including lost responses and crashes. Do not map new observations
   to the existing `expired` or `disposed` outcomes without an independently
   reviewed contract and coordination with the worker owner. Missing journal
   records never turn an invalidated attempt into `disposed`. A delayed or
   repeated admission must not create new authority.
6. Retain uncertain actions and their capacity until a supported settlement is
   established. A missing response or a provider lifetime alone is not evidence
   of cleanup. An uncaptured issuance can remain unknown indefinitely.

The current lifetime guarantee and custody rules belong to the GitHub Backend;
the common engine must not infer a lifetime for arbitrary adapters. A new
observation would also need to establish that the guarantee applies to the exact
captured response. Unexpected or malformed responses and incomplete actions
remain unknown. Each credential in a replacement sequence needs its own evidence.

## Narrow first delivery: retain an observed terminal result

A smaller candidate is to persist the original broker's exact `DISPOSED`
observation while that broker still holds the custody and action evidence. This
would recover a terminal result lost before the worker records it, without
inventing a post-restart expiry outcome or persisting token bytes. The existing
[service transition](../../apps/controller/src/drivers/repo/credentials/service.ts)
requires closure, drained exchanges and actions, finalized lifecycle and empty
custody before it reports `DISPOSED`.

This candidate still needs a durable admission record before client material is
released, exact input and session matching, atomic replay fencing, and a
terminal receipt committed before it can be reported as durable. It must
prevent another broker generation or a delayed request from recreating the same
admission after cleanup. A durable reservation must distinguish a confirmed
missing admission from an owner that might still complete a delayed open;
lease expiry or a lost response alone cannot establish that distinction. The worker must consume only the matching receipt and
retain or acknowledge it safely across lost responses. A journal outage or a
crash before the terminal commit leaves the obligation unknown. An active or
uncertain session at process loss remains unknown; this first delivery would not
revoke a recovered token or settle an old invalidated attempt without evidence.

## Incremental implementation under review

The worker hosts a private receipt socket next to the broker control socket. It
checks the persisted Driver, Backend, Namespace, admission, grant and deadline,
then commits a reservation before the broker releases material. Missing recovery
can commit a fence; a reservation or active receipt cannot be treated as missing.
The original broker commits its exact terminal observation before reporting
`DISPOSED`. The receipt survives worker acknowledgment and later broker restart;
no token, bearer or recoverable provider action is stored. Existing attempts
without the durable protocol remain fail-closed. Uncaptured, active, uncertain
and pre-commit outcomes remain unknown. The [current reference](../../docs/reference/repository-credentials.md)
owns the supported contract and the [test guide](../../docs/testing/repository-credentials-platform.md)
describes verification and its limits.

## Persistence choice and tradeoffs

The worker already persists immutable admission identity and cleanup context in
`repository_session_attempts`; those records survive Agent deletion. One
direction to evaluate is to extend that State ownership with nonsecret broker
session and action evidence and use the existing private worker/broker volume
for a narrowly scoped journal protocol. The worker validates the exact persisted
owner and commits each operation before responding. The broker must not receive
the worker's database credential. Storage and protocol limits, socket ownership,
replay fencing, concurrent process ownership and recovery from uncertain commits
must be specified and proved before delivery.

This choice keeps provider token bytes in process memory and needs no new
journal-encryption key. It also keeps the detached broker's existing built-in
runtime dependency boundary. Its cost is that broker journal operations depend
on worker availability; an unavailable journal cannot be treated as an empty
journal or permit fresh acquisition. Evaluate the effect on surviving sessions
when the worker alone restarts.

A separate broker-only PostgreSQL role could provide direct storage access and
worker-independent journal availability, but adds a database credential, network
access and a PostgreSQL client to the currently isolated broker image. Reusing
the broad `occ_app` credential would grant the broker unrelated platform State
access. Persisting encrypted token bytes enables attempted revocation after
restart, but adds key custody, rotation and backup requirements and still cannot
recover an issuance whose response was lost.

## Delivery and proof

The supported Agent path must exercise worker admission and cleanup, the actual
control protocol, the broker and durable State. Use PostgreSQL with the repository's
migrator and limited application roles and a controlled provider. Cover crashes
before dispatch, after provider issuance but before receipt, after durable receipt,
during revocation, after a confirmed outcome but before the worker commits it,
and after that commit. Check exact identity, stale-bearer denial, no remint on
unknown issuance, provider evidence, bounded capacity, concurrent ownership,
ambiguous commits and repeated restarts. Exercise an old owner paused after
its dispatch gate and prove that takeover cannot treat its possible late mint
as settled. Advance monotonic and wall time independently; a restarted wait
must never be accepted as disposal on its own. Any candidate lifetime-elapsed
observation needs tests for every condition in its reviewed contract.

Keep the queue-deduplication work and [PR #488](https://github.com/openclaw/openclaw-enterprise/pull/488)
coordinated with changes to worker cleanup and admission. Preserve its
invalidated-before-cleanup error precedence, locks and authorization. Fixture
provider and clock evidence do not establish live GitHub, cluster or Agent model
execution. No operator settlement mechanism for historical invalidated attempts
is proposed here.
