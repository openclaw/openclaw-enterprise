# ComputeDriver contract

## Overview

`ComputeDriver` prepares and removes Namespace infrastructure and runs Agent
revisions. OpenClaw Control Plane (OCC) selects one Compute Driver per
Installation, authorizes operations, and records each revision's configuration;
that record cannot change. Compute manages the Agent gateway, workload identity,
routing, and activation; it also reports when the workload is ready. Its backend owns the underlying
resources. A selected [SandboxDriver](sandbox.md) can create a dedicated Harness
workload; Compute keeps its other responsibilities.

See [Driver selection](selection.md) for supported combinations and package trust,
the [feature matrix](compute-matrix.md) to compare Drivers, and the
[design status](../../design.md#implementation-status) for differences between
current and planned placement.

## Interface

The [shared contracts](../../../packages/contracts/src/index.ts) define the types.
Every `ComputeDriver` has an `id`,
an `implementation`, and `capability: "compute"`.

The optional `getRuntimeImages(revision)` method observes containers belonging to
that admitted revision and returns `{workload, container, image, imageId, commit, openclawCommit}`
entries. OCC requires exact Agent read authority and calls the Driver pinned by
the active revision. The `runtime-images` API reports `undeployed` without an
active revision and `unsupported` when the Driver omits this method.

Docker reads the immutable image attached to each owned container and its OCI
revision label plus `org.openclaw.image.revision` for the upstream OpenClaw commit,
even if the configured tag has moved. Kubernetes reads image
references and IDs from revision-owned Pods, including init and ephemeral
containers. Its private runtime metadata read is bound to the Pod UID and running
container ID; both commits apply only to containers with that same image ID.
Commits must be full lowercase Git SHAs. Missing IDs or provenance remain `null`.
These observations do not inventory separate Sandbox Driver workloads.

The optional `discoverHarnessModels({provider, apiKey})` method returns native
model IDs and names for Agent setup without persisting credentials. OCC checks
Agent creation authority before calling it. Bundled Kubernetes and Docker use
the official OpenAI and Anthropic model-list APIs with bounded requests and no
redirects. Discovery does not provision runtime credentials or establish model
compatibility; unsupported or unavailable discovery permits manual model entry.
The call runs in the OCC API process and requires its egress access to the
selected provider; see [Agent setup](../console/create-and-deploy.md).

### Core lifecycle operations

| Required method                       | What it does                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureNamespace(namespace)`          | Prepares or checks infrastructure for the specified Namespace. Returns `namespaceReady`. Runs before an Agent exists; do not require or guess its ID.                                                                                                               |
| `deleteNamespace(namespace)`          | Returns `namespaceDeleted` after supported teardown. OCC permits deletion only for an empty Namespace. If the backend has no approved deletion path, fail without deleting the physical namespace or Agent resources.                                               |
| `prepareRevision(revision, context?)` | Creates or reuses the Agent gateway and prepares the configured embedded OpenClaw or dedicated Codex workload. Returns `ready` for that Namespace, Agent, and revision, plus optional plugin warnings. `ready: false` stays pending; OCC rejects an invalid result. |
| `stopRevision(revision)`              | Removes inbound routing and stops execution for this revision, including applicable hooks and Sandbox cleanup. Safe to repeat; retains snapshots, runtime credentials, workspace data, and other persistent Agent state.                                            |
| `retireRevision(revision)`            | Revokes workload access, then stops the workload and requests applicable Sandbox cleanup. Preserves an Agent gateway already owned by its replacement.                                                                                                              |

Namespace results identify the Namespace and can mark a failure `retryable` or
`permanent`. Success requires a true flag and no failure.
Methods without a return value must reject if they cannot complete. The revision
context is optional in TypeScript; the worker supplies it to preparation and
activation after authorization.

### Optional additions

| Method or declaration                                                  | When it is needed                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindAgent({ namespace, agent })`                                      | Receives the approved Namespace, Agent, and ServicePrincipal before the worker operates on a revision. It may be asynchronous. Failure stops that attempt before further runtime work.                                                              |
| `validateHarnessAuth(harness, auth, configuration)`                    | Deployment requires this check of the Harness, authentication snapshot, and native Configuration. It must have no side effects. A missing method causes a dependency-unavailable error; a thrown error becomes a resource conflict before queueing. |
| `activateRevision(revision, context?)`, `deactivateRevision(revision)` | Production startup requires both. The worker also calls activation if a development Driver provides it. See [revision stages](#production-revision-stages).                                                                                         |
| `setLifecycleDrivers(drivers)`                                         | Startup requires it when another selected Driver provides [Compute hooks](#optional-selected-driver-hooks).                                                                                                                                         |
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
[Agent native admin UI](../agent-native-admin.md#agent-host-identity) derives
an HTTPS base with the same authority and Agent path for native HTTP and
WebSocket proxying; the Driver method's WSS return contract stays unchanged.
A missing method or unsupported endpoint prevents native admin access.
See [Kubernetes private routes](kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
for the bundled route implementation.

### Optional initial runtime credential provisioning

`getAgentRuntimeCredentialStatus(binding)` returns `transportConfigured`: whether
complete generated transport credentials are stored for this Agent.
`provisionAgentRuntimeCredentials(binding, input)` accepts an empty input object and
sets up those transport credentials. Channel credentials use Namespace Secrets and
Configuration `secretBindings` instead of this endpoint. The caller holds Namespace
and Agent locks and requires a ready Namespace with no earlier Agent revision. It
passes approved identities, never physical storage names. Missing methods return an
error. External writes can survive a database or audit failure; refresh status
before retrying. See the [initial credential workflow](../console/create-and-deploy.md#initial-runtime-credentials).

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
for the exact observed revision. Compute owns collection and classification;
the core does not inspect native runtime output. Evidence contains safe
`component`, `check`, `checkedAt`, and `code` fields, never credentials or raw
provider errors. An unavailable or untrusted observation omits the evidence.

At the convergence deadline, the worker persists that observation with its
terminal result. The existing [deployment status API](../agents.md#deployment-status)
returns the saved evidence under the caller's exact-revision read permission.
It does not invoke Compute while serving the GET request.

### Optional runtime diagnostics

`diagnoseAgentDeployment(binding)` returns current checks for an exact revision
using its approved Namespace and Agent. OCC first authorizes exact Agent read
and operate and revision read.

The Driver owns native collection and maps its evidence to generic
`component`, `check`, `state`, nullable `checkedAt`, and optional safe `code`
fields. It must verify runtime identity, bound response size and time, and omit
credentials, raw provider output, and logs. OCC rejects mismatched revisions,
invalid timestamps, more than 32 checks, and unsupported states.

The call does not update deployment work, rerun the startup probe, send
messages, or prove a model response. Missing support returns dependency
unavailable; Drivers unable to collect safe evidence should omit the method.

### Runtime logging ownership

Omitting `runtimeLogging` or setting it to `"platform"` uses the bundled
[Harness logging policy](../harness-execution.md#runtime-logging). With `"driver"`,
OCC preserves native logging after any Sandbox changes, validates it through
ConfigurationDriver, and records it in the immutable revision. Compute must
apply that configuration and reject unsupported changes. The Driver operator owns
log destinations, credentials, redaction, access, and delivery; the bundled
Collector's privacy and export guarantees do not apply.

The gateway and Harness emit their own logs in either mode. Compute need not
transport or query them, and they do not pass through OCC. OCC process logs,
lifecycle results, and audit records use their own paths.

## IAM

OCC authenticates callers and asks the selected [IAMDriver](iam.md) to authorize
the requested operation on the specified resource. Before doing the work, the
worker rechecks the original caller's authority. It does not proceed if access
was denied or revoked, or IAM is unavailable. Backend credentials cannot replace
platform authorization. Compute cannot choose a different Principal, Namespace,
Agent, or revision.

Reading initial credential status requires Agent `read`; provisioning requires
Agent `read` and `operate`. Resolving a gateway endpoint also requires access to
that Agent. See [authorization](../authorization.md).

`ComputeRevisionContext.harnessAuth` contains either the approved API-key source
and its current backend reference, the managed-account credential reference and
private Backend binding, or just `{ method: "runtime" }` for operator-managed
authentication. None contains credential values. The separate `secretEnvironment`
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
earlier snapshot, including failed candidates. Stop must wait for resource
release, preserve durable data, and be safe to repeat. A stop failure prevents
preparation. The Driver owns backend-specific termination and Sandbox cleanup.

A newer admitted exclusive revision supersedes older reconciliation and
maintenance, even while the old revision remains the last committed active
pointer. This prevents an old pass from recreating a competing runtime. This
mode accepts downtime and has no automatic rollback: restore a configuration by
deploying a new higher revision. Other Drivers keep the default ordering.

### SandboxDriver coordination

A selected Sandbox currently works only with bundled Kubernetes Compute. Compute
isolates the Namespace, then calls the Sandbox's optional Namespace setup. It
prepares the gateway and, if the Sandbox creates the dedicated Harness, passes
the workload identity, approved mounts, and environment references backed by
Secrets. Otherwise Compute creates the workload itself. Compute waits for that
workload, activates its route, and calls Sandbox cleanup before removing resources
owned by the provider. See the [Sandbox contract](sandbox.md).

### Optional selected-driver hooks

Other selected Drivers may provide `afterNamespacePrepared`, `beforeWorkloadStart`,
`beforeWorkloadStop`, and `beforeNamespaceDelete`. Hooks run in selection order;
cleanup runs in reverse. Startup hooks affect the combined embedded workload or
the dedicated Harness, never a dedicated gateway. Their limited `opaque-`
environment cannot contain plaintext credentials or reserved names. Hooks cannot
change images, commands, placement, networking, authorization, or revision data.

Hooks must be safe to repeat. If preparation fails, Compute undoes completed
hooks. If revocation fails, teardown waits for a retry. If rollback is cancelled,
cleanup gets a separate signal with a time limit. See the [hook execution flow](../../flows/compute-driver-lifecycle-hooks.md).

### Optional active-runtime maintenance

`maintenanceIntervalMs` must be a positive safe integer. After activation or
maintenance, OCC atomically queues another pass for the same Agent, revision,
and original deployment Principal. The worker prepares and activates the revision
again; those operations must be safe to repeat. Failed observations, including
asynchronous binding failures, schedule another authorized pass without changing
the active revision. Maintenance survives worker restarts and ends when a newer
revision replaces it, or is admitted with exclusive replacement enabled. Without
an interval, lifecycle work responds to events. New deployments have limited retries.

### Plugin startup warnings

Readiness warnings contain an approved `pluginId` and either `PLUGIN_INSTALL_FAILED`
or `PLUGIN_AUTH_REQUIRED`. The Driver may return `ready: true` only if it has
safely disabled failed plugins and the remaining runtime is ready. OCC records
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
- Compute cannot query runtime logs. Selecting a different Driver does not migrate
  revisions that recorded the previous Driver's identity.

## Troubleshooting

| Symptom                                 | What to check                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails                           | Check the selected Driver, required production stages, hooks, and whether preflight threw an error. Fix the cause and confirm startup completes. Preflight warnings alone do not block it.                                 |
| Deployment fails before work is queued  | Check the Harness and authentication settings and whether `validateHarnessAuth` exists. Fix the combination or Driver and confirm OCC creates a revision.                                                                  |
| Revision stays unready                  | Check that the Driver reported the correct Namespace, Agent, and revision; that the workload is ready and authenticated; and that plugin startup status can be trusted. After the fix, confirm the revision becomes ready. |
| Cleanup or replacement stalls           | Check revocation, hooks, and Sandbox cleanup. Fix it and retry; confirm cleanup or activation completes. A missing workload alone does not prove cleanup succeeded.                                                        |
| Maintenance stops after a policy change | Check that the original Principal is still authorized and IAM is available. Restore the intended permission or start a newly authorized operation, then confirm reconciliation resumes.                                    |
| Credential setup partially fails        | Refresh stored status before retrying; confirm the required groups report configured. It does not prove the provider accepts them.                                                                                         |

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
