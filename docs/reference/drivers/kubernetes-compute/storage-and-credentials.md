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
The required `runtime.gatewayStorageClassName` selects an operator-provisioned
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

## Harness storage

Each dedicated Agent receives a `40Gi` `ReadWriteMany` claim mounted only by
Harness Pods:

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

RWX remains necessary for the Driver's overlapping Harness revisions, not for
Gateway access. The interface and Skill ownership proposal is recorded in
[the storage split specification](../../../../specs/30-storage-split-integration.md#where-data-lives).
Rendered mounts do not establish deployed runtime compatibility; use the
[workspace flow](../../../flows/workspace-files.md) for integration status.

Both claims retain exact Namespace and Agent ownership across revision
cutover and gateway Pod replacement. Reconciliation rejects foreign,
terminating, or incompatible claims without mutating them. The driver creates
the claims before their consumers and relies on gateway workload readiness;
waiting for `Bound` before creating a Pod would deadlock
`WaitForFirstConsumer` storage classes. Retiring a predecessor preserves the
current gateway and its claims. Final gateway teardown requests deletion of
its owned claims using their exact Kubernetes UIDs before deleting the
gateway; PVC protection completes deletion after Pods unmount. Agent deletion
is not currently a supported API operation.

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

Before the first AgentRevision, the [console credential workflow](../../console/create-and-deploy.md#initial-runtime-credentials)
can create initial per-Agent transport and Slack Secrets through
the selected Driver. It derives their names internally, checks Namespace and
Agent ownership, and creates missing whole Secrets without replacing existing
values. Provider-managed credentials and Configuration Secret bindings retain
their separate provisioning paths.

The controller API service account needs `list` permission for Deployments in
that exact tenant namespace so it can reject an existing runtime before
creating initial Secrets.

Before deploying an Agent, provision its Agent-specific transport Secret using
the configured `runtime.transportSecretPrefix`. The Secret name appends the
first 12 hexadecimal characters of `sha256(agentId)`. Token-mode gateways use
`gateway-token`; dedicated Agents additionally require `app-server-token`. When
native Configuration explicitly selects `gateway.auth.mode: "trusted-proxy"`,
the generated Secret may still contain a `gateway-token` key, but the Driver
does not project it into the gateway environment. The initial credential API also
generates `gateway-password`. The Driver projects it as `OPENCLAW_GATEWAY_PASSWORD`
only when `gateway.auth.password` explicitly uses an environment SecretRef with
that ID. This supports native local-direct password access alongside trusted-proxy
authentication; the API never returns the password. Plaintext password Configuration
is rejected.

The Agent's required [harnessAuth binding](../../agents.md#harness-authentication)
selects the model credential. API keys use the selected OCC Secret Driver's
exact reference; account tokens use one directly projected account-owned
Secret. Kubernetes prepares the projection and explicit login mode during
workload rendering. Only the combined embedded gateway/Harness or dedicated
Codex consumer receives it; a dedicated gateway never receives model auth.

If channels are enabled, configure `runtime.channels.proxyUrl`, then store the
Agent's channel credentials as Namespace Secrets referenced by Configuration
`secretBindings`. Channel credentials are available only to the dedicated gateway,
never to its Codex Harness.

Use an approved secret manager, protected files, or standard input when
creating Secrets. Never expose credentials in command-line arguments or logs.
Missing or incorrectly scoped credentials fail deployment.

Use `runtime.codexSeccompProfile` only for a reviewed Codex compatibility
allowlist. The optional profile exists for source-backed compatibility cases
where Codex `0.156.0` cannot start because `RuntimeDefault` denies the
user-namespace `clone`, `unshare`, and `mount` calls used by bubblewrap. It
does not relax filesystem or network policy: Codex and bubblewrap still own
runtime filesystem boundaries, while Kubernetes NetworkPolicies and the
configured runtime channel proxy own network enforcement.

See [service-account credential delivery](../../service-accounts.md#provider-managed-access-tokens)
for provider-issued credentials and supported execution modes.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Runtime security boundaries](../../security/runtime-isolation.md)
