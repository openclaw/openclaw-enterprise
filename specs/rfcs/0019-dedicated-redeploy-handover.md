---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Check a dedicated replacement before stopping its predecessor

- **ID:** RFC-0019
- **Created:** 2026-10-03
- **Last updated:** 2026-10-07
- **RFC PR:** [#1045](https://github.com/openclaw/openclaw-enterprise/pull/1045)
- **Related:** [Dedicated Harness RWO workspace plan](../plans/38-harness-rwo-workspace-plan.md);
  [exclusive replacement contract](../../docs/reference/drivers/compute.md#production-revision-stages);
  [harness execution](../../docs/reference/harness-execution.md)

<a id="problem-and-decision"></a>

## Summary

A dedicated Agent redeploy stops every earlier revision before it prepares the
replacement. A healthy Agent is therefore unavailable for the whole replacement,
about 75 seconds on a local k3d install, and a replacement that cannot start (for
example a rotated credential with a typo) leaves no revision serving. This RFC
proposes that the worker run the replacement's checks that need no Agent-owned
volume before it stops the predecessor. A replacement that fails those checks
fails while the predecessor keeps serving. The remaining outage covers only
predecessor termination and the replacement's own startup. Zero-downtime
replacement is out of scope; it needs a second copy of single-writer state.

## Motivation

Dogfood measurement (D67 in the OCE dogfood log, a 1 s Pod poll of a Codex
Agent redeploy with a working key):

| Phase                                               | Time     |
| --------------------------------------------------- | -------- |
| Request to predecessor Gateway and Harness deletion | ~5 s     |
| Predecessor termination                             | ~20 s    |
| Replacement scheduling and volume attach            | ~7 s     |
| Replacement Harness and Gateway startup to Ready    | ~43-50 s |

D95 shows the worse case: a Secret updated to a wrong value, then a redeploy.
The predecessor was deleted one second after the request, the replacement failed
`RUNTIME_AUTHENTICATION_FAILED` 27 seconds later, and the Agent had no running
workload until someone deployed again.

The ordering is deliberate. [Plan 38](../plans/38-harness-rwo-workspace-plan.md)
moved the dedicated Harness workspace to a per-Agent ReadWriteOnce claim and made
Kubernetes Compute return `requiresStoppedPredecessors(revision) === true` for
dedicated revisions. The worker then stops predecessors before
`prepareAfterPredecessors` (`apps/controller/src/worker.ts`,
`prepareRevisionPass`). The Gateway's SQLite private state is also a per-Agent
ReadWriteOnce claim behind a `Recreate` Deployment. Two revisions cannot run
against either claim at once, so a Deployment strategy change (surge or
RollingUpdate) cannot fix this: it would start a second writer on the same
state.

## Goals

- A replacement whose credentials, configuration or images are unusable fails
  before the predecessor is stopped, and the Agent keeps serving.
- The successful-path outage drops by the work that does not need the volumes.
- The exclusive contract still holds: no two revisions run against one
  Agent-owned claim.

## Non-goals

- Zero-downtime dedicated replacement. That needs per-revision state copies,
  ReadWriteMany storage with multi-writer semantics, or a state handoff
  protocol. All three change the storage design from plan 38.
- Embedded Agents, which already prepare while the predecessor serves.

<a id="design"></a>

## Proposal

Split exclusive preparation into two stages around the predecessor stop:

1. **Pre-stop checks (predecessor still serving).** The worker calls a new
   optional Compute stage, `prepareWithoutExclusiveResources(revision, context)`,
   before `stopPredecessors`. Kubernetes Compute uses it to:
   - create or update the replacement's revision-owned Secrets, ConfigMaps and
     NetworkPolicies, none of which the predecessor reads;
   - make sure the replacement images exist on the node that holds the Agent's
     claims, with a short-lived pull Pod that mounts nothing;
   - run the existing startup model check from a short-lived probe Pod that
     receives only the replacement's model credential and no workspace or
     Gateway state, under the same NetworkPolicy as the Harness.

   A failure here records the revision as failed with the existing failure
   codes, marked as failed before any predecessor stop (see below). The
   predecessor is not touched.

2. **Exclusive stage (unchanged).** Stop predecessors, then
   `prepareAfterPredecessors` creates the Gateway and Harness workloads that
   mount the claims, waits for readiness, and activates.

### Failure before the stop

Three readers on main assume that a failed newer dedicated revision stopped its
predecessor:

- the console's `replacementFailed` check in
  `apps/controller/src/console/agents/detail.mjs` shows "Probably down" and asks
  for a new deployment whenever the latest dedicated deployment failed and an
  older revision is current;
- native admin's `replacesActiveWorkload` in
  `apps/controller/src/http/native-admin.ts` reports the Agent unavailable while
  a newer exclusive revision exists;
- the worker's supersede check in `apps/controller/src/worker.ts` ends
  reconciliation and maintenance of every revision older than an admitted
  exclusive revision, whatever that revision's outcome.

The worker must therefore record, with the failed deployment, that it failed
before stopping any predecessor, and the deployment status API must report it.
For such a failure the console shows the failure with the current revision still
serving, native admin stays available, and the supersede check ignores the
failed revision so the predecessor keeps its maintenance. A failure after the
stop keeps today's "Probably down" state.

### Compatibility

Drivers that do not implement the new stage keep today's behavior. The stage
must be idempotent and safe to repeat after a lost lease, like other preparation
stages. Its probe and pull Pods are revision-owned and are removed by the same
cleanup that removes a failed candidate.

### Security

The probe Pod receives exactly the credential the Harness would receive, in the
Agent's Namespace, under the Harness NetworkPolicy and workload identity. No
credential reaches the Gateway, the controller or a log. The probe makes one
provider request, as the startup check already does.

### Failure and recovery

- Probe or pull failure: the revision fails before any stop; the predecessor
  keeps serving, its active pointer, routes and maintenance are unchanged, and
  status reports the failure as pre-stop.
- Worker loss during pre-stop checks: the next pass repeats them; nothing has
  been stopped.
- Failure after the stop: unchanged from today (deploy a higher revision).

## Alternatives

- **Accept and document.** The Compute and harness-execution references already
  state the downtime. This leaves D95's outage on a bad credential.
- **Surge or RollingUpdate.** Rejected: two writers on ReadWriteOnce claims.
- **ReadWriteMany or per-revision claims with a copy.** Zero downtime, but
  reopens the plan 38 storage decision and SQLite-on-shared-storage risks.

## Delivery and evidence

One PR: the optional stage in the Compute contract and worker, the Kubernetes
implementation, the pre-stop failure marker in deployment status, and its
console, native admin and supersede handling. Kubernetes Compute maintainers
review the Compute contract and worker changes.

Evidence:

- Extend the exclusive-replacement cases in
  `tests/integration/postgres-worker-agent-revision.test.mjs` (fixtures in
  `tests/helpers/postgres-worker-revision-fixture.mjs` since
  [#1553](https://github.com/openclaw/openclaw-enterprise/pull/1553)): a
  replacement with a rejected credential leaves the predecessor running, its
  route active and its maintenance running, and its deployment status reports a
  pre-stop failure.
- Console and native admin tests: a pre-stop failure shows the failure without
  "Probably down" and keeps native admin available; a failure after the stop
  still shows "Probably down".
- The real-cluster case in `tests/integration/kubernetes-compute-real.test.mjs`
  measures the outage window before and after.

Docs: Compute contract, harness execution, Kubernetes Compute, API deployment
status.

## Open questions

- Should the probe run for every redeploy, or only when the credential or
  harness settings changed since the active revision (owner: Compute
  maintainers)?
- Is the startup check's provider charge acceptable twice per redeploy (probe
  and Harness startup), or should the Harness skip its own check when the probe
  passed for the same credential generation (owner: product)?
