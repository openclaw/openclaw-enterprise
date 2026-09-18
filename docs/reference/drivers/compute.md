# ComputeDriver contract

`ComputeDriver` owns Namespace infrastructure, Agent gateways, workload
orchestration, and the AgentRevision lifecycle. OCC selects one ComputeDriver
for the Installation. A selected
[SandboxDriver](sandbox.md) can own a dedicated Harness workload while
Compute retains Namespace, gateway, identity, routing, and activation ownership.
IAM owns authorization. Compare the bundled implementations in the
[ComputeDriver feature matrix](compute-matrix.md).

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
- `validateHarnessAuth(harness, auth, configuration)` validates the admitted
  Harness, immutable authentication snapshot, and native Configuration without
  side effects. Although optional in the TypeScript interface, deployment requires
  this hook: its absence is a dependency-unavailable error; a thrown validation
  error becomes a resource conflict before any revision is queued.
- `prepareRevision(revision, context)` creates or reuses that Agent's gateway and
  realizes its immutable Harness topology: one combined gateway/Harness for
  `embedded` OpenClaw or a separate exact-revision Codex workload for
  `dedicated` execution. Compute creates the workload unless the selected
  SandboxDriver implements `provisionHarness`.
- `stopRevision(revision)` idempotently removes inbound routing and terminates
  execution for the exact revision. It invokes workload-stop hooks and delegated
  Sandbox cleanup while retaining revision snapshots, runtime credentials,
  workspace data, and other Agent-owned persistent state.
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
Bundled Kubernetes supports both embedded OpenClaw and dedicated Codex with
[managed Agent harness authentication](../agents.md#harness-authentication).
Bundled SSH supports embedded OpenClaw with operator-managed `runtime`
credentials; it rejects managed bindings and dedicated Codex. Bundled Docker
rejects all harness authentication bindings.

The worker passes `ComputeRevisionContext` to preparation and activation after
reauthorizing the immutable revision. Its `harnessAuth` contains the admitted
API-key source with its current authoritative OCC backend reference, or the exact
managed-account credential and private Provider binding. For operator-managed
credentials, it contains only `{ method: "runtime" }`, with no delivery reference.
None of these forms contains credential bytes. Its separate `secretEnvironment` contains
Configuration bindings for gateway credentials. Drivers must preserve this
separation and project model credentials only into the selected Harness workload;
see the [credential delivery flow](../../flows/native-service-account-credential-delivery.md).

### Plugin startup warnings

Preparation returns readiness for the exact Namespace, Agent, and revision. A
Driver may return `warnings`, containing only an admitted `pluginId` and
`PLUGIN_INSTALL_FAILED` or `PLUGIN_AUTH_REQUIRED`. Warnings describe the current
startup attempt and may accompany `ready: true` only after failed selections
are safely disabled and the remaining runtime passes its readiness checks.

OCC stores the observed warnings with the successful deployment result under the
live worker claim. A later runtime restart recomputes plugin results; the saved
deployment result is historical, not a live plugin-health query. No receipt or
post-commit acknowledgment is required. Missing or untrusted startup status
cannot establish safe effective configuration or readiness.
The [Kubernetes startup implementation](kubernetes-compute.md#plugin-startup-status)
defines its workload coverage and transport.

## Optional startup preflight

`preflight()` verifies external dependencies before production readiness. It
may return structured warnings with a stable `code` and safe `message`; the API
and worker emit each warning as `compute.preflight-warning` and continue.
Thrown errors still block startup. Production requires preflight from the
bundled Kubernetes Compute Driver. Other implementations expose it when their
dependency checks require startup validation.

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

`activateRevision(revision, context)` and `deactivateRevision(revision)` are optional in
the shared TypeScript contract. `stopRevision` is required for every Compute
Driver. Trusted startup additionally requires both activation stages on every
production-selected Compute Driver before returning a runtime. When a development Driver
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

## Runtime logging ownership

Runtime logging ownership is a deployment design choice, independent of whether
the runtime is newly provisioned or adopted. The installed ComputeDriver declares
one of two modes:

- **Platform-managed (default):** OCC admits the logging policy described in
  [Harness execution](../harness-execution.md#runtime-logging). Bundled Docker,
  Kubernetes, and SSH Compute use this policy, with optional Collector export.
- **Deployment-managed (`runtimeLogging: "driver"`):** the runtime platform
  manages its logging configuration and collection. This allows deployments to
  use their own logging infrastructure without moving collection into ComputeDriver.

Keep the default when using the bundled logging policy. Select deployment-managed
logging only when the runtime platform provides its own configuration and
collection path; it does not automatically connect that path to OCC. Gateway and
Harness continue to emit their own logs in either mode. Neither mode requires a
separate log backend per component or routes runtime logs through the OCC API.

In deployment-managed mode, OCC preserves the native logging configuration
(after any Sandbox transformation), validates it through ConfigurationDriver,
and freezes it in the revision without imposing the bundled Collector's policy.
The Driver must reject unsupported logging changes and realize the admitted
configuration exactly; this does not permit ignoring revision fields.

The `"driver"` value declares responsibility at the Driver boundary; it does not
require the Driver to transport, store, or query logs. The Compute contract has
no runtime-log query operation. Lifecycle results and failures still reach OCC
through Driver operations, independently of the log collection path.

This declaration belongs to the trusted installed Driver, not tenant YAML or a
request option. Its operator owns runtime logging destinations, credentials,
redaction, access controls, and delivery verification. The bundled Collector's
privacy and export guarantees do not cover that separate pipeline. OCC process
logging, authorization, immutable revisions, and durable audit are unchanged.

## Optional gateway endpoint resolution

`getGatewayEndpoint(revision)` returns the private WSS endpoint for an admitted
AgentRevision, or `undefined` when the Driver does not support gateway access.
OCC invokes it after exact-Agent authorization and active-revision selection.
The resolver derives an address from trusted Driver settings and resource IDs;
it does not establish readiness, perform user authorization, or persist a URL in
Agent Configuration. Native connection failures remain dependency failures.

Bundled Kubernetes Compute uses this capability for
[private Agent routes](kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes).
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

Failed active-runtime observations, including asynchronous `bindAgent` lookups,
schedule another authorized maintenance pass without changing the active revision.
Binding failure prevents subsequent runtime effects; each new pass checks the
original actor again. New deployments retain their bounded retry budget.

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
transport and Slack credential groups are stored. The
`transportConfigured` and `slackConfigured` flags describe
complete, correctly owned storage; they do not probe provider authentication or
workload readiness.

`provisionAgentRuntimeCredentials(binding, input)` supports initial transport
and optional Slack credential setup. Model auth uses Agent `harnessAuth` and is
validated separately at deployment. OCC authorizes the exact
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
See the [console workflow](../console/create-and-deploy.md#initial-runtime-credentials).
