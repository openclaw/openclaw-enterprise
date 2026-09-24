# Feature Spec: Agent deployment status API

**Date:** 2026-09-11
**Status:** Completed
**Owner:** OCC API, persistence, and controller worker maintainers

## Problem and Decision

Expose durable deployment outcomes using the admitted AgentRevision ID and the
original reconciliation work row. Preserve the existing deploy response and add
authorized polling for one terminal outcome with one safe error envelope:
`{code,message,data?}`.

This standalone implementation owns deployment polling, lease-aware status, and
generic bounded error metadata. Native plugin failure attribution and runtime
receipt races remain deferred to later plugin work; this spec does not require
plugin-specific diagnostics before the deployment status API ships.

## Scope

- Preserve `POST /namespaces/:namespaceId/agents/:agentId/deploy` returning the
  admitted AgentRevision at `data`; clients poll with `data.id`.
- Add authorized `GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId`.
- Persist terminal outcome, failure code, and optional validated JSON metadata on
  the original controller work row.
- Report `queued`, `running`, `succeeded`, and `failed` from original work state
  without claiming serving health.
- Exclude new deployment resources, history APIs, cancellation, callbacks,
  automatic repair, rollback guarantees, and plugin-specific producer metadata.

## Contract

### Identity and access

One admitted revision has one deployment, scoped to its exact Namespace and
Agent. `deploymentId` is the existing AgentRevision `id`, stable across worker
claims and retries. Only the original `agent_revision:<id>:reconcile` work row
owns the historical deployment outcome.

The bodyless deploy request keeps this response shape:

```json
{
  "data": {
    "id": "rev_..."
  },
  "meta": {
    "requestId": "req_..."
  }
}
```

`data` is the existing AgentRevision object, and `data.id` is the polling key.
Admission, revision creation, work enqueue, and attributable audit commit before
the `202` response. Rejected admission creates no deployment to poll. Acceptance
does not imply runtime readiness.

The new polling route returns:

```json
{
  "data": {
    "deploymentId": "rev_...",
    "namespaceId": "ns_...",
    "agentId": "agt_...",
    "status": "running",
    "error": null
  },
  "meta": {
    "requestId": "req_..."
  }
}
```

Authorization reuses exact `read` on `agent_revision:<deploymentId>` under the
server-owned Installation, Namespace, and Agent. Ownership mismatches remain
404, denials remain 403, and denial audit behavior stays unchanged. The API reads
the original work row only after the revision read authorization succeeds. A
missing original work row is a dependency error; it must not fabricate readiness
or success.

### Status and error

| Public status | Authoritative meaning                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`      | Original work is queued, or its claim lease expired and recovery has not reclaimed it.                                                      |
| `running`     | Original work has a live claim; this does not assert workload readiness.                                                                    |
| `succeeded`   | Activation finished, the active revision was verified, and required predecessor retirement completed.                                       |
| `failed`      | The original deployment reached a permanent failure, exhausted its retry/deadline budget, or was superseded before successful finalization. |

`error` is `null` before terminal failure and on success. On failure it is:

```json
{
  "code": "LEASE_EXPIRED",
  "message": "Deployment worker lease expired.",
  "data": {
    "attemptCount": 1
  }
}
```

`data` is optional and omitted when no metadata applies. Each failure producer
defines its own metadata shape and must validate it before persistence and
exposure. Metadata is bounded and safe: it is not a raw upstream error payload.
The public schema limits codes to `^[A-Z][A-Z0-9_]{0,63}$` and messages to 200
characters. The standalone implementation exposes only code-specific metadata:
OCC-controlled retry, deadline, lease and finalization failures may return
`data: { "attemptCount": <0..1000> }`; unsupported metadata is rejected before
persistence or omitted from the public response. Plugin-specific data remains
deferred. Never store or return credentials, paths, command output, native
process text, claim tokens, actor IDs, or other diagnostic material that is not
explicitly part of a fixed public error contract.

The public `message` is derived from fixed platform-owned codes, not stored
native text. Internal success code `REVISION_SUPERSEDED` maps to public `failed`.
Activated completion maps to public `succeeded`. A completed success remains a
historical success after later replacement or health failure; polling is not a
serving-health endpoint.

### Commit and recovery

The controller work row stores terminal outcome, failure code, and optional
validated JSON metadata. The worker commits terminal state and outcome under its
live claim; recovery and retry exhaustion persist safe terminal reasons through
the same queue owner. Stale claimants cannot write or acknowledge diagnostics.
Terminal reports for the original work row are immutable; maintenance work cannot
rewrite them.

`activeRevisionId` alone cannot prove success while finalization remains
pending. Activation and cleanup failures retain existing retry, deadline, and
safety behavior. Failure does not promise pointer rollback, predecessor
availability, or partial infrastructure cleanup. Worker outage leaves queued or
expired work awaiting recovery within existing bounded attempts and convergence
deadline.

Repeated deploy requests admit distinct revisions. Idempotency keys and safe
client replay for ambiguous writes remain deferred.

## Implementation

1. Add route and response schemas in the contracts package, OCC controller API,
   and generated OpenAPI output while preserving the existing deploy response.
2. Extend controller work persistence with terminal outcome, reason code, and
   optional bounded metadata. Enforce terminal invariants in PostgreSQL. The
   in-memory adapter records admission-pending work only and has no worker
   claim or terminal lifecycle.
3. Update worker finalization, retry exhaustion, stale-claim recovery, and
   supersession handling to persist one authoritative original-work outcome.
4. Update current Agent deployment reference, generated API reference, and
   controller-worker flow documentation.

Current implementation limitation: existing terminal `controller_work` rows
without durable outcome codes cannot be classified safely because prior storage
does not distinguish completed success from supersession or other terminal
failure. The deployment-outcomes migration therefore fails explicitly when such
rows exist instead of backfilling guessed outcomes.

## Verification

| Required outcome          | Proof                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy response preserved | API tests keep `POST /deploy` returning the AgentRevision at `data` and use `data.id` as the polling key.                                                                                                                     |
| Access control            | Polling reuses exact revision read authorization, denies cross-scope reads, returns ownership-mismatch 404, and does not read work before authorization.                                                                      |
| Lease-aware status        | Queued, live-claim running, expired-lease queued, terminal succeeded, and terminal failed states derive from the original work row.                                                                                           |
| Durable failures          | Permanent failures, retry exhaustion, and supersession survive restart/recovery and return fixed `{code,message,data?}` errors.                                                                                               |
| Metadata safety           | Supported `{attemptCount}` metadata round trips for OCC-controlled failures, omitted metadata stays absent, unsupported code/data pairs are rejected before persistence, and unsupported stored metadata is omitted publicly. |
| History                   | A completed deployment stays succeeded after replacement; a superseded unfinished deployment reports failed; maintenance cannot mutate the original outcome.                                                                  |
| Legacy terminal rows      | Migration proof shows terminal `controller_work` rows without durable outcome codes fail explicitly rather than inferring success or failure.                                                                                 |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-13: Expanded exact attempt metadata to the PostgreSQL integer range and bounded retry budgets to the same maximum. The current [worker settings](../docs/reference/settings/operations.md) and [deployment reference](../docs/reference/agents/deployment.md) own the supported limits.

- 2026-09-11 18:40: Marked local implementation verification complete; supported behavior is documented in the current [Agent identity and deployment](../docs/reference/agents/deployment.md) reference, with release and PR merge still tracked separately. (01a091f2-5124-7732-ab79-15625b5facae - b971f36)
- 2026-09-11 17:15: Added standalone deployment status contract preserving POST data:revision, polling by revision id, durable original-work outcomes, and generic error data. (01a091f2-5124-7732-ab79-15625b5facae - b971f36)

## Current implementation amendment (2026-09-24)

The current terminal outcome implementation supersedes the proposed
`outcome_code` and `outcome_data` columns and terminal-row migration refusal.
Deployment polling uses the canonical `reason_code`, `result_data`, and
`attempt_count` on the original controller work row. It retains runtime failure
evidence and plugin warnings. The remaining clock and attempt diagnostic work
is described in the [current Agent reference](../docs/reference/agents.md#deployment-status).
