# ComputeDriver contract

## Overview

`ComputeDriver` manages Namespace infrastructure and Agent revisions, including
gateways, workload identity, routing, activation and readiness. OCC selects one
Driver per Installation, authorizes operations and records immutable revisions.
Backends own resources; a selected [SandboxDriver](sandbox.md) can create a
dedicated Harness.

See [Driver selection](selection.md) for supported combinations and package trust,
the [feature matrix](compute-matrix.md), and
[current versus planned placement](../../design.md#implementation-status).

## Interface

Types: [shared contracts](../../../packages/contracts/src/index.ts).
Every `ComputeDriver` has an `id`, `implementation`, and
`capability: "compute"`.

Optional `getRuntimeImages(revision)` returns
`{workload, container, image, imageId, commit, openclawCommit}` entries for
containers owned by that admitted revision. OCC requires exact Agent read
authority and calls the Driver pinned by the active revision. The
`runtime-images` API reports `undeployed` without an active revision and
`unsupported` when the Driver omits this method.

Commits must be full lowercase Git SHAs; missing IDs or provenance remain `null`.
Results exclude separate Sandbox Driver workloads. Neither Docker nor Kubernetes
[derives commits](../console/debug-fields.md#where-the-source-commit-comes-from)
from a moved tag. Kubernetes
[inspects](../console/debug-fields.md#inspection-scope) revision-owned Pods and
binds its private metadata read to the Pod UID and running container ID; both
commits apply only to containers with that image ID.

Optional `discoverHarnessModels({provider, apiKey})` returns native model IDs
and names without persisting credentials. OCC checks Agent creation authority
before calling it. Bundled Kubernetes and Docker call the official OpenAI and
Anthropic model-list APIs with bounded requests and no redirects. Discovery requires
[OCC API egress](../console/create-and-deploy.md#create-an-agent) to each
provider; it neither provisions runtime credentials nor proves model
compatibility. Unsupported or unavailable discovery permits manual model entry.

The bundled Codex OAuth device-login implementation is **Experimental**.
Optional `startHarnessDeviceAuthorization(harnessId)` returns a public challenge
and opaque private state; `pollHarnessDeviceAuthorization(privateState)` returns
pending or a native credential bundle. OCC owns authorization, scope, and Secret
custody. See the [device login flow](../../flows/native-service-account-credential-delivery.md).

### Core lifecycle operations

| Required method                       | What it does                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureNamespace(namespace)`          | Prepares or checks the Namespace's infrastructure and returns `namespaceReady`. Runs before an Agent exists; do not require or guess its ID. A `failure` may add a `reason` of at most 256 characters for the worker log, using only letters, digits, spaces and `. _ : / @ -`; it must not carry provider output or another tenant's values. |
| `deleteNamespace(namespace)`          | Returns `namespaceDeleted` after supported teardown. OCC permits deletion only for an empty Namespace. If the backend has no approved deletion path, fail without deleting the physical namespace or Agent resources.                                                                                                                         |
| `prepareRevision(revision, context?)` | Creates or reuses the Agent gateway and prepares the configured Harness workload. Returns `ready` for that Namespace, Agent, and revision, plus optional plugin warnings. `ready: false` stays pending, with an optional [`pendingReason`](../agents/deployment.md#pending-deployment-progress); OCC rejects an invalid result.               |
| `stopRevision(revision)`              | Removes inbound routing and stops execution for this revision, including applicable hooks and Sandbox cleanup. Safe to repeat; retains snapshots, runtime credentials, workspace data, and other persistent Agent state.                                                                                                                      |
| `retireRevision(revision)`            | Revokes workload access, then stops the workload and requests applicable Sandbox cleanup. Preserves an Agent gateway already owned by its replacement.                                                                                                                                                                                        |

Namespace results can mark a failure `retryable` or `permanent`; success
requires a true flag and no failure.
Methods without a return value must reject if they cannot complete. The revision
context is optional in TypeScript; the worker supplies it after authorization.

### Human runtime access

Browser access requires `listAgentRuntimeRoles(configuration)` and
`getAgentRuntimeAccess(revision, principalId, runtimeRole)`; other Drivers may
omit both. Saved Configuration supplies assignable roles without a runtime;
immutable active Configuration supplies deployed summaries.

Admission returns a private endpoint and server-owned person/role headers, or an
unavailable reason. Unknown roles and unsupported transport fail closed; service
endpoints cannot substitute. Kubernetes supports browser access;
Docker and SSH do not. See [Runtime access](../agent-native-admin.md).

### Optional additions

| Method or declaration                                                  | When it is needed                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindAgent({ namespace, agent })`                                      | Receives the approved Namespace, Agent, and ServicePrincipal before the worker operates on a revision; may be asynchronous. Failure stops that attempt before further runtime work.                                                                                                           |
| `validateHarnessAuth(harness, auth, configuration)`                    | Deployment and provisioning require this side-effect-free check of the Harness, authentication snapshot, and native Configuration. A missing method is a dependency-unavailable error. A thrown `ConfigurationHarnessError` answers `400` with its message; other errors become a conflict.   |
| `validateGatewaySettings(configuration)`                               | Optional side-effect-free deployment check after `validateHarnessAuth`. Throw `ComputeGatewaySettingError` for a native gateway setting every preparation would refuse; OCC answers `409` with its message, which names the setting and never its value. Leave other refusals to preparation. |
| `activateRevision(revision, context?)`, `deactivateRevision(revision)` | Production startup requires both. The worker also calls activation if a development Driver provides it. See [revision stages](#production-revision-stages).                                                                                                                                   |
| `setLifecycleDrivers(drivers)`                                         | Startup requires it when another selected Driver provides [Compute hooks](#optional-selected-driver-hooks).                                                                                                                                                                                   |
| `describePrepareRevisionFailure(error)`                                | Returns bounded safe fields for rejected preparation. OCC attributes them to the revision without serializing the raw error. Omission preserves generic retries.                                                                                                                              |
| `resolveSandboxNamespace`, `withdrawCredentialSource`                  | [Credential Gateway](credential-gateway.md#optional-additions) hooks for registration and withdrawal.                                                                                                                                                                                         |
| `activationOrder`, `maintenanceIntervalMs`                             | Control [activation timing](#production-revision-stages) and optional [maintenance](#optional-active-runtime-maintenance).                                                                                                                                                                    |
| `requiresStoppedPredecessors(revision)`                                | A side-effect-free declaration, derived from the admitted revision, that opts into [exclusive replacement](#production-revision-stages).                                                                                                                                                      |

### Optional startup preflight

`preflight()` checks dependencies before production startup completes; a thrown
error blocks startup. The API and worker log warnings as `compute.preflight-warning`
and continue; each has a stable `code` and a log-safe `message`.
Bundled Kubernetes Compute requires it in production.

### Optional gateway endpoint resolution

`getGatewayEndpoint(revision)` returns a private WSS address derived from trusted
Driver settings and approved resource IDs, or `undefined` if gateway access is
unsupported. OCC calls it after authorizing access to the Agent and selecting
its active revision. The method does not check readiness, authorize the caller,
grant backend route permissions, or save a URL in Agent Configuration. Connection
errors are dependency failures.

Workspace-file access uses this endpoint;
[Agent native admin UI](../agent-native-admin.md#agent-host-identity) uses
`getAgentRuntimeAccess`. Kubernetes implements
[private routes](kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes).

### Optional initial runtime credential provisioning

`getAgentRuntimeCredentialStatus(binding)` returns `transportConfigured` when
complete generated transport credentials are stored.
`provisionAgentRuntimeCredentials(binding, input)` accepts an empty input object and
sets up those credentials. The caller holds Namespace and Agent locks,
requires a ready Namespace with no earlier revision, and passes approved
identities, never storage names. Missing methods fail. External writes can
survive database or audit failure.

Agent provisioning also requires `validateAgentProvisioning({ executionMode,
configuration })`. A thrown `ComputeGatewaySettingError` reaches the caller as a
`409` naming the setting, and the worker stores it as a permanent
`PROVISIONING_REJECTED`. `DependencyUnavailableError` stays a retryable
dependency failure. Any other error becomes a fixed `409`, with the first 512
characters of its message logged as `reason`.

With `requiresAgentRuntimeCredentials: true`, OCC checks stored status and
[creates missing transport credentials](../console/create-and-deploy.md#initial-runtime-credentials)
before the first revision; later revisions cannot regenerate them.

`deleteAgentRuntimeCredentials(binding)` is the idempotent teardown counterpart.
During Agent deletion, the worker calls it after retiring every revision and
before removing the Agent's database identity. Kubernetes Compute deletes the
Agent's workspace setup Secret, transport Secret, and
[owned claims](kubernetes-compute/storage-and-credentials.md#harness-storage),
which revision retirement retains; absence is success. Namespace-owned Harness
model authentication survives Agent deletion.
A Driver that supports provisioning but not deletion fails Agent deletion
permanently on its first worker attempt; one with neither method is unaffected.

### Startup failure evidence

`ComputeReadiness.runtimeFailure` optionally reports a bounded startup failure,
collected and classified by Compute, for the exact observed revision: safe
`component`, `check`, `checkedAt`, `code`, and optional
[`cause`](../agents/deployment.md#model-check-failure-cause) fields, never
credentials or provider errors. An unavailable or untrusted observation omits it.

Runtimes hold published evidence until restart, so the worker
[fails at once](../controller/reconciliation.md#deferred-namespace-and-agent-convergence)
with `RUNTIME_` plus the code (`RUNTIME_CPU_STARVED` for
`MODEL_PROBE_CPU_STARVED`; `RUNTIME_STARTUP_FAILED` for `UNAVAILABLE` and
`INCOMPATIBLE_RESPONSE`); other codes persist at the convergence deadline. The
[deployment status API](../agents.md#deployment-status) returns saved evidence
without invoking Compute.

### Optional runtime diagnostics

After [OCC authorization](../agents.md#current-runtime-diagnostics),
`diagnoseAgentDeployment(binding)` returns current checks for an exact revision
using its approved Namespace and Agent. The Driver maps native evidence to generic `component`, `check`, `state`,
nullable `checkedAt` and optional safe `code` fields. It verifies runtime
identity, bounds size and time, and omits credentials, provider output and logs.
OCC rejects mismatched revisions, invalid timestamps, more than 32 checks and
unsupported states.

The call does not update deployment work, rerun the startup probe, send
messages, or prove a model response. Missing support returns dependency
unavailable; Drivers unable to collect safe evidence should omit the method.

### Optional runtime status and logs

`describeAgentRuntime(binding, signal, options)` returns Pod status, restarts,
Events and log sources of a revision, or one source without Events;
`readAgentRuntimeLogs(binding, request)` returns bounded **raw** lines from a
listed Pod. Drivers re-check ownership and raise
`RuntimeLogsForbiddenByClusterError` for a cluster `403`; OCC [redacts and bounds](../../guides/topics/agent-logs.md) output. Without them,
or with `runtimeLogging: "driver"`, both routes answer `501`.

### Runtime logging ownership

Omitting `runtimeLogging` or setting it to `"platform"` uses the bundled
[Harness logging policy](../harness-execution.md#runtime-logging). With `"driver"`,
OCC preserves native logging after any Sandbox changes, validates it through
ConfigurationDriver, and records it in the immutable revision. Compute must
apply that configuration and reject unsupported changes. The Driver operator owns
log destinations, credentials, redaction, access, and delivery; the bundled
Collector's privacy and export guarantees do not apply.

The gateway and Harness emit their own logs in either mode. OCC does not
transport them, and neither OCC nor Compute streams, stores or exports them;
authorized readers fetch bounded, redacted pages on demand through the Driver. OCC process logs, lifecycle results and audit records use their own paths.

## IAM

OCC authenticates callers and asks the selected [IAMDriver](iam.md) to authorize
each operation on its resource. The worker rechecks the original caller's
authority before doing the work and stops if access is denied or revoked, or IAM
is unavailable. Backend credentials cannot replace platform authorization. Compute cannot choose a different Principal, Namespace,
Agent, or revision.

Reading initial credential status requires Agent `read`; provisioning, including
automatic creation before the first revision, requires Agent `read` and `operate`. See [authorization](../authorization.md).

`ComputeRevisionContext.harnessAuth` holds, without credential values, the
approved API-key source and its current backend reference, the managed-account
credential reference and private Backend binding, the current
[credential source](../credential-sources.md) record, or
`{ method: "runtime" }` for operator-managed authentication. The separate
`secretEnvironment` holds Configuration bindings for gateway credentials. Deliver
model credentials only to the selected Harness workload. Channel tokens are
ordinary Namespace Secrets referenced by Configuration `secretBindings`; never expose
them in responses, Configuration, audit, logs, or errors. See the [credential delivery flow](../../flows/native-service-account-credential-delivery.md).
Installed Drivers run with control-plane privileges. Validating a package does
not isolate untrusted code.

## Lifecycle

### Driver initialization and shutdown

At startup, each API or worker process constructs the selected Driver from trusted
Installation configuration, validates its identity and methods, attaches required
hooks, and runs production preflight when required or provided. The interface has
no `initialize`, `dispose`, or `destroy` method; stopping the process does not
delete managed resources. See the [Driver loading flow](../../flows/driver-plugin-loading.md).

### Production revision stages

OCC records the Compute identity, Harness placement, and Configuration in the
immutable revision. Before dispatch, the worker checks that the selected Compute
still matches, [rechecks authorization](#iam), and resolves current credential references.
By default, the previous route serves while the replacement prepares; activation
checks that the active revision is still the expected one, then switches the
route so the candidate serves. Activation must be safe to repeat and requires the
configured runtime to be ready and authenticated. Deactivation is a separate
stage for an unpublished candidate; `stopRevision` stops execution.

With the default `activationOrder: "afterCommit"`, the worker publishes the
active revision before activating it, retries finalization when needed, and on
the first production deployment deactivates an unpublished dedicated candidate.
A Driver that keeps one stable Agent runtime can select `"beforeCommit"` to
activate the candidate before publishing it and skip that initial deactivation. If a required stage becomes unavailable, the worker cannot proceed.

When `requiresStoppedPredecessors(revision)` returns `true`, the worker closes
earlier credential sessions and calls `stopRevision` for every earlier snapshot,
including failed candidates, before preparing that revision. Later passes
re-stop after failures and doubling lease intervals. Stop must wait for resource
release, preserve durable data, and be safe to repeat; a stop failure prevents
preparation. The Driver owns backend-specific termination and Sandbox cleanup.

A newer admitted exclusive revision supersedes older reconciliation and
maintenance, even while the old revision remains the last committed active
pointer, so no old pass recreates a competing runtime. This mode accepts
downtime without automatic rollback: deploy a higher revision instead.

### SandboxDriver coordination

A selected Sandbox works only with bundled Kubernetes Compute. Compute isolates
the Namespace, calls the Sandbox's optional Namespace setup, and either passes
[prepared workload inputs](sandbox.md#provisioning-inputs) to a Sandbox that
creates the dedicated Harness or creates it itself. It waits for the workload,
activates its route and calls Sandbox cleanup before removing provider
resources. See the [Sandbox lifecycle](sandbox.md#admission-and-lifecycle).

### Optional selected-driver hooks

Other selected Drivers may provide `afterNamespacePrepared`, `beforeWorkloadStart`,
`beforeWorkloadStop`, and `beforeNamespaceDelete`. Hooks run in selection order;
cleanup runs in reverse. Startup hooks affect the combined embedded workload or
the dedicated Harness, never a dedicated gateway. Their limited `opaque-`
environment cannot contain plaintext credentials or reserved names. Hooks cannot
change images, commands, placement, networking, authorization, or revision data.

Hooks must be safe to repeat. Failed preparation undoes completed hooks; failed
revocation waits for a retry; cancelled rollback gets a separate, time-limited
cleanup signal. See the [hook execution flow](../../flows/compute-driver-lifecycle-hooks.md).

### Optional active-runtime maintenance

`maintenanceIntervalMs` must be a positive safe integer. After activation or
maintenance, OCC atomically queues another pass for the same Agent, revision and
original deployment Principal, which prepares and activates the revision again.
Failed observations schedule another authorized pass without changing the active
revision. Maintenance survives worker restarts and ends when a newer revision
replaces or [supersedes](#production-revision-stages) it. Without an interval,
lifecycle work responds to events. New deployments have limited retries.

### Plugin startup warnings

Readiness warnings contain an approved `pluginId` and either `PLUGIN_INSTALL_FAILED`
or `PLUGIN_AUTH_REQUIRED`. The Driver returns `ready: true` only after safely
disabling failed plugins with the rest of the runtime ready. OCC records
warnings from a successful deployment while the worker still owns the job; the
record is neither a live health check nor an acknowledgment, and restarting
recalculates it. Missing or untrusted startup status cannot
prove readiness. See [Kubernetes startup status](kubernetes-compute.md#plugin-startup-status).

## Limits

- Implementations differ in topology, credentials, Namespace deletion, and
  private gateway access; see the [feature matrix](compute-matrix.md). The gateway
  and Harness need not share a cluster or a component that writes their resources.
- Initial credential helpers cannot rotate credentials, manage model
  authentication, or prove that credentials work or workloads are ready.
- Selecting a different Driver does not migrate revisions that recorded the
  previous Driver's identity.

## Troubleshooting

| Symptom                                 | What to check                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails                           | The selected Driver, required production stages, hooks, and preflight errors; preflight warnings alone do not block startup. Fix it and confirm startup.   |
| Deployment fails before work is queued  | The Harness and authentication settings, and whether `validateHarnessAuth` exists. Fix the combination or Driver and confirm OCC creates a revision.       |
| Revision stays unready                  | The reported Namespace, Agent and revision, workload readiness and authentication, and plugin startup-status trust. Fix it and confirm readiness.          |
| Cleanup or replacement stalls           | Revocation, hooks, and Sandbox cleanup; a missing workload alone does not prove cleanup succeeded. Fix it and retry until cleanup or activation completes. |
| Maintenance stops after a policy change | The original Principal's authority and IAM availability. Restore the permission or start a newly authorized operation; confirm reconciliation resumes.     |
| Credential setup partially fails        | Refresh stored status before retrying; confirm the required groups report configured. That does not prove the provider accepts them.                       |

## Implementations

- [Docker ComputeDriver](docker-compute.md): development container runtime.
- [Kubernetes ComputeDriver](kubernetes-compute.md): embedded and dedicated workloads.
- [SSH ComputeDriver](ssh-compute.md): raw Linux hosts and embedded OpenClaw.

## Related

- [Harness execution](../harness-execution.md) and [Agent lifecycle](../agents.md)
- [Driver selection](selection.md) and [deployment guide](../../guides/deploy.md)
- [Agent deployment diagnostics flow](../../flows/agent-deployment-diagnostics.md)
- [Controller reconciliation](../controller/reconciliation.md) and [Harness execution topology](../../flows/harness-execution-topology.md)
- [Worker source](../../../apps/controller/src/worker.ts) and [OCC admission and resource operations](../../../packages/occ/src/index.ts)
- [Docker Compose development flow](../../flows/docker-compose-development.md) and [verification guide](../../testing/README.md)
