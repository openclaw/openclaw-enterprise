# Kubernetes storage and credentials

Configure separate Gateway and Harness storage, and runtime
Secrets for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Shared contracts and the Codex implementation

The public `ComputeDriver` and `HarnessWorkloadRequirements` contracts describe
platform operations and workload requirements; OpenClaw's `AgentWorkspaceAccess`
provides workspace capabilities without the Codex app-server protocol. The dedicated storage implementation below currently supports Codex;
its launcher and filesystem layout are Codex-specific Kubernetes choices, not
requirements for every Harness or additions to the public Compute contract.

| Boundary         | Shared behavior                                                                           | Current dedicated Codex implementation                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workspace access | Gateway file consumers address the workspace used by the Harness, subject to file policy. | A paired file node serves `/home/node/workspace`; the Codex plugin uses the corresponding `appServer.remoteWorkspaceRoot`.  |
| Execution        | The selected Harness owns execution and its workspace lifecycle.                          | Codex app-server executes turns; a separate node serves file, Memory and Skills operations.                                 |
| Startup          | Compute delivers the selected workload and observes readiness.                            | The launcher supervises Codex and the file node separately, separates their credentials, and sets Codex shell/PATH options. |

The file node's explicit command allowlist disables OpenClaw worker hosting;
this launcher is not an OpenClaw remote worker launcher.

[Dedicated OpenClaw worker support (#77)](https://github.com/openclaw/openclaw-enterprise/issues/77)
remains pending without end-to-end proof. It must align Gateway file access with
the worker's assigned workspace and validate worker command admission,
attachments and readiness. Codex validation neither establishes that
compatibility nor requires the worker to adopt Codex paths or app-server settings.

## Gateway storage

Each real gateway, embedded or dedicated, receives one private `10Gi`
`ReadWriteOnce` filesystem claim named `gateway-state-<agent-hash>`, where
`agent-hash` is the first 12 hexadecimal characters of `sha256(agentId)`.
Claims live in the tenant namespace in a single cluster; dedicated Gateway claims
use the control-cluster Gateway namespace only with the two-cluster profile. The required
`runtime.gatewayStorageClassName` selects an operator-provisioned
StorageClass for a local or cloud block disk mounted as a filesystem.

The filesystem must be SQLite-compatible: reliable file locking, durable writes
through `fsync`, and support for SQLite's database and companion WAL/SHM files
in the same directory. The driver checks the claim configuration but does not
certify the storage provider's locking or durability guarantees.
See [SQLite's filesystem requirements](https://sqlite.org/useovernet.html).

Do not use NFS or SMB/CIFS for gateway databases:
[SQLite WAL does not support network filesystems](https://sqlite.org/wal.html).
A network-attached cloud block disk is different: the node mounts its own
filesystem on that disk.

`ReadWriteOnce` (RWO) means read-write access from one **node**, not one Pod;
[multiple Pods on that node may still mount it](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).
It does not establish SQLite compatibility or single-gateway access. Normal
gateway replacement uses one replica with `Recreate`; node partitions and
forced replacements still require operator fencing before permitting another
writer.

When stopping a revision, the Driver stops its Gateway first while the Harness
finishes active work, and waits for the Gateway Pod to disappear before stopping
the Harness. The Gateway supervisor and Pod allow up to 330 seconds for the
pinned runtime's drain and cleanup budget; idle Gateways should exit promptly. Forced termination can leave an owner lease until it
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
`OPENCLAW_STATE_DIR`, retaining the workspace files attested by gateway
SQLite so a continued turn after Pod replacement does not fail with
`WorkspaceVanishedError`. Native configurations that override the workspace
path are outside this persistence contract. In dedicated mode,
`/home/node/workspace` is a logical Gateway workspace key served by the paired
node; Gateway does not mount the Harness workspace.

A nonroot init container prepares these directories using the gateway image,
without credentials or additional privileges. The nested
`agents/main/agent/codex-home` is overmounted from Pod-local `emptyDir` so
Codex credentials remain ephemeral; the rest of the private runtime home is
also ephemeral.
The same init container creates a node-owned mode-`0700` subdirectory on the
Pod-local temporary `emptyDir` and mounts it at `/tmp`, preserving private
temp-workspace ancestry for Gateway and Harness processes; the fsGroup-writable
volume root is never their runtime temp root.

OCE disables OpenClaw automatic package updates in the Gateway and workspace
node; runtime upgrades use the operator-selected image and ordinary redeployment.
State on this claim outlives those upgrades. Before OpenClaw starts, the Gateway
wrapper runs `openclaw doctor --fix --non-interactive` once, with the
configuration read-only, when an agent database uses an older schema than the
pinned OpenClaw; Doctor keeps a `.pre-startup-migration-<id>.bak` copy beside
it. A database still older afterwards holds the Gateway unready with check
`state-migration` (`RUNTIME_STARTUP_FAILED`).

## Harness storage

Each dedicated Agent receives a `40Gi` `ReadWriteOnce` filesystem claim
from the default StorageClass, mounted only by its Harness:

| Subpath                                        | Harness mount                        |
| ---------------------------------------------- | ------------------------------------ |
| `codex-home` ([OAuth](codex-oauth-storage.md)) | `/home/node/.codex`                  |
| `workspace`                                    | `/home/node/workspace`               |
| `generated-images`                             | `/home/node/.codex/generated_images` |
| `codex-sessions`                               | `/home/node/.codex/sessions`         |
| `workspace-node-<agent-hash>-<harness-hash>`   | `/home/node/.openclaw-node`          |

The nonroot init container creates each subpath as uid 1000 with mode `0700`
before the kubelet mounts it. Claims from the first release hold root-owned
`workspace` and `generated-images` directories the kubelet created; the init
renames such a directory aside, recreates it and moves its entries back. A name
the new directory already has stays in `.<subpath>.kubelet-created`.

This directory keeps node identity across Pod and revision replacement.
The node Secret's setup code expires ten minutes after preparation mints it. A
node with a saved device token for the same Gateway reconnects with that token;
one without saved credentials rejects an expired code.

A Deployment-backed Codex Harness renders this wiring from its first start,
mounting the node Secret as an optional volume at `/run/openclaw-node-setup`
that projects only `setupCode`, so the Harness starts before the Secret exists.
Codex starts at once; the node starts when the file holds a complete code.
After writing the Secret, preparation annotates the running Harness Pod so the
kubelet refreshes the volume within about two seconds instead of its roughly
one-minute periodic resync; enrollment restarts neither the Harness nor its
Gateway. The worker needs `patch` on Pods in tenant
namespaces; without it the pass fails.

The file mode is `0440`. Secret volume files are root-owned and the kubelet
grants the Pod `fsGroup` read access, so `0400` would behave the same. Codex
runs as the same user and group and can read the code, as it can already read
the node's command line. Once readiness records the device ID, the controller
removes `setupCode` from the Secret and annotates the Pod again, so the kubelet
removes the file within seconds; the node then reconnects with its saved device
token, and preparation mints no new code for it. If the Gateway loses that
pairing, delete the Agent's node Secret: the next pass mints a code, which the
node uses when it restarts. Native workers and SandboxDriver Harnesses receive the code in
their environment, keep it for restarts, and are replaced to attach the node.
Installations that enrolled one node per revision enroll a new Agent device once,
at the first replacement; retiring each earlier revision deletes its node Secret.
Sessions stay on the private Gateway claim, which the Harness never receives. Selected generated-image bytes return
through the Codex remote-media reader; there is no shared image mount. Each image
initializes its own bundled/plugin assets instead of mounting shared Skill trees.
Embedded Agents use the private claim without creating this Harness claim.

Default node writes include workspace `skills/**`, `.clawhub/lock.json`,
`.clawdhub/lock.json`, and `.openclaw/skill-installs/**`; explicit policies remain
unchanged. Skill lifecycle operations require a compatible runtime. See the
[workspace flow](../../../flows/workspace-files.md) for authorization boundaries.

The worker stops all earlier revisions and waits for their Pods to terminate
before preparing a dedicated replacement, including failed candidates and
Sandbox-owned workloads. Replacement has a downtime window; it does not need
simultaneous cross-node mounts. If preparation fails, retry the candidate or
deploy the intended configuration as a new revision; OCC does not restart a lower
revision automatically or roll back filesystem writes made by a failed candidate.
The last committed active revision is not proof that its Pod still runs during
replacement. A newer admitted exclusive revision supersedes older reconciliation and
maintenance; see the [Compute replacement contract](../compute.md#production-revision-stages).

Existing RWX Harness or Gateway claims are rejected during reconciliation and
final Agent deletion; follow the
[upgrade prerequisite](../../../guides/deploy/upgrade-checklist.md#remove-legacy-rwx-workspaces).

As with the Gateway claim, RWO does not fence writers on a partitioned node. Pod
termination and the storage provider's safe detach/attach behavior remain
required; the Driver never force detaches a disk. A local-path PV keeps its node
affinity and cannot move its data to another node. Cross-node rescheduling needs
an appropriate portable StorageClass, not RWX.

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
restores the managed snapshot, while the persistent gateway and workspace claims
retain their data. Edits stay outside OCE Configuration and AgentRevisions; see
the [native admin feature boundary](../../agent-native-admin.md#native-authority-and-drift)
and [deployment procedure](../../../guides/deploy/native-admin.md).

## Runtime credentials

Canonical Configuration, OCC Secret and managed account credential sources live
in the shared tenant namespace in a single cluster, or the control-cluster
storage target with the two-cluster profile. Dedicated Gateways reference
admitted channel Secrets there directly; Compute verifies their scope and UID.
There is no Gateway Secret mirror.

New credentials use `transport-<agent-hash>` (configured prefix) with only
`app-server-token`, and `gateway-password-<agent-hash>` with only
`gateway-password`, in either execution mode. The hash is 12 hexadecimal
characters. Startup refuses a prefix when `<prefix>-<hash>` is not a DNS-safe
Kubernetes resource name, the same check credential provisioning already applies.
Mode changes preserve these sources.
Legacy combined transport Secrets remain readable. Before rendering new workloads,
Compute copies their password into an owned separate source; the legacy Secret
survives for older Gateway Pods. Conflicting password sources fail closed.
`harness-secrets-<agent-hash>-<revision-hash>` contains only selected model fields
and the app-server token. Gateway passwords and channel tokens never enter the
Harness projection. Managed account sources retain account ownership; runtime
copies have exact Namespace, Agent, service-principal and revision ownership.

Preparation checks admitted source identities before writing runtime material
and, when repeated, repairs absent or changed projections. Activation validates
Gateway sources and selects the prepared revision; it does not issue credentials.
Stop and retirement wait for the workload to stop, then delete its projection
and revision ConfigMaps by UID. Canonical sources survive retirement; Agent deletion removes transport/password.
Account and OCC Secret lifecycles remain independent.

Source updates do not restart running processes. The supported model-key update
sequence is: update the OCC Secret, redeploy each consuming Agent through OCE,
wait for the new revision to become active, and verify a model request with the
new credential. Preparation delivers current source values to the new revision's
runtime Secret. Merely recreating a Harness Pod or restarting its Deployment
reads the existing projection and does not refresh it from the canonical source. See
[update and redeploy](../kubernetes-secret.md#update-and-redeploy).
Deleting a source or runtime Secret does not revoke bytes a process loaded or a
provider accepted.
Transport rotation, finite token TTL and immediate revocation remain open; see
[follow-up tracking](../../../../specs/plans/36-control-plane-gateways-plan.md#open-work-and-release-boundaries).
Embedded execution combines Gateway and Harness in one workload; model/configuration
sources are delivered to that workload.

When Kubernetes runtime credentials are configured,
[Agent creation or first deployment](../../console/create-and-deploy.md#initial-runtime-credentials)
creates missing per-Agent transport and Gateway password Secrets, generating
`gateway-password` and the independent `app-server-token`, before the first
AgentRevision through the selected Driver. It derives their names internally,
checks Namespace and Agent ownership, and creates missing whole Secrets without
replacing existing values.
Backend-managed credentials and Configuration Secret bindings retain
their separate provisioning paths.

The controller API service account needs `list` permission for Deployments in
each runtime target so it can reject an existing runtime before
creating initial Secrets.

The Driver projects `gateway-password` as `OPENCLAW_GATEWAY_PASSWORD` only when
`gateway.auth.password` explicitly uses an environment SecretRef with that ID.
This supports native local-direct password access alongside
[trusted-proxy authentication](networking-and-isolation.md#gateway-authentication),
the only Kubernetes gateway mode; the API never returns the password. Plaintext password Configuration
is rejected.

The Agent's required [harnessAuth binding](../../agents.md#harness-authentication)
selects the model credential. API keys use the selected OCC Secret Driver's
exact reference; account tokens use an account-owned CP source. Compute selects
the explicit login mode during workload rendering. Only the combined embedded gateway/Harness or dedicated
Codex consumer receives the model credential; a dedicated gateway never receives model auth. A
[credential source](../../credential-sources.md) binding is the exception: Compute
renders no model Secret and hands the Credential Gateway's attachments to the
OpenShell Sandbox instead.

If channels are enabled, set `runtime.channels.proxyUrl` to a literal-IP proxy
URL, or to the Helm-managed proxy Service URL paired with
`runtime.channels.managedProxy` so Compute limits gateway egress to that proxy's
Pods by selector. Store the Agent's channel credentials as Namespace Secrets
referenced by Configuration `secretBindings`; they are available only to the
dedicated gateway, never to its Codex Harness.

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
older material is insufficient. Cleanup retains Secrets while owned Deployments
or Pods still reference them. The
[repository credential flow](../../../flows/agent-repository-credentials.md#4-deliver-and-retain-one-complete-runtime-generation)
covers generation rechecks, missing-material repair, and how dedicated
replacement preserves node enrollment.

Use an approved secret manager, protected files, or standard input when
creating Secrets. Never expose credentials in command-line arguments or logs.
Missing or incorrectly scoped credentials fail deployment.

Use the optional `runtime.codexSeccompProfile` only for a reviewed Codex
compatibility allowlist in source-backed cases; it does not relax filesystem or
network policy. [Pod and container hardening](../../security.md#pod-and-container-hardening)
states when Codex `0.163.0-alpha.1` needs it and which components own those boundaries.

See [service-account credential delivery](../../service-accounts.md#backend-managed-access-tokens)
for provider-issued credentials and supported execution modes.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Runtime security boundaries](../../security/runtime-isolation.md)
