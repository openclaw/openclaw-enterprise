# Feature Spec: Milestone 1.6 — Agents and Immutable AgentRevisions: contract

[Spec overview](../1.6-agents-and-immutable-agent-revisions.md). Original record; decisions and status are preserved.

## Contract

### Agent draft and workload identity

`Agent.draft_spec` is the mutable JSON-object configuration users edit. Store it
in `occ.agents.draft_spec`; an omitted creation value defaults to `{}`. Agent
reads expose the saved draft, and an exact-Agent `update` operation replaces it.
The draft is arbitrary opaque safe JSON: apply the existing body-size, nesting
depth, JSON-object, and prototype-pollution protections, but do not interpret
generic keys as resource references or invent reference syntax. Milestone 1.6
supports no draft resource-reference mechanism. An Agent's name, Namespace,
and stable workload identity are not draft fields.

Agent creation authorizes `create` on its exact Namespace collection; draft
replacement authorizes `update` on the exact Agent. Both mutations append
attributable audit evidence in their resource transaction. Add the existing
`update` permission to the development administrator's Agent grants. Add a narrow
`GRANT UPDATE (draft_spec)` for the PostgreSQL application role while retaining
its existing `GRANT UPDATE (active_revision_id)`; never replace or revoke the
existing activation permission. Neither mutation
enqueues Compute work or changes an admitted revision or active pointer.

The public HTTP contract is exact:

- `POST /namespaces/:namespaceId/agents` accepts
  `{ "name": "...", "draft_spec": { ... } }`, with `draft_spec` optional and
  defaulting to `{}`, and returns `201 AgentResponse`.
- `AgentResponse.data` and Agent list entries expose `draft_spec` and the
  existing optional `activeRevisionId`, in addition to existing public Agent
  fields; they never expose the workload identity.
- `PATCH /namespaces/:namespaceId/agents/:agentId` accepts exactly
  `{ "draft_spec": { ... } }` and returns `200 AgentResponse`.
- Bodyless `POST /namespaces/:namespaceId/agents/:agentId/deploy` returns
  `202 AgentRevisionResponse`.
- `GET /namespaces/:namespaceId/agents/:agentId/revisions` returns
  `200 AgentRevisionListResponse`.
- `GET /namespaces/:namespaceId/agents/:agentId/revisions/:revisionId` returns
  `200 AgentRevisionResponse`.

Both revision response types use the existing `{ data, meta }` envelope, with a
single revision or an array respectively. Each public revision contains exactly
`id`, `namespaceId`, `agentId`, `revision`, `draft_spec`,
`harness: { id, version }`, `compute: { id, implementation }`, and `createdAt`.
The public API never returns workload identity identifiers or credentials.

OCC already creates one `WorkloadIdentity` with each Agent in the same
transaction. Retain the current exact `(namespaceId, agentId)` ownership,
one-per-Agent constraint, and immutable identity relationship. Every revision
inherits that identity. `IAMDriver` authorizes identities; `ComputeDriver`
consumes the selected identity; neither provisions the OCC-owned identity. Test
fixtures may pass the trusted Agent/revision/identity tuple without a bearer
token. Runtime credentials and Kubernetes attestation remain out of scope.

### Harness and immutable admission

The Harness is one server-selected, singleton-scoped descriptor containing its
stable ID and version. Select it in existing controller composition; callers
cannot choose it, change its version, or supply an Installation. It is not a
new platform resource, Driver, IAM target, executable process, or database
table.

Bodyless `POST /namespaces/:namespaceId/agents/:agentId/deploy` deploys the
persisted draft; its request cannot replace configuration. Before admission,
OCC resolves only the exact Namespace, Agent, and stable workload identity;
authorizes `deploy` on that exact Agent through the selected `IAMDriver`;
validates the saved draft as an opaque safe JSON object; checks the
server-selected Harness descriptor and selected Compute implementation; and
requires `Namespace.status === "ready"`. That status already certifies the
backing Namespace and its one gateway. There are no other supported resource
references to resolve or authorize in Milestone 1.6; later milestones own any
new protected resource references and their independent authorization.

Lock the exact Agent, deep-copy its latest `draft_spec`, assign the next
per-Agent revision number, and insert one immutable `AgentRevision`. Reuse
existing revision ownership, ID, number, and admission-time columns; persist the
complete admitted snapshot in `agent_revisions.admitted_spec`:

```json
{
  "draft_spec": { "model": "local-codex" },
  "harness": { "id": "codex-local", "version": "1.0.0" },
  "compute": {
    "id": "compute-local-development",
    "implementation": "deterministic-local-development"
  }
}
```

The Harness values above illustrate server-selected identity and version; they
do not prescribe installation, executable discovery, or a production runtime.
Namespace, Agent, and revision identities already exist in relational columns;
the workload identity is inherited from immutable Agent ownership. Do not
duplicate those fields or `installationId` in the snapshot. Every admitted
revision must contain the complete pinned snapshot. PostgreSQL is the
authoritative validator: enforce the exact top-level and nested keys, JSON
types, and nonempty Harness and Compute descriptor values with the
`agent_revisions_admitted_snapshot` database constraint. The in-memory adapter
mirrors that invariant; PostgreSQL repository readers and workers trust the
persisted shape instead of duplicating structural validation. Remove old
controller-level revision-construction helpers and admit application revisions
through the canonical authorized deployment path. Persistence conformance
fixtures may exercise the underlying storage primitive directly with fully
pinned snapshots. Do not preserve, rewrite, filter, or adapt unpinned
historical revision formats.

Insert the revision, append deployment audit evidence, and enqueue its initial
revision work in one transaction. A denial, invalid draft, unavailable selected
dependency, or unready Namespace creates no revision, work, or Compute effect.
Deployment responds with the admitted revision and asynchronous accepted state;
list/exact reads expose only revisions the caller is authorized to read.

### Revision work, activation, and failure

Keep Namespace work scoped to its existing `ready` and `deleted` targets. Reuse
the current candidate-revision semantic key for the entire replacement effect:

```text
agent_revision:<revisionId>:reconcile
```

Each item belongs to the exact Namespace, Agent, revision, and initiating
actor. Retain existing owner foreign keys, idempotent enqueueing, claim-token
fencing, bounded retries, and the partial unique index that serializes work per
Agent while allowing sibling Agents to progress independently. PostgreSQL must
accept exactly two durable work shapes: Namespace lifecycle items with a
`ready` or `deleted` target, and fully owned AgentRevision items with both Agent
and revision identifiers. Reject metadata-only Agent operations and malformed
queue rows at the database boundary; creating or updating an Agent never
enqueues work. Process only canonical admitted revisions containing pinned
Harness and Compute metadata; do not introduce a compatibility path for
preexisting unpinned revisions or obsolete work.

The existing worker claims Namespace and AgentRevision work. Before each effect,
reload current
IAM policy, resolve the exact Agent and immutable revision, reauthorize
`deploy` on that Agent, require a ready Namespace, verify the stable workload
identity, and require the pinned Harness and Compute descriptors to match the
currently selected runtime. Trust the database-validated persisted revision
shape; do not repeat structural snapshot validation in the worker. Revocation
or a runtime mismatch fails closed; an unavailable
dependency retries without substituting another identity or implementation.
If a newer revision has already activated, terminally supersede an older
retried candidate under the existing claim fence and append attributable audit
evidence without preparing it, retiring the newer revision, or changing the
active pointer.

For one claimed candidate item, call
`ComputeDriver.prepareRevision(candidate)` and validate that its readiness
observation identifies the exact Namespace, Agent, and revision. If an earlier
revision is active, call `ComputeDriver.retireRevision(previous)` next. Both
Driver effects are idempotent and run outside database transactions. Then use
the existing fenced transaction to renew the same claim, lock the Agent,
compare its previous active pointer, set `agents.active_revision_id` to the
candidate, append lifecycle audit, and complete the work atomically.

Candidate preparation failure before predecessor retirement preserves both the
previous active pointer and its workload. An ambiguous or unverifiable
retirement, lost claim, wrong-owner observation, failed audit, or failed
completion cannot publish a new active pointer. If idempotent fake retirement
already succeeded before the claim is lost or fenced activation fails, the old
pointer may temporarily remain even though that predecessor has been retired;
Milestone 1.6 has no executable workload, route, or workload-authentication
surface whose availability or routing could be guaranteed during that interval.
Recover the same candidate item: its next valid claim idempotently prepares the
candidate, retries retirement of the same predecessor, and publishes activation
only after verifying its own live claim. Atomic external cutover, stronger
retirement observation, and verified rollback belong to a later real runtime.
Runtime progress comes from queue state and the existing active pointer; add no
queue column, revision target, mutable revision status, draft resource,
published pointer, Agent generation, or second worker.

### Gateway and sandbox boundaries

Namespace provisioning already reconciles exactly one gateway through the
existing `ComputeDriver.ensureNamespace`; OCC sets Namespace readiness only
after both Namespace and gateway are ready. Agent deployment checks that status
but never creates, replaces, or deletes the gateway. Concrete local-test gateway
and child-process execution belong to Milestone 1.7.

The selected Driver capabilities remain exactly `iam` and `compute`. Do not
add `SandboxDriver`, sandbox policy resources, sandbox snapshot metadata, or
claims of containment enforcement in Milestone 1.6. Production sandboxing and
workload authentication remain later capabilities.

