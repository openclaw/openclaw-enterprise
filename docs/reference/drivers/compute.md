# ComputeDriver contract

## Overview

`ComputeDriver` prepares and removes Namespace infrastructure and runs Agent
revisions. OCC selects one Driver per Installation, authorizes operations, and
stores immutable revision configurations. Compute owns gateway, workload
identity, routing, activation, and readiness; its backend owns underlying
resources. A selected [SandboxDriver](sandbox.md) can create a dedicated Harness
workload.

See [Driver selection](selection.md) for supported combinations and package trust,
the [feature matrix](compute-matrix.md) to compare Drivers, and the
[design status](../../design.md#implementation-status) for differences between
current and planned placement.

## Interface

The [shared contracts](../../../packages/contracts/src/index.ts) define the types.
Every `ComputeDriver` has an `id`, `implementation`, and
`capability: "compute"`.

The optional `getRuntimeImages(revision)` method observes containers belonging to
that admitted revision and returns `{workload, container, image, imageId, commit, openclawCommit}`
entries. OCC requires exact Agent read authority and calls the Driver pinned by
the active revision. The `runtime-images` API reports `undeployed` without an
active revision and `unsupported` when the Driver omits this method.

Docker reads each owned container's immutable image, its OCI revision label and
`org.openclaw.image.revision` (the OpenClaw commit), even if the tag has moved.
Kubernetes reads image references and IDs from revision-owned Pods, including
init and ephemeral containers. Its private runtime metadata read is bound to the Pod UID and running
container ID; both commits apply only to containers with that same image ID.
Commits must be full lowercase Git SHAs. Missing IDs or provenance remain `null`.
These observations do not inventory separate Sandbox Driver workloads.

The optional `discoverHarnessModels({provider, apiKey})` returns native model IDs
and names without persisting credentials. OCC checks Agent creation authority
before calling it. Bundled Kubernetes and Docker call official OpenAI and
Anthropic model-list APIs with bounded requests and no redirects. Discovery
requires OCC API egress; it neither provisions runtime credentials nor proves
model compatibility. Unsupported or unavailable discovery permits
[manual model entry](../console/create-and-deploy.md).

The bundled Codex OAuth device-login implementation is **Experimental**.
Optional `startHarnessDeviceAuthorization(harnessId)` returns a public challenge
and opaque private state; `pollHarnessDeviceAuthorization(privateState)` returns
pending or a native credential bundle. OCC owns authorization, scope, and Secret
custody. See the [device login flow](../../flows/native-service-account-credential-delivery.md).

### Core lifecycle operations

| Required method                       | What it does                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureNamespace(namespace)`          | Prepares or checks infrastructure for the specified Namespace. Returns `namespaceReady`. Runs before an Agent exists; do not require or guess its ID.                                                                                                                                                                           |
| `deleteNamespace(namespace)`          | Returns `namespaceDeleted` after supported teardown. OCC permits deletion only for an empty Namespace. If the backend has no approved deletion path, fail without deleting the physical namespace or Agent resources.                                                                                                           |
| `prepareRevision(revision, context?)` | Creates or reuses the Agent gateway and prepares the configured Harness workload. Returns `ready` for that Namespace, Agent, and revision, plus optional plugin warnings. `ready: false` stays pending, with an optional [`pendingReason`](../agents/deployment.md#pending-deployment-progress); OCC rejects an invalid result. |
| `stopRevision(revision)`              | Removes inbound routing and stops execution for this revision, including applicable hooks and Sandbox cleanup. Safe to repeat; retains snapshots, runtime credentials, workspace data, and other persistent Agent state.                                                                                                        |
| `retireRevision(revision)`            | Revokes workload access, then stops the workload and requests applicable Sandbox cleanup. Preserves an Agent gateway already owned by its replacement.                                                                                                                                                                          |

Namespace results can mark a failure `retryable` or `permanent`; success
requires a true flag and no failure.
Methods without a return value must reject if they cannot complete. The revision
context is optional in TypeScript; the worker supplies it after authorization.

### Optional additions

| Method or declaration                                                  | When it is needed                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindAgent({ namespace, agent })`                                      | Receives the approved Namespace, Agent, and ServicePrincipal before the worker operates on a revision. It may be asynchronous. Failure stops that attempt before further runtime work.                                                              |
| `validateHarnessAuth(harness, auth, configuration)`                    | Deployment requires this check of the Harness, authentication snapshot, and native Configuration. It must have no side effects. A missing method causes a dependency-unavailable error; a thrown error becomes a resource conflict before queueing. |
| `activateRevision(revision, context?)`, `deactivateRevision(revision)` | Production startup requires both. The worker also calls activation if a development Driver provides it. See [revision stages](#production-revision-stages).                                                                                         |
| `setLifecycleDrivers(drivers)`                                         | Startup requires it when another selected Driver provides [Compute hooks](#optional-selected-driver-hooks).                                                                                                                                         |
| `resolveSandboxNamespace`, `withdrawCredentialSource`                  | [Credential Gateway](credential-gateway.md#optional-additions) hooks for registration and withdrawal.                                                                                                                                               |
| `activationOrder`, `maintenanceIntervalMs`                             | Control [activation timing](#production-revision-stages) and optional [maintenance](#optional-active-runtime-maintenance).                                                                                                                          |

`requiresStoppedPredecessors(revision)` opts into [exclusive replacement](#production-revision-stages).
It must be a side-effect-free declaration derived from the admitted revision.

### Optional startup preflight

`preflight()` checks dependencies before production startup completes. A thrown
error blocks startup. The API and worker log warnings as `compute.preflight-warning`
and continue; each warning has a stable `code` and a `message` safe to log.
Bundled Kubernetes Compute requires preflight in production; other Drivers may
omit it.

### Optional gateway endpoint resolution

`getGatewayEndpoint(revision)` returns a private WSS address derived from trusted
Driver settings and approved resource IDs, or `undefined` if gateway access is
unsupported. OCC calls it after authorizing access to the Agent and selecting
its active revision. The method does not check readiness, authorize the caller,
grant backend route permissions, or save a URL in Agent Configuration. Connection
errors are dependency failures.

Workspace-file access uses the returned WSS endpoint. The opt-in
[Agent native admin UI](../agent-native-admin.md#agent-host-identity) derives an
HTTPS base with the same authority and path for native proxying. A missing
method or unsupported endpoint prevents native admin access.
See [Kubernetes private routes](kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
for the bundled route implementation.

### Optional initial runtime credential provisioning

`getAgentRuntimeCredentialStatus(binding)` returns `transportConfigured` when
complete generated transport credentials are stored.
`provisionAgentRuntimeCredentials(binding, input)` accepts an empty input object and
sets up those transport credentials. Channel credentials use Namespace Secrets
and Configuration `secretBindings`. The caller holds Namespace and Agent locks
and requires a ready Namespace with no earlier revision. It passes approved
identities, never storage names. Missing methods fail. External writes can
survive database or audit failure; refresh status before retrying. See the
[initial credential workflow](../console/create-and-deploy.md#initial-runtime-credentials).

`requiresAgentRuntimeCredentials: true` means the Driver needs generated
transport credentials to deploy. OCC checks stored status for these Drivers and
creates missing credentials before the first revision with the caller's exact
Agent `read` and `operate` permission. Later revisions cannot regenerate them.
Other Drivers skip this deployment step.

`deleteAgentRuntimeCredentials(binding)` is the idempotent teardown counterpart.
During Agent deletion, the worker calls it after retiring every revision and
before removing the Agent's database identity. Kubernetes Compute deletes
the admitted Agent-owned private-state and Harness-workspace claims, workspace
setup Secret, and transport Secret; absence is success. Revision retirement
retains those claims. Namespace-owned Harness model authentication survives Agent deletion.
A Driver that supports provisioning but not deletion fails Agent deletion
permanently on its first worker attempt. Drivers that implement neither optional
method are unaffected.

### Startup failure evidence

`ComputeReadiness.runtimeFailure` optionally reports a bounded startup failure
for the exact observed revision. Compute owns collection and classification. Evidence contains safe
`component`, `check`, `checkedAt`, and `code` fields, never credentials or raw
provider errors. An unavailable or untrusted observation omits the evidence.

Runtimes hold published evidence until restart, so the worker fails at once
with `RUNTIME_` plus the code (`RUNTIME_CPU_STARVED` for
`MODEL_PROBE_CPU_STARVED`; `RUNTIME_STARTUP_FAILED` for `UNAVAILABLE` and
`INCOMPATIBLE_RESPONSE`). It persists other codes at the convergence deadline. The
[deployment status API](../agents.md#deployment-status) returns saved evidence
under exact-revision read permission without invoking Compute.

### Optional runtime diagnostics

`diagnoseAgentDeployment(binding)` returns current checks for an exact revision
using its approved Namespace and Agent. OCC first authorizes exact Agent read
and operate and revision read.

The Driver maps native evidence to generic `component`, `check`, `state`,
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
transport, store or export them; an authorized reader can fetch a bounded,
redacted page on demand through the Driver. OCC process logs, lifecycle results
and audit records use their own paths.

## IAM

OCC authenticates callers and asks the selected [IAMDriver](iam.md) to authorize
each operation on its resource. The worker rechecks the original caller's
authority before doing the work and stops if access was denied or revoked, or IAM
is unavailable. Backend credentials cannot replace
platform authorization. Compute cannot choose a different Principal, Namespace,
Agent, or revision.

Reading initial credential status requires Agent `read`; provisioning requires
Agent `read` and `operate`. Resolving a gateway endpoint also requires access to
that Agent. See [authorization](../authorization.md).

`ComputeRevisionContext.harnessAuth` contains the approved API-key source and
its current backend reference, the managed-account credential reference and
private Backend binding, the current [credential source](../credential-sources.md)
record, or just `{ method: "runtime" }` for operator-managed authentication.
None contains credential values.
The separate `secretEnvironment`
contains Configuration bindings for gateway credentials. Deliver model credentials
only to the selected Harness workload. Channel tokens are ordinary Namespace Secrets
referenced by Configuration bindings; never expose them in responses, Configuration,
audit, logs, or errors. See the [credential delivery flow](../../flows/native-service-account-credential-delivery.md).
Installed Drivers run with control-plane privileges. Validating a package does
not isolate untrusted code.

## Lifecycle

### Driver initialization and shutdown

At startup, each API or worker process constructs the selected Driver from trusted
Installation configuration, validates its identity and methods, attaches required
hooks, and runs production preflight when required or provided. The shared
interface has no `initialize`, `dispose`, or `destroy` method. Stopping the process does not delete
managed resources. See the [Driver loading flow](../../flows/driver-plugin-loading.md).

### Production revision stages

OCC records the Compute identity, Harness placement, and Configuration in the
immutable revision. Before dispatch, the worker checks that the selected Compute
still matches, rechecks authorization, and resolves current credential references.
By default, while preparing a replacement, the worker preserves the previous route until
activation checks that the active revision is still the expected one and switches
the route. Activation lets the candidate serve; it must be safe to repeat and
requires the configured runtime to be ready and authenticated. Deactivation is a
separate stage for an unpublished candidate;
use `stopRevision` to stop execution.

With the default `activationOrder: "afterCommit"`, the worker publishes the
active revision before activating it and retries finalization when needed. On the
first production deployment, it deactivates an unpublished dedicated candidate.
A Driver that keeps one stable Agent runtime can select `"beforeCommit"`; the
worker then activates the candidate before publishing it and skips that initial
deactivation. If a required stage becomes unavailable, the worker cannot proceed.

A Driver may implement `requiresStoppedPredecessors(revision)` to return `true`
for workloads needing exclusive preparation. Before preparing that revision,
the worker closes earlier credential sessions and calls `stopRevision` for every
earlier snapshot, including failed candidates. Later passes re-stop after
failures and doubling lease intervals. Stop must wait for resource release,
preserve durable data, and be safe to repeat. A stop failure prevents
preparation. The Driver owns backend-specific termination and Sandbox cleanup.

A newer admitted exclusive revision supersedes older reconciliation and
maintenance, even while the old revision remains the last committed active
pointer, so no old pass recreates a competing runtime. This mode accepts
downtime without automatic rollback: deploy a higher revision instead. Other
Drivers keep the default ordering.

### SandboxDriver coordination

A selected Sandbox works only with bundled Kubernetes Compute. Compute isolates
the Namespace and calls the Sandbox's optional Namespace setup. If the Sandbox
creates the dedicated Harness, Compute passes the workload identity, approved
mounts and Secret-backed environment references; otherwise it creates the
workload. It waits for the workload, activates its route and calls Sandbox
cleanup before removing provider resources. See the [Sandbox contract](sandbox.md).

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
revision. Maintenance survives worker restarts and ends when a newer
revision replaces it, or is admitted with exclusive replacement enabled. Without
an interval, lifecycle work responds to events. New deployments have limited retries.

### Plugin startup warnings

Readiness warnings contain an approved `pluginId` and either `PLUGIN_INSTALL_FAILED`
or `PLUGIN_AUTH_REQUIRED`. The Driver returns `ready: true` only after safely
disabling failed plugins with the rest of the runtime ready. OCC records
the warnings from a successful deployment while the worker still owns the job.
The record is neither a live health check nor an acknowledgment.
Restarting recalculates the warnings. Missing or untrusted startup status cannot
prove readiness. See [Kubernetes startup status](kubernetes-compute.md#plugin-startup-status).

## Limits

- Implementations differ in topology, credentials, Namespace deletion, and
  private gateway access; see the [feature matrix](compute-matrix.md). The gateway
  and Harness need not share a cluster or a component that writes their resources.
- Initial credential helpers cannot rotate credentials, manage model
  authentication, or prove that credentials work or workloads are ready.
- Compute reads bounded log pages on demand; it cannot stream, store or export
  them. Selecting a different Driver does not migrate revisions that recorded the
  previous Driver's identity.

## Troubleshooting

| Symptom                                 | What to check                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails                           | Check the selected Driver, required production stages, hooks, and preflight errors. Fix the cause and confirm startup; preflight warnings alone do not block it.      |
| Deployment fails before work is queued  | Check the Harness and authentication settings and whether `validateHarnessAuth` exists. Fix the combination or Driver and confirm OCC creates a revision.             |
| Revision stays unready                  | Check the reported Namespace, Agent and revision, workload readiness and authentication, and plugin startup-status trust. Fix the cause and confirm readiness.        |
| Cleanup or replacement stalls           | Check revocation, hooks, and Sandbox cleanup. Fix it and retry; confirm cleanup or activation completes. A missing workload alone does not prove cleanup succeeded.   |
| Maintenance stops after a policy change | Check the original Principal's authority and IAM availability. Restore the intended permission or start a newly authorized operation; confirm reconciliation resumes. |
| Credential setup partially fails        | Refresh stored status before retrying; confirm the required groups report configured. It does not prove the provider accepts them.                                    |

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
