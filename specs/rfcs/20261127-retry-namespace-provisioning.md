---
status: Proposed
implementation_status: Partially implemented
author: HerbertHuerto
---

# Proposal: Retry failed Namespace provisioning

- **ID:** RFC-20261127-retry-namespace-provisioning
- **Created:** 2026-11-27
- **Last updated:** 2026-11-27
- **Related:** [Issue #3983](https://github.com/openclaw/openclaw-enterprise/issues/3983), [Namespace Driver lifecycle](0035-namespace-driver-lifecycle.md)

<a id="problem-and-decision"></a>

## Summary

Let the caller who created a Namespace retry its failed provisioning after an operator repairs the cause. OpenClaw Control Plane (OCC) would reopen the same Namespace and its existing work item with a fresh, bounded reconciliation budget. The worker, not the retry request, decides whether the Namespace is ready.

## Motivation

An operator can restore tenant access after the worker's deadline or correct a quota that prevented setup. Neither repair reopens a failed Namespace. Stock OCC at `2b5318e8f` does not offer a retry. Deleting and recreating the Namespace loses its identity and may require removing resources first.

<a id="scope"></a>

## Goals

Recover in place without replacing the Namespace, changing its placement, or recreating resources already owned by it. Keep one active provisioning operation per Namespace. Preserve authorization, finite deadlines, and the record of each failed attempt.

## Non-goals

No automatic retry of terminal failures, transfer of work to another actor, new Console control, API-visible failure diagnostics, or change to Agent provisioning or Namespace deletion.

<a id="design"></a>

## Proposal

After repair, the original actor submits a bodyless retry for the exact Namespace. OCC checks current permissions and locks the Namespace. In one transaction it verifies that both the Namespace and its provisioning work failed, returns the Namespace to `provisioning`, requeues the work, and records the retry. If any write fails, none take effect.

The worker uses its [existing reconciliation path](../../docs/flows/controller-worker.md). It rechecks the actor's current grants before calling Compute and the selected lifecycle participants. It starts from Compute even if earlier steps completed. A permanent refusal or an exhausted budget makes the Namespace `failed` again. The operator can still delete it under the existing deletion rules.

The dashed step is proposed. The other transitions already exist.

```text
failed  - - authorized retry - ->  provisioning
                                      |-- all participants ready --> ready
                                      |-- refusal or exhaustion ---> failed
```

## Interface changes

### APIs

Add `POST /namespaces/{namespaceId}/provision/retry`. On admission, return `202` with the existing Namespace response envelope and status `provisioning`. Poll the existing Namespace GET for completion. The retry accepts no actor, placement, or work ID from the caller.

After authorization, return `404` for an absent or tombstoned Namespace. Return `409` for a live Namespace that is not `failed` or that lacks matching terminal provisioning work. Concurrent retries must not add work or refresh an active budget. If the response is lost, read the Namespace before deciding whether it needs another retry.

### IAM

Reuse the original work actor, not just any caller with permission to create Namespaces. Require read access to the exact Namespace, Namespace `create` on the Installation collection, no exact Namespace restriction on creation, and Installation `administer` for an adopted backing namespace. Reuse the [worker's authorization checks](../../apps/controller/src/worker.ts); the worker must still recheck them at dispatch. Return `403` on denial without disclosing work state or changing it. No new role or IAM action.

### Database entities

Allow `failed → provisioning` on the existing Namespace for this operation only. Match the exact live Namespace and its `ready`-target work in `failed_permanent`. Keep the work key, original actor, creation time, and historical audits. Reset the attempt count and terminal result. Record the retry start on the database clock: the worker measures convergence for this run from that instant, not from original creation, claim renewal, or a duplicate request. The normal attempt limit and timeout still apply across worker restarts.

Record the actor, Namespace, work key, request ID and prior failure code and attempt count in the mutation audit. Preserve normal denial auditing. Serialize retry and deletion on the same Namespace; a retry cannot reopen a deleting or deleted Namespace. No new entity or general-purpose queue reset.

### Driver contracts

No changes. The [existing contract](../../docs/reference/drivers/namespace-lifecycle.md) already requires repeated setup to tolerate completed effects. Drivers do not authorize retries, grant access, or change Namespace state.

## Simplifications

Reuse the existing worker, work key, IAM checks and status read. No repair service, replacement Namespace, or per-Driver retry endpoint. Simply increasing the timeout would delay failure for every caller without recovering a Namespace that already failed. Requeuing with the original deadline could fail on the first pending observation, even after repair.

## Acceptance Criteria

- **AC-1 — Recover in place:** In the [disposable OpenShell integration](../../tests/integration/namespace-driver-openshell-k3d-real.test.ts), reach `failed` after quota refuses setup and gateway keys exist. Repair the quota and retry as the original authorized actor. Observe `202`, then `ready` via GET, with the same Namespace ID, backing placement and gateway key Secret UID.
- **AC-2 — Bound the new attempt:** In a disposable PostgreSQL API/worker test, let provisioning expire, repair the cause, then retry. A pending pass after the old deadline must still be able to reach ready within the new budget. A separate unrepaired run must fail within the new limits, including across a worker restart.
- **AC-3 — Preserve authority:** Exercise another creator, a revoked grant, and an adopted namespace without Installation admin. Verify denial, unchanged terminal work and no Driver effects. Revoke permission after admission and verify the worker refuses dispatch.
- **AC-4 — Admit once:** Race two authorized retries against one failed work item using the real API and PostgreSQL. Verify one admission, one budget reset and one successful mutation audit linked to the prior failure. Verify that retry cannot reverse a concurrent deletion, and that an audit write failure leaves both Namespace and work terminal.

## Delivery and verification

These are proposed implementation gates, not test results. Verify AC-2 through AC-4 with the migrated application-role database; AC-1 additionally requires a prepared disposable OpenShell cluster. A passing database test cannot establish that gateway keys survive recovery.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

Restricting retry to the original actor avoids changing who owns queued work. If that actor is unavailable, this proposal offers no takeover. Maintainers should decide whether that limit is acceptable; adding takeover would require a separate authorization and audit decision. Waiting indefinitely for operator-managed tenant access would address one failure mode but would remove the deadline without helping a Namespace that failed for another reason.
