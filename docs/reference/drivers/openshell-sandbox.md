# OpenShell SandboxDriver

The OpenShell SandboxDriver pairs its Gateway, dedicated Codex/native OpenClaw
Harnesses, and [Kubernetes Compute](kubernetes-compute.md). OCC owns Agents,
Agent revisions, Namespaces, routing, credentials, and authorization.

Development supports native OpenClaw and dedicated Codex with
[`v0.1.6`](https://github.com/NVIDIA/OpenShell/tree/v0.1.6). The pinned
OCE runtime declares native Dedicated support. The paired
[Credential Gateway](openshell-credential-gateway.md) delivers model credentials;
each Agent revision's providers supply node enrollment and Codex files. These experimental APIs are
unqualified for production.

Embedded OpenClaw is unsupported. The Driver supplies native OpenClaw's three
containment facets; see
[qualification](#qualification-contract).

## Ownership model

[Kubernetes Compute](kubernetes-compute.md) retains baseline isolation, storage,
routing, and the per-Agent Gateway. Sandbox owns:

- `supportsHarnessExecutionMode` declares OpenClaw support at construction. Embedded
  is unsupported; Dedicated needs `kubernetes.userNamespaces: false` and at most
  one ServiceAccount in `gateway.operatorWorkspaceResources`. See the
  [mode support contract](sandbox.md#harness-mode-support).
- `configureAgent` pins the main Agent workspace to the configured Sandbox data
  mount for both dedicated Harnesses before OCC saves the Agent revision. Codex retains
  app-server containment policy.
- `validateWorkspaceSetup` admits initial files only for that projected workspace
  with a single main Agent (or an omitted roster). Compute retains runtime-storage
  and identity checks; the Sandbox privately initializes the same mount.
- In `operator` mode, `ensureNamespace` applies configured labels, workspace
  resources, and NetworkPolicies, then owns the exact active Workspace.
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

The Driver requires `hard_requirement` for Landlock filesystem enforcement. Omit
`policy.landlockCompatibility` or set it to `hard_requirement`; any other value,
including `best_effort`, fails Installation startup. Hosts lacking these Landlock operations fail launch.

There is no `exec` facet. Command-level authorization and per-tool sandbox
creation are deferred; `exec` runs inside the selected Harness sandbox.

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

Startup refuses an unknown key in `kubernetes`, `kubernetes.serviceAccount`,
`kubernetes.sandboxDataMount`, `kubernetes.agentResources`, `policy`,
`policy.process` and `gateway.readiness`, so a misspelled key never falls back
to its default. Each `kubernetes.agentResources.requests` and `limits` value is
a quoted, non-negative Kubernetes quantity (`cpu: "500m"`), and a request may
not exceed its limit. The Driver always sets the Agent container's
`ephemeral-storage` to a `256Mi` request and `1Gi` limit, replacing configured
values.

The Driver requires `policy.process.runAsUser` and `runAsGroup`, but the pinned
OpenShell ignores them: every Sandbox process runs as the workload identity,
default `10001:10001`.

Do not add a policy for the model endpoint: the credential source's provider
profile allows `api.openai.com` with TLS inspection, and an uninspected rule for
that host conflicts.

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

Optional readiness observes a Service and Pods in the OCC namespace (a paired
Gateway normally uses a Backend `endpoint`). It needs a positive `timeoutMs`;
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
installs one Gateway with workspace resources disabled: in `oce-system` for the
Kubernetes-only control plane, or `openshell-system` for Compose. Agent Sandbox
runs in `agent-sandbox-system`. The launcher renders `openshell-workspace` once
into trusted Installation configuration; the Driver applies it for each OCC
Namespace before creating its Workspace, without per-Namespace Helm releases.

The disposable profile uses unauthenticated development mode. The pinned release
shares one Gateway port for control-plane RPCs and provider-advertised Harness traffic. NetworkPolicies limit access to trusted OCE,
OpenShell, and dedicated Agent Gateway Pods, but cannot give Agent Gateways
service-only authority on that shared listener. Accept this only in an owned
disposable development cluster; never qualify this topology for production.

`gateway.operatorWorkspaceResources` accepts the namespace-scoped
ServiceAccount, Role, RoleBinding, and NetworkPolicy objects rendered from the
workspace chart. The Driver injects the Compute-owned namespace and OCC
ownership metadata before server-side apply. Only `operator` mode applies it;
never include Secrets or cluster-scoped objects.

`gateway.networkPolicyResources` accepts namespace-scoped Kubernetes objects
for provider networking, applied during `ensureNamespace`. Secrets are rejected;
OpenShell credentials must not appear in startup YAML.

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
exemption for its trusted privileged components. Because Pod Security Admission
exempts the whole Pod, a fail-closed policy must restrict it to digest-pinned
OpenShell images, expected ServiceAccounts, Namespaces, labels, and capabilities.

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

Local contracts are implemented; protected cluster proof remains.

### Workload identity

The local profile disables the optional Harness workload credential. OpenShell
may use its gateway-configured infrastructure ServiceAccount, but the
supervisor credential must remain inaccessible to the Agent. If a deployment
requests an Agent ServiceAccount and projected token, the Driver must preserve
both exactly or reject the Agent revision.

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

## Sandbox log reads

`readSandboxLogs` calls only `GetSandboxLogs`. The OCC gateway identity needs
the `sandbox:read` scope and Workspace role `user`. OpenShell `NOT_FOUND`
becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND`. See
[Agent logs](../../guides/topics/agent-logs.md#sandbox-source).

## Troubleshooting

Errors include:

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

If stop, deletion, or credential withdrawal reports `SANDBOX_GATEWAY_UNAUTHORIZED`,
check the worker's `sandbox-gateway-identity` hint. A missing Workspace role
fails immediately. Restore the role, or deploy again to recreate an externally
removed Workspace. If authentication fails, check the controller's token file
and the gateway's signing-key refresh. The worker retries transient failures
within its attempt budget. Retry the original operation after restoring access.

OpenShell can return `NOT_FOUND` for a resource hidden from the caller. To
confirm absence, the Driver reads the Workspace with the controller's identity
and reads the resource again. If a delete returns `NOT_FOUND` immediately after
a read found the target, removal is unconfirmed (`SANDBOX_DELETION_UNCONFIRMED`).
The worker logs `worker.harness-exposure-withdrawal-unconfirmed` during the
exposure sweep and retries.

For Namespace setup or cleanup, `PERMISSION_DENIED` or `UNAUTHENTICATED`
raises `SandboxNamespaceRefusedError`. Compute marks the Namespace step as
permanent. For setup, the worker records the refusal code as the reason. Check
the gateway identity and Workspace access before retrying. Worker diagnostics
report the method, gRPC status, and validation category without provider text or
request values.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [OpenShell Harness providers and exposure](openshell-sandbox/harness-providers.md)
- [OpenShell Harness observation and restart states](openshell-sandbox/harness-providers.md#harness-observation)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)
