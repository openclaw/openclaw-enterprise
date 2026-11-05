# Kubernetes storage and credentials

Configure [separate Gateway and Harness storage](../../../guides/topics/remote-harness.md) and runtime
Secrets for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Shared contracts and the Codex implementation

`ComputeDriver` and `HarnessWorkloadRequirements` are shared contracts.
OpenClaw's `AgentWorkspaceAccess` is independent of Codex's protocol.
The layout and launcher below describe dedicated Codex only.

| Boundary         | Shared behavior                                                                           | Current dedicated Codex implementation                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workspace access | Gateway file consumers address the workspace used by the Harness, subject to file policy. | A paired file node serves `/home/node/workspace`; the Codex plugin uses the corresponding `appServer.remoteWorkspaceRoot`.  |
| Execution        | The selected Harness owns execution and its workspace lifecycle.                          | Codex app-server executes turns; a separate node serves file, Memory and Skills operations.                                 |
| Startup          | Compute delivers the selected workload and observes readiness.                            | The launcher supervises Codex and the file node separately, separates their credentials, and sets Codex shell/PATH options. |

The file node's command allowlist disables OpenClaw worker hosting.

[Dedicated native OpenClaw](../../harness-execution.md#native-worker-support)
has an experimental worker path with Sandbox-owned Harness provisioning.
Compute manages the Harness PVC and supplies its approved storage mounts.
[Issue #77](https://github.com/openclaw/openclaw-enterprise/issues/77) tracks outstanding
end-to-end qualification of model/tool turns, replacement, and retirement.
Codex validation does not qualify native workers or require them to use Codex
paths or app-server settings.

## Gateway storage

Each real gateway, embedded or dedicated, receives one private `10Gi`
`ReadWriteOnce` filesystem claim named `gateway-state-<agent-hash>`, where
`agent-hash` is the first 12 hexadecimal characters of `sha256(agentId)`.
Claims live in the tenant namespace in a single cluster; dedicated Gateway claims
use the control-cluster Gateway namespace only with the two-cluster profile. The required
Kubernetes DNS-subdomain `runtime.gatewayStorageClassName` selects an
operator-provisioned StorageClass for a local or cloud block disk mounted as a
filesystem.

The filesystem must support SQLite locking, durable `fsync`, and colocated
database and WAL/SHM files. The Driver checks claim configuration, not filesystem
guarantees. See [SQLite’s requirements](https://sqlite.org/useovernet.html).

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

A stop deletes the Gateway and waits for its Pod to disappear before stopping the
Harness, which finishes active work meanwhile; a refused candidate's stop deletes
both at once. The Gateway supervisor and Pod allow up to 330 seconds for the
pinned runtime's drain and cleanup. Idle Gateways exit promptly. Forced
termination can leave native Gateway locks and an owner lease on retained state.

If the kubelet restarts an embedded Gateway container in the same Pod, OpenClaw
can recover locks held by the **first container instance**. Before configurable
code runs, that instance signs its Pod UID and Linux PID namespace and discards
the signing key. The replacement uses a read-only public key held in the Pod
to verify the previous instance, then asks OpenClaw to check every holder.
This requires OCE's runtime launcher, private container PID namespaces and no
custom lifecycle environment, additional Secret bindings, or repository tooling.
Replacing the Pod discards its keys. A later container's locks or a missing
record also require [operator recovery](../../../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner).

Only the Gateway Pod mounts these writable directories, including SQLite
databases and their WAL/SHM siblings:

| Private subpath             | Gateway mount                               |
| --------------------------- | ------------------------------------------- |
| `state`                     | `/home/node/.openclaw/state`                |
| `client`                    | `/home/node/.openclaw/client`               |
| `agent`                     | `/home/node/.openclaw/agents/main/agent`    |
| `media`                     | `/home/node/.openclaw/media`                |
| `worktrees`                 | `/home/node/.openclaw/worktrees`            |
| `worktree-sources`          | `/home/node/.openclaw/worktree-sources`     |
| `sessions` (dedicated mode) | `/home/node/.openclaw/agents/main/sessions` |

Linked worktrees and Git metadata in `worktree-sources` persist across Gateway replacement.
The retained database requires the client store’s migration receipt; both persist.

Embedded Gateways mount the claim's `workspace` subpath at
`/home/node/.openclaw/workspace`, the default workspace under the configured
`OPENCLAW_STATE_DIR`, retaining the workspace files attested by gateway
SQLite so a continued turn after Pod replacement does not fail with
`WorkspaceVanishedError`. Native workspace path overrides are outside this
persistence contract. In dedicated mode,
`/home/node/workspace` is a logical Gateway workspace key served by the paired
node; Gateway does not mount the Harness workspace.

A nonroot init container prepares directories without credentials or extra privileges. The nested
`agents/main/agent/codex-home` is overmounted from Pod-local `emptyDir` so
Codex credentials remain ephemeral; the rest of the private runtime home is
ephemeral.
The init container creates a node-owned mode-`0700` subdirectory on the
Pod-local temporary `emptyDir` and mounts it at `/tmp`, preserving private
temp-workspace ancestry for Gateway and Harness processes; the fsGroup-writable
volume root is never their runtime temp root.

OCE disables OpenClaw automatic package updates in the Gateway and workspace
node; runtime upgrades use the operator-selected image and ordinary redeployment.
State on this claim outlives those upgrades. Before OpenClaw starts, the Gateway
wrapper runs `openclaw doctor --fix --non-interactive` once, with the
configuration read-only, when the shared state database or an agent database
uses an older schema than the pinned OpenClaw; Doctor keeps a
`.pre-startup-migration-<id>.bak` copy beside each. Outdated schemas or refused
maintenance hold the Gateway unready with check `state-migration`
(`RUNTIME_STARTUP_FAILED`). A marker beside the retained shared database requires retry after Pod replacement,
even if schemas already advanced.

## Harness storage

Each dedicated Agent receives a `40Gi` `ReadWriteOnce` filesystem claim
from the default StorageClass, mounted only by its Harness:

| Subpath                                      | Harness mount                        |
| -------------------------------------------- | ------------------------------------ |
| `workspace`                                  | `/home/node/workspace`               |
| `generated-images`                           | `/home/node/.codex/generated_images` |
| `codex-sessions`                             | `/home/node/.codex/sessions`         |
| `workspace-node-<agent-hash>-<harness-hash>` | `/home/node/.openclaw-node`          |

The nonroot initializer creates each subpath as uid 1000 with mode `0700`.
For existing root-owned `workspace` and `generated-images` directories, it
recreates ownership and moves entries back; conflicting names remain in
`.<subpath>.kubelet-created`.

Node identity survives replacement. Before setup or connection,
the Harness runs [Gateway](#gateway-storage) Doctor with the node environment
for older databases; incomplete maintenance holds at `state-migration`.
Doctor and the node stage SQLite under private `/tmp` children, avoiding
group-writable persistent ancestors without changing state permissions.

Setup expires after ten minutes. `--pair-or-reconnect` tries fresh setup;
only `AUTH_BOOTSTRAP_TOKEN_INVALID` permits saved-token retry. Expired codes
require credentials bound to the same device, Gateway scope and TLS pin.
Renewal preserves the enrolled endpoint.

OCC records receipts as `setupReceiptDeviceId`. The node saves, reads back, and
reconnects with its credential. `node.describe` must confirm
current-session token authentication before setting `deviceId`. Disconnect or
pairing replacement clears proof; live approval requires reauthentication.
Grants stay unchanged. Readiness records the revision.

After OCC retains the receipt, missing status cannot trigger fresh credentials.
If its first reconciliation follows Gateway's 20-minute receipt retention,
preparation can renew expired setup without recovering the prior receipt; this
remains a limitation. Unconfirmed possession after expiry requires recovery below.

Endpoint changes require successful credential retirement and preserve identity.
Exact-device resume uses saved endpoint and Cloudflare Access settings without
ambient overrides or configuration writes. Saved Access requires matching
WebSocket scope and TLS pin.

Each local profile permits one node runner; [lock recovery](../../../guides/topics/agent-troubleshoot.md#deployment-is-blocked-or-has-no-selected-version)
never relies on age.

Deployment-backed Codex mounts only `setupCode` at `/run/openclaw-node-setup`.
Codex starts before enrollment; the node awaits complete setup. Preparation annotates the Pod after Secret writes to refresh kubelet's
projection in about two seconds instead of one minute; tenant Pod `patch`
permission is required.

The projection is `0440`; kubelet grants `fsGroup` read access even with `0400`.
Codex shares the node's user/group and can read code and arguments. Recording
the device removes `setupCode` and annotates the Pod, removing the file within
seconds. Later starts use the saved token.

Supervisors poll Codex files and native-worker provider envelopes every second.
Files and encoded setup are capped at 65,536 bytes each; Gateway URLs require
`ws://`/`wss://` authority. A TLS fingerprint requires `wss://`.
Changed complete setup replaces only the node or `connect` process group: TERM,
then KILL after five seconds, awaiting child exit. Equivalent, missing, unreadable
or malformed projections do not trigger restarts. Initial incomplete envelopes
wait; pending replacements retain the latest complete setup if the file disappears.
Operator stop cancels replacement. Environment-delivered setup is a startup
snapshot.

OpenShell accepts
expired setup only from the same owned Secret with a recorded device; native
code validates token, identity, scope and pin. Unpaired expired setup waits
for Gateway before provider provisioning.

For pairing loss or unconfirmed credential possession after setup expiry,
[stop the Agent](../../agents/deployment.md#stop-and-resume) and wait for shutdown.
Delete only the Agent-owned node Secret named in the failure, then deploy a new
revision. Preserve node identity and the Harness PVC. Missing diagnostic exposure
alone does not justify deleting credentials.
Older per-revision installations enroll an Agent device at first replacement;
retiring earlier revisions deletes their node Secrets.
Gateway history stays on its private claim; resuming the original Codex thread
requires the Harness claim’s `codex-sessions`.
Selected generated-image bytes use the Codex remote-media reader; no image mount
is shared. Images initialize bundled/plugin assets without shared Skill-tree mounts.
Embedded Agents use the private claim without creating this Harness claim.

Default node writes include workspace `skills/**`, `.clawhub/lock.json`,
`.clawdhub/lock.json`, and `.openclaw/skill-installs/**`; explicit policies remain
unchanged. Skill lifecycle operations require a compatible runtime. See the
[workspace flow](../../../flows/workspace-files.md) for authorization boundaries.

Before preparing a dedicated replacement, the worker stops all earlier workloads
and awaits Pod termination, including failed candidates and Sandbox-owned
workloads. Replacement requires downtime, without simultaneous cross-node mounts.
If preparation fails, retry the candidate or deploy the intended configuration as
a new version. OCC neither restarts earlier versions nor reverses failed candidates'
filesystem writes. The last selected version does not prove its Pod still runs.
After OCC accepts a newer version that requires earlier workloads to stop, the
worker stops their reconciliation and maintenance;
see the [Compute replacement contract](../compute.md#production-revision-stages).

RWX Harness or Gateway claims are rejected during reconciliation and final
Agent deletion.

As with the Gateway claim, RWO does not fence writers on a partitioned node. Pod
termination and the storage provider's safe detach/attach behavior remain
required; the Driver never force detaches a disk. A local-path PV keeps its node
affinity and cannot move its data to another node. Cross-node rescheduling needs
an appropriate portable StorageClass, not RWX.

Both claims retain Namespace and Agent owners across version and Gateway Pod
changes. Reconciliation rejects foreign, terminating, or incompatible claims
without mutation. Claims precede consumers; readiness uses the Gateway workload.
Waiting for `Bound` before creating Pods would deadlock `WaitForFirstConsumer`
storage classes. Stopping or retiring an Agent revision retains
both claims, including when the gateway has already stopped. Agent deletion
retires every Agent revision before its final cleanup hook deletes the owned claims
using their exact Kubernetes UIDs. A cleanup failure keeps deletion pending
for retry and preserves the Agent's database identity.

## Managed native configuration

How runtime gateways read the managed native configuration, and when native
admin editing uses a writable copy, is in
[Managed native configuration](managed-native-configuration.md).

## Runtime credentials

Canonical Configuration, OCC Secret and managed account credential sources live
in the shared tenant namespace in a single cluster, or the control-cluster
storage target with the two-cluster profile. Dedicated Gateways reference
admitted channel Secrets there directly; Compute verifies their scope and UID.
There is no Gateway Secret mirror.

New credentials use `transport-<agent-hash>` (configured prefix) with only
`app-server-token`, and `gateway-password-<agent-hash>` with only
`gateway-password`, in either execution mode. The hash is 12 hexadecimal
characters. Startup and credential provisioning both reject prefixes unless
`<prefix>-<hash>` is a DNS-safe Kubernetes resource name.
Mode changes preserve these sources.
Legacy combined transport Secrets remain readable. Before rendering new workloads,
Compute copies their password into an owned separate source; the legacy Secret
survives for older Gateway Pods. Conflicting password sources fail closed.
`harness-secrets-<agent-hash>-<revision-hash>` contains only selected model fields
and the app-server token. Gateway passwords and channel tokens never enter the
Harness projection. Managed account sources retain account ownership; runtime
copies record their Namespace, Agent, service-principal and Agent revision IDs.

Preparation checks admitted source identities before writing runtime material
and, when repeated, repairs absent or changed projections. Activation validates
Gateway sources and selects the prepared version; it does not issue credentials.
Stop and retirement wait for the workload to stop, then delete its projection
and ConfigMaps for that Agent revision by UID. Canonical sources survive retirement; Agent deletion removes transport/password.
Account and OCC Secret lifecycles remain independent.

Source updates do not restart processes. Update the OCC Secret, redeploy each
consumer through OCE, wait for readiness and selection, then verify a model
request. Preparation refreshes the runtime Secret; Pod or Deployment restarts
only reread the existing projection. See
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
each runtime target to reject existing runtimes before
creating initial Secrets.

The Driver projects `gateway-password` as `OPENCLAW_GATEWAY_PASSWORD` only when
`gateway.auth.password` explicitly uses an environment SecretRef with that ID.
Deployment refuses a reference OpenClaw cannot read from the environment, as for
[plugin secret inputs](../../harness-execution.md#native-runtime-selection).
This supports native local-direct password access alongside
[trusted-proxy authentication](networking-and-isolation.md#gateway-authentication),
the only Kubernetes gateway mode; the API never returns the password. Plaintext password Configuration
is rejected.

The Agent's required [harnessAuth binding](../../agents.md#harness-authentication)
selects the model credential. API keys use the selected OCC Secret Driver's
exact reference; account tokens use an account-owned CP source. Compute selects
the explicit login mode during workload rendering. The combined embedded workload
or dedicated Harness receives the selected model credential; a dedicated Gateway does not. A
[credential source](../../credential-sources.md) binding is the exception: Compute
renders no model Secret and hands the Credential Gateway's attachments to the
OpenShell Sandbox instead.

If channels are enabled, set `runtime.channels.proxyUrl` to a literal-IP proxy
URL, or to the Helm-managed proxy Service URL paired with
`runtime.channels.managedProxy` so Compute limits gateway egress to that proxy's
Pods by selector. Store the Agent's channel credentials as Namespace Secrets
referenced by Configuration `secretBindings`; they are available only to the
dedicated gateway, never to its Codex Harness.

Agent revisions with repository bindings support embedded OpenClaw or dedicated Codex,
without a Sandbox Driver. Compute delivers each immutable repository-material
generation only to the container that executes commands:

| Credential material      | Embedded gateway/Harness | Dedicated gateway | Dedicated Codex |
| ------------------------ | ------------------------ | ----------------- | --------------- |
| Repository session files | Yes                      | No                | Yes             |
| Model credential         | Yes                      | No                | Yes             |
| Slack channel tokens     | Unsupported              | Yes               | No              |

Readiness must match that consumer's Agent revision ID and credential material generation.
Credential rotation for the same Agent revision ID replaces the consuming workload; a Ready Pod carrying
older material is insufficient. Cleanup retains Secrets while owned Deployments
or Pods still reference them. The
[repository credential flow](../../../flows/agent-repository-credentials.md#4-deliver-and-retain-one-complete-runtime-generation)
covers generation rechecks, missing-material repair, and how dedicated
replacement preserves node enrollment.

Create Secrets with an approved secret manager, protected files, or standard
input. Never expose credentials in command-line arguments or logs.
Missing or incorrectly scoped credentials fail deployment.

Use the optional `runtime.codexSeccompProfile` only for a reviewed Codex
compatibility allowlist in source-backed cases; it does not relax filesystem or
network policy. [Pod and container hardening](../../security.md#pod-and-container-hardening)
states when Codex `0.164.0` needs it and which components own those boundaries.

See [service-account credential delivery](../../service-accounts.md#backend-managed-access-tokens)
for provider-issued credentials and supported execution modes.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Runtime security boundaries](../../security/runtime-isolation.md)
