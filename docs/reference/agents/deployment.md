# Agent identity and deployment

Use this reference to select an [Agent](../agents.md) execution mode and understand its stable identity, immutable revision, and asynchronous deployment. Creating or editing an Agent alone does not start a workload.

## Agent service principal and workload credentials

Every Agent owns exactly one stable, platform-owned service principal.
Separate Agents receive separate service principals, even when they share a
Namespace. The service principal is immutable, belongs to its exact Agent and
Namespace, and remains the same across every revision of that Agent.

An Agent service principal does not inherit your permissions, session cookie,
provider credentials, or another Agent's identity. It has the same
role-granted capabilities as a human Principal: an appropriately scoped Role
and AccessBinding can grant any platform action, including administrative
actions and access to another Agent in the same Namespace. Its Namespace scope,
exact resource grants, and matching Restrictions still apply. The public Agent
response intentionally does not expose its internal `servicePrincipalId`.

Workload identity is execution credential evidence, not a third platform
principal. For a `dedicated` Agent, the
[Kubernetes Compute Driver](../drivers/kubernetes-compute.md) uses separate
gateway and Codex ServiceAccounts. Only Codex receives the short-lived,
audience-scoped projected token for its exact Agent's existing
`servicePrincipalId`; production requires this projection. An `embedded`
gateway necessarily shares its exact Agent's projected workload identity and
Agent-specific model credential because that same process runs the built-in
Harness. Both modes are supported in production. OCC token verification,
identity exchange, and ServicePrincipal
authentication through the controller API remain deferred.

An Agent may also reference one same-Namespace, OCC-owned
[service account](../service-accounts.md) through `serviceAccountId`; updating
the field to `null` detaches it. This optional credential reference does not
replace its ServicePrincipal or Kubernetes ServiceAccount.

## Execution mode

Each Agent explicitly records how its selected Harness runs:

- `embedded` starts one OpenClaw gateway with its built-in Harness. It is the
  default when creation omits `executionMode` and is supported in development
  and production; the combined workload receives its own Agent identity and
  model key.
- `dedicated` starts an Agent-owned gateway and a separate Codex app-server.
  Production uses separate workload identities, authenticated gateway-to-Codex
  transport, and either an operator-owned model API key or an associated
  account's directly projected access token mounted only into Codex.

The Agent's native Configuration selects a Harness through model/provider
`agentRuntime.id` policy. The [Harness execution reference](../harness-execution.md)
owns supported runtime selections, model catalogs, transport, and credential
boundaries. OCC rejects conflicting, unknown, or mode-incompatible selections
before admitting a revision. A selected SandboxDriver currently requires
`dedicated` Codex execution; it does not support embedded OpenClaw.

An Agent update may include `executionMode`, `serviceAccountId`, and `providerId`
alongside its required `configurationId`. Omission preserves the current value;
`serviceAccountId: null` detaches the account and `providerId: null` clears the
Provider. Existing revisions retain their immutable placement, account, and
Provider association.
See the
[Harness execution topology flow](../../flows/harness-execution-topology.md) for
runtime selection, identity boundaries, and activation.

## Revisions and deployment

An AgentRevision is the immutable admitted configuration for one deployment
of its owning Agent. An Agent owns an ordered revision history and at most one
active revision, identified by `activeRevisionId`. Deployment does not overwrite
an earlier revision or make the new revision active immediately.

The revision records the source `configurationId`, `configurationKind`, and
`configurationGeneration`, its complete admitted native `configuration`
document, the approved Harness identity/version/mode, selected Compute identity,
nullable `providerId`, and any associated service account's opaque credential
reference. The account association contains no credential bytes. Native Configuration values must use
unresolved inline SecretRefs because the admitted document is persisted and
returned through the API; see [secret boundaries](../configuration/secrets.md#secret-boundaries).
Nested objects and arrays are immutable.

When a SandboxDriver is selected, its `configureAgent` hook can transform a
copy of the source document before admission and snapshotting; it does not
update the reusable Configuration or its generation. The admitted revision
therefore records the source generation and the effective document after that
transformation. Its SandboxDriver selection and the Agent's stable service
principal are retained internally and are not exposed by the current HTTP
revision schema. See [SandboxDriver](../drivers/sandbox.md).

An authorized `POST /namespaces/:namespaceId/agents/:agentId/deploy` has no
request body. It requires a `ready` Namespace, exact-Agent `deploy`, exact
Configuration `read`, and exact associated-account `read` when present. A
successful `202` means the immutable revision was admitted and its work queued;
it does not mean the workload is ready. Later Configuration edits or changes to
an account's selected credential reference affect only future deployments. A
snapshot freezes a Secret reference, not the value stored at that reference.

The separate PostgreSQL controller worker prepares the exact Agent gateway and
revision, activates its route, retires its predecessor, and sets
`activeRevisionId`. Each Agent owns its gateway; sibling Agents never share
one. The default PostgreSQL-backed development Compute Driver starts Docker
runtime containers for embedded OpenClaw or dedicated Codex topologies. Selected
Kubernetes Compute starts either an Agent-owned gateway plus a dedicated
Codex workload with its separate ServiceAccount, or one embedded combined
gateway/Harness. Without a SandboxDriver, Compute owns the Codex Deployment;
with one selected, that Driver provisions the dedicated Harness workload.
Both embedded and dedicated modes are supported in production, subject to the
selected Drivers' mode constraints. A replacement must preserve
its predecessor's Service selector until activation succeeds. Without an
eligible worker, revision work remains queued.

Revision list and read operations are scoped beneath the exact Namespace and
Agent. Each returned revision requires its own authorized read; substituting a
parent does not grant access to another Agent's history. Public response shapes
are defined by the [API reference](../api.md).
