# Kubernetes storage and credentials

Configure separate Gateway and Harness storage, and runtime
Secrets for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Shared contracts and the Codex implementation

The public `ComputeDriver` and `HarnessWorkloadRequirements` contracts describe
platform operations and workload requirements. OpenClaw's `AgentWorkspaceAccess`
provides workspace capabilities without depending on the Codex app-server
protocol. The dedicated storage implementation below currently supports Codex;
its launcher and filesystem layout are concrete Kubernetes implementation choices.

| Boundary         | Shared behavior                                                                           | Current dedicated Codex implementation                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workspace access | Gateway file consumers address the workspace used by the Harness, subject to file policy. | A paired file node serves `/home/node/workspace`; the Codex plugin uses the corresponding `appServer.remoteWorkspaceRoot`.  |
| Execution        | The selected Harness owns execution and its workspace lifecycle.                          | Codex app-server executes turns; a separate node serves file, Memory and Skills operations.                                 |
| Startup          | Compute delivers the selected workload and observes readiness.                            | The launcher supervises Codex and the file node separately, separates their credentials, and sets Codex shell/PATH options. |

These Codex details belong in OCE because OCE deploys this Harness. They are not
requirements for every Harness or additions to the public Compute contract.
The file node's explicit command allowlist disables OpenClaw worker hosting;
this launcher is not an OpenClaw remote worker launcher.

[Dedicated OpenClaw worker support (#77)](https://github.com/openclaw/openclaw-enterprise/issues/77)
remains pending and has no end-to-end proof here. Its integration must align
Gateway file access with the worker's actual assigned workspace and validate
worker command admission, attachments and readiness. Codex validation does not
establish that compatibility or require the worker to adopt Codex paths or
app-server settings.

## Gateway storage

Each real gateway, embedded or dedicated, receives one private `10Gi`
`ReadWriteOnce` filesystem claim named `gateway-state-<agent-hash>`, where
`agent-hash` is the first 12 hexadecimal characters of `sha256(agentId)`.
Dedicated claims live in the managed Gateway runtime namespace; embedded claims
remain in the tenant data-plane namespace. The required
`runtime.gatewayStorageClassName` selects an operator-provisioned
StorageClass for a local or cloud block disk mounted as a filesystem.

"SQLite-compatible" describes the backing storage, not a Kubernetes feature or
certification. The filesystem must provide reliable file locking, durable
writes through `fsync`, and support for SQLite's database and companion WAL/SHM
files in the same directory. The driver checks the claim configuration, but
does not certify the storage provider's locking or durability guarantees.
See [SQLite's filesystem requirements](https://sqlite.org/useovernet.html).

Do not use NFS or SMB/CIFS for gateway databases:
[SQLite WAL does not support network filesystems](https://sqlite.org/wal.html).
A cloud block disk accessed over a network is different: the node mounts a
filesystem on that disk instead of accessing a shared network filesystem.

`ReadWriteOnce` (RWO) means read-write access from one **node**, not one Pod;
[multiple Pods on that node may still mount it](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).
It does not establish SQLite compatibility or single-gateway access. Normal
gateway replacement uses one replica with `Recreate`; node partitions and
forced replacements still require operator fencing before permitting another
writer.

When stopping a revision, the Driver first stops its Gateway while the Harness
remains available to finish active work. The Gateway supervisor and Pod allow up
to 330 seconds for the pinned runtime's drain and cleanup budget; idle Gateways
should exit promptly. The controller waits for Gateway Pod disappearance before
stopping the Harness. Forced termination can leave an owner lease until it
expires and delay the successor; a longer grace period does not make forced
termination a clean shutdown.

Only the gateway Pod receives this claim. Its complete writable directories
include database files and their WAL/SHM siblings:

| Private subpath             | Gateway mount                               |
| --------------------------- | ------------------------------------------- |
| `state`                     | `/home/node/.openclaw/state`                |
| `agent`                     | `/home/node/.openclaw/agents/main/agent`    |
| `media`                     | `/home/node/.openclaw/media`                |
| `sessions` (dedicated mode) | `/home/node/.openclaw/agents/main/sessions` |

Embedded gateways also mount the same private claim's `workspace` subpath at
`/home/node/.openclaw/workspace`, the default workspace under the configured
`OPENCLAW_STATE_DIR`. This retains the workspace files attested by gateway
SQLite so a continued turn after Pod replacement does not fail with
`WorkspaceVanishedError`. Native configurations that override the workspace
path are outside this default-workspace persistence contract. In dedicated mode,
`/home/node/workspace` is a logical Gateway workspace key: file access uses the
paired node, and Gateway does not mount the Harness workspace.

A nonroot init container prepares these directories using the gateway image,
without credentials or additional privileges. The nested
`agents/main/agent/codex-home` is overmounted from Pod-local `emptyDir` so
Codex credentials remain ephemeral. The remaining private runtime home is
also ephemeral. Persisting these directories does not persist the entire home.

The same nonroot initializer creates a private temporary directory in each
Pod's `emptyDir`, mounted at `/tmp` for native safe temporary-file operations.
OCE disables OpenClaw automatic package updates in the Gateway and workspace
node; runtime upgrades use the operator-selected image and ordinary redeployment.

## Harness storage

Each dedicated Agent receives a `40Gi` `ReadWriteOnce` (RWO) filesystem claim
from the default StorageClass, mounted only by its Harness:

| Subpath                                       | Harness mount                        |
| --------------------------------------------- | ------------------------------------ |
| `workspace`                                   | `/home/node/workspace`               |
| `generated-images`                            | `/home/node/.codex/generated_images` |
| `workspace-node-<agent-hash>-<revision-hash>` | `/home/node/.openclaw-node`          |

The revision-specific directory retains file-node identity across Pod replacement.
Sessions stay on the private Gateway claim. Selected generated-image bytes return
through the Codex remote-media reader; there is no shared image mount. Each image
initializes its own bundled/plugin assets instead of mounting shared Skill trees.
The Harness never receives the Gateway claim. Embedded Agents use the private
claim without creating this Harness claim.

The worker stops all earlier revisions and waits for their Pods to terminate
before preparing a dedicated replacement. This includes failed candidates and
Sandbox-owned workloads. Replacement has a downtime window; it does not need
simultaneous cross-node mounts. Older reconciliation and maintenance are
superseded when a newer exclusive revision is admitted. If preparation fails,
retry the candidate or deploy the intended configuration as a new revision;
OCC does not restart a lower revision automatically or roll back filesystem writes
made by a failed candidate. The last committed active
revision is not proof that its Pod still runs during replacement.

Existing owned `ReadWriteMany` workspace claims remain usable without changing
their spec, identity, or data. New claims use RWO; Gateway private claims still
require RWO. No revision stop or retirement replaces a PVC with ephemeral storage.

RWO does not fence writers on a partitioned node. Pod termination and the storage
provider's safe detach/attach behavior remain required; the Driver never force
detaches a disk. A local-path PV keeps its node affinity and cannot move its data
to another node. Cross-node rescheduling needs an appropriate portable StorageClass,
not RWX. See the [Compute replacement contract](../compute.md#production-revision-stages)
and [workspace flow](../../../flows/workspace-files.md) for runtime boundaries.

Both claims retain exact Namespace and Agent ownership across revision
cutover and gateway Pod replacement. Reconciliation rejects foreign,
terminating, or incompatible claims without mutating them. The driver creates
the claims before their consumers and relies on gateway workload readiness;
waiting for `Bound` before creating a Pod would deadlock
`WaitForFirstConsumer` storage classes. Stopping or retiring a revision retains
both claims, including when the gateway has already stopped. Agent deletion
retires every revision before its final cleanup hook deletes the owned claims
using their exact Kubernetes UIDs. A cleanup failure keeps deletion pending
for retry; it does not remove the Agent's database identity.

## Managed native configuration

Ordinary runtime gateways read the managed ConfigMap at
`/etc/openclaw/openclaw.json`. Native admin editing uses a writable copy only
when runtime gateway images and private `gatewayRouting` are configured and
the saved native Configuration explicitly enables the pilot shape:

- Trusted-proxy authentication accepts `x-occ-identity: occ-workspace-files`
  with `operator.admin` identity scopes.
- Trusted-proxy device auto-approval is enabled with `operator.admin` scope.
- `controlUi.enabled` is true and `controlUi.allowedOrigins` is nonempty.
- Dangerous device-auth disabling and host-header origin fallback are disabled.

For those gateways, the managed ConfigMap remains read-only at
`/etc/openclaw-managed/openclaw.json`. The nonroot init container copies it to
`/home/node/.openclaw/openclaw.json` on the Pod-local `emptyDir`, and
`OPENCLAW_CONFIG_PATH` points to that writable copy. Gateways without the full
opt-in shape, including ordinary routed gateways, keep the read-only path.

Native edits change only the copy; Pod replacement or Agent redeployment
restores the managed snapshot. The persistent gateway and workspace claims
retain their data. This behavior does not import edits into OCE Configuration
or immutable AgentRevisions. See the [native admin feature boundary](../../agent-native-admin.md#native-authority-and-drift)
and [deployment procedure](../../../guides/deploy/native-admin.md).

## Runtime credentials

Canonical Configuration, OCC Secret and managed account credential sources live
in the tenant's managed control-plane namespace. Dedicated Gateways reference
admitted channel Secrets there directly; Compute verifies their scope and UID.
There is no data-plane source or Gateway Secret mirror.

For dedicated execution, `transport-<agent-hash>` (using the configured prefix)
contains only `app-server-token`; `gateway-password-<agent-hash>` contains only
`gateway-password`. Both are canonical CP resources. Compute creates
`harness-secrets-<agent-hash>-<revision-hash>` in the data plane, containing only
the selected model credential fields and app-server token. Harness Pods reference
that revision-owned runtime Secret. Gateway password and channel tokens never
enter it. Managed account sources retain account ownership in CP; runtime copies
have exact Namespace, Agent, service-principal and revision ownership.

Preparation checks admitted source identities before writing runtime material.
Repeated preparation repairs absent or changed projections. Activation validates
Gateway sources and selects the prepared revision; it does not issue credentials.
Retirement waits for the old workload to stop before deleting its projection by
UID. Gateway and account canonical sources survive revision retirement; final
Agent deletion removes its transport/password, while account and OCC Secret
storage retain their separate lifecycles.

Source updates do not restart running processes. The supported model-key update
sequence is: update the OCC Secret, redeploy each consuming Agent through OCE,
wait for the new revision to become active, and verify a model request with the
new credential. Preparation delivers current source values to the new revision's
runtime Secret. Merely recreating a Harness Pod or restarting its Deployment
reads the existing projection and does not refresh it from CP. See
[update and redeploy](../kubernetes-secret.md#update-and-redeploy).
Deleting a source or runtime Secret
does not revoke bytes already loaded into a process or accepted by a provider.
Transport rotation, finite token TTL and immediate revocation remain open; see
[follow-up tracking](../../../../specs/36-control-plane-gateways-plan.md#open-work-and-release-boundaries).
Embedded execution retains its combined workload and transport bundle; CP-backed
model/configuration sources are delivered to that workload as needed. It is
outside the dedicated trust-boundary acceptance scope.

When Kubernetes runtime credentials are configured,
[Agent creation or first deployment](../../console/create-and-deploy.md#initial-runtime-credentials)
creates missing per-Agent transport and Gateway password Secrets before the first
AgentRevision through
the selected Driver. It derives their names internally, checks Namespace and
Agent ownership, and creates missing whole Secrets without replacing existing
values. Backend-managed credentials and Configuration Secret bindings retain
their separate provisioning paths.

The controller API service account needs `list` permission for Deployments in
both physical namespaces so it can reject an existing runtime before
creating initial Secrets.

The Driver names each Agent-specific transport Secret with the configured
`runtime.transportSecretPrefix` followed by the first 12 hexadecimal characters
of `sha256(agentId)`. Kubernetes gateways use
trusted-proxy authentication only. Initial provisioning generates
`gateway-password` and the independent `app-server-token`; dedicated Codex
requires the latter for its Harness transport. Dedicated provisioning requires
two separate nonempty single-key Secrets; embedded provisioning retains the
combined bundle. Credential inspection rejects other shapes.
The Driver projects `gateway-password` as `OPENCLAW_GATEWAY_PASSWORD`
only when `gateway.auth.password` explicitly uses an environment SecretRef with
that ID. This supports native local-direct password access alongside trusted-proxy
authentication; the API never returns the password. Plaintext password Configuration
is rejected.

The Agent's required [harnessAuth binding](../../agents.md#harness-authentication)
selects the model credential. API keys use the selected OCC Secret Driver's
exact reference; account tokens use an account-owned CP source. Compute delivers
only the admitted fields to a revision-owned runtime Secret and selects the
explicit login mode during workload rendering. Only the combined embedded gateway/Harness or dedicated
Codex consumer receives it; a dedicated gateway never receives model auth. A
[credential source](../../credential-sources.md) binding is the exception: Compute
renders no model Secret and hands the Credential Gateway's attachments to the
OpenShell Sandbox instead.

If channels are enabled, configure `runtime.channels.proxyUrl`, then store the
Agent's channel credentials as Namespace Secrets referenced by Configuration
`secretBindings`. Channel credentials are available only to the dedicated gateway,
never to its Codex Harness.

Repository-bearing revisions support embedded OpenClaw or dedicated Codex,
without a Sandbox Driver. Compute delivers each immutable repository-material
generation only to the container that executes commands:

| Credential material      | Embedded gateway/Harness | Dedicated gateway | Dedicated Codex |
| ------------------------ | ------------------------ | ----------------- | --------------- |
| Repository session files | Yes                      | No                | Yes             |
| Model credential         | Yes                      | No                | Yes             |
| Slack channel tokens     | Unsupported              | Yes               | No              |

Readiness must match that consumer's exact revision and material generation.
Same-revision rotation replaces the consuming workload; a Ready Pod carrying
older material is insufficient. Preparation rechecks the generation after
asynchronous plugin status and dedicated gateway/node observations. Dedicated
replacement preserves the enrolled workspace node and its private state mount. The worker owns missing-material repair and
session replacement. Cleanup retains Secrets while owned Deployments or Pods
still reference them. See the
[repository credential flow](../../../flows/agent-repository-credentials.md).

Use an approved secret manager, protected files, or standard input when
creating Secrets. Never expose credentials in command-line arguments or logs.
Missing or incorrectly scoped credentials fail deployment.

Use `runtime.codexSeccompProfile` only for a reviewed Codex compatibility
allowlist. The optional profile exists for source-backed compatibility cases
where Codex `0.158.0` cannot start because `RuntimeDefault` denies the
user-namespace `clone`, `unshare`, and `mount` calls used by bubblewrap. It
does not relax filesystem or network policy: Codex and bubblewrap still own
runtime filesystem boundaries, while Kubernetes NetworkPolicies and the
configured runtime channel proxy own network enforcement.

See [service-account credential delivery](../../service-accounts.md#backend-managed-access-tokens)
for provider-issued credentials and supported execution modes.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Runtime security boundaries](../../security/runtime-isolation.md)
