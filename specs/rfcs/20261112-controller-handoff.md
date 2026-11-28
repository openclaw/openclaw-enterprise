---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Keep the API serving during a controller upgrade

## Proposed decision

For qualified controller-only upgrades, serve both APIs through the existing Service while
transferring traffic. At most one Worker may dispatch work. Authorized Console, TUI and HTTP
requests must complete on the first attempt within ordinary deadlines. Chat may reconnect and
recover an acknowledged turn in its original conversation.

`occ installation upgrade plan` shows the requested service level, workload changes, image
eligibility (unknown without the installed digest) and outstanding live checks. `apply` must refuse
if it cannot deliver that service level. Use the
[RFC-0011 maintenance procedure](0011-coordinated-image-upgrade.md) to install the first
handoff-capable controller and chart, and for unsupported pairs.

Today the [upgrade helper](../../scripts/upgrade-production-images) stops both writers before
initialization. The [chart](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml) uses
one API replica and `Recreate` because sign-in limits are process-local. The
[Job](../../deploy/helm/openclaw-enterprise/templates/jobs.yaml) runs migration and bootstrap. The
[read-only verifier](../../docs/reference/settings/production.md#production-installation-bootstrap-environment)
is separate. Installed continuous handoff remains unproven.

## Upgrade sequence

1. **Check eligibility before changing workloads.** Bind eligibility to both controller digests,
   chart, ingress and enabled Installation configuration. Require surge capacity, unchanged runtime
   and startup configuration, identical migration catalogs and completed history. Verify schema and
   bootstrap state without writes. Compare the candidate's Installation ID with the incumbent ID
   obtained independently through its authenticated API and bound startup configuration. Refuse a
   missing or different ID. Independently establish that every connection and reconnect from both
   controllers reaches the same live writable PostgreSQL database throughout overlap. A restored
   copy can retain the ID and history. Refuse uncertain database identity.

   Qualify both APIs with the incumbent Worker and the candidate API with its replacement. Every
   serving API and Worker must be able to read and act on writes made during overlap. Defer
   incompatible effects until predecessors drain only when the operation contract permits it.
   Otherwise use maintenance. Qualify mixed Console assets in a cold load and open tab. Refuse an
   [unknown or unsafe Worker replacement](../../docs/reference/repository-credentials/worker-replacement.md).
   Refuse continuous service if a live check fails or the ingress cannot acknowledge drain.

2. **Start the candidate.** Helm owns two API Deployments with disjoint slot selectors and a common
   Service selector. Normally one slot has one replica and the other is empty. Stage a revision that
   retains the incumbent API and Worker. Recheck read-only schema and bootstrap conditions before
   candidate readiness. IAM, authentication, preset and repository startup owners must serialize or
   defer effects that could change incumbent behavior before readiness.
3. **Serve the candidate.** Publish its ready endpoint after it can authenticate, authorize and
   reach route dependencies. Observe an authenticated first attempt reach that Pod through ordinary
   ingress while the incumbent remains healthy.
4. **Withdraw and drain the incumbent.** Identify its slot and exact Pod UID and mark it unready.
   Keep its listener open and give chat clients a resumable disconnect. For the Pod UID and routing
   revision, the ingress owner must record every instance's acknowledgment that it has stopped
   selecting the Pod and has zero connections or pending requests to it. Include pooled connections
   and requests waiting in middleware before connecting. New or restarted instances must honor
   withdrawal before serving. Missing or stale evidence blocks retirement.

   After those acknowledgments, fence new API admissions on the Pod. The API and database owners
   must settle admitted work, including disconnected writes, even if the Pod disappears. Track each
   admitted operation durably before it can write. Confirm its transaction has ended on the live
   database, then reconcile its resource, mutation audit and queued work by operation ID. Scale to
   zero only after ingress drain and operation settlement are confirmed. On timeout or uncertainty,
   keep listening and report pending work. A clean Pod exit, empty resource lookup or error audit
   can precede a later `COMMIT` and cannot establish settlement.

5. **Transfer Worker authority.** Before the final restart inventory, the deployment and dispatch
   owners must establish a durable pause on new incumbent claims. Settle in-flight launches, then
   recheck the inventory under that pause. Stop transfer on an unsafe or unknown result. Keep the
   pause across restarts until the incumbent loses dispatch authority. Accept eligible deployments
   as visibly queued work and release them after the replacement takes authority. Settle or recover
   incumbent claims before replacement dispatch. Verify expected Agent revisions and the public
   route before completion.

## Shared state and recovery

Authentication and route owners retain admission policy. State owns shared PostgreSQL-backed
attempt, rate and concurrency state. Preserve key scopes, charges, slow lanes and responses,
including raw WebSocket upgrades and reads with effects. Recover an abandoned concurrency
reservation only after fencing its owner so it cannot finish the protected work or release a newer
reservation. Retain charged attempts and fail closed when owner fencing or shared state is
unavailable. Any enabled process-local limit disqualifies the pair.

Resource owners serialize conflicting writes and preserve operation identity, transactions, audit
and durable work. Reconcile unknown database or external effects against the original durable
operation. Never replay an unknown effect.

Reuse the upgrade journal and Helm history to record submissions and slot identities. On resume,
reconcile the actual Helm revision, Pod UIDs, endpoints, admission state, database settlement and
Worker claims before advancing. Keep the incumbent if the candidate fails before serving. After
candidate writes, reverse only with an independently qualified reverse pair on the same live
database and schema, with the predecessor able to read and act on the resulting state. Otherwise
keep the compatible API serving and recover forward.

## Interface changes

### APIs

Existing request, authorization and result contracts hold across both versions. Upgrade plan and
apply gain the qualified handoff path. No new public routes.

### IAM

Both APIs enforce current authorization and revocation. No permission changes.

### Database entities

State owns shared admission, operation tracking and the dispatch pause in PostgreSQL.

### Driver contracts

Extend State for these guarantees. The implementation plan defines its schema and cleanup.

## Simplifications

A rolling update alone cannot prevent startup writes, share limits, confirm ingress drain or
transfer Worker authority. Two Helm slots let the existing command identify, drain and recover each
API. Faster initialization only shortens today's interruption.

## Acceptance Criteria

Use the normal command, packaged images, actual ingress, PostgreSQL, IAM and a running Agent.
Capture first attempts throughout the upgrade.

- **AC-1. First attempts.** Reads, mutations, Console cold loads and open tabs, and TUI actions
  return expected results within ordinary deadlines. Record status, latency, serving Pod, endpoint
  continuity, leading and trailing failures, and unprobed slots. Reach both versions, serving the
  Console entry module from one and its imports from the other in both directions. Verify the page
  works. Verify an incumbent read of a candidate mutation and incumbent Worker dispatch of
  candidate-queued work.
- **AC-2. Shared admission and drain.** Verify authorization, revocation and shared quotas through
  both APIs. Exercise real sign-in routes in both directions, successful sign-in, window rollover,
  administrator access, concurrent attempts and database disconnects. Kill one API after charging an
  attempt. Require the survivor to fence the owner, recover its reservation once, retain the charge
  and throttle the next over-budget request. Require refusal while fencing is uncertain and prevent
  the old owner from releasing a newer reservation.

  Delay one ingress instance's withdrawal and hold requests on pooled connections and in middleware
  for the exact retiring Pod. Require first-attempt success and keep its listener open until every
  instance acknowledges drain.

  Separately disconnect a client after admission and hold its mutation past the API drain deadline.
  Apply reports pending work and keeps the listener open. Inject a clean Pod exit while `COMMIT` is
  still pending, with an absent resource lookup and an error audit. Require the handoff to remain
  pending until authoritative database settlement identifies the original durable operation. Release
  the commit and verify one mutation, its audit and one downstream effect without resending.

- **AC-3. Chat and deployment.** Reconnect an acknowledged chat turn through the public route,
  recover one terminal reply in the original conversation and complete a continuation. Rehearse a
  deployment after the final inventory while the incumbent Worker is alive and could otherwise claim
  a launch that requires it. Repeat in a separate run after the incumbent exits and before the
  replacement starts. In both runs, immediately before the authenticated deployment POST, record
  revision and deployment-work counts. Require HTTP `202`, each count to increase by exactly one,
  both records to identify the returned revision, status `queued`, zero attempts and the previous
  `activeRevisionId` until transfer. Start the replacement Worker. Within the original convergence
  deadline, require status `succeeded`, matching `activeRevisionId` and exactly one successful
  activation. Deny a separate caller the Agent's `deploy` permission and verify both counts remain
  unchanged.
- **AC-4. Refusal and recovery.** Refuse a restored database copy with the same Installation ID,
  administrator and completed migration history before changing workloads, either database or
  bootstrap outputs. Change a live condition after the offline plan and require apply to refuse
  before changing workloads. Exercise an unsupported pair, pending migration, failed candidate,
  incomplete drain, interrupted Helm submission, independently qualified reverse handoff after a
  write on the same live database and schema, and incompatible rollback. Verify refusal or recovery
  while a compatible API remains serving.

Next, write the implementation plan.
