---
created: 2026-08-21
updated: 2026-09-24
last_updated_session: 01a0cf72-6985-7712-ba92-d8cc32470f24
---

# Harness Execution Topology Flow

## Overview

An authorized deployment resolves its harness from native selected-model/provider policy, freezes
the Agent's explicit `embedded` or `dedicated` placement and harness authentication binding
in its AgentRevision, and asks Compute to start that topology. The flow ends after guarded route
publication, predecessor retirement, and exactly-once activation audit.

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
  E -->|dedicated Codex| G["Start control-plane Gateway and data-plane Codex in separate namespaces"]
  E -->|unsupported or mismatched| H["Reject before workload creation"]
  F --> I["Activate shared gateway; Recreate on replacement"]
  I --> K{"Gateway ready after startup authentication?"}
  K -->|no| L["Stay unready; Agent may be unavailable until repair"]
  K -->|yes| J["Complete activation, retire predecessor, and commit audit"]
  G --> M["Activate authenticated dedicated revision"]
  M --> J
```

## Execution Trace

### 1. Resolve and freeze the native harness

`packages/occ/src/index.ts:OpenClawController.deployAgent`

OCC authorizes and locks the exact Agent and Configuration. Selected-model/provider
`agentRuntime.id` explicitly selects `codex` or `openclaw`; only an unambiguous built-in
configuration defaults to embedded OpenClaw. Missing ambiguous/plugin runtime policy, conflicting
routes, unsupported IDs, and harness/mode mismatches fail closed. OCC validates each primary
and fallback model through the same resolver; fallbacks must keep the
primary provider and Harness. It preserves their order in the native configuration.
The admitted revision immutably
captures its native configuration, approved harness identity/version, explicit mode, Compute
selection, and Agent ServicePrincipal. Production admits both approved
`openclaw`/`embedded` and `codex`/`dedicated` combinations. An associated
`access_token` additionally requires dedicated Codex; the frozen account
contains only its OCC identity, credential kind, and opaque Secret reference.

### 2. Claim work and realize the approved topology

`apps/controller/src/worker.ts:ControllerWorker`

The worker claims exact revision work, reauthorizes its actor and ownership, revalidates its frozen
approved harness, and calls `ComputeDriver.prepareRevision`.

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.prepareRevision`

Docker's existing topology implementation starts an embedded gateway or dedicated
Codex container, but it does not support the new harness-auth binding contract;
unsupported bindings fail before deployment. In the underlying container path,
`dockerGatewayConfigurationDocument` admits only supported authentication
fields and modes. Omitted
mode renders password mode. An omitted password or explicit managed reference
selects `OPENCLAW_GATEWAY_PASSWORD`; other password settings are preserved.
Explicit trusted proxy retains its native configuration and can also request the
managed password. `reconcileGateway` generates the managed credential only for a
new container, leaving a reused container's credential intact. Dedicated
Codex app-server authentication remains independent. These implementation checks
do not establish a currently deployable Docker Agent path.

Kubernetes supports managed bindings.
SSH supports `{ "method": "runtime" }` only for embedded OpenClaw: operator
credentials remain on the host and OCC checks gateway readiness without model
validation. See the [SSH flow](pr-24-ssh-compute.md).

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.prepareRevision`

Kubernetes workload rendering calls `prepareHarnessAuth` once for the resolved
source. It projects the OCC Secret key only into embedded OpenClaw or dedicated
Codex. Canonical sources live in CP; Compute delivers selected fields into an
exact revision-owned DP Secret, including the account token/workspace for ChatGPT.
Dedicated gateways receive neither model source. This namespace-local delivery
also applies to fixture images without native runtime configuration; only the
native dedicated transport token depends on that configuration.
See the [harness authentication flow](native-service-account-credential-delivery.md)
for admission, immutable source snapshots, and worker reauthorization.

Kubernetes `ensureNamespace` prepares the data-plane namespace and a distinct
managed Gateway runtime namespace. `requireGatewayNamespace` verifies the latter's
exact logical owner. `prepareRevision` and `activateRevision` place dedicated
Gateway Deployments, private PVCs, Services, native configuration and routes there;
Harness resources stay in the data-plane namespace. `deliverGatewaySecrets`
validates direct references to canonical CP sources for dedicated Gateways;
`deliverHarnessAuth` creates the selected DP runtime projection. Dedicated app-server
DNS includes the Harness namespace, and NetworkPolicy peers combine namespace
and exact Agent/revision selectors. The active dedicated Harness Service selector
carries the same Namespace, Agent, revision, and workload-role labels before
adding a Compute-owned workload-name selector, so Service-IP traffic remains
compatible with NetworkPolicy implementations that check Service selectors before
destination translation. Active Gateway Services carry the Namespace, Agent, and
gateway workload-role labels, satisfying gateway policy selectors without tying
the stable Gateway route to a revision. `runtime.gatewayNodeSelector`
independently places the Gateway Pod and private-state initializer on trusted nodes.

Production dedicated workloads keep separate Agent-owned gateway/Codex
ServiceAccounts, authenticated same-Agent transport, and default-deny network
policies with auth-method-specific provider login egress. Embedded OpenClaw uses
one combined workload with its exact Agent identity and model key. The worker
has scoped Secret permissions for admitted delivery and node enrollment. Its
trusted workload-writing authority also projects tenant Secrets. Gateway Pods
receive no controller or Harness Kubernetes credentials.

The selected Sandbox consumes the same rendered projections and explicit login
mode in `HarnessWorkloadRequirements`. Unsupported upstream projection fails
without a test-only credential bridge.

When a selected SandboxDriver provisions the dedicated Harness,
`providerHarnessReady` lists Pods using the same Agent/revision/role labels as
the active Service. It validates the complete observation and requires exactly
one nonterminating candidate with the supplied Harness labels and `Ready=True`.
An unready second live candidate blocks readiness even when the first is Ready.
Malformed or incomplete observations throw through the existing preparation
cleanup path. `activateRevision` repeats this check before changing routing.
See the [Kubernetes readiness contract](../reference/drivers/kubernetes-compute.md)
for candidate rules and the limits of this observation.

### 3. Publish safely and complete activation once

`apps/controller/src/worker.ts:ControllerWorker`

For dedicated Kubernetes execution, Compute declares
`requiresStoppedPredecessors`. `ControllerWorker.prepareRevision` stops every
earlier runtime and waits for Pod termination before preparing the replacement.
Old reconciliation and maintenance cannot restart a predecessor after a newer
exclusive revision is admitted. Both PVCs survive this downtime window; a failed
candidate is recovered by retry or a new revision, not automatic rollback.
Dedicated Codex must complete its bounded native authentication/model probe
before its app-server becomes ready.
Embedded preparation does not validate the replacement's credentials. See the
[authentication flow](native-service-account-credential-delivery.md#5-authenticate-during-runtime-startup).

The worker commits the database `activeRevisionId` with an exact compare-and-set
before Kubernetes default after-commit activation.
`KubernetesComputeDriver.activateRevision` updates the shared gateway's `Recreate`
Deployment and Service. Embedded cutover can stop the serving gateway before the
replacement validates credentials in its own startup. The same bounded check
runs for initial and replacement gateways. A failed check, including a provider
timeout or rate limit, holds the gateway unready until repair and restart or a
new deployment. Readiness polling does not repeat model requests; worker retries
do not restart an unchanged Pod. No automatic rollback restores the predecessor.

If activation, readiness, predecessor retirement, or audit completion fails,
the worker requeues the revision with `REVISION_FINALIZATION_INCOMPLETE`; recovery
retries activation and retirement for the already-active revision. Lost claims
and foreign/stale workloads fail closed.

Kubernetes gateways in both modes mount their own persistent SQLite and media
directories. Embedded gateways also retain their attested default workspace on
the same private claim so continued turns survive Pod replacement. Dedicated
Codex receives only the Harness workspace claim; the gateway's nested Codex home
remains ephemeral. The driver creates separate Harness and gateway claims before
their consuming Pods and relies on workload readiness instead of waiting for
`Bound`, which would deadlock `WaitForFirstConsumer` storage classes. A nonroot
gateway-image init container prepares private SQLite and media directories
without credentials or elevated privileges.

Each image initializes its own bundled and plugin assets. Workspace-file access
uses the enrolled Harness node; generated-image bytes return through the remote
media reader. There are no shared workspace, session, skill, or image mounts
between gateway and Harness. See the [storage contract](../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).
For a selected Sandbox Driver, stopping or retiring a revision always runs its
required cleanup after stopping a Compute-owned ordinary Harness, or delegates
provider-owned Harness removal to that cleanup. An absent ordinary Deployment
does not skip cleanup, so a cleanup failure remains retryable.
Revision retirement retains both owned claims even after stop removed the
gateway. When another revision's Gateway or route survives in the other physical
namespace, retirement removes only the old Gateway's resources and preserves the
shared data-plane Agent identity, Service and policies. `apps/controller/src/worker.ts:ControllerWorker.processAgentDeletion`
retires every revision before calling
`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.deleteAgentRuntimeCredentials`
to delete exact-owned private and shared claims by UID. Final deletion checks
both physical targets, independently of the Agent draft's current execution mode. Cleanup failures retry
before the worker removes the Agent's database identity. The [storage contract](../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage)
owns claim sizes, mount paths, StorageClass requirements, and final teardown.

## Debugging and Verification

- Check placement, immutable policy, and conflicts:
  `node --test tests/conformance/configuration-occ.test.mjs`.
- Check guarded activation and recovery:
  `node --test tests/integration/postgres-worker-agent-revision.test.mjs` with its explicitly
  provisioned application-role PostgreSQL database.
- Run real disposable-k3d Kubernetes coverage for both production topologies, exact identity and
  model-key placement, authenticated dedicated transport, isolated networking, and active routing;
  an HTTP fixture or skipped cluster scenario is not model-turn proof.
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

- 2026-09-24 11:28: Document exclusive dedicated preparation and durable RWO workspaces in the accompanying change. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 14a4508baad876d3eea4e6fe6388f8d8a91559b7)

- 2026-09-24 13:08: Align the dedicated Harness Service selector trace with gateway-to-Harness NetworkPolicy matching. (01a0d504-19bd-7833-9ef5-237750f5831a - b4b6a0e0d8700930f21d58b3724c055f8249c486)

- 2026-09-23 13:13: Keep fixture credential delivery namespace-local, matching native runtime placement. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - df4ca4474d90de2d4ab0dd6f6d03a64ebb92526a)

- 2026-09-23 12:38: Guard cross-mode retirement and inspect both targets during final Agent cleanup. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 25a520de9d0259c3ae6b7ef6d7c0e7e6ccce0349)

- 2026-09-23 12:26: Describe canonical CP sources and the selected DP runtime projection. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 429f46735be45247c3b8a406e1c9f57c2ef0327f)

- 2026-09-23 11:31: Trace dedicated control-plane Gateway placement, scoped credential delivery and cross-namespace lifecycle. (01a0cf72-6985-7712-ba92-d8cc32470f24 - b141ba1157c2f28276717d35c8c63028f209a479)

- 2026-09-23 03:24: Move durable claim cleanup from revision retirement to Agent deletion. (01a0cc43-d13b-7cb2-ae15-1fd56e61bbf4 - 43776d25c5007e017f7d0ffdca6b06f063afcd37)

- 2026-09-22 22:31: Describe supported auth admission without legacy gateway credential compatibility handling. (authoring-run/d7126920-6a2a-4126-ad7d-fafd57593855 - c387eef76420f05a060689d2fa04b57a3e416956)
- Removed legacy gateway credential compatibility handling. (NOT_IN_SPEC)

- 2026-09-22 22:02: Trace Docker managed gateway passwords while preserving harness admission limits and Codex transport authentication. (authoring-run/b91ebd83-2105-4b1e-aad8-6747fe22c2f1 - 01b42feaf8321e231fbe23a80e00ba641bb9fbcb)
- Bundled Compute Drivers use managed passwords or trusted proxy for native gateway authentication. (NOT_IN_SPEC)

- 2026-09-17 19:14: Distinguish SSH operator credentials from Kubernetes managed authentication. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - b8cabaf9a49e069a7668ccf88b9e71a7484227b7)

- 2026-09-17 02:58: Remove embedded preflight and trace shared-gateway cutover before actual startup credential validation. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - cfb384f22ebcbadcfb421b3020b4bb72fd657160)

- 2026-09-17 01:10: Document native authentication gates before dedicated readiness and embedded replacement cutover. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - 177a24e4)

- 2026-09-17 00:31: Align credential selection and delivery with Agent harnessAuth and the shared Kubernetes rendering path. (01a0acc2-a404-77e3-b1a0-9fa4ffbbdb04 - d2bcbd1c53acb2582a774b5158f254d726abd33f)

- 2026-09-01 19:09: Corrected Kubernetes after-commit activation semantics and merged the dedicated shared-workspace runtime ordering into this topology trace. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-28 21:20: Removed host-process local-test topology coverage; document Docker and Kubernetes runtime execution and verification. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 3ec166eb5fae39ed0f51ffb5ebd93338c4a2db94)
- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-27 00:05: Replaced the removed schema-contract suite with the authoritative harness-placement conformance test. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - ab560806dbd945436835ab092ebd10bf3e50d942)
- 2026-08-24 23:46: Distinguished operator-materialized API keys from API Compute-owned account Secrets, provider-neutral revision snapshots, direct dedicated-Codex token projection, and worker Secret authority. (01a03542-30ff-77a1-9967-587d55548ace - 51033bee121374332df2791e90e2290a5c892e5d)
- 2026-08-21 14:01: Consolidated explicit runtime selection, canonical approval, isolated dedicated credentials, predecessor-safe activation, and real dual model-turn proof. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 8796ccc)
- 2026-08-21 12:43: Documented dedicated and embedded model execution, the supported shared model, isolated in-memory Codex authentication, managed execution policy, and bounded proxy propagation. (01a0119a-9843-7423-a4c6-955ff4187bd9 - be58d1b)
- 2026-08-21 19:17: Documented explicit placement, immutable native Harness resolution, embedded versus dedicated Compute ownership, existing production credential/transport boundaries, recoverable activation, and two real provider-turn integration scenarios. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 149882c)
