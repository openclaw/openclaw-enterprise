---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Keep the API serving during a controller upgrade

## Proposed decision

For a qualified controller-only image change, start the candidate while the
incumbent API serves, then transfer traffic through the existing Service. Both
versions use the same PostgreSQL database and completed migration history. One
worker has dispatch authority. Authorized Console, TUI, and HTTP requests must
complete on the first attempt within ordinary deadlines. Chat may reconnect and recover an
acknowledged turn in its original conversation.

The operator runs `occ installation upgrade plan` and `apply`. The offline plan
shows the requested service level, known image eligibility, workload changes,
and checks that need the live Installation. Pair qualification remains unknown
when the incumbent digest is unavailable. Apply checks the current pair and live
conditions before changing workloads. It stops if the approved service level is
unavailable. Use the [RFC-0011 maintenance procedure](0011-coordinated-image-upgrade.md)
for the first handoff-capable chart and controller and for unsupported pairs.

Today the [upgrade helper](../../scripts/upgrade-production-images) stops both
writers before initialization. The [chart](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml)
uses one API replica and `Recreate` because sign-in limits are process-local.
The [Job](../../deploy/helm/openclaw-enterprise/templates/jobs.yaml) runs migration
and ordinary bootstrap; the [read-only verifier](../../docs/reference/settings/production.md#production-installation-bootstrap-environment)
is separate.

## Upgrade sequence

1. **Qualify before changing workloads.** Apply binds the decision to both
   controller digests, chart, ingress, and enabled Installation configuration.
   Require surge capacity, unchanged runtime and startup configuration, identical
   migration catalogs, and completed history. Verify schema and bootstrap state
   without writes, using the incumbent Installation ID obtained independently
   through its authenticated API and bound startup configuration. Refuse a missing
   or different Installation ID. Independently verify that both controllers
   share one live writable PostgreSQL database throughout overlap and on
   reconnect. A restored copy can retain the ID and history. Refuse overlap
   if database identity is uncertain. Qualify both APIs with the incumbent
   worker and the candidate API with its replacement. Each write must
   remain readable and actionable by every API and worker
   still serving. Defer an incompatible effect until its predecessors drain only
   when the operation contract permits the delay; otherwise use maintenance.
   Qualify mixed-version Console assets in a cold load and open tab. Exclude
   sessions requiring the original worker. Refuse continuous service before
   changing workloads if ingress lacks a verifiable drain signal or a live condition fails.
2. **Start the candidate without changing incumbent behavior.** Helm owns two
   API Deployments with disjoint slot selectors and a common Service selector;
   normally one slot has one replica and the other is empty. Stage a revision
   that retains the incumbent API and worker. Recheck the read-only schema and
   bootstrap conditions before the candidate becomes ready. The candidate's IAM,
   authentication, preset, and repository startup owners must serialize or defer effects that
   could change incumbent behavior before readiness.
3. **Serve the candidate.** Publish its ready endpoint only after it can
   authenticate, authorize, and reach its route dependencies. Observe an
   authenticated first attempt reach that Pod through the ordinary ingress while
   the incumbent remains healthy.
4. **Withdraw and drain the incumbent.** Target its slot and exact Pod UID.
   Mark it unready. Keep listening and give chat clients a resumable disconnect.
   The ingress owner must confirm every instance has stopped selecting the Pod
   and drained requests that can still reach it. Include pooled connections
   and requests waiting in middleware before connecting. Then fence new API
   admissions on that Pod and verify settlement of admitted work, including
   disconnected writes. Scale to zero only after both owners confirm drain.
   Empty sockets and proxy exit are insufficient. On timeout, keep listening
   and report pending work.
5. **Transfer worker authority.** Keep the candidate API serving. The deployment
   and dispatch owners must keep the restart inventory valid until transfer:
   defer work that could create an original-worker-only session, leave accepted
   work visibly pending, and release it after the replacement worker takes
   authority. Settle or recover incumbent claims before the replacement dispatches.
   Verify the expected Agent revisions and public route before completion.

## Shared state and recovery

Authentication and route owners retain admission policy; State owns shared
PostgreSQL-backed attempt, rate, and concurrency state. Preserve key scopes,
charging, slow lanes, and responses; recover abandoned concurrency reservations.
Cover raw WebSocket upgrades and reads with effects. Any enabled process-local
limit disqualifies the pair.

Resource owners serialize conflicting writes and preserve operation identity,
transactions, audit, and durable work. The dispatcher reconciles uncertain
external effects before resending.

Reuse the upgrade journal and Helm history to record submissions and slot
identities. On resume, reconcile the actual Helm revision, Pod UIDs, endpoints,
admission state, and worker claims before advancing. Keep the incumbent if the
candidate fails before serving. After candidate writes, reverse only when the
predecessor can read and act on the resulting state; otherwise keep the compatible
API serving and recover forward.

## Interface changes

### APIs

No new public routes. Existing request, authorization, and result contracts must
hold across both versions. Upgrade plan and apply gain the qualified handoff path.

### IAM

No permission changes. Both APIs enforce current authorization and revocation.

### Database entities

Shared admission state is required in PostgreSQL. Its schema and cleanup belong
to the State owner and implementation plan.

### Driver contracts

The State contract must support shared admission. No other Driver contract change
is selected here.

## Simplifications

A standard Kubernetes rolling update alone is insufficient: readiness does not
prevent startup writes, combine process-local limits, transfer worker authority,
or confirm that an operator-owned ingress has drained. Two Helm-owned slots let
the command stage, identify, drain, and recover each API explicitly. Reusing the
existing Service, State, journal, and maintenance path avoids a second upgrade
manager. A faster initialization Job only shortens the current interruption.

## Acceptance Criteria

Use the normal command, packaged images, actual ingress, PostgreSQL, IAM, and a
running Agent. Capture first attempts throughout the upgrade.

- **AC-1.** Reads, mutations, Console cold loads and open tabs, and TUI actions
  return their expected result within ordinary deadlines. Record status, latency,
  serving Pod, endpoint continuity, leading and trailing failures, and unprobed
  slots. Reach both versions. Verify an incumbent read of a candidate mutation
  and incumbent worker dispatch of candidate-queued work.
- **AC-2.** Authorization changes and shared quotas produce the same decisions
  through both APIs. Delay one ingress instance’s withdrawal. Hold a request
  between selection of the retiring Pod and connection. Require first-attempt
  success before retiring that listener. Separately, disconnect a client after
  admission. Hold its mutation before commit through ingress drain and past the
  API drain deadline. Apply must report pending work and keep the retiring
  listener running. Release the mutation, resume the handoff and verify one
  commit, one result audit record and one downstream effect without resending.
- **AC-3.** Reconnect an acknowledged chat turn through the public route, recover
  one terminal reply in the original conversation, and complete a continuation.
  After the final restart inventory, wait for the incumbent worker process to
  exit. Immediately before an authenticated deployment POST, record this Agent's
  revision and deployment-work counts. Before starting the replacement worker,
  require HTTP `202`, each count to increase by exactly one, and both new records
  to identify the returned revision. Require deployment status `queued`, zero work
  attempts, and the previous `activeRevisionId`. Start the replacement worker.
  Within the original convergence deadline, require the returned deployment to
  report `succeeded`, the Agent's
  `activeRevisionId` to match the returned revision, and exactly one successful
  activation of that revision. Submit a separate request that fails the Agent's
  `deploy` permission check and verify that revision and work-item counts do not
  change.
- **AC-4.** Refuse a restored database copy with the same Installation ID,
  administrator, and completed migration history before changing workloads,
  either database, or bootstrap outputs. Change a live condition after the offline plan and verify
  apply refuses before changing workloads. Exercise an unsupported pair, pending
  migration, failed candidate, incomplete drain, interrupted Helm submission,
  compatible reverse handoff after a write, and incompatible rollback. Verify the
  specified refusal or recovery while a compatible API remains serving.

The verifier exists. Shared admission, startup control, drain, worker transfer,
and installed pair qualification remain pending. Next, write the implementation plan.
