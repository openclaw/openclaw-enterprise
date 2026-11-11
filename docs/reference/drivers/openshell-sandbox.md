# OpenShell SandboxDriver

The Driver pairs its Gateway, dedicated Codex/native OpenClaw
Harnesses, and [Kubernetes Compute](kubernetes-compute.md). OCC owns Agents,
Agent revisions, Namespaces, routing, credentials, and authorization.

Development supports dedicated native OpenClaw and Codex with
[`v0.1.6`](https://github.com/NVIDIA/OpenShell/tree/v0.1.6) and the pinned OCE runtime.
[Credential Gateway](openshell-credential-gateway.md) delivers model credentials;
Agent revision providers supply node enrollment and Codex files. These APIs are
unqualified for production.

Embedded OpenClaw is unsupported. See native OpenClaw
[containment facets](#openshell-containment-facets) and
[qualification](#qualification-contract).

Namespace-owned gateways use [setup](openshell-sandbox/namespace-gateway.md); Gateway settings below describe operator-owned gateways.

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
- `validateWorkspaceSetup` admits initial files only for that projected workspace
  with a single main Agent (or an omitted roster). Compute retains runtime-storage
  and identity checks; the Sandbox privately initializes the same mount.
- In `operator` mode, `ensureNamespace` applies configured labels, workspace
  resources, and NetworkPolicies, then owns the exact active Workspace. A
  [preprovisioned namespace](kubernetes-compute/preprovisioned-namespace.md)
  only verifies them.
- `provisionHarness` creates one Workspace Sandbox. Dedicated Codex exposes its
  app-server. A native OpenClaw worker connects outbound and can expose a
  temporary status endpoint until its workspace node enrolls. The Driver adds each
  [credential attachment](openshell-sandbox/harness-providers.md#credential-attachments) and that Agent revision's Harness runtime provider
  to the Sandbox's providers, validates any Codex route, and returns the stable Sandbox reference.
  Private [workspace initialization](../../flows/workspace-files.md#2-deployment-initializes-storage-before-execution) completes before execution.
- OpenShell's controller creates and owns the Sandbox's Harness Pod.
- `cleanup` derives the stable Sandbox identity during Agent revision retirement, even
  without its Pod. Namespace cleanup verifies Workspace ownership and
  removes the Workspace and configured resources before Compute deletes the
  Kubernetes namespace.

Compute trusts OpenShell to enforce its Pod, but requires workload readiness and
routing matching the running Agent revision ID before serving traffic. Each Agent revision stores only
`sandboxDriverId`; workers resolve it for provisioning and cleanup.

## OpenShell containment facets

The Driver requests three [containment facets](sandbox.md#containment-facets):

| Facet        | Current OpenShell behavior                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `networking` | Binary-scoped OpenShell policies for Harness tool traffic, plus Kubernetes baseline policies. |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths.   |
| `process`    | OpenShell runs the workload with the UID and GID selected by its driver.                      |

Landlock enforcement requires `policy.landlockCompatibility` omitted or
`hard_requirement`; other values, including `best_effort`, fail Installation
startup. Hosts lacking these Landlock operations fail launch.

There is no `exec` facet. Command-level authorization and per-tool sandbox
creation are deferred; `exec` runs inside the selected Harness sandbox.

## Configuration

Select `drivers.sandbox` with bundled Kubernetes Compute. The
[`openshell` Backend](../backends.md#openshell-gateway) must match the Sandbox
and [Credential Gateway](openshell-credential-gateway.md#configure-the-driver)
IDs. Configure Gateway connection fields and the WSS CA
(`rootCertificatePath`) on the Backend.

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

Startup rejects unknown Kubernetes, policy, and Gateway readiness keys. Set
`kubernetes.agentResources` using quoted, non-negative Kubernetes quantities.
The Driver submits `256Mi` and `1Gi` for ephemeral-storage request and limit.
Provider template resource keys take precedence. Verify CPU, memory, and
ephemeral storage on the rendered Agent container.

`kubernetes.agentResourceOverrides` binds exact `namespaceId` and `agentId`
pairs. Set `cpu` or `memory` in `requests` and `limits`. Omitted keys inherit
`agentResources`. Optional `runtimeClassName` applies to the Agent Pod and
native OpenClaw's workspace preparation Pod. Startup rejects malformed IDs,
duplicates, and requests above limits. Before replacement, check scheduling and
the provider ServiceAccount's `get` access to that RuntimeClass. Redeploy after
changes. Adoption checks the exact Sandbox spec.

Set `policy.process.runAsUser` and `runAsGroup`. The pinned OpenShell runs
Sandbox processes as the workload identity, normally `10001:10001`.

The credential provider already configures TLS inspection for `api.openai.com`.
An uninspected rule for that host conflicts.

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
[approved artifact rules](../../snippets/openshell-quickstart/plugin-network-policy.yaml)
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

Optional readiness observes an OCC-namespace Service/Pods; paired Gateways normally use Backend `endpoint`. Require positive `timeoutMs` and `pollIntervalMs` ≤ `2147483647` (default 1000). Development uses Harness readiness without `startupDelayMs`.

Install the Gateway separately. Set required `gateway.workspaceMode` and its Kubernetes driver's `workspaceMode` to `operator`; `managed` fails before mutations/calls. Match its namespace selector to `operatorNamespaceLabels`. Include `openclaw.dev/*`, `app.kubernetes.io/name`, and `app.kubernetes.io/managed-by` in `allowed_pod_labels` or receive `SANDBOX_POD_LABELS_NOT_PERMITTED`. Workspace names match pre-provisioned namespaces: `oce-` plus a 15-character digest (19 characters maximum).

The [development profile](../../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile) installs a Gateway without workspace resources in `oce-system` (Kubernetes-only) or `openshell-system` (Compose), and Agent Sandbox in `agent-sandbox-system`. The launcher renders `openshell-workspace` into trusted Installation configuration once; the Driver applies it before Workspace creation without per-Namespace Helm releases.

Kubernetes-only installations enable Gateway TLS, mTLS and authentication; static inference requires opt-in. Compose permits unauthenticated Gateway access. Control-plane RPCs and Harness traffic share a port; NetworkPolicies cannot give Agent Gateways service-only authority. Use only owned disposable development clusters.

`gateway.operatorWorkspaceResources` accepts workspace ServiceAccount, Role, RoleBinding and NetworkPolicy manifests; `gateway.networkPolicyResources` accepts namespaced provider networking manifests. Operator `ensureNamespace` applies both server-side to the Compute-owned namespace with OCC ownership metadata; `preprovisionedNamespace` only compares. Startup rejects Secrets, NetworkPolicy ingress `_from` (use `from`), and fields the Kubernetes client drops or changes (misspelled selector keys, LimitRange `default`). Neither list permits OpenShell credentials or cluster-scoped objects.

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

<a id="codex-permission-profile"></a>

Codex requires `danger-full-access` mode, the `:danger-full-access` profile,
and `user` review. Readiness refusal produces
`RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE` with fixed
[worker diagnostic categories](../../guides/topics/agent-troubleshoot.md#codex-refuses-the-required-permission-profile).
The [read limits](../../flows/openshell-sandbox-provisioning.md) distinguish
`RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE` from incomplete evidence.
OpenShell isolates all login modes and blocks restricted profiles' nested bubblewrap
namespaces. The Gateway rejects constrained threads.

Native OpenClaw disables inner isolation. Its hook sets `agents.defaults.workspace`
and any `agents.entries.main.workspace` to `sandboxDataMount.mountPath` for the Gateway,
file transfer, and node. Admission requires `main` as the default Agent. Native workers
use separate workspaces and share the Sandbox user, filesystem, process, and network.
OpenShell isolates Agent revisions from other workloads. Sessions within one Agent
share that boundary. Kubernetes defaults to eight native workers;
`runtime.nativeOpenClawSessionCapacity` accepts `1` through `1024`. Stopping a
session releases its slot; idle workers are not retired automatically.

[Harness providers and exposure](openshell-sandbox/harness-providers.md)
covers credential attachments, the dedicated runtime providers and the
create-time app-server exposure.

## Kubernetes and admission requirements

OpenShell's trusted privileged components require an operator-installed RuntimeClass
or equivalent admission exemption. Pod Security Admission exempts the whole Pod;
a fail-closed policy must restrict it to digest-pinned OpenShell images, expected
ServiceAccounts, Namespaces, labels, and capabilities.

### Gateway Kubernetes authority

Stock OpenShell v0.1.6 operator mode
[watches Sandboxes cluster-wide](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/crates/openshell-driver-kubernetes/src/driver.rs#L5264-L5383).
Selectors filter discovery, not RBAC. Sandbox `list`/`watch` exposes Pod templates,
literal values and Secret references, without granting Secret payload access.

The [stock chart](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/deploy/helm/openshell/templates/clusterrole.yaml#L66-L99)
also permits cluster-wide Sandbox/Pod mutations. Review rendered RBAC.
Namespace labels/NetworkPolicies do not limit this authority.
OCE does not support upstream's namespaced `shared` mode.

OCE controller/worker grants remain separate: Compute access, namespace-scoped
policy apply and Gateway readiness, without Sandbox custom-resource permission.
Do not grant wildcard tenant permissions.

Kubernetes Compute retains default-deny policies. In the development profile,
provider transport grants the Agent Gateway egress only to the configured
shared OpenShell peer and port and omits direct Harness ingress. Broad namespace
allows can bypass this boundary. Production must instead select the separate
service port required by the qualification contract below.

Compute passes `provider-fenced-v1` to the provider Harness template; retain it
on the Pod. This profile admits no Compute DNS, model or authentication egress;
OpenShell's workload fence governs those decisions. The policy proxy opens node connections from
OpenShell supervisor Pods, which carry no `openclaw.dev` labels; on one cluster,
each Agent Gateway admits only its own Sandbox's supervisor
(`openshell.ai/sandbox-id`). The OpenShell Gateway also needs
scoped DNS/API policies. Redeploy an existing Agent to apply the profile
and this scoping. See the
[network profile reference](kubernetes-compute/networking-and-isolation.md#explicit-network-profiles).

## Qualification contract

Local contracts are implemented; protected cluster proof remains.

### Workload identity

OpenShell cannot preserve an Agent ServiceAccount and projected token. Dedicated
Agents need Compute's `servicePrincipalCredentials.mode: disabled` or a compatible
Sandbox Driver. Deployment admission rejects projected identity; saving a
credential-source binding does not validate it. OpenShell may use its
gateway-configured infrastructure ServiceAccount; supervisor credentials must
remain inaccessible to the Agent.

Kubernetes ServiceAccount tokens cannot identify an OCE Agent across cluster
trust domains. Future exchange must scope evidence to its ServicePrincipal and
Agent revision; Gateway and Harness authenticate separately. See
[authorization](../authorization.md#principals).

### Writable runtime state

OpenShell mounts `/sandbox/.openclaw-runtime` from an Agent revision's separate PVC subpath,
never the PVC root. Persistent categories use separate subpaths below
`/sandbox/.openclaw-mounts`. Exact mount paths, including
`OPENCLAW_NODE_STATE_DIR`, use a process-created `state` child so atomic writes
avoid symlinks and permission changes on root-owned mounts. PVC quota limits
runtime storage; Agent deletion removes it.

Before opening node state, the Codex Harness and dedicated OpenClaw worker set
their process-owned state root to `0700`, clearing inherited setgid bits. Shared
workspace directories keep their permissions. OpenClaw prepares its private
children, including a `control` directory retained after a failed setup.

The supervisor probes the image's `/tmp`. Native OpenClaw uses its runtime-home
`tmp` child without changing supervisor directory permissions. Native
provisioning privatizes writable PVC subpaths in a restricted per-revision
Deployment and preserves retained entries.
Ownership and mode checks, foreground deletion, and writer termination
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

## Sandbox log reads

`readSandboxLogs` calls only `GetSandboxLogs`. The OCC gateway identity needs
the `sandbox:read` scope and Workspace role `user`. OpenShell `NOT_FOUND`
becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND`. See
[Agent logs](../../guides/topics/agent-logs.md#sandbox-source).

## Troubleshooting

- Startup requires bundled Kubernetes Compute and an OpenShell Backend. Configure
  the Gateway endpoint on the Backend.
- For a credential attachment failure, verify that the selected Backend issued
  the attachment and check its provider status in OpenShell.
- For an unavailable Gateway, check Service and Pod readiness.
- For `SANDBOX_HARNESS_UNSUPPORTED`, select dedicated Codex or OpenClaw.
- `OpenShell refused <method>: ... limit of 1000 durable request admissions ...`
  reports `SANDBOX_ADMISSION_LIMIT_REACHED`. Completed records expire after 24
  hours; unsuccessful ones have no reset API: inspect the Gateway database
  before redeploying. Other `RESOURCE_EXHAUSTED` errors retry as usual.
- `OpenShell dedicated Harness exposure requires one literal APP_TOKEN_SHA verifier.`
  Malformed deployment or raw app-server token.
- `Codex plugin preparation failed before native WebSocket startup.`
  Verify plugin availability for the bound Codex account and connect its app.
  Correct the selection or access, then redeploy.
  See [plugin installation](openshell-sandbox/harness-providers.md#codex-plugin-installation).
- `Provider environment is unavailable or changed during preparation` with no
  Codex app-server: verify Unix write access to `/sandbox/.openclaw-runtime/home/.codex`
  and exclude PVC mounts below `/sandbox/.openclaw-runtime`. Landlock grants
  cannot override image ownership.

### Private CAs for Gateway peers

If both `pkiInitJob.enabled` and `certManager.enabled` are false and the Gateway container does not trust the issuing CA, set:

```yaml
server:
  extraEnv:
    - name: OPENSHELL_PEER_TLS_CA_FILE
      value: /etc/openshell-tls/server/ca.crt
```

Include the public `ca.crt` in the Secret named by `server.tls.certSecretName`. Middleware uses `tls_ca_cert_path` separately.

### Gateway identity and removal

During stop, deletion, or credential withdrawal, check `sandbox-gateway-identity`
for `SANDBOX_GATEWAY_UNAUTHORIZED`. Missing Workspace roles fail immediately.
Restore the role or redeploy an externally removed Workspace. For authentication
failures, check the controller token file and Gateway signing-key refresh.
Workers retry transient failures within their attempt budget.

OpenShell can hide resources with `NOT_FOUND`. To confirm absence, the Driver
reads the Workspace as the controller and rereads the resource. A delete that
returns `NOT_FOUND` immediately after a successful read raises
`SANDBOX_DELETION_UNCONFIRMED`. The exposure sweep logs
`worker.harness-exposure-withdrawal-unconfirmed` and retries.

During Namespace setup or cleanup, the lifecycle adapter treats
`SandboxNamespaceRefusedError` (`PERMISSION_DENIED` or `UNAUTHENTICATED`) as
permanent. The worker records the setup refusal code. Restore gateway identity
and Workspace access before retrying. Diagnostics include the method, gRPC
status and validation category, and omit provider text and request values.

### CreateSandbox admission failures

For `CreateSandbox`, `worker.completed` reports `grpcStatus` and
`validationCategory` without resource names or supplier text.

- **9, `PVC_ADMISSION_LABELS`**: Check admission labels on the namespaced PersistentVolumeClaim.
- **9, `CLASS_ADMISSION_LABELS`**: Check RuntimeClass or PriorityClass admission labels. For either refusal, use an approved resource or obtain owner approval before relabeling.
- **13, `RESOURCE_METADATA_FORBIDDEN`**: Kubernetes denied a metadata read (HTTP 403). Verify the Gateway ServiceAccount's read permission for the claim or cluster-scoped class.
- **`UNKNOWN`**: The status alone does not identify the cause. Inspect the request configuration and Gateway diagnostics.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [OpenShell Harness providers and exposure](openshell-sandbox/harness-providers.md)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)
