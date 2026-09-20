# ComputeDriver contract

## Overview

`ComputeDriver` is the OpenClaw Control Plane (OCC) boundary for preparing and
removing Namespace infrastructure and running Agent revisions. OCC selects one
Compute Driver for the Installation, admits immutable revisions, and dispatches
resource operations. Compute owns the Agent gateway, workload identity, routing,
activation, and readiness observation; its backend owns the underlying resources.
A selected [SandboxDriver](sandbox.md) can provision a dedicated Harness workload
while Compute retains those responsibilities. IAM owns platform authorization.

Start with [Driver selection](selection.md) for composition and package trust and
the [feature matrix](compute-matrix.md) for differences between current Drivers.
The [design implementation status](../../design.md#implementation-status)
distinguishes current placement from target architecture.

## Interface

The canonical [shared contracts](../../../packages/contracts/src/index.ts) export
`ComputeDriver`, its inputs and results. Every Compute Driver has an `id`, an
`implementation`, and `capability: "compute"`.

### Core lifecycle operations

| Required method                       | Inputs, result, and failure boundary                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureNamespace(namespace)`          | Prepares or validates the exact Namespace's infrastructure before an Agent exists. Returns `namespaceReady`; never require a guessed Agent identity.                                                                                                                          |
| `deleteNamespace(namespace)`          | Attempts provider-supported teardown and returns `namespaceDeleted`. A provider without an approved deletion path must fail closed without deleting Agent-owned resources or the physical namespace. OCC admits deletion only for an empty Namespace.                         |
| `prepareRevision(revision, context?)` | Creates or reuses the Agent gateway and realizes the admitted embedded OpenClaw or dedicated Codex topology. Returns `ready` for the exact Namespace, Agent, and revision, plus optional plugin warnings. `ready: false` remains pending; an invalid observation is rejected. |
| `stopRevision(revision)`              | Idempotently removes inbound routing and terminates execution for the exact revision, including applicable workload-stop hooks and delegated Sandbox cleanup. Retains revision snapshots, runtime credentials, workspace data, and other Agent-owned persistent state.        |
| `retireRevision(revision)`            | Revokes that revision's workload access before stopping its owned workload and requesting delegated cleanup. Preserves an Agent gateway already owned by a replacement revision.                                                                                              |

Namespace results identify the exact Namespace and optionally classify failure as
`retryable` or `permanent`; success requires the corresponding flag with no
failure. Revision methods that return no result must reject when their required
stage cannot complete. Although the revision context is optional in TypeScript,
the worker supplies it to preparation and activation after authorization.

### Optional additions

| Method or declaration                                                  | Caller requirement and absence                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindAgent({ namespace, agent })`                                      | Receives admitted Namespace, Agent, and ServicePrincipal identities before worker revision operations when implemented; it may be asynchronous. Failure prevents further runtime effects for that pass.               |
| `validateHarnessAuth(harness, auth, configuration)`                    | Deployment requires this side-effect-free check of the admitted Harness, authentication snapshot, and native Configuration. Absence is dependency-unavailable; a thrown error is a resource conflict before queueing. |
| `activateRevision(revision, context?)`, `deactivateRevision(revision)` | Both are required by production startup. The worker also calls activation when a development Driver provides it. See [revision stages](#production-revision-stages).                                                  |
| `setLifecycleDrivers(drivers)`                                         | Required at startup if other selected Drivers expose Compute hooks. See [selected-Driver hooks](#optional-selected-driver-hooks).                                                                                     |
| `activationOrder`, `maintenanceIntervalMs`                             | Optional scheduling declarations; see [revision stages](#production-revision-stages) and [maintenance](#optional-active-runtime-maintenance).                                                                         |

### Optional startup preflight

`preflight()` checks dependencies before production readiness. A thrown error
blocks startup; structured warnings with a stable `code` and safe `message` are
emitted by the API and worker as `compute.preflight-warning` and do not block.
Production requires preflight for bundled Kubernetes Compute; other Drivers may
omit it.

### Optional gateway endpoint resolution

`getGatewayEndpoint(revision)` returns a private WSS address from trusted Driver
settings and admitted resource IDs, or `undefined` when gateway access is
unsupported. OCC uses it after exact-Agent authorization and active-revision
selection. It does not establish readiness, authorize callers, grant backend
route permissions, or persist a URL in Agent Configuration. Connection failures
remain dependency failures. See
[Kubernetes private routes](kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
for current implementation support.

### Optional initial runtime credential provisioning

`getAgentRuntimeCredentialStatus(binding)` returns `transportConfigured` and
`slackConfigured`: whether complete, correctly owned credentials are stored.
`provisionAgentRuntimeCredentials(binding, input)` supports initial transport
setup and optionally takes Slack app and bot tokens. The caller holds Namespace
and Agent locks, requires a ready Namespace and no historical revision, and
passes admitted identities rather than physical storage names. Missing methods
fail explicitly. Partial external writes can survive database or audit failure;
refresh status before retrying. See the [initial credential workflow](../console/create-and-deploy.md#initial-runtime-credentials).

### Runtime logging ownership

Omitting `runtimeLogging` (or setting `"platform"`) selects the bundled
[Harness logging policy](../harness-execution.md#runtime-logging). With `"driver"`,
OCC preserves native logging after any Sandbox transformation, validates it through
ConfigurationDriver, and freezes it in the revision. Compute must reject
unsupported logging changes and realize the admitted configuration. The trusted
Driver operator owns destinations, credentials, redaction, access, and delivery
verification; the bundled Collector's privacy and export guarantees do not apply.
The gateway and Harness emit their own logs either way. This declaration neither
requires Compute to transport or query logs nor routes them through OCC; OCC
process logging, lifecycle results, and durable audit remain separate.

## IAM

OCC authenticates callers and asks the selected [IAMDriver](iam.md) to authorize
the exact operation. The worker reauthorizes the original actor before effects;
denial, revocation, or unavailable authority prevents dispatch. Infrastructure
credentials never replace platform authorization, and Compute cannot select a
different Principal, Namespace, Agent, or revision. Initial credential status
requires Agent `read`; provisioning requires Agent `read` and `operate`. Gateway
endpoint resolution also follows exact-Agent authorization. See [authorization](../authorization.md).

`ComputeRevisionContext.harnessAuth` carries the admitted API-key source and its
current authoritative backend reference, or the exact managed-account credential
reference and private Provider binding. Operator-managed auth carries only
`{ method: "runtime" }`. None contains credential bytes. The separate
`secretEnvironment` carries Configuration bindings for gateway credentials;
project model credentials only into the selected Harness workload. Initial
provisioning is the exception where Slack values are accepted as input: never
expose them in responses, Configuration, audit, logs, or errors. See the
[credential delivery flow](../../flows/native-service-account-credential-delivery.md).
Installed Drivers run with control-plane authority; package validation is not a
sandbox for untrusted code.

## Lifecycle

### Driver initialization and shutdown

Trusted Installation composition constructs the selected Driver for each API or
worker runtime, validates its identity and methods, attaches required hooks, and
runs applicable production preflight. The shared interface has no `initialize`,
`dispose`, or `destroy` method. Process shutdown does not delete managed resources;
resource removal uses explicit operations. See the [Driver loading flow](../../flows/driver-plugin-loading.md).

### Production revision stages

OCC freezes Compute identity, Harness placement, and Configuration into the
revision; the worker verifies the selected Compute still matches and resolves
live authority and credential references before dispatch. Replacement preparation
preserves the predecessor's route until fenced activation. Activation permits the
admitted candidate to serve; it must be idempotent and cannot succeed until
effective configuration and the authenticated runtime are ready. Deactivation is
a separate stage for an unpublished candidate; stopping execution uses the
required `stopRevision` operation.

Default `activationOrder` is `"afterCommit"`: the worker publishes the active
revision before activation and retries finalization when necessary; initial
production preparation deactivates an unpublished dedicated candidate. A Driver
that retains a stable Agent runtime may select `"beforeCommit"`; the worker then
activates the candidate before publication and avoids that initial deactivation.
A required stage that becomes unavailable fails closed.

### SandboxDriver coordination

Current startup composes a selected Sandbox only with bundled Kubernetes Compute.
Compute establishes Namespace isolation, then calls optional Sandbox Namespace
preparation. It prepares the gateway and passes the exact workload identity,
approved mounts, and Secret-backed environment when delegating dedicated Harness
provisioning; otherwise it provisions the workload itself. Compute waits for the
exact workload, activates its route, and calls Sandbox cleanup before removing
provider-owned resources. See the [Sandbox contract](sandbox.md).

### Optional selected-driver hooks

Non-Compute Drivers may expose `afterNamespacePrepared`, `beforeWorkloadStart`,
`beforeWorkloadStop`, and `beforeNamespaceDelete`. Hooks run in selection order
and unwind in reverse. Workload-start hooks affect only the combined embedded
workload or dedicated Harness, never a dedicated gateway. Their bounded `opaque-`
environment cannot contain plaintext credentials or reserved names or change
images, commands, placement, networking, authorization, or immutable revision
data. Hooks must be idempotent. Preparation failure compensates completed hooks;
revocation failure blocks teardown for retry; cancelled rollback receives a
bounded cleanup signal. See the [hook execution flow](../../flows/compute-driver-lifecycle-hooks.md).

### Optional active-runtime maintenance

`maintenanceIntervalMs` must be a positive safe integer. After activation or
maintenance, OCC atomically queues the next exact-Agent and exact-revision pass
for the original deployment Principal. The worker prepares and idempotently
activates again; failed observations, including asynchronous binding failures,
schedule another authorized pass without changing the active revision.
Maintenance survives worker restarts and ends when superseded. Without the
interval, lifecycle work is event-driven; new deployments retain bounded retries.

### Plugin startup warnings

Readiness warnings contain an admitted `pluginId` and `PLUGIN_INSTALL_FAILED` or
`PLUGIN_AUTH_REQUIRED`. They may accompany `ready: true` only after failed
selections are safely disabled and the remaining runtime is ready. OCC stores
warnings from successful deployment under the live worker claim; they are
historical, not a live health query or acknowledgment. Restart recomputes them.
Missing or untrusted startup status cannot establish readiness. See [Kubernetes
startup status](kubernetes-compute.md#plugin-startup-status).

## Limits

- Implementations differ in topology, credential support, Namespace deletion,
  and private gateway access; consult the [feature matrix](compute-matrix.md).
  Logical Compute ownership does not require a shared cluster or resource writer.
- Initial credential helpers do not rotate or delete credentials, manage model
  auth, or prove provider authentication or workload readiness.
- Compute has no runtime-log query operation. Changing the selected Driver does
  not migrate revisions frozen to the former identity.

## Troubleshooting

| Symptom                                | Check, recover, and verify                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails                          | Check selection, required production stages, hooks, and whether preflight threw. Restore the dependency or correct the Driver; verify startup reaches readiness. Preflight warnings alone do not block. |
| Deployment fails before queueing       | Check Harness/auth inputs and whether `validateHarnessAuth` exists. Correct the unsupported combination or Driver; verify a revision is admitted.                                                       |
| Revision remains unready               | Check exact observation identity, authenticated workload readiness, and trustworthy plugin startup evidence. Correct the workload or evidence and verify the revision becomes ready.                    |
| Cleanup or replacement stalls          | Check revocation, hooks, and delegated Sandbox cleanup. Correct the dependency and retry; verify cleanup or activation completes. An absent workload alone is insufficient.                             |
| Maintenance stops after policy changes | Check the original Principal's live authorization; unavailable IAM must also fail closed. Restore the intended authority or perform a newly authorized operation; verify reconciliation resumes.        |
| Credential setup partially fails       | Refresh stored status before retrying; verify required groups report configured. Stored status alone does not prove provider authentication.                                                            |

## Implementations

- [Docker ComputeDriver](docker-compute.md): development container runtime.
- [Kubernetes ComputeDriver](kubernetes-compute.md): embedded and dedicated workloads.
- [SSH ComputeDriver](ssh-compute.md): raw Linux hosts and embedded OpenClaw.

See the [comparison matrix](compute-matrix.md) for authentication and other
implementation support.

## Related

- [Harness execution](../harness-execution.md) and [Agent lifecycle](../agents.md)
- [Driver selection](selection.md) and [deployment guide](../../guides/deploy.md)
- [Controller reconciliation](../controller/reconciliation.md) and [Harness execution topology](../../flows/harness-execution-topology.md)
- [Worker lifecycle caller](../../../apps/controller/src/worker.ts) and [OCC admission and resource operations](../../../packages/occ/src/index.ts)
- [Docker Compose development flow](../../flows/docker-compose-development.md) and [verification guide](../../testing/README.md)
