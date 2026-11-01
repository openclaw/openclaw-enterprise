# OpenShell SandboxDriver

Use dedicated Codex/native OpenClaw with
[Kubernetes Compute](kubernetes-compute.md) and the selected
[Credential Gateway](openshell-credential-gateway.md). Development uses
[`v0.1.6`](https://github.com/NVIDIA/OpenShell/tree/v0.1.6); APIs are
unqualified for production. The pinned runtime declares native Dedicated support;
see [qualification](#qualification-contract).
Embedded OpenClaw is unsupported.

## Ownership model

[Kubernetes Compute](kubernetes-compute.md) retains baseline isolation, storage,
routing, and the per-Agent Gateway. Sandbox owns:

- `supportsHarnessExecutionMode` declares OpenClaw support at construction.
  Dedicated needs `kubernetes.userNamespaces: false` and at most
  one ServiceAccount in `gateway.operatorWorkspaceResources`. See the
  [mode support contract](sandbox.md#harness-mode-support).
- `configureAgent` pins the main Agent workspace to the configured Sandbox data
  mount for both dedicated Harnesses before OCC saves the Agent revision. Codex retains
  app-server containment policy.
- `validateWorkspaceSetup` admits initial files for the projected workspace and
  a single main Agent or omitted roster; Compute retains storage/identity checks.
- `ensureNamespace` saves preparation intent and immutable identities through
  Compute's Namespace journal before reporting ready.
- `provisionHarness` creates one Workspace Sandbox with its
  [credential attachments and runtime provider](openshell-sandbox/harness-providers.md).
  Dedicated Codex exposes its app-server; native OpenClaw connects outbound and
  temporarily exposes status until node enrollment.
  [Private workspace initialization](../../flows/workspace-files.md#2-deployment-initializes-storage-before-execution)
  precedes execution.
- OpenShell's controller creates and owns the Sandbox's Harness Pod.
- `cleanup` derives the Agent revision's Sandbox identity even without its Pod.
  [Namespace cleanup](#namespace-cleanup) saves provider confirmation before teardown.

Compute checks revision readiness and routing before serving traffic; workers
resolve its saved `sandboxDriverId` for provisioning and cleanup.

## OpenShell containment facets

[Containment facets](sandbox.md#containment-facets):

| Facet        | Current OpenShell behavior                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `networking` | Binary-scoped OpenShell policies for Harness tool traffic, plus Kubernetes baseline policies. |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths.   |
| `process`    | OpenShell runs the workload with the UID and GID selected by its driver.                      |

The Driver requires `hard_requirement` for Landlock filesystem enforcement. Omit
`policy.landlockCompatibility` or set it to `hard_requirement`; any other value,
including `best_effort`, fails Installation startup. Hosts lacking these Landlock operations fail launch.

No `exec` facet or per-tool sandbox exists; Harness `exec` authorization is deferred.

## Configuration

Select `drivers.sandbox` in Installation YAML with bundled Kubernetes Compute;
installed Compute Drivers fail startup. Its [`openshell` Backend](../backends.md#openshell-gateway)
must match this ID and the [Credential Gateway](openshell-credential-gateway.md#configure-the-driver).
Backend `rootCertificatePath` supplies public CA trust for the Agent Gateway's WSS
endpoint. Sandbox `gateway` rejects connection fields: `endpoint`, `scheme`,
`serviceName`, `port`, `auth`, `requestTimeoutMs`, and `rootCertificatePath`.

```yaml
drivers:
  compute:
    id: compute-kubernetes
    configuration:
      # See kubernetes-compute.md.

  sandbox:
    id: openshell-sandbox
    configuration:
      gateway:
        workspaceMode: operator
        operatorNamespaceLabels:
          openshell.ai/openclaw-workspace: "true"
        operatorWorkspaceResources: []
        networkPolicyResources: []
      kubernetes:
        runtimeClassName: openshell-sandbox
        userNamespaces: false
        serviceAccount:
          mode: gatewayConfigured
        sandboxDataMount:
          subPath: workspace
          mountPath: /sandbox/enterprise
          readOnly: false
      policy:
        process:
          runAsUser: "1000"
          runAsGroup: "1000"
        networkPolicies:
          - name: source-control
            binaries:
              - path: /usr/bin/git
            endpoints:
              - host: github.com
                ports: [443]
                protocol: tcp
                tls: skip
```

When `policy.filesystem` is omitted, the Driver sends OpenShell's permissive
runtime baseline: `/bin`, `/usr`, `/lib`, `/proc`, `/dev/urandom`, `/etc`,
`/var/log`, and `/app` are read-only; `/tmp`, `/dev/null`, the image workdir,
approved mounts, and `/sandbox/.openclaw-runtime` are writable. An explicit `filesystem` block replaces the baseline; the Driver still adds
required mounts, runtime root, and `/tmp`.

Startup rejects unknown keys in `kubernetes`, `kubernetes.serviceAccount`,
`kubernetes.sandboxDataMount`, `kubernetes.agentResources`, `policy`,
`policy.process` and `gateway.readiness`. Each `kubernetes.agentResources.requests`
and `limits` value must be a quoted, non-negative Kubernetes quantity
(`cpu: "500m"`); requests cannot exceed limits. Agent `ephemeral-storage` is
always a `256Mi` request and `1Gi` limit, replacing configured values.

Required `policy.process.runAsUser` and `runAsGroup` are ignored by pinned
OpenShell: Sandbox processes use the workload identity, default `10001:10001`.

Do not add model-endpoint policy: the credential provider allows `api.openai.com`
with TLS inspection; uninspected rules conflict.

v0.1.6 requires unique network policy names and nonempty executable
paths. `workspace-node-enrollment` is reserved. Options include `enforcement: enforce|audit`
and `access: read_only|read_write|full`. Omit `tls` for automatic TLS inspection;
`tls: skip` bypasses inspection. The pinned gateway rejects explicit `terminate`
and `passthrough`. An endpoint `protocol` is `tcp`, `rest`, `websocket`, `graphql` or
`sql` in any case (OCE sends it lowercase), or omitted. `tcp` takes neither
`access` nor `enforcement`; the other protocols need `access`, and `sql` allows
only `enforcement: audit`. `json-rpc` and `mcp` need rules this setting cannot
express, so startup refuses them. `gatewayConfigured` is the only ServiceAccount mode; the
gateway's configured sandbox ServiceAccount applies to every Sandbox and does
not satisfy the per-Agent production requirement below.

### Protected Codex artifact rules

For protected, dedicated Codex repository execution, select
[approved artifact rules](../../assets/openshell-quickstart/plugin-network-policy.yaml)
with `policy.codexArtifactRuleNames`, for example
`codexArtifactRuleNames: [codex-plugin-artifacts]`. Each name must identify exactly
one existing `policy.networkPolicies` rule. Omission grants no artifact access.

Selected rules require the bundled Codex executable paths, exact DNS hosts,
port 443, `protocol: rest`, `enforcement: enforce` and `access: read_only`.
Omit `tls`: stock OpenShell 0.1.6 verifies and inspects REST TLS by default;
explicit skip and deprecated termination modes are refused. Wildcards, numeric
addresses, GitHub repository hosts, reserved names and credential/provider fields are refused.

Admission freezes only that qualified map with empty Agent additions. Preparation
and replay use the revision, even if Installation defaults change. Select a new
revision to change artifact authority. Live Agent policy apply remains unavailable.

### Gateway readiness and workspace

Optional readiness checks a Service and Pods in the OCC namespace (paired
Gateways normally use Backend `endpoint`). It needs positive `timeoutMs`;
`pollIntervalMs` (default 1000) is at most `2147483647`. Development retains
the 30-second `startupDelayMs`.

Install OpenShell's gateway separately. Required `gateway.workspaceMode`
accepts `operator` or `managed`; deferred managed mode fails before Kubernetes
mutations or Gateway calls. Configure the Gateway's Kubernetes driver with `workspaceMode: operator`, a
namespace selector matching `operatorNamespaceLabels`, and `allowed_pod_labels`
listing `openclaw.dev/*`, `app.kubernetes.io/name`, and
`app.kubernetes.io/managed-by`; it rejects other labels. An OpenShell Workspace
name must equal its pre-provisioned Kubernetes namespace: `oce-` plus a
15-character digest, within the 19-character limit.

The [development profile](../../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
installs one Gateway with workspace resources disabled in `oce-system`
(Kubernetes-only) or `openshell-system` (Compose), and Agent Sandbox in
`agent-sandbox-system`. The launcher renders `openshell-workspace` into trusted
Installation configuration; the Driver creates each Namespace's resources before
its Workspace, without per-Namespace Helm releases.

Development uses unauthenticated mode. The pinned release shares one Gateway
port for control-plane RPCs and Harness traffic. NetworkPolicies restrict access
to trusted OCE, OpenShell, and dedicated Agent Gateway Pods, but cannot give
Agent Gateways service-only authority there. Use only owned disposable clusters;
this topology is not qualified for production.

`gateway.operatorWorkspaceResources` takes the ServiceAccount, Role,
RoleBinding, and NetworkPolicy manifests the workspace chart renders;
`gateway.networkPolicyResources` takes namespaced provider networking manifests.
In `operator` mode, `ensureNamespace` adds the Compute-owned namespace, OCC
ownership metadata and a saved creation nonce. It binds each created UID before
ready; later server-side apply uses UID and `resourceVersion` preconditions.
Startup rejects Secrets, ingress `_from` (write `from`), and fields the Kubernetes
client would drop or change, such as a misspelled selector key or LimitRange
`default`. Keep credentials and cluster-scoped objects out of both lists.

`kubernetes.sandboxDataMount` must match exactly one approved dedicated Harness
workspace mount. It may not mount the PVC root or use `..`, and must mount
under `/sandbox/`. For native OpenClaw, the permission preparer creates that subpath
before Sandbox creation. After supervisor readiness, Sandbox initializes
[private workspace inputs](../../flows/workspace-files.md#2-deployment-initializes-storage-before-execution)
through private stdin; the Harness verifies completion at its effective path.

For dedicated Codex, OpenShell's `configureAgent` hook removes
`appServer.networkProxy` and adds this before OCC validates and saves the Agent revision:

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "sandbox": "danger-full-access",
            "approvalsReviewer": "user"
          }
        }
      }
    }
  }
}
```

OpenShell isolates every login mode. The bridge
requests `:danger-full-access` with `user` review, subject to native account policy.
The Gateway refuses constrained threads before turns. Restricted profiles,
including the proxy's, require nested bubblewrap namespaces, which OpenShell blocks.
Native OpenClaw already disables inner isolation. Its hook sets
`agents.defaults.workspace` and any
`agents.entries.main.workspace` to the approved `sandboxDataMount.mountPath`,
which the Gateway, file transfer, and node address; admission refuses a roster
that makes another Agent the default. Native workers have separate
workspaces but share the Sandbox's user, filesystem, process, and network
boundary. OpenShell isolates each Agent revision from other workloads, not mutually
untrusted sessions within one Agent. Kubernetes defaults to eight native workers;
`runtime.nativeOpenClawSessionCapacity` accepts `1` through `1024`. Stopping a
hosted session releases its slot; idle workers are not retired automatically.

[Harness providers and exposure](openshell-sandbox/harness-providers.md)
covers credential attachments, the dedicated runtime providers and the
create-time app-server exposure.

## Kubernetes and admission requirements

OpenShell requires an operator-installed RuntimeClass or equivalent admission
exemption for trusted privileged components. Pod Security Admission exempts the
whole Pod: restrict it to digest-pinned OpenShell images and expected
ServiceAccounts, Namespaces, labels, and capabilities.

Do not grant wildcard tenant permissions. The Driver uses the Kubernetes Compute
client. Controller and worker need Compute access, namespace-scoped policy apply,
and Gateway readiness, without Sandbox custom-resource permission.

Kubernetes Compute retains default-deny policies. In the development profile,
provider transport grants the Agent Gateway egress only to the configured
shared OpenShell peer and port and omits direct Harness ingress. Broad namespace
allows can bypass this boundary. Production must instead select the separate
service port required by the qualification contract below.

Compute passes the provider-fenced network profile (`provider-fenced-v1`) to the
provider Harness template; the provider must retain it on the resulting Pod.
It admits no Compute DNS, model, or authentication egress; OpenShell's workload
fence governs those decisions. The policy proxy opens node connections from
OpenShell supervisor Pods, which carry no `openclaw.dev` labels; on one cluster,
each Agent Gateway admits only its own Sandbox's supervisor
(`openshell.ai/sandbox-id`). The separately installed OpenShell gateway needs
its own scoped DNS/API policies. Redeploy an existing Agent to apply the profile
and this scoping. See the
[network profile reference](kubernetes-compute/networking-and-isolation.md#explicit-network-profiles).

## Qualification contract

### Workload identity

The local profile disables optional Harness workload credentials. OpenShell
may use its gateway-configured infrastructure ServiceAccount, but must hide
supervisor credentials from the Agent. Preserve any requested Agent
ServiceAccount and projected token exactly, or reject the revision.

Kubernetes tokens cannot identify OCE Agents across cluster trust domains. Future
exchange must bind evidence to the ServicePrincipal and Agent revision; Gateway
and Harness authenticate separately. See
[authorization](../authorization.md#principals).

### Writable runtime state

OpenShell mounts `/sandbox/.openclaw-runtime` from a separate Agent revision PVC
subpath, never its root. Persistent categories use separate subpaths below
`/sandbox/.openclaw-mounts`. Mount paths, including `OPENCLAW_NODE_STATE_DIR`, use
a process-created `state` child for atomic writes without symlinks or permission
changes on root-owned mounts. PVC quota limits storage; Agent deletion removes it.

Before opening node state, Codex and dedicated OpenClaw set their process-owned
state root to `0700`, clearing inherited setgid. Shared workspace permissions
stay unchanged. OpenClaw prepares private children, retaining `control` after
failed setup.

The supervisor probes the image's `/tmp`; native OpenClaw uses its runtime-home
`tmp` child without changing supervisor directory permissions. Codex's container has
a `1Gi` ephemeral-storage limit. Native provisioning privatizes writable PVC
subpaths, keeping retained entries, in a restricted per-revision Deployment;
ownership/mode checks, foreground deletion and writer termination
precede Sandbox creation. It needs `kubernetes.userNamespaces: false`,
at most one `gateway.operatorWorkspaceResources` ServiceAccount and the pinned
Gateway's default identity, without UID/GID overrides; Agent save refuses
dedicated OpenClaw otherwise. Ordinary Kubernetes Compute may use `/home/node`
and `/tmp` `emptyDir` volumes limited to `1Gi` and `64Mi`.

### Remaining qualification work

Production qualification is blocked until upstream OpenShell serves
provider-advertised Harness traffic on a port separate from control-plane and
management RPCs. OCE must then route Agent Gateways only to the service port and
reserve the control-plane port for authenticated Sandbox and Credential Gateway
callers. Real-cluster proof must show a model turn through the service port and
rejection of Agent Gateway management operations.

OpenShell gateway authentication must bind each trusted control-plane caller to
the requested Sandbox or Pod identity. Provider-managed files require real
Kubernetes proof of their lifecycle, limits, direct-open behavior, and failures.
The proxy-mediated workspace-node enrollment above requires an exact k3d proof.
Missing admission, node enrollment, or gateway guarantees must fail the Agent revision
instead of launching a weakened Harness.

## Namespace cleanup

Compute's journal binds the selected Driver/Backend, endpoint/server trust,
Namespace UID, Workspace ID, and configured resource UIDs. Missing or changed
bindings refuse cleanup. Operator resources use
[preprovisioned binding authority](compute-namespace-lifecycle.md#driver-owned-data)
and remain retained.

Cleanup checks ownership/UIDs before removing owned providers/profiles from the
original Workspace. It confirms fresh `DeleteWorkspace` completion and removal,
then commits its checkpoint before configured-resource or gateway teardown.
No attempt or confirmed creation refusal needs no provider call. Accepted deletion,
`ALREADY_ABSENT`, and `NOT_FOUND` are not completion receipts.

Resource deletes use saved UID/current `resourceVersion` preconditions and removal
readback; finalizers defer completion. Cleanup returns every configured reference
as confirmed absent or retained with its saved UID. Compute persists this result
before its orphan sweep. Reappearing absent references and replacement retained
UIDs refuse cleanup; names alone cannot establish new ownership.

Receipts survive worker/tenant-local gateway loss. Compute separately releases
external Namespace claims. Unknown Workspace responses remain unconfirmed;
see [recovery](#gateway-identity-and-removal). [Supplier replay](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/crates/openshell-server/src/grpc/mutation_replay.rs#L137-L375) expires and binds
names, so it is not permanent generation authority. Workspace deletion has no
atomic [precondition for the saved ID](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/proto/openshell.proto#L3784-L3835).

## Sandbox log reads

`readSandboxLogs` calls only `GetSandboxLogs`. The OCC gateway identity needs
the `sandbox:read` scope and Workspace role `user`. OpenShell `NOT_FOUND`
becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND`. See
[Agent logs](../../guides/topics/agent-logs.md#sandbox-source).

## Troubleshooting

- `drivers.sandbox requires the bundled Kubernetes Compute Driver.`
- `The bundled OpenShell drivers.sandbox requires a backend entry with type openshell.`
- `OpenShell gateway option endpoint belongs to the openshell Backend or is unsupported.`
  Move the connection settings to the Backend.
- `The Harness requires a credential attachment that this OpenShell Backend did not issue.`
- `The Sandbox did not apply a required credential attachment.` Check the
  provider's status in OpenShell.
- `OpenShell gateway Service is unavailable.`
- `OpenShell gateway Pod is not ready.`
- `OpenShell SandboxDriver supports only dedicated Codex or OpenClaw Harness revisions.`
  Deployment status reports `SANDBOX_HARNESS_UNSUPPORTED`.
- `OpenShell refused <method>: ... limit of 1000 durable request admissions ...`
  reports `SANDBOX_ADMISSION_LIMIT_REACHED`. Completed records expire after 24
  hours; unsuccessful ones have no reset API: inspect the Gateway database
  before redeploying. Other `RESOURCE_EXHAUSTED` errors retry as usual.
- `OpenShell dedicated Harness exposure requires one literal APP_TOKEN_SHA verifier.`
  Malformed deployment or raw app-server token.
- `Codex plugin preparation failed before native WebSocket startup.`
  Check that the selected plugin is available to the bound Codex account and its
  app is connected. Correct the selection or account access, then deploy again.
  See [plugin installation](openshell-sandbox/harness-providers.md#codex-plugin-installation).
- A Sandbox that starts without serving the Codex app-server can report
  `Provider environment is unavailable or changed during preparation`. Confirm
  `/sandbox/.openclaw-runtime/home/.codex` is writable and no PVC mounts are
  below `/sandbox/.openclaw-runtime`; a Landlock write grant does not
  override Unix ownership on the image layer.

### Gateway identity and removal

For `SANDBOX_GATEWAY_UNAUTHORIZED`, check `sandbox-gateway-identity`. Restore
the Workspace role, controller authentication or gateway signing-key refresh
before retrying. Transient failures retry within the worker's attempt budget.

OpenShell can return `NOT_FOUND` for a resource hidden from the caller. To
confirm absence, the Driver reads the Workspace with the controller's identity
and reads the resource again. If a delete returns `NOT_FOUND` immediately after
a read found the target, removal is unconfirmed (`SANDBOX_DELETION_UNCONFIRMED`).
The worker logs `worker.harness-exposure-withdrawal-unconfirmed` during the
exposure sweep and retries.

Revision cleanup checks the returned Sandbox name, Workspace, and Namespace,
Agent, and revision annotations before deleting it. A same-name Sandbox assigned
to another owner is refused; do not relabel it to force cleanup.

If both Sandbox and Workspace records are missing, revision cleanup cannot confirm
removal: stop, retirement and Agent deletion remain incomplete, including permanent
provider loss. Unknown Workspace creation/deletion responses also remain blocked.
Restore authoritative provider state/access before retrying; recreating an empty
Workspace, relabeling a replacement, or deploying again does not prove earlier
removal. There is no force-completion operation; retain the incomplete work for
investigation.

Namespace setup/cleanup `PERMISSION_DENIED` or `UNAUTHENTICATED` raises
`SandboxNamespaceRefusedError`; Compute marks it permanent. Setup records the
refusal code. Check gateway identity and Workspace access before retrying.
Diagnostics report method, gRPC status and validation category, without provider
text or request values.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [OpenShell Harness providers and exposure](openshell-sandbox/harness-providers.md)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)
