---
created: 2026-08-21
updated: 2026-10-08
last_updated_session: 01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa
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
process containment and the Installation declares a compatible runtime image.
The default native capability remains disabled pending runtime qualification.
An associated
`access_token` additionally requires dedicated Codex; the frozen account
contains only its OCC identity, credential kind, and opaque Secret reference.

### 2. Claim work and realize the approved topology

`apps/controller/src/worker.ts:ControllerWorker`

The worker claims exact revision work, reauthorizes its actor and ownership, revalidates its frozen
approved harness, and calls `ComputeDriver.prepareRevision`.

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.prepareRevision`

Docker's underlying path starts embedded gateways or dedicated Codex containers,
but rejects harness-auth bindings before deployment; no Agent path is deployable.
`dockerGatewayConfigurationDocument` admits supported authentication fields/modes;
`reconcileGateway` generates `OPENCLAW_GATEWAY_PASSWORD` only for new containers. The
[Docker gateway authentication reference](../reference/drivers/docker-compute.md#gateway-authentication)
owns the mode and password rules.

Kubernetes supports managed bindings.
SSH supports `{ "method": "runtime" }` only for embedded OpenClaw: operator
credentials remain on the host and OCC checks gateway readiness without model
validation. See the [SSH flow](pr-24-ssh-compute.md).

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.prepareRevision`

Kubernetes calls `prepareHarnessAuth` once per resolved source. From canonical
tenant storage, it delivers selected fields, including ChatGPT account tokens,
into exact revision-owned Harness Secrets. Only embedded OpenClaw or dedicated
Harnesses receive model keys, never dedicated Gateways. Fixture images use the
same namespace-local delivery; only native dedicated transport tokens depend on
runtime configuration.
See the [harness authentication flow](native-service-account-credential-delivery.md)
for admission, immutable source snapshots, and worker reauthorization.

API composition, including development, and worker startup call
`KubernetesComputeDriver.preflight` before reconciliation. Single-cluster
preflight checks every storage-namespace page and refuses legacy split targets
without changing labels or state.
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
With the predecessor Gateway stopped or not ready, preparation starts the candidate
Gateway once its Harness is otherwise ready. It provides the bootstrap endpoint
without changing unrelated Gateways. The revision cannot activate until its exact
workspace node is enrolled and observed.
`KubernetesComputeDriver.gatewayNativeHookRelayConfiguration` binds dedicated Codex
callbacks to the Agent's route. `AGENT_WITH_NODE_ENTRYPOINT` prepares private
capability storage and TLS trust; OpenClaw authorizes callbacks. See
[native hook routing](../reference/gateway-routing.md#native-node-endpoint).

Dedicated Codex uses workspace-node name `agent-<agent digest>-workspace`, stable
across restarts and revisions.

Dedicated Harnesses have ServiceAccounts separate from their Gateway. Compute
owns the Gateway Pod; SandboxDriver owns the native Harness. The paired native
node owns its identity, workspace, and model key. OpenShell delivers the exact
revision's setup envelope and Gateway CA through its native runtime profile
provider files, separate from Codex's. The native entrypoint combines the Gateway
CA with inherited TLS trust and converts the envelope into a private one-use
target; restarts reuse the persisted device token. SandboxDriver propagates renewed
enrollment material and removes the revision's provider during cleanup. Native
workers connect outbound without a Codex app-server endpoint. Compute pins the
device in `dedicated-native` with `inference: "worker"`: missing/disconnected
Harnesses fail without Gateway inference. Exact callbacks and session-bound
admission scope transport to the Agent.
`apps/controller/src/drivers/compute/kubernetes/index.ts:nativeRuntimeConfiguration`
projects admitted OpenAI models and an environment SecretRef into canonical
`models.providers.openai`.
`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:NATIVE_WORKER_ENTRYPOINT`
writes private node configuration with capacity, isolation, and Driver-provided
`OPENCLAW_WORKSPACE_DIR`. OpenShell's
`apps/controller/src/drivers/sandbox/openshell.ts:configureAgent` admits its data
mount as the default and main Agent workspace. Native Gateway file transfer uses
that workspace unless an endpoint overrides it. OpenClaw snapshots node-local models/credentials
and derives exact managed workspaces from authorized launch descriptors, without
an inference file, grant catalog, or retired `nativeInferenceConfig` setting.

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

For provider-owned Harnesses, `providerHarnessReady` lists Pods by the active
Service's Agent/revision/role labels. It requires exactly one nonterminating
`Ready=True` Pod with the supplied labels; malformed/incomplete observations
enter preparation cleanup. Activation repeats this check before routing changes.
The [readiness contract](../reference/drivers/kubernetes-compute.md#requirements)
owns candidate rules and observation limits.

### 3. Publish safely and complete activation once

`apps/controller/src/worker.ts:ControllerWorker`

For dedicated Kubernetes execution, Compute declares
`requiresStoppedPredecessors`. `ControllerWorker.prepareRevision` stops every
earlier runtime, including its Gateway, and waits for Pod termination before
preparing the replacement, so a redeploy interrupts service until the replacement is ready.
The worker records stopped predecessors, avoiding repeated stops during pending
passes/maintenance. If one returns, Compute reports an unready successor; the
worker stops it again after one, two, four, then more claim leases. Failed
preparation, or preparing/activating that predecessor, clears its record.
Both PVCs survive downtime; recovery retries or creates a revision. New exclusive
revisions supersede old reconciliation/maintenance without automatic rollback; see
[production revision stages](../reference/drivers/compute.md#production-revision-stages).
Dedicated Codex and dedicated OpenClaw must complete a bounded native
authentication/model probe before their Harness becomes ready.
While first-deploy [workspace setup](workspace-files.md) is pending, embedded
preparation starts the replacement Gateway itself before activation. If the Gateway
of a revision that never served (its Service still selects no Pod) is unready,
for example after rejected model authentication, the next revision's preparation
repairs it with its own template instead of waiting on the failed predecessor.
The repair deletes an embedded predecessor's revision Secret and ConfigMap copies.

The worker commits `activeRevisionId` by exact compare-and-set before Kubernetes
activation. `KubernetesComputeDriver.activateRevision` updates the shared Gateway's
`Recreate` Deployment and Service. Embedded preparation does not validate credentials,
so cutover can stop the serving Gateway before replacement
[startup](native-service-account-credential-delivery.md#5-authenticate-during-runtime-startup)
validates them. Initial and replacement Gateways use the same bounded check;
failures, including provider timeouts/rate limits, hold them unready until repair
and restart or a new deployment. Readiness polling does not repeat model requests;
worker retries do not restart unchanged Pods. There is no automatic rollback.
Embedded activation deletes embedded predecessor copies when re-rendering, even
if the replacement never becomes ready. For a dedicated predecessor, copies remain
while its Harness Deployment or terminating Pod survives; normal retirement stops
the Harness and removes the artifacts.

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

Stopping or retiring a revision always runs the selected Sandbox Driver's cleanup:
after Compute stops an ordinary Harness, or to remove a provider-owned Harness.
An absent ordinary Deployment does not skip cleanup; failures remain retryable.
Retirement retains both owned claims after Gateway removal and checks the retiring
revision's ownership before deleting resources. Successors keep
their Gateway Deployment, identity, Service and policies.
`apps/controller/src/worker.ts:ControllerWorker.processAgentDeletion` retires every
revision, then calls
`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.deleteAgentRuntimeCredentials`
to delete exact-owned private and shared claims by UID across all selected targets,
regardless of the Agent draft's mode. Cleanup retries precede database identity
removal. The [storage contract](../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage)
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

- 2026-10-08 02:42: Align the admitted native Agent workspace and Gateway file-transfer binding with OpenShell's approved data mount. (authoring-run/4fbff731-5f62-4865-9fee-a2a117c3d0a6 - a8d2969355bd3c0478337e16a01e267ad3607595)

- 2026-10-08 02:38: Consume the Driver-owned native workspace path so OpenShell file operations reach the admitted mount. (authoring-run/4fbff731-5f62-4865-9fee-a2a117c3d0a6 - e23d7dc5bf63ca103d6c7dec76d36ced9e1fbf5f)

- 2026-10-08 02:28: Project dedicated native models through canonical node configuration in the accompanying change; retain required placement and separate image qualification. (authoring-run/4fbff731-5f62-4865-9fee-a2a117c3d0a6 - 1f97586276fde1dbddec9f14dca3d6d783aade63)

- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)

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
