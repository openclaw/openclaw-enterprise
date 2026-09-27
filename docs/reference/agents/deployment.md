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
exact resource grants, and matching Restrictions still apply. Authorized Agent
responses expose this internal `servicePrincipalId` as a read-only identifier
so administrators can bind exact IAM policy to the Agent-owned principal.
Create and update requests cannot set or replace it.

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
[service account](../service-accounts.md) through
`harnessAuth: { method: "chatgpt_service_account", serviceAccountId }`; setting
`harnessAuth` to `null` clears it. This credential binding does not
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

An Agent update may include `executionMode`, `harnessAuth`, and `backendId`
alongside its required `configurationId`. Omission preserves the current value;
`harnessAuth: null` clears authentication and `backendId: null` clears the
Backend. Existing revisions retain their immutable placement, auth binding, and
Backend association.
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
nullable `backendId`, and `harnessAuth` with its resolved internal source snapshot.
The auth snapshot contains no credential bytes; public revisions omit private
backend locators and Backend/workspace metadata. Native Configuration values must use
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
Configuration `read`, and, for managed credentials, the selected
[harness source permissions](../agents.md#harness-authentication). If the selected
Compute Driver requires generated transport credentials and they are missing
before the first revision, deployment also requires exact-Agent `read` and
`operate` to create them. Missing credentials after any historical revision
block deployment and require operator investigation. A
successful `202` means the immutable revision was admitted and its work queued;
it does not mean the workload is ready. Later Configuration edits or changes to
an account's selected credential reference affect only future deployments. A
snapshot freezes a Secret reference, not the value stored at that reference.

The separate PostgreSQL controller worker prepares the exact Agent gateway and
revision, activates its route, retires its predecessor, and sets
`activeRevisionId`. Each Agent owns its gateway; sibling Agents never share
one. Kubernetes Compute supports managed authentication; SSH Compute supports
embedded OpenClaw with [operator-managed runtime credentials](../drivers/ssh-compute.md#credentials-and-supported-boundaries).
Docker rejects authentication bindings. Each Driver rejects unsupported bindings
and topologies before deployment. Kubernetes Compute starts either an Agent-owned gateway plus a dedicated
Codex workload with its separate ServiceAccount, or one embedded combined
gateway/Harness. Without a SandboxDriver, Compute owns the Codex Deployment;
with one selected, that Driver provisions the dedicated Harness workload.
Both embedded and dedicated modes are supported in production, subject to the
selected Drivers' mode constraints. A replacement must preserve
its predecessor's Service selector until activation succeeds. Without an
eligible worker, revision work remains queued.

When creation included [initial workspace files](../agents.md#initial-contents-at-creation),
the worker passes private setup state to Compute before starting execution.
Compute must support initialization in the exact Agent's durable workspace;
unsupported Drivers or storage layouts fail deployment. Native setup, file
application, and the durable completion marker must succeed before the gateway
or Harness runs. A `202` deployment response does not establish that this gate
has passed. After activation, OCC clears staged contents and retains setup
identity and completion metadata. Later revisions check completion without
reapplying the original text, preserving edits made in the live workspace.

Revision list and read operations are scoped beneath the exact Namespace and
Agent. Each returned revision requires its own authorized read; substituting a
parent does not grant access to another Agent's history. Public response shapes
are defined by the [API reference](../api.md).

## Stop and resume

In the console, open the Agent, select **Stop Agent**, and confirm. Use
**Refresh stop status** to reread its desired state and selected revision.
Resume through **Create new version** → **Deploy new version**. See the
[console controls](../console.md#stop-and-resume-an-agent) for request recovery.

`POST /namespaces/:namespaceId/agents/:agentId/stop` is bodyless and requires
exact-Agent `operate`. A `202` response means OCC committed `desiredRuntimeState:
"stopped"` and queued Agent-scoped work; it does not claim Compute has already
finished. The worker reauthorizes the original actor, invokes the selected
Compute Driver's idempotent `stopRevision`, and clears the exact
`activeRevisionId` only after shutdown succeeds.

Stop terminates inbound routing and execution while retaining the immutable
revision, Agent credentials, gateway state, and workspace. It neither creates a
revision nor calls destructive revision retirement. Repeated stop requests
converge safely, and one Agent's stop does not affect siblings.

Deployment is the resume operation. It admits the next immutable revision and
sets desired state to `running`; OCC never restarts an old revision by mutating
it. Revision preparation and maintenance recheck desired state before publication,
so work that overlaps a stop shuts down its candidate instead of resurrecting the
Agent.
