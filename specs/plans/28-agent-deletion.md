# Agent deletion and revision teardown

**Status:** Implemented and locally verified; PR pending.
**Issue:** [#94](https://github.com/openclaw/openclaw-enterprise/issues/94) (M3.4).
**Sequencing:** [Agent stop](29-agent-stop.md) ([#93](https://github.com/openclaw/openclaw-enterprise/issues/93))
landed first and owns the shared Agent runtime-state and queue model. This work
is rebased onto it.
**Current reference this will change:** [Agents](../../docs/reference/agents.md),
[Namespaces](../../docs/reference/namespaces.md),
[Controller reconciliation](../../docs/reference/controller.md),
[controller worker flow](../../docs/flows/controller-worker.md), and the generated
[API reference](../../docs/reference/api.md).

## Goal

Provide an authorized Agent deletion operation that retries transient cleanup
failures, removes the Agent and its AgentRevisions, tears down OCC-owned runtime
resources, and lets a Namespace be offboarded after its last Agent is removed.

## Implementation

Migration `0019_agent_deletion.sql` adds
`occ.agents.status` (`active` or `deleting`) with `agents_status_valid`, the
`occ.validate_agent_lifecycle` trigger, and `GRANT UPDATE (status)`; it relaxes
`controller_work_namespace_target_valid` and recreates
`agent_revisions_are_immutable` as `UPDATE`-only. `DELETE
/namespaces/:namespaceId/agents/:agentId` authorizes `delete` on the exact
Agent, transitions it to `deleting`, queues teardown, and answers `202`.
`AgentSchema` exposes `status`, and the bootstrap administrator Role gained the
`delete` action on `agent`, which it had never carried.

The worker binds the Agent, retires its revisions, removes Kubernetes runtime
credentials, then uses the claim-protected
`occ.finalize_agent_deletion` function to remove
the Agent, revisions, service principal, API keys, IAM references, and work rows
atomically while preserving lifecycle audit evidence.

## Current state

Before this work, the contracts and OCC exposed no Agent deletion operation;
the [Agents reference](../../docs/reference/agents.md#current-limitations) recorded
this limitation.

`deleteNamespace` rejects any Namespace that still has an Agent through
`state.namespaces.hasAgents`, and `occ.validate_namespace_lifecycle`, as
redefined in `0013_secret_state.sql`, independently raises
`a nonempty namespace cannot be tombstoned` when an `occ.agents` row for the
Namespace still exists.

Every foreign key among the Agent relationships is
`ON UPDATE RESTRICT ON DELETE RESTRICT`, with no cascade, though cascades exist
elsewhere in the schema, for example
`service_account_driver_bindings_account_owner`. `occ_app` holds `SELECT`,
`INSERT`, and column-scoped `UPDATE` on the Agent tables, but no `DELETE`.

Two constraint cycles govern deletion order. `occ.agents.active_revision_id`
references `agent_revisions` immediately, while `agent_revisions.agent_id`
references `agents`. Separately, both service-principal ownership edges are
declared `DEFERRABLE INITIALLY DEFERRED`, but their `ON DELETE RESTRICT` actions
still run immediately and must become deferred `NO ACTION` checks for teardown.
`occ.audit_events` stores `resource_kind` and `resource_id` as plain text with no
foreign key, so audit history survives deletion.

Triggers, not only privileges, forbid deletion, and triggers are not
privilege-gated, so `SECURITY DEFINER` does not bypass them. Of the records this
operation touches, only `occ.agent_revisions` carries a `DELETE`-rejecting
trigger; `iam_group_memberships` carries one too, but needs no cleanup.

The teardown primitives exist. `ComputeDriver.retireRevision` is implemented by
all three bundled Drivers and, per the
[Compute contract](../../docs/reference/drivers/compute.md), already delegates
provider-owned Sandbox cleanup during retirement. Kubernetes waits for exact
revision Pods, then deletes owned gateway, route, ConfigMaps, claims, Services,
ServiceAccount, and NetworkPolicies with ownership and observed-UID checks.

## Resolved decisions

1. **Row deletion, not a tombstone.** The acceptance criteria require the Agent
   and its revisions to be removed and state that internal revision retirement
   alone is insufficient. A tombstone also cannot satisfy Namespace offboarding:
   the lifecycle trigger rejects a Namespace tombstone while any `occ.agents` row
   remains, and `agents.configuration_id` is `NOT NULL`, so a retained Agent row
   would pin its Configuration and block Configuration deletion. Row deletion
   removes both obstacles and needs no trigger change.
2. **Workspace data and Agent credentials are destroyed with the Agent.**
   Workspace teardown already follows from the unconditional retirement path,
   which deletes the gateway private state claim and the dedicated shared
   workspace claim. Credentials need a new primitive; see below.
   Namespace-owned Secrets and Configurations are independently owned and survive.
3. **Name reuse follows automatically.** With the row deleted,
   `agents_namespace_id_name_unique` frees the name; no partial index is needed.
4. **Deletion accepts an active Agent directly.** Issue #94 requires deleting
   active as well as stopped Agents, and requiring a separate stop call first
   would add client choreography for no benefit. Deletion reuses the internal
   shutdown primitive from
   [#93](https://github.com/openclaw/openclaw-enterprise/issues/93) without
   making that issue's public endpoint a prerequisite.

## Design

### API

Add `operationId: "deleteAgent"`, `method: "DELETE"`,
`path: "/namespaces/:namespaceId/agents/:agentId"`,
`action: "openclaw.agents.delete"`, `iamAction: "delete"`,
`resourceKind: "agent"`, `authorizationTarget: "agent"`, responding `202`
with the Agent envelope plus the shared `mutationErrors`. `agent` is the
established target for exact Agent operations in the route catalog. IAM already
admits
`delete` on `agent`, so no authorization vocabulary changes. Regenerate the
contract and verify with `pnpm openapi:check`.

### Shared lifecycle model

Agent stop owns the lifecycle model, and deletion consumes it rather than
defining a competing one. Two concerns stay separate: `status` (`active` or
`deleting`) records whether the Agent is being removed, while
`desired_runtime_state` (`running` or `stopped`) records whether its workload
should run. They are orthogonal — an Agent can be stopped and then deleted — and
`0019_agent_deletion.sql` ties them together with
`CHECK (status <> 'deleting' OR desired_runtime_state = 'stopped')`. Deletion
therefore inherits the invariant that a deleting Agent is never running, which
is the precondition its teardown needs.

### Concurrency boundary

Deletion is asynchronous, so every Agent mutation must reject a `deleting` Agent
before doing work: update, deploy, runtime credential provisioning, and workspace
file writes. Without this, a revision could be admitted after the worker
enumerated the revisions to retire, leaving an orphaned workload behind. The
guard also honors `desired_runtime_state`, so it does not admit work that
contradicts a stop already in progress. Reads may continue to return the Agent
as `deleting`. These mutation guards return `409 AGENT_DELETING`; a stopped but
active Agent continues to use `409 RESOURCE_CONFLICT`. The existing
`controller_work_one_claim_per_resource` index
serializes work per Agent but does not gate the synchronous API, so this check is
the boundary. Race coverage is required, not optional.

### Work item and queue changes

Agent stop supplies this. `controller_work.agent_target` is an explicit
discriminator admitting `stopped` or `deleted`, `PlatformOperation` carries an
`agent` kind targeting either, and `PostgresWorkQueue.enqueue` no longer requires
`agentId` and `revisionId` together. Deletion uses the `deleted` target that
model already reserves.

This supersedes stage 2's implicit owner-column encoding, which was discarded
during the Agent-stop rebase.

### Worker teardown

Add an Agent branch to `apps/controller/src/worker.ts`. The handler validates the
target, ownership, reauthorization, and credential-deletion capability before it
binds the persisted Agent into Compute, retires revisions, and deletes credentials.
This rebuilds binding after a worker or SSH Driver restart. Dependency failures
retry; invalid state, ownership, authorization, or capability fails permanently.

### Agent credential cleanup

Runtime credentials can be provisioned only before the first revision but
outlive deployment. Deletion must therefore handle zero-revision and deployed
Agents. Revision retirement does not remove them, and Compute has no cleanup
counterpart.

Add `deleteAgentRuntimeCredentials?(binding: ComputeAgentBinding): Promise<void>`
to `ComputeDriver`, Agent-scoped and symmetric with the provisioning method. It
must be idempotent, succeeding when no credential exists, so retries and Agents
that never had credentials both converge. Kubernetes removes Agent-owned
transport and Slack Secrets. Model authentication now uses `harnessAuth`; its
referenced Namespace-owned Secret survives Agent deletion. Docker, SSH, and
plugin runtimes implement neither method.

A Driver that implements provisioning but not deletion must fail the deletion
closed on its first attempt with `CREDENTIAL_DELETION_UNSUPPORTED`, rather than
leave credentials behind or spend retries on a static capability mismatch. The
worker checks that capability before revision retirement. When supported, it
invokes the primitive after retirement and before database finalization, so a
runtime credential failure leaves the Agent `deleting` and retryable rather than
deleting the rows that identify the leaked Secrets.

Removing credentials contradicts the current documented Kubernetes behavior, so
[Compute](../../docs/reference/drivers/compute.md) must be corrected in the
implementing PR.

The worker must not call `SandboxDriver.cleanup` itself. `retireRevision` already
delegates Sandbox cleanup, and a second call would run teardown twice. Sandbox
cleanup stays owned by Compute.

Retirement must be idempotent so a retry after partial failure converges; the SSH
conformance suite already asserts repeated `retireRevision` calls are safe.

### Ordered deletion and privilege model

Granting `occ_app` blanket `DELETE` on the Agent and IAM tables would widen the
application role well beyond this operation. Deletion is therefore a single
migrator-owned `SECURITY DEFINER` function with `EXECUTE` granted to `occ_app`
and revoked from `PUBLIC`, `SET search_path` fixed to `pg_catalog, occ`, and an
exact signature taking the Namespace, Agent, idempotency key, and claim token.
`occ_app` receives no `DELETE` grant on any Agent, IAM, or work table, so the
function is the only deletion path. It resolves the ServicePrincipal internally
rather than accepting it as an argument, locks the Agent row and verifies its
status is `deleting`, and validates the claim token and unexpired lease before
mutating anything.

Inside one transaction, the function:

1. Clears `agents.active_revision_id`, satisfying the immediate
   `agent_active_revision_owner`.
2. Deletes `iam_access_bindings` whose subject is the ServicePrincipal, and
   `iam_access_bindings` and `iam_restrictions` whose `(resource_kind,
resource_id)` names the Agent or one of its revisions. Those resource columns
   are textual with no foreign key, so nothing else removes them and the
   authorization state would otherwise be orphaned.
3. Deletes the Agent's `agent_revisions`.
4. Deletes the ServicePrincipal `iam_identities` row, then the `occ.agents` row.
   Migration `0017` recreates both ownership edges as deferred `NO ACTION`
   constraints so the cycle validates the empty end state at commit.
5. Deletes `occ.apikey` rows whose `reference_id` is the ServicePrincipal, which
   also has no foreign key.
6. Records success evidence and deletes the Agent's `controller_work` rows last,
   including the completing item.

`iam_group_memberships` needs no cleanup. `validate_group_membership` requires
`identity_kind = 'principal'`, so a ServicePrincipal can never be a member.

### Revision immutability exception

`agent_revisions_are_immutable` rejects every revision `DELETE`, and the definer
function cannot bypass it. Recreate the trigger as `BEFORE UPDATE ON
occ.agent_revisions`, preserving content immutability, and let deletion be gated
by privilege instead: `occ_app` holds no `DELETE` on the table, so only the
migrator-owned function can remove a revision. If review prefers a trigger-level
guard as well, the alternative is to keep the `DELETE` arm and admit it only when
a transaction-local flag set inside the function is present. Leave
`audit_events_are_append_only` and `installation_cannot_be_deleted` untouched.

### Work item finalization

The Agent branch must not call the generic `PostgresWorkQueue.complete`. That
method updates the claimed `controller_work` row to `succeeded`, inserts success
evidence, and throws `WorkClaimLostError` when no row matches — which is exactly
what happens once the deletion function has removed the row.

Add a specialized finalizer to the queue that performs claim validation, success
evidence, and deletion as one atomic step, and have the Agent branch call it in
place of `complete`. Its claim-token and unexpired-lease predicates must match
`complete`'s, so a lost or expired lease still fails closed and no deletion
occurs. Every other worker branch keeps using `complete` unchanged.

### Permanent failure recovery

Permanent results and exhausted retries leave a terminal `failed_permanent` work
row. The queue does not requeue it automatically, and a repeated `DELETE` returns
the existing `deleting` Agent without creating new work. The Agent therefore
remains readable but mutation-blocked and continues to block Namespace offboarding.
No public or operator recovery path exists.

### Database changes

One new migration, `0019_agent_deletion.sql`, following the upstream harness
authentication migrations through `0018_runtime_harness_auth.sql`:
add `status` to `occ.agents` with a check constraint and
`GRANT UPDATE (status)`; relax `controller_work_namespace_target_valid`; recreate
`agent_revisions_are_immutable` as `UPDATE`-only; and create the deletion
function, revoking `EXECUTE` from `PUBLIC` and granting it to `occ_app`.
`occ.validate_namespace_lifecycle` needs no change, because no Agent row
survives, and no new table-level `DELETE` grant is issued.

Author the SQL by hand, as the existing migrations are. Grants, triggers,
`SECURITY DEFINER` functions, and these check constraints are not expressible in
`packages/occ/src/state/postgres-schema.ts`, and `migrations/meta/` holds
snapshots for only `0000` and `0002`, so generated diffs are not the authoring
path. Add the matching `_journal.json` entry with `idx: 19` and
`when: 1787000000019`, continuing the existing sequential timestamps.

The journal timestamp is load-bearing. The PostgreSQL migrator in drizzle-orm
0.45.2 selects the newest `created_at` from `drizzle.__drizzle_migrations` and
applies only migrations whose journal `when` exceeds it; the stored file hash is
never compared. Editing an already-applied migration in place is therefore
skipped silently, leaving the schema diverged from the SQL with no error. Add new
files rather than amending applied ones.

Per the repository validation boundary, keep persisted invariants in constraints
and mirror them in the in-memory adapter rather than duplicating them in
application logic. No data backfill, compatibility shim, or rollout choreography
is in scope; the platform has no production consumers, and this specification
adds no migration rollout guidance to the documentation set.

## Work breakdown

1. **Done.** Migration, `Agent` status field, repository methods, and in-memory
   adapter parity.
2. **Superseded by Agent stop.** Discard the implicit encoding and adopt
   `agent_target` during the rebase.
3. **Done.** `deleteAgent` route, OpenAPI regeneration, and the controller method
   with authorization, status transition, and audit.
4. **Done.** Status rejection in every Agent mutation path, honoring `desired_runtime_state`
   as well as `status`.
5. **Done.** Deletion function, the revision immutability change, and the queue finalizer.
6. **Done.** `deleteAgentRuntimeCredentials` on the Compute contract and in the Kubernetes
   Driver, with the corrected Compute reference.
7. **Done.** Worker teardown with retryable and permanent failure classification,
   shutdown reuse, credential cleanup, and claim-protected finalization.
8. **Done.** `hasAgents` and Namespace offboarding coverage.
9. **Done.** Documentation: remove the deletion limitation from Agents, correct the
   Namespace statement, update the controller worker flow, and record completion
   here.

Console coverage is [#95](https://github.com/openclaw/openclaw-enterprise/issues/95)
and is out of scope.

## Verification

- Conformance: delete an Agent with no revisions, with an admitted but undeployed
  revision, and with a deployed active revision. Assert `202`, the audit events,
  repeat deletion while work is nonterminal, and denial without `delete` permission.
- Credentials and k3d: assert zero-revision credential deletion; directly delete
  running embedded and dedicated Agents with an immutable runtime image. Assert
  finalization waits for exact Pods, and credential Secrets,
  PVCs, Services, ServiceAccounts, revision ConfigMaps, and Agent NetworkPolicies
  are gone while sibling resources survive. Assert idempotent absence and
  fail-closed unsupported Drivers.
- Race: attempt update, deploy, credential provisioning, and a workspace write
  against a `deleting` Agent and assert each is rejected; assert no revision can
  be admitted after teardown enumerates revisions.
- Retry: fail `retireRevision` once, then assert the retry completes and the rows
  are gone; restart the worker with a fresh SSH Driver and prove binding precedes
  retirement.
- Isolation: assert a sibling Agent, its revisions, and its ServicePrincipal
  survive, and that the Namespace's Configurations and Secrets are untouched.
- Privilege and immutability: assert `occ_app` cannot delete an Agent, revision,
  or identity directly, that revision `UPDATE` is still rejected after the
  trigger change, and that `EXECUTE` on the function is denied to `PUBLIC`.
- Finalization: assert an expired or stolen lease deletes nothing, and that
  success evidence is recorded even though the work row is removed.
- Orphan checks: assert no `iam_access_bindings` or `iam_restrictions` rows
  reference the deleted Agent or its revisions, and no `occ.apikey` row
  references its ServicePrincipal.
- Namespace: delete the last Agent and its Configurations, then assert
  `deleteNamespace` reaches the tombstone through the lifecycle trigger.
- PostgreSQL integration per [database setup](../../docs/testing/postgresql.md),
  migrating with the migrator role and running as the limited application role, to
  prove the privilege model is sufficient.
- Real-runtime Kubernetes teardown per
  [cluster setup](../../docs/testing/kubernetes.md), asserting the workload, gateway,
  route, and claims are gone while operator-owned Namespace resources remain.

## Dependencies

[#93](https://github.com/openclaw/openclaw-enterprise/issues/93) owns the
internal shutdown primitive this work reuses and the shared lifecycle model
described above. Its public stop endpoint remains no prerequisite for deletion,
which accepts an active Agent directly; the two are sequenced because they share
`occ.agents` and `controller_work`, not because deletion depends on the stop
API. Stop merges first and deletion rebases onto it.
[#99](https://github.com/openclaw/openclaw-enterprise/issues/99) owns upgrade
handling for the new lifecycle state. A dedicated rollback API and recovery from
terminal Agent-deletion work stay out of scope. Issue #94 delegates deployment
recovery to [#100](https://github.com/openclaw/openclaw-enterprise/issues/100),
which does not cover requeueing permanently failed Agent deletion.
