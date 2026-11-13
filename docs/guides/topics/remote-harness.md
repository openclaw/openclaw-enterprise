# Remote Harness execution and split storage

In `dedicated` mode, an Agent's Gateway receives messages and controls access,
while a separate Harness calls the model and runs native tools. OCE supports
two dedicated runtimes: Codex and experimental native OpenClaw workers. Embedded
OpenClaw runs both roles in one workload; see [Agent compute](agent-compute.md)
for mode selection.

## Gateway and Harness

The Gateway owns conversation routing, session admission, tool policy, and reply
delivery. The Harness owns model execution and its local file and command tools.
Separating their storage keeps the Harness from mounting Gateway conversations,
databases, and channel credentials.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 15px
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    nodeSpacing: 20
    rankSpacing: 28
    padding: 12
---
flowchart LR
  Gateway["<b>Gateway</b><br/>Routing and sessions<br/>Tool policy"]
  Runtime["<b>Harness execution</b><br/>Codex or native OpenClaw<br/>Model and native tools"]
  Node["<b>Workspace service</b><br/>Enrolled Harness node"]
  GatewayState[("<b>Gateway storage</b><br/>Conversations, index<br/>Delivery media")]
  Workspace[("<b>Harness storage</b><br/>Agent workspace files<br/>Execution workspaces")]
  Gateway -->|dispatch turns| Runtime
  Gateway -->|access files| Node
  Gateway -->|persist| GatewayState
  Runtime -->|native tools| Workspace
  Node -->|read/write| Workspace

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  class GatewayState,Workspace state
  class Gateway,Runtime,Node operation
```

Each Agent revision uses one Harness runtime. Codex uses an app-server plus a
companion file node; native OpenClaw uses a node host that serves workspace
operations and manages worker processes. Execution and workspace access are separate operations, even
when they use the same node connection.

“Remote” does not require two clusters. In the ordinary Kubernetes topology,
Gateway and Harness have separate Pods, ServiceAccounts, and storage within the
same tenant namespace. Operators can choose different node placement or the
experimental two-cluster profile. See [workload placement](../../design/workloads.md).

## Two execution paths

| Aspect                 | Dedicated Codex                                                      | Dedicated native OpenClaw                                                                              |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Runtime                | Codex app-server shared by the Agent's sessions                      | Node host managing session-owned native workers                                                        |
| Model and native tools | Run in the Codex Harness                                             | Run in each native worker                                                                              |
| Execution workspace    | Harness workspace used by Codex                                      | Separate managed workspace for each hosted session                                                     |
| Execution history      | Codex threads on Harness; conversation and thread binding on Gateway | Canonical transcripts and turn admission on Gateway                                                    |
| Availability           | Supported on Kubernetes                                              | Experimental; requires a provisioning SandboxDriver with networking, filesystem, and process isolation |

### Codex

Gateway sends turns to Codex app-server and receives progress and results.
Codex's native file and command tools operate in the Harness. Requests for
Gateway-provided tools return to Gateway for authorization and execution.
Gateway-local file, shell, and administration tools are excluded from Codex's
dynamic tool set.

A companion file node serves the Harness workspace to Gateway features outside
model turns. For example, editing `AGENTS.md` in the console uses this node;
asking Codex to change project code uses Codex's native tools. The Gateway does
not maintain a second execution workspace to synchronize after each Codex turn.

### Native OpenClaw

OCE requires placement on the enrolled node with worker-local inference.
Gateway admits turns, applies tool policy, and commits transcripts; workers call
the model and run native coding tools. A missing model or disconnected node
fails the turn without falling back to Gateway inference.

Each hosted session has a managed execution workspace. It is distinct from the
Agent workspace exposed by the console's four-file editor. The native worker
lifecycle prepares that workspace and reconciles eligible file changes when a
turn completes. Depending on the workspace source, Gateway retains checkpoints
or applies changes to a managed worktree. This is separate from remote access
to Agent documents, Memory, and Skills.

One Agent revision shares a node host and its outer Sandbox across sessions;
separate worker directories do not give each session its own Sandbox. The
[Harness reference](../../reference/harness-execution.md#supported-topology)
defines capacity, and [native worker support](../../reference/harness-execution.md#native-worker-support)
lists deployment prerequisites. The bundled OpenShell path remains
verification-only because of upstream provisioning blockers.

## What each side stores

| Data                                                   | Location                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Conversation routing, transcripts, and tool policy     | Gateway                                                                                 |
| Agent documents, Memory source files, workspace Skills | Harness Agent workspace, reached through the enrolled node                              |
| Native tool working files                              | Codex workspace or native worker's session workspace on Harness                         |
| Memory search index and embedding configuration        | Gateway                                                                                 |
| Codex thread history                                   | Harness; separate from Gateway conversation history                                     |
| Native worker recovery data                            | Gateway checkpoints or managed worktrees, as required by the session's workspace source |
| Uploads and retrieved reply attachments                | Gateway media store; execution receives staged input files                              |

The selected [Harness authentication binding](../../reference/harness-execution.md#harness-authentication)
keeps its inference credential off the dedicated Gateway. Gateway features,
such as Memory embeddings, can use separately configured credentials.

The [storage reference](../../reference/drivers/kubernetes-compute/storage-and-credentials.md)
defines Kubernetes claim sizes, mounts, and persistence. A Sandbox provider may
supply a different Harness layout. Neither workload mounts the other's private
state.

## Add operator-owned scratch storage

For a dedicated OpenShell Harness, provision a separate filesystem PVC in its
execution namespace, then add an exact Agent binding under
`drivers.compute.configuration` in the Installation YAML:

```yaml
runtime:
  # Keep the other required runtime settings.
  scratchVolumes:
    - namespaceId: "<OCE namespace ID>"
      agentId: "<OCE agent ID>"
      namespace: "<execution Kubernetes namespace>"
      claimName: "<existing scratch PVC name>"
      claimUid: "<existing scratch PVC metadata.uid>"
```

Before restarting API/worker and deploying a new Agent revision:

1. Verify the claim's identity, writable filesystem, private-directory permissions,
   and actual available capacity and quotas. For native OpenClaw, existing scratch
   directories must be owned by the preparation process with mode `0700`;
   the initializer refuses to repair them. Kubernetes may still change volume
   group/modes; see the [storage contract](../../reference/drivers/kubernetes-compute/configuration.md#scratch-volumes). Prevent concurrent PVC deletion or
   recreation: Kubernetes mounts reference claim names, so a UID check alone
   cannot prevent replacement after verification.
2. Check the selected OpenShell provider's resource admission policy for every
   PVC mounted by the Harness, including the durable workspace. With the default
   labels on providers that enable resource admission, the operator sets
   `openshell.ai/sandbox-attachable=true` and
   `openshell.ai/sandbox-attachable-workspace=<OpenShell workspace name>`
   on each approved PVC. In operator mode, use the execution Kubernetes
   namespace name as the workspace name. A selected RuntimeClass needs the
   shared approval label. Check the actual policy if it uses custom labels.
3. For [local storage](https://kubernetes.io/docs/concepts/storage/volumes/#local), set the PV's node affinity to the prepared storage node.
   Check that all Harness claims can mount there together, including the durable
   disk's availability zone, and that resources, taints, and RuntimeClass permit
   both preparation and execution. A Bound PVC does not establish schedulability;
   Compute's `runtime.nodeSelector` is not forwarded to OpenShell.
4. Preserve workspace and Gateway state claims. Replacement stops existing
   workloads before checking scratch; a failed preparation causes downtime.
   See [replacement and recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).

After deployment, use an ordinary Agent tool turn to inspect the mount at
`/sandbox/scratch`, report total and available bytes, and write, read, and remove
a small file in a new private temporary directory there. Correlate the mount with
the operator's PV and backing filesystem. A directory name or PVC requested size
does not prove NVMe backing or usable capacity. Check that durable workspace and
conversation state remain available.

Select `/sandbox/scratch` explicitly for disposable build outputs or caches;
the mount does not widen native tool permissions or redirect existing paths.
A separate PVC's capacity is independent of the container's ephemeral-storage
limit, which still covers logs and writable-layer files.

The operator owns scratch cleanup after consumers stop. Local storage can survive
same-node Pod replacement but cannot move with the Pod. [Instance-store data is lost](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-lifetime.html)
when its instance is stopped, hibernated, or terminated; provision and qualify replacement
storage, update the binding, and deploy a new revision after such loss. Keep
irreplaceable data on durable storage. The [storage contract](../../reference/drivers/kubernetes-compute/configuration.md#scratch-volumes)
defines binding and retention behavior.

## Files across the boundary

### Agent documents

The console's [Workspace files](workspace-files.md) editor authorizes access
through OCC and the Agent Gateway, then reads or writes the Harness Agent
workspace. It exposes `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.
Completed initialization preserves later edits across restarts and redeploys.
Live edits are last-write-wins; reload after an uncertain save.

### Memory

Memory source files stay in the Harness Agent workspace. Gateway reads them and
receives change notifications through the node, maintains the index, and serves
search. Remote reads need the workspace service: a configured but unavailable
remote workspace returns an error instead of using a local Gateway workspace.
The retained index does not guarantee fresh results during disconnection.

### Skills

Gateway-provided Skill sources remain on Gateway; workspace Skill sources
remain on Harness. Native worker turns can receive temporary copies of selected
Skill files. Gateway discovers remote Skill sources and applies installation policy.
Approved dependency installation runs on the workspace host. Each host supplies
its own bundled assets, without a shared Skill-tree mount. Remote channel menu
discovery remains deferred; see the [workspace flow](../../flows/workspace-files.md#6-compute-resolves-a-route-and-occ-loads-the-current-key).

### Attachments

Gateway retains admitted uploads and stages input bytes for execution. For
Codex, the workspace service creates private input files on Harness and supplies
local paths before dispatch; a failed required transfer stops dispatch.
Codex's remote-media reader retrieves selected reply artifacts over app-server
while its connection is available. Gateway stores those bytes for delivery.
Native workers use their session workspace transfer and result lifecycle.

An attachment transfer does not grant a shared filesystem. Command admission and
path policy still apply, and an allowed output may contain sensitive content;
file transfer does not inspect it for safe sharing.

## Access and recovery limits

The workspace binding names an enrolled node and remote root. Default reads
cover the Agent workspace and managed Skill roots. Default writes cover
designated documents, Memory, Skill state, and staged inputs; explicit policies
remain authoritative. Default file access does not follow symlinks. The console
editor exposes fewer operations than this underlying workspace service.

Persistent files do not guarantee that an interrupted turn resumes. Codex thread
state, Gateway conversation state, and native worker checkpoints have different
recovery roles. Kubernetes dedicated replacement stops earlier workloads before
preparing the replacement, causing downtime, with no automatic rollback. Check
[activation and restart limits](../../reference/harness-execution.md#isolation-and-activation)
before relying on recovery behavior.
