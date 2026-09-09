# ComputeDriver contract

`ComputeDriver` owns Namespace infrastructure, Agent gateways, workload
orchestration, and the AgentRevision lifecycle. OCC selects one ComputeDriver
for the Installation. A selected
[SandboxDriver](sandbox.md) can own a dedicated Harness workload while
Compute retains Namespace, gateway, identity, routing, and activation ownership.
IAM owns authorization.

The exported interface is in
[shared contracts](../../../packages/contracts/src/index.ts). See
[Driver selection](selection.md) for supported composition and package trust,
and [deployment](../../guides/deploy.md) for operator setup.

## Core lifecycle operations

- `ensureNamespace(namespace)` validates or prepares tenant placement before an
  Agent exists; providers must not require a startup-guessed Agent identity.
- Optional `bindAgent({ namespace, agent })` receives the actual server-admitted
  Namespace, Agent, and service-principal identities after IAM authorization
  and before any revision operation. A name-configured provider can use it to
  bind an existing company-specific tenant without caller-authored resource IDs.
- `prepareRevision(revision)` creates or reuses that Agent's gateway and
  realizes its immutable Harness topology: one combined gateway/Harness for
  `embedded` OpenClaw or a separate exact-revision Codex workload for
  `dedicated` execution. Compute creates the workload unless the selected
  SandboxDriver implements `provisionHarness`.
- `retireRevision(revision)` first revokes that revision's workload access,
  then stops its owned embedded gateway or dedicated Codex workload and delegates
  provider-owned Sandbox cleanup when applicable. It preserves an Agent gateway
  already owned by a replacement revision.
- `deleteNamespace(namespace)` performs provider-supported teardown; providers
  without an approved deletion path must fail closed without removing any
  Agent-owned resource or physical namespace.

Namespace, admitted Agent context, and AgentRevision identify the exact tenant,
Agent, revision, ServicePrincipal, and immutable harness placement; IAM owns
authorization. Logical Compute ownership does not require the Gateway and
Harness to share a Kubernetes cluster or a physical resource writer.
Production accepts both embedded OpenClaw and dedicated Codex.

## SandboxDriver coordination

Current startup composes a selected SandboxDriver only with bundled Kubernetes
Compute. In that composition, Compute:

1. Establishes the Namespace and baseline isolation before invoking optional
   `SandboxDriver.ensureNamespace`.
2. Prepares the Agent gateway, workload identity, approved workspace mounts,
   Services, and revision-specific Harness requirements.
3. Invokes optional `SandboxDriver.provisionHarness`; otherwise, it creates the
   ordinary Harness workload itself.
4. Waits for the exact revision's workload, activates its existing route, and
   invokes `SandboxDriver.cleanup` before removing provider-owned resources.

The SandboxDriver receives the Compute-provided Namespace context, immutable
revision, exact projected ServiceAccount identity, approved mounts, and
Secret-backed environment references. OCC remains responsible for authorization
and immutable revision admission.

## Production revision stages

`activateRevision(revision)` and `deactivateRevision(revision)` are optional in
the shared TypeScript contract. Trusted startup requires **both** on every
production-selected Compute Driver before returning a runtime; development
Drivers can implement only the four core operations. When a development Driver
implements `activateRevision`, the worker invokes it after the active-revision
commit and on finalization retry, unless the Driver selects `beforeCommit`.
The worker fails closed if
a required stage becomes unavailable during execution. Replacement preparation
preserves the predecessor's Service selector until fenced activation succeeds.

Drivers that keep one stable Agent-owned runtime across revisions can declare
`activationOrder: "beforeCommit"`. The worker then activates and verifies the
candidate before publishing its active revision and does not deactivate an
already-serving dedicated runtime during initial adoption. Existing Drivers
retain their default post-commit activation behavior. A Driver's activation
must remain idempotent and must not report success before its effective
configuration and authenticated runtime are actually ready.

## Optional gateway endpoint resolution

`getGatewayEndpoint(revision)` returns the private WSS endpoint for an admitted
AgentRevision, or `undefined` when the Driver does not support gateway access.
OCC invokes it after exact-Agent authorization and active-revision selection.
The resolver derives an address from trusted Driver settings and resource IDs;
it does not establish readiness, perform user authorization, or persist a URL in
Agent Configuration. Native connection failures remain dependency failures.

Bundled Kubernetes Compute uses this capability for
[private Agent routes](kubernetes-compute.md#private-agent-gateway-routes).
Docker and SSH do not implement it. Optional resolution does not change the required
revision lifecycle operations or grant the API Kubernetes route permissions.

## Optional active-runtime maintenance

A provider that must continuously observe and repair an already-active Agent
can declare `maintenanceIntervalMs` as a positive safe integer. After a
successful activation or maintenance pass, OCC atomically enqueues the next
exact-Agent, exact-revision reconciliation in its existing durable work queue.
The original deployment Principal remains the actor and is reauthorized before
every subsequent provider operation; revoked access therefore fails closed.

Maintenance runs `prepareRevision` again before idempotent activation. It
preserves the current active revision, stops naturally when a newer revision
supersedes it, and survives worker restarts without a separate scheduler,
provider database, or elevated service identity. Drivers without the optional
interval retain their existing event-driven lifecycle.

## Optional selected-driver hooks

An Installation-selected non-Compute Driver can expose
`computeLifecycleHooks`:

1. `afterNamespacePrepared(namespace, signal)` runs after Namespace infrastructure readiness.
2. `beforeWorkloadStart(revision, launch, signal)` runs before workload launch.
3. `beforeWorkloadStop(revision, signal)` runs before workload teardown.
4. `beforeNamespaceDelete(namespace, signal)` runs before tenant teardown.

Captured hooks run in selection order and unwind in reverse. Workload-start
hooks run before the combined embedded gateway or separate dedicated Codex;
their bounded `opaque-` environment reaches only that workload, never a
dedicated gateway. Reserved names, plaintext credentials, and changes to
images, commands, placement, networking, authorization, or immutable revision
data are rejected. Hooks must be idempotent; preparation failure compensates
completed hooks, revocation failure blocks teardown for safe retry, and
cancelled rollback receives a bounded cleanup signal.

## Implementations

- [Docker ComputeDriver](docker-compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [SSH ComputeDriver](ssh-compute.md): raw Linux hosts, embedded OpenClaw, and systemd lifecycle.
- [SandboxDriver contract](sandbox.md)
- [Docker Compose development flow](../../flows/docker-compose-development.md)
- [ComputeDriver lifecycle-hook execution flow](../../flows/compute-driver-lifecycle-hooks.md)
- [Harness execution topology flow](../../flows/harness-execution-topology.md)

## Optional initial runtime credential provisioning

`getAgentRuntimeCredentialStatus(binding)` reports whether the admitted Agent's
transport, model, and Slack credential groups are stored. The
`transportConfigured`, `modelConfigured`, and `slackConfigured` flags describe
complete, correctly owned storage; they do not probe provider authentication or
workload readiness.

`provisionAgentRuntimeCredentials(binding, input)` supports initial transport,
OpenAI API key, and optional Slack credential setup. OCC authorizes the exact
Agent and holds Namespace and Agent locks while checking that no historical
revision exists and invoking the selected Driver. Drivers receive admitted
`ComputeAgentBinding`, never caller-selected physical storage names. Unsupported
Drivers fail explicitly.

The bundled Kubernetes implementation creates missing whole Secrets and generates
transport tokens and a local gateway password internally. It rejects foreign or malformed objects and
conflicting supplied values, preserves complete matching groups on retry, and
never rotates or deletes credentials. Partial external writes survive database
or audit failure; callers must refresh stored status before retrying. Credential
values must not appear in response metadata, Configuration, audit, or errors.
See the [console workflow](../console.md#initial-runtime-credentials).
