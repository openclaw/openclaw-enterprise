# Agent stop without revision mutation

**Status:** Implementing.
**Issue:** [#93](https://github.com/openclaw/openclaw-enterprise/issues/93) (M3.3).
**Current reference this will change:** [Agents](../../docs/reference/agents.md),
[Agent deployment](../../docs/reference/agents/deployment.md),
[ComputeDriver](../../docs/reference/drivers/compute.md), bundled Compute Driver
references, [controller worker flow](../../docs/flows/controller-worker.md), and the
generated [API reference](../../docs/reference/api.md).

## Goal

Provide an authorized, retryable stop operation that removes an Agent from
execution and routing without creating, replacing, or deleting an AgentRevision.
Keep the stopped revision and Agent-owned persistent data available for inspection
and a later deployment.

## Current state

There is no stop route or OpenClaw Control Plane (OCC) controller method.
Deployment admits an immutable AgentRevision, queues revision-scoped work, and
eventually publishes its ID as `Agent.activeRevisionId`. The worker continuously
reconciles a selected Compute Driver's active revision when that Driver requests
maintenance.

The existing `ComputeDriver.deactivateRevision` stage is not a stop primitive. It
protects candidate publication: Kubernetes disconnects a Service selector while
the candidate is staged, SSH only verifies the revision because its supported
topology does not need candidate deactivation, and Docker does not implement the
optional stage. None of those behaviors guarantees that both inbound routing and
runtime execution have ceased.

`retireRevision` is also the wrong public-stop primitive. It owns destructive
revision retirement: Kubernetes can remove gateway state and shared-workspace
claims, SSH removes the revision snapshot, and a selected SandboxDriver is cleaned
up as part of retirement. Stop must terminate execution while retaining database
history, runtime credentials, persistent state, and workspace data.

The durable queue already serializes claimed work by Agent. That prevents two
workers from mutating one Agent runtime concurrently, but queue serialization does
not express user intent. A deployment admitted before a later stop, or an already
queued maintenance pass, could otherwise reactivate the Agent after stop.

## Resolved decisions

1. **Desired state and observed activation are separate.** Add
   `Agent.desiredRuntimeState: "running" | "stopped"`. New Agents start stopped,
   deployment sets the intent to running, and stop sets it to stopped.
   `activeRevisionId` continues to identify the observed serving revision and is
   cleared only after provider shutdown succeeds.
2. **Stop does not create or mutate a revision.** The active revision row and its
   admitted contents remain byte-for-byte unchanged. Historical revision numbering
   is unaffected.
3. **Resume uses the existing deploy operation.** Deploying a stopped Agent admits
   the next immutable revision and sets the desired state to running. This issue
   adds no start endpoint and does not reactivate an old revision in place.
4. **Persistent Agent data survives.** Runtime credentials, gateway private state,
   shared workspace data, Configurations, Secrets, and ServiceAccounts are not
   deleted. Ephemeral gateway and Harness processes may be removed and recreated.
5. **Repeated stops are accepted and safe.** Each request gets distinct server-owned
   work identity. A worker that finds no active revision completes successfully as
   already stopped; Driver shutdown is idempotent after partial or completed work.
6. **Deletion is a follow-up.** This change does not add Agent lifecycle status or
   deletion. The later deletion change can reuse the same internal shutdown
   mechanics before performing destructive cleanup.

## Design

### API and controller transaction

Add `operationId: "stopAgent"`, `method: "POST"`,
`path: "/namespaces/:namespaceId/agents/:agentId/stop"`,
`action: "openclaw.agents.stop"`, `iamAction: "operate"`,
`resourceKind: "agent"`, and `authorizationTarget: "agent"`. Return `202` with
the Agent envelope and shared mutation errors. The response records stopped
intent immediately; `activeRevisionId` may remain present until the worker proves
shutdown. Regenerate the contract and verify it with `pnpm openapi:check`.

Within one OCC transaction, lock the exact Namespace and Agent, authorize
`operate` on that Agent, set `desiredRuntimeState = "stopped"`, append uniquely
identified Agent-scoped stop work, and record the accepted mutation audit. Do not
require a `ready` Namespace:
an authorized safety stop must remain available while Namespace provisioning or
provider health is degraded. A missing or foreign Agent fails without revealing a
cross-Namespace resource.

Deployment must set `desiredRuntimeState = "running"` in the same transaction that
admits its revision and work item. Its worker checks that intent before external
preparation, before publishing `activeRevisionId`, and before maintenance repair.
If a later stop changes intent after `prepareRevision` has started a candidate
Harness, the worker must call `stopRevision` for that candidate before completing
the deployment as superseded; declining to publish its route alone would leave
execution running. Maintenance applies the same cleanup if stopped intent arrives
during repair. Conversely, a deployment admitted after stop sets running intent,
so stale or retried stop work that has not begun a provider effect completes as
superseded and the later request wins.

### Agent-scoped work target

Stop introduces Agent-scoped work with the explicit target `"stopped"`. Persist
`agent_target` on `controller_work`; the follow-up deletion change can extend the
target union with `"deleted"` without changing the stop contract. The database
constraint must admit exactly three unambiguous shapes:

- Namespace work has `namespace_target` and no Agent or revision.
- Agent work has an Agent and `agent_target`, but no revision or Namespace target.
- Revision deployment or maintenance has an Agent and revision, but neither
  lifecycle target.

Carry `agentTarget` through the queue's enqueue, claim, row validation, and
operation persistence layers. Stop work uses a fresh bounded server-generated
suffix in its idempotency key. A permanent key such as `agent:<id>:stopped` is
incorrect because its succeeded row would suppress stopping the Agent again after
a later deployment.

### Compute shutdown contract

Add required `stopRevision(revision: AgentRevision): Promise<void>` to
`ComputeDriver`. It must verify the revision's exact selected Driver and ownership,
cease both execution and traffic, invoke `beforeWorkloadStop` lifecycle hooks, and
be idempotent when some or all runtime resources are already absent. Keep
`deactivateRevision` as the candidate-publication stage; changing its meaning
would break the existing activation protocol.

Refactor each bundled Driver so `stopRevision` and `retireRevision` share one
internal shutdown implementation without invoking lifecycle or Sandbox cleanup
twice. Retirement calls shutdown before its additional destructive cleanup.

- Kubernetes first disconnects external and Agent Services/routes, then stops the
  embedded gateway or the dedicated gateway and Harness. For an externally owned
  Sandbox workload, Compute invokes the selected SandboxDriver's idempotent
  revision cleanup. It retains runtime credential Secrets, gateway-private and
  shared-workspace claims, Configurations, NetworkPolicies, and ownership markers.
- Docker invokes lifecycle revocation and removes the exact Agent and gateway
  containers. Its current writable runtime is container-local tmpfs, not
  supported persistent Agent state; PostgreSQL resources and external credentials
  remain.
- SSH stops and disables the exact systemd unit and removes its `current` pointer,
  but retains the revision snapshot, Agent home, state, and operator credentials.

Installed Compute packages must implement the new required method. Production and
development startup fail closed when the selected Driver lacks it; accepting stop
and leaving execution running is not a supported fallback.

### Worker and finalization

Dispatch Agent work by `agentTarget`. For `stopped`, reauthorize the recorded actor
for exact-Agent `operate`; revoked identity or permission produces attributable
denial evidence and no provider mutation. Stop does not reauthorize the Agent's
Secret or ServiceAccount dependencies because revoking execution must not depend
on credentials needed only to start it.

Before beginning a provider effect, verify that the current desired state is still
stopped; otherwise complete stale work as superseded. If `activeRevisionId` is
absent, append an `ALREADY_STOPPED` lifecycle outcome and complete. Otherwise load
that exact immutable revision, validate its Agent, ServicePrincipal, and selected
Compute identity, and call `stopRevision` under the normal claim heartbeat.
Dependency failure leaves the active pointer intact so an unsuperseded stop can
retry; a later deployment owns recovery once it changes intent back to running.

After shutdown succeeds, finalize in one claim-protected transaction: lock the
Agent and verify it still names the stopped revision, clear `activeRevisionId`
with a compare-and-set, append
`openclaw.agents.lifecycle.stop` success evidence naming the revision and Compute
Driver, and complete the work item. Clear that exact observed pointer even if a
later deployment changed desired intent while shutdown was in flight: the old
revision did stop, and the later Agent-serialized deployment will publish its own
revision after readiness. A lost or expired lease changes no database state.
Queued maintenance observes stopped intent and completes without preparing,
activating, or scheduling another pass; maintenance already in preparation shuts
its candidate down before completion.

### Database and contract changes

Add `desired_runtime_state text NOT NULL DEFAULT 'stopped'` to `occ.agents`, a
`running`/`stopped` check, and a column-scoped grant to `occ_app`. Enforce at the
database boundary that a newly inserted Agent starts stopped. Mirror the invariant
in the in-memory adapter.

Add nullable `agent_target` to `occ.controller_work`, update its target-shape check,
and validate `stopped`. Update the Drizzle schema and authored migration without
changing an already-applied migration. The follow-up deletion migration owns any
extension of this target shape.

Expose `desiredRuntimeState` in the Agent contract and generated API. This is
desired intent, not the timestamped serving observation owned by
[#96](https://github.com/openclaw/openclaw-enterprise/issues/96).

## Work breakdown

1. Agent desired-runtime contract, persistence, constraints, and adapter parity.
2. Explicit Agent work targets across platform operations and the durable queue.
3. Authorized stop route, controller transaction, acceptance audit, and OpenAPI.
4. Required `stopRevision` contract and bundled Kubernetes, Docker, and SSH
   implementations, including Sandbox coordination.
5. Worker stop dispatch, reauthorization, claim-safe finalization, and maintenance
   suppression.
6. Deploy/stop ordering.
7. Current reference, Driver reference, flow, guide, and navigation updates.

Console coverage belongs to [#95](https://github.com/openclaw/openclaw-enterprise/issues/95)
and is outside this implementation PR.

## Verification

- API conformance: stop an active Agent with exact `operate`, receive `202`, and
  observe `desiredRuntimeState = "stopped"`; deny absent and cross-Namespace
  permission with attributable audit evidence.
- Lifecycle: prove execution and inbound routing cease, `activeRevisionId` clears,
  no revision is created or changed, and acceptance plus lifecycle outcome are
  audited.
- Repetition and recovery: stop an undeployed or already-stopped Agent, issue
  concurrent repeated stops, lose a claim, and fail shutdown once; all retries
  converge without duplicate destructive effects.
- Ordering: cover deploy-then-stop and stop-then-deploy admission, plus a queued
  or in-flight maintenance item. Inject stop after candidate preparation and
  assert the unaccepted candidate is shut down. The later user intent wins and
  maintenance never resurrects a stopped Agent.
- Resume: deploy after completed stop, assert revision number increments exactly
  once, the new revision becomes active, and the stopped revision remains readable
  and unchanged.
- Isolation and retention: a sibling Agent keeps serving; runtime credentials,
  persistent claims/workspace files, Configurations, Secrets, ServiceAccounts, and
  revision history survive stop.
- Driver conformance: Kubernetes, Docker, and SSH stop execution idempotently and
  reject foreign ownership; `retireRevision` still performs its additional cleanup
  without double lifecycle or Sandbox calls.
- Real Kubernetes: with both embedded and dedicated/OpenShell fixtures, verify no
  Agent or gateway Pod remains reachable or executing while Agent-owned credential
  Secrets and persistent claims remain. Then deploy again and prove a model turn
  only when the testing guide's real-runtime credentials are available.
- PostgreSQL integration: exercise the limited application role, target-shape
  constraints, claim loss, compare-and-clear, audit persistence, and concurrent
  ordering against the migrated database.

## Dependencies

This specification lands after the cleanup behavior in
[#81](https://github.com/openclaw/openclaw-enterprise/issues/81), which supplies
the containment-only Sandbox cleanup semantics reused by stop. Agent deletion is
a follow-up: it may extend Agent-scoped work with a `deleted` target and call
`retireRevision`, which reuses the internal stop implementation. It must not call
public stop or create a second work item.

[#96](https://github.com/openclaw/openclaw-enterprise/issues/96) owns richer
deployment outcomes and timestamped serving observations. This issue exposes only
the desired state and existing active-revision pointer needed for safe stop.
