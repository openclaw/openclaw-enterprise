---
created: 2026-08-21
updated: 2026-10-05
last_updated_session: authoring-run/05067642-df93-4716-8f90-5b7430e50c41
---

# Harness Execution Topology Flow

## Overview

Deployment freezes native Harness policy, placement and authentication in an
AgentRevision. Compute prepares its workloads, publishes guarded routes and
retires predecessors before exactly-once activation audit.

## Entry Points

- Trigger: exact-Agent `POST /namespaces/:namespaceId/agents/:agentId/deploy` and durable revision
  reconciliation.
- Source: `packages/occ/src/index.ts:OpenClawController.deployAgent` and
  `apps/controller/src/worker.ts:ControllerWorker`.
- Assumptions: authorized actor; ready Namespace; same-Namespace native agent Configuration;
  explicit Agent execution mode; and a supported `harnessAuth` binding. Managed methods reference an authorized OCC
  Secret API key or a Driver-issued account-owned access-token credential.

## Flow

```mermaid
graph TD
  A["Authorize Agent and Configuration"] --> B["Resolve explicit native runtime and placement"]
  B --> C["Freeze configuration, harness identity, and harness authentication binding"]
  C --> D["Claim and reauthorize revision work"]
  D --> E{"Approved topology"}
  E -->|embedded OpenClaw| F["Create gateway or stage replacement"]
  E -->|dedicated Codex| G["Start separate Gateway and Codex Pods in the tenant namespace"]
  E -->|dedicated OpenClaw| Q{"Full-containment provisioning Sandbox?"}
  Q -->|no| H
  Q -->|yes| R["Start Gateway; SandboxDriver provisions native Harness"]
  E -->|unsupported or mismatched| H["Reject before workload creation"]
  F --> I["Activate shared gateway; Recreate on replacement"]
  I --> K{"Gateway ready after startup authentication?"}
  K -->|no| L["Stay unready; Agent may be unavailable until repair"]
  K -->|yes| J["Complete activation, retire predecessor, and commit audit"]
  G --> N{"Predecessor Gateway can enroll node?"}
  N -->|yes| M["Activate authenticated dedicated revision"]
  N -->|no| O["Start candidate Gateway as bootstrap endpoint"]
  O --> P["Enroll and observe workspace node"]
  P --> M
  R --> S{"Gateway and enrolled Harness ready?"}
  S -->|no| L
  S -->|yes| M
  M --> J
```

## Execution Trace

### 1. Resolve and freeze the native harness

`packages/occ/src/index.ts:OpenClawController.deployAgent`

OCC authorizes and locks the exact Agent and Configuration. Selected-model/provider
`agentRuntime.id` explicitly selects `codex` or `openclaw`; only an unambiguous built-in
configuration defaults to embedded OpenClaw. Missing ambiguous/plugin runtime policy, conflicting
routes, unsupported IDs, and harness/mode mismatches fail closed. OCC validates each primary
and fallback model through the same resolver and preserves their native order;
fallbacks must keep the primary provider and Harness.
The admitted revision immutably
captures its native configuration, approved harness identity/version, explicit mode, Compute
selection, and Agent ServicePrincipal. Production admits approved
`openclaw`/`embedded` and `codex`/`dedicated`, and `openclaw`/`dedicated` only when
the selected SandboxDriver provisions Harnesses with networking, filesystem, and
process containment. An associated
`access_token` additionally requires dedicated Codex; the frozen account
contains only its OCC identity, credential kind, and opaque Secret reference.

### 2. Claim work and realize the approved topology

`apps/controller/src/worker.ts:ControllerWorker`

The worker claims exact revision work, reauthorizes its actor and ownership, revalidates its frozen
approved harness, and calls `ComputeDriver.prepareRevision`.

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.prepareRevision`

Docker starts an embedded gateway or dedicated Codex container but does not
support the harness-auth binding contract, so it has no currently deployable Agent
path; unsupported bindings fail before deployment.
In the underlying container path, `dockerGatewayConfigurationDocument` admits only
supported authentication fields and modes, and `reconcileGateway` generates the
managed `OPENCLAW_GATEWAY_PASSWORD` only for a new container. The
[Docker gateway authentication reference](../reference/drivers/docker-compute.md#gateway-authentication)
owns the mode and password rules.

Kubernetes supports managed bindings.
SSH supports `{ "method": "runtime" }` only for embedded OpenClaw: operator
credentials remain on the host and OCC checks gateway readiness without model
validation. See the [SSH flow](pr-24-ssh-compute.md).

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.prepareRevision`

Kubernetes workload rendering calls `prepareHarnessAuth` once for the resolved
source. It projects the OCC Secret key only into embedded OpenClaw or a dedicated
Harness. Canonical sources live in the tenant storage target; Compute delivers selected fields into an
exact revision-owned Harness Secret, including the account token/workspace for ChatGPT.
Dedicated gateways receive neither model source. This namespace-local delivery
also applies to fixture images without native runtime configuration; only the
native dedicated transport token depends on that configuration.
See the [harness authentication flow](native-service-account-credential-delivery.md)
for admission, immutable source snapshots, and worker reauthorization.

Configured API composition, including development, and worker startup call
`KubernetesComputeDriver.preflight` through the optional Compute contract
before tenant reconciliation. In a single cluster it checks every page of storage
namespaces and refuses a legacy split target without altering its labels or state.
The [upgrade requirements](../reference/drivers/kubernetes-compute.md#existing-split-layout-installations)
own the operator boundary.

Kubernetes `ensureNamespace` prepares one tenant namespace in a single cluster,
including adopted namespaces; its storage-role label enables discovery.
The two-cluster profile retains its control-cluster Gateway target.
`prepareRevision` and `activateRevision` keep dedicated Gateway and Harness Pods,
identities and PVCs separate in their selected targets. `deliverGatewaySecrets`
validates canonical sources for dedicated Gateways; `deliverHarnessAuth` creates
only the selected model/transport projection. Canonical transport and Gateway
password sources now stay separate across modes. Legacy combined sources remain
for older Pods; Compute copies their password to the separate source before
new templates reference it. If concurrent delivery creates the password source first,
Compute re-reads it and accepts only the exact-owned, identical password; conflicting
or foreign sources still fail. App-server DNS includes the Harness namespace; policies select exact
Namespace, Agent and revision peers. Harness Services select exact Namespace, Agent, revision, workload role, network
profile and Compute-owned workload name. Gateway Services omit revision for a
stable route. These selectors match NetworkPolicy before destination translation.
[Namespaces and isolation](../reference/drivers/kubernetes-compute/networking-and-isolation.md#namespaces-and-isolation)
owns app-server DNS, NetworkPolicy peers and Service selectors.
`runtime.gatewayNodeSelector`
independently places the Gateway Pod and private-state initializer on trusted nodes.
Because the predecessor Gateway is stopped first (step 3) or otherwise not ready, preparation starts the candidate Gateway after the candidate Harness is
otherwise ready. That candidate Gateway provides the bootstrap endpoint and changes no unrelated
Gateway; the revision remains not ready, and never activates, until its exact workspace node is
enrolled and observed.
`KubernetesComputeDriver.gatewayNativeHookRelayConfiguration` binds dedicated Codex
callbacks to the Agent's route. `AGENT_WITH_NODE_ENTRYPOINT` prepares private
capability storage and TLS trust; OpenClaw authorizes callbacks. See
[native hook routing](../reference/gateway-routing.md#native-node-endpoint).

A dedicated Codex Harness names its workspace node `agent-<agent digest>-workspace` on every
start, so the Gateway's node list keeps one stable name across revisions.

Dedicated Codex and dedicated OpenClaw keep separate Agent-owned Gateway and
Harness ServiceAccounts. Compute owns the Gateway Pod; the selected SandboxDriver
owns the native Harness Pod. The OpenClaw Harness enrolls as a paired node, owns
its identity and workspace, and alone receives the model key. It reads the
one-use enrollment target from a private file; later starts reuse the persisted
device token. Compute pins the enrolled device in a generated `dedicated-native`
profile with `inference: "worker"`, so a missing or disconnected Harness fails
the turn rather than using Gateway inference. An exact callback route and
session-bound worker admission scope the transport to the owning Agent.
Embedded OpenClaw uses one combined workload with its exact Agent identity
and model key. The worker
has scoped Secret permissions for admitted delivery and node enrollment. Its
trusted workload-writing authority also projects tenant Secrets. Gateway Pods
receive no controller or Harness Kubernetes credentials.

The selected Sandbox consumes the same rendered projections and explicit login
mode in `HarnessWorkloadRequirements`. Unsupported upstream projection fails
without a test-only credential bridge.

Every Pod template Kubernetes Compute renders carries the ordinary
[network profile](../reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles).
Ordinary allow policies and Gateway/Harness peers require it, and readiness
rejects a template without it.

When a selected SandboxDriver provisions the dedicated Harness,
`providerHarnessReady` lists Pods using the active Service's Agent/revision/role
labels and requires exactly one nonterminating `Ready=True` candidate with the
supplied Harness labels; malformed or incomplete observations throw through the
existing preparation cleanup path. `activateRevision` repeats this check before
changing routing. See the [Kubernetes readiness contract](../reference/drivers/kubernetes-compute.md#requirements)
for candidate rules and the limits of this observation.

### 3. Publish safely and complete activation once

`apps/controller/src/worker.ts:ControllerWorker`

For dedicated Kubernetes execution, Compute declares
`requiresStoppedPredecessors`. `ControllerWorker.prepareRevision` stops every
earlier runtime, including its Gateway, and waits for Pod termination before
preparing the replacement, so a redeploy interrupts service until the replacement is ready.
The worker records each stopped predecessor and skips it on later pending passes
and maintenance instead of re-stopping it on each readiness poll.
Compute reports a predecessor that came back (for example, a lost claim's late
write) as an unready successor, not an error, so the worker stops each recorded
predecessor again after one claim lease, then after two, four and so on. A failed
preparation pass, or preparing or activating that predecessor, drops the record.
Both PVCs survive this downtime window; a failed candidate is recovered by retry
or a new revision. A newer exclusive revision supersedes old reconciliation and
maintenance, with no automatic rollback; see
[production revision stages](../reference/drivers/compute.md#production-revision-stages).
Dedicated Codex and dedicated OpenClaw must complete a bounded native
authentication/model probe before their Harness becomes ready.
While first-deploy [workspace setup](workspace-files.md) is pending, embedded
preparation starts the replacement Gateway itself before activation. If the Gateway
of a revision that never served (its Service still selects no Pod) is unready,
for example after rejected model authentication, the next revision's preparation
repairs it with its own template instead of waiting on the failed predecessor.
The repair deletes an embedded predecessor's revision Secret and ConfigMap copies.

The worker commits the database `activeRevisionId` with an exact compare-and-set
before Kubernetes default after-commit activation.
`KubernetesComputeDriver.activateRevision` updates the shared gateway's `Recreate`
Deployment and Service. Embedded preparation does not validate the replacement's
credentials, so cutover can stop the serving gateway before the replacement
validates them in its own
[startup](native-service-account-credential-delivery.md#5-authenticate-during-runtime-startup).
The same bounded check
runs for initial and replacement gateways. A failed check, including a provider
timeout or rate limit, holds the gateway unready until repair and restart or a
new deployment. Readiness polling does not repeat model requests; worker retries
do not restart an unchanged Pod. No automatic rollback restores the predecessor.
Embedded activation also deletes embedded predecessor copies when it re-renders
the Gateway, even if the replacement never becomes ready.
For a dedicated predecessor, activation preserves copies while its Harness
Deployment or terminating Pod survives. Normal retirement stops the Harness
and removes the artifacts.

If activation, readiness, predecessor retirement, or audit completion fails,
the worker requeues the revision with `REVISION_FINALIZATION_INCOMPLETE`, or a
known wait's own [pending code](../reference/agents/deployment.md#pending-deployment-progress); recovery
retries activation and retirement for the already-active revision. Lost claims
and foreign/stale workloads fail closed. Dedicated activation waits for the
Gateway to report the workspace node it was handed; that wait is a 20-second
budget per revision and node across activation retries, then one status read per
retry, so a Gateway that never applies its node cannot hold the serial worker
on every retry. It and the pairing wait end early when other Work is claimable.

When stopping a revision, the Driver stops its Gateway within the pinned
runtime's 330-second stop budget and waits for Pod disappearance before stopping
the Harness, which stays available for active work. Idle shutdown, or one before
OpenClaw starts (wrappers run under `tini`), completes promptly. Forced
termination can delay the successor until the persistent owner lease expires.

Kubernetes gateways in both modes mount their own persistent SQLite and media
directories; embedded gateways also keep their attested default workspace on
that private claim so continued turns survive Pod replacement. Dedicated
Harnesses receive only the Harness workspace claim, which keeps the node
identity across Pod and revision replacement. The driver creates both claims
before their consuming Pods and relies on workload readiness instead of waiting
for `Bound`, which would deadlock `WaitForFirstConsumer` storage classes. The [Gateway storage](../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage)
contract owns the ephemeral nested Codex home and the init container that
prepares private directories and `/tmp`.

Workspace-file access uses the enrolled Harness node; Gateway and Harness share
no workspace, session, skill, or image mounts. The [storage contract](../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage)
covers per-image assets and generated-image return.
The OpenClaw node host keeps Gateway-issued worker bundles in its own state and
workspaces below `/home/node/workspace`, away from gateway state, `CODEX_HOME`,
and credentials. A restart republishes image-owned
runtime assets and reconnects with the paired identity; readiness waits for the
bounded identity check. The compile cache and model-probe state stay in node
state and `TMPDIR`, which a Sandbox Driver can grant.

For a selected Sandbox Driver, stopping or retiring a revision always runs its
required cleanup after stopping a Compute-owned ordinary Harness, or delegates
provider-owned Harness removal to that cleanup. An absent ordinary Deployment
does not skip cleanup, so a cleanup failure remains retryable.
Revision retirement retains both owned claims even after stop removed the
gateway. When another revision's Gateway or route survives, retirement checks its exact
revision ownership before deleting resources. A successor in the shared namespace
keeps its Gateway Deployment, identity, Service and policies. `apps/controller/src/worker.ts:ControllerWorker.processAgentDeletion`
retires every revision before calling
`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.deleteAgentRuntimeCredentials`
to delete exact-owned private and shared claims by UID. Final deletion checks
all selected targets, independently of the Agent draft's current execution mode. Cleanup failures retry
before the worker removes the Agent's database identity. The [storage contract](../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage)
owns claim sizes, mount paths, StorageClass requirements, and final teardown.

## Debugging and Verification

- Check placement, immutable policy, and conflicts:
  `node --test tests/conformance/configuration-occ.test.mjs`.
- Check guarded activation and recovery:
  `node --test tests/integration/postgres-worker-agent-revision.test.mjs` with its explicitly
  provisioned application-role PostgreSQL database.
- Check dedicated Gateway repair after an unready predecessor:
  `pnpm test:files --test-name-pattern='dedicated replacement starts a candidate Gateway' -- tests/conformance/kubernetes-compute.test.mjs`.
- Check embedded Gateway repair after a never-served unready predecessor:
  `pnpm test:files --test-name-pattern='never-served unready Gateway' -- tests/conformance/kubernetes-compute.test.mjs`.
- Run real disposable-k3d Kubernetes coverage for both production topologies, exact identity and
  model-key placement, authenticated dedicated transport, isolated networking, and active routing.
- Run `node --test tests/integration/docker-compute-real.test.mjs` for real Docker Compose
  embedded and dedicated model turns, or
  `node --test tests/integration/harness-topology-k3d-real.test.mjs` for real Kubernetes
  model turns. Select each suite's runtime images, infrastructure, and credentials through the
  [test environment settings](../testing/docker.md#docker-compose-development-test-environment).
- Verify provider-backed dedicated Codex separately with
  `node --test tests/integration/service-account-driver-real.test.mjs`,
  `OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1`, and an authorized mounted
  `OCC_TEST_CHATGPT_ADMIN_KEY_PATH`; this scenario does not use `OPENAI_API_KEY`.
- Treat unavailable credentials, runtime images, provider access, or either real model response as
  a verification failure. Never substitute a readiness probe, handshake, fixture, or skipped test.
- An HTTP 401 before worker admission means the callback missed the node-only
  worker ingress and fell through to the administrative route.

## Related docs

- [Harness execution topology implementation specification](../../specs/.archive/07-harness-execution-topology.md)
- [Platform design](../design/workloads.md#openclaw-gateways)
- [Agent placement and deployment](../reference/agents/deployment.md#execution-mode)
- [Controller worker](../reference/controller/reconciliation.md#agentrevision-lifecycle)
- [Docker Compute Driver](../reference/drivers/docker-compute.md)
- [Kubernetes Compute Driver](../reference/drivers/kubernetes-compute.md)
- [Compute Driver lifecycle hooks flow](compute-driver-lifecycle-hooks.md)
- [Service Account Driver credential delivery flow](service-account-driver-credential-delivery.md)
- [Shared-drive specification](../../specs/.archive/12-dedicated-harness-shared-workspace-drive.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-05 14:24: Route dedicated Codex native hook callbacks with per-relay capabilities. (authoring-run/05067642-df93-4716-8f90-5b7430e50c41 - dfa091b6)

- 2026-10-03 16:02: Run configured development API and worker Compute preflight before admitting work. (01a0fe72-58b2-7cc3-b770-7310f5401deb - c04093189f2ba6240f8dc431847c2f487afd11de)

- 2026-10-03 15:38: Refuse unsafe split-layout upgrades and converge concurrent legacy password creation. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 94364ae9)

- 2026-10-02: Stabilize canonical credential layout across execution modes with legacy source compatibility. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-02: Retain dedicated predecessor projections during shared-namespace embedded cutover until Harness retirement. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-02: Share the single-cluster tenant namespace while preserving role-specific runtime delivery and revision cleanup. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-02 14:00: End node pairing and ack waits early for claimable Work. (r7-d221)

- 2026-10-02 12:00: Delete a replaced embedded predecessor's Secret and ConfigMap copies at activation re-render. (fix-d280-embedded-retire)

- 2026-10-02 06:00: Budget the workspace node binding ack wait per binding across activation retries. (fix-deploy-node-pairing)

- 2026-09-30 09:30: Include the Harness network profile in Service selectors for EKS policy resolution. (authoring-run/1373b7f3-e273-466a-b9da-bb197bdb469e - 0d00e8970b69)

- 2026-09-30 21:00: Delete a repaired embedded predecessor's Secret and ConfigMap copies at repair time. (fix/dogfood3b-1)

- 2026-09-30 10:30: Repair a never-served unready embedded Gateway during redeploy with pending workspace setup. (fix-dogfood-1)

- 2026-09-30 09:54: Correct dedicated replacement: the worker stops the predecessor Gateway before preparation, so redeploys interrupt service. (authoring-run/a37a9c9b-9e94-4bd2-88c5-dfa5c5f94d12 - 90899dc55ab7)

- 2026-09-28 02:55: Trace dedicated native OpenClaw on paired node hosts with full-facet Sandbox provisioning. (oce-pr-440-sync - e2b739f51f89)

- 2026-09-25 18:25: Document candidate Gateway bootstrap during dedicated recovery from an unready predecessor. (authoring-run/9b15ee1e-3767-4dd0-8d9a-56ad2087dcb5 - 7b2345a3cd6e78b9c7c8bae530f3379db56be443)

- 2026-09-24 11:28: Document exclusive dedicated preparation and durable RWO workspaces in the accompanying change. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 14a4508baad876d3eea4e6fe6388f8d8a91559b7)

[Harness execution topology documentation history](harness-execution-topology/history.md) preserves the older dated entries.
