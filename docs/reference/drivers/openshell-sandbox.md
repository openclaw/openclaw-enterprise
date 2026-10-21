# OpenShell SandboxDriver

The OpenShell SandboxDriver pairs its Gateway, dedicated Codex/native OpenClaw
Harnesses, and [Kubernetes Compute](kubernetes-compute.md). OCC owns Agents,
Agent revisions, Namespaces, routing, credentials, and authorization.

Development supports native OpenClaw and plugin-free Codex with
[`v0.1.5`](https://github.com/NVIDIA/OpenShell/tree/v0.1.5). The pinned
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

- `configureAgent` pins the main Agent workspace to the configured Sandbox data
  mount for both dedicated Harnesses before OCC saves the Agent revision. Codex retains
  app-server containment policy.
- `validateWorkspaceSetup` admits initial files only for that projected workspace
  with a single main Agent (or an omitted roster). Compute retains runtime-storage
  and identity checks; the Sandbox privately initializes the same mount.
- In `operator` mode, `ensureNamespace` applies configured labels, workspace
  resources, and NetworkPolicies, then owns the exact active Workspace.
- `provisionHarness` creates one Workspace Sandbox, with a loopback app-server
  exposure for dedicated Codex; native OpenClaw requests no inbound service. The Driver adds each
  [credential attachment](#credential-attachments) and that Agent revision's Harness runtime provider
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

Select `drivers.sandbox` in trusted Installation YAML. OpenShell requires the
bundled Kubernetes Compute Driver; installed Compute Drivers fail startup.
Select an [`openshell` Backend](../backends.md#openshell-gateway) whose
`drivers.sandbox` matches this ID and its
[Credential Gateway](openshell-credential-gateway.md#configure-the-driver) member.
The Backend owns connections; Sandbox configuration rejects `endpoint`,
`scheme`, `serviceName`, `port`, `auth`, `requestTimeoutMs`, and
`rootCertificatePath` in `gateway`.

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

The Driver requires `policy.process.runAsUser` and `runAsGroup`, but the pinned
OpenShell ignores them: every Sandbox process runs as the workload identity,
default `10001:10001`.

Do not add a policy for the model endpoint: the credential source's provider
profile allows `api.openai.com` with TLS inspection, and an uninspected rule for
that host conflicts.

v0.1.5 requires unique network policy names and nonempty executable
paths. `workspace-node-enrollment` is reserved. Options are `tls: skip|terminate`, `enforcement: enforce|audit`, and
`access: read_only|read_write|full`; `skip` replaces the rejected `passthrough`
spelling. `gatewayConfigured` is the only ServiceAccount mode; the
gateway's configured sandbox ServiceAccount applies to every Sandbox and does
not satisfy the per-Agent production requirement below.

Optional readiness observes a Service and Pods in the OCC namespace; a paired
Gateway normally uses an explicit Backend `endpoint`. Readiness requires a
positive `timeoutMs`. Development retains the 30-second `startupDelayMs`.

Install OpenShell's gateway separately. Required `gateway.workspaceMode`
accepts `operator` or `managed`; deferred managed mode fails before Kubernetes
mutations or Gateway calls. Configure the Gateway's Kubernetes driver with `workspaceMode: operator`, a
namespace selector matching `operatorNamespaceLabels`, and `allowed_pod_labels`
listing `openclaw.dev/*`, `app.kubernetes.io/name`, and
`app.kubernetes.io/managed-by`; it rejects other labels. The
OpenShell Workspace name must equal its pre-provisioned Kubernetes namespace, so
OCC uses a stable `oce-` name with a 15-character digest within the 19-character
Workspace limit.

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
`appServer.networkProxy` and adds this before OCC validates and saves the immutable Agent revision:

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

## Credential attachments

For an Agent revision that uses a [credential source](../credential-sources.md),
Compute passes one attachment per source in `credentialAttachments`. The Driver
appends each attachment's provider name to the static `providers` list in
`SandboxSpec`, rejecting a name outside the OCC `oce-cs-` provider shape or one
that repeats a static provider. Startup rejects
static `providers` entries that use the OCC shape, so operator-configured
providers cannot impersonate a credential source. After the Harness is ready,
Compute requires every attachment to report `ready` before activation.

<span id="dedicated-codex-runtime-provider"></span>

For external ChatGPT authentication, the Sandbox stores account metadata but
omits static `CODEX_ACCESS_TOKEN`. Only the attached OpenShell provider supplies
its bound alias. Withdrawal therefore leaves no placeholder on restart, and the
Harness holds its authentication failure without starting Codex or using cached state.

## Dedicated runtime providers

Each Agent revision's runtime providers use `oce-codex-runtime` or `oce-openclaw-runtime` profiles.
Both expose node-enrollment and Gateway CA files after the Agent Gateway issues
setup. Codex requires nonsecret `runtime.json` and
`config.toml`, each at most 65,536 UTF-8 bytes, addressed through `OPENCLAW_PLUGIN_RUNTIME_MANIFEST` and
`OPENCLAW_PLUGIN_CODEX_CONFIG_TOML`; native OpenClaw rejects them. Ordinary
Secret-backed environment projections remain unsupported.

The expiring setup token is visible inside the Sandbox, without a production
credential guarantee. Policy limits node egress to the Gateway and executable.
Codex waits for its provider route; native OpenClaw connects outbound. Renewal
updates `node_setup_json` only if the provider's resource version still matches;
endpoint, TLS fingerprint, runtime files, CA, and identity labels must also match.
Native startup reads the envelope; the Codex
supervisor rereads it before node retries and retains valid setup during projection
gaps. The raw app-server token stays outside the provider. Plugins and repository
broker configuration fail before creation.

Agent revision cleanup deletes the Sandbox before its runtime provider; Namespace
cleanup removes unused profiles. Adoption requires matching
Namespace, Agent, and Agent revision IDs and nonsecret configuration,
except when renewing an expired setup envelope. Failed or timed-out Sandbox creation may complete remotely. The provider remains
for normal Agent revision cleanup with the Sandbox.

## Create-time app-server exposure

For dedicated Codex, `CreateSandbox` includes one unnamed exposure for Compute's
literal `APP_SERVER_PORT`. The UUID from the Agent revision ID is the first `request_id`.
With no Sandbox,
[create retries](../../flows/openshell-sandbox-provisioning.md#4-call-the-versioned-gateway-contract)
after unresolved refusals use at most 16 request IDs. Adoption requires an
exact Sandbox and, before enrollment, exposure. The client keeps a normalized control URL and the
advertised workload URL, which `harnessEndpoint` returns
as a WebSocket origin.

Compute supplies only `APP_TOKEN_SHA`, never the raw token; bearer passthrough
forwards the header Codex, or a native held failure, authenticates. Other
exposures keep OpenShell's authorization-stripping default. A Sandbox without a
replayable Create receipt must be removed, not mutated by `ExposeService`.

Compute replaces the fail-closed Gateway target and omits its direct Agent
Service and Harness route. Drivers without provider transport retain Kubernetes transport.

A native worker's node opens its Gateway connection. Its exposure serves
only Compute's held-failure read before enrollment; OpenShell routes it
unauthenticated, so once the node enrolls the Driver deletes it
(`DeleteService`, fail closed); adoption or recreation has none. A missing
service, Sandbox or credential attachment is gone only if `GetWorkspace` answers
and a second read still misses it (OpenShell hides unauthorized Sandboxes as
missing); a refusal fails with `SANDBOX_GATEWAY_UNAUTHORIZED`. The worker's
sweep covers Agent revisions without a current reconciliation pass and failed candidates.

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

OpenShell remains experimental. Local contracts are implemented; protected
cluster proof remains.

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

The supervisor probes the image's `/tmp`; native OpenClaw uses its runtime-home
`tmp` child without changing supervisor directory permissions. Codex's container has
a `1Gi` ephemeral-storage limit. Native provisioning preserves
retained entries while privatizing writable PVC subpaths in a restricted
Deployment for that Agent revision. Ownership/mode verification, foreground deletion,
and writer termination precede Sandbox creation. Temporary preparation
requires `kubernetes.userNamespaces: false` and the pinned Gateway's default
identity selection, without UID/GID overrides.
Ordinary Kubernetes Compute may use `/home/node` and `/tmp` `emptyDir`
volumes limited to `1Gi` and `64Mi`, respectively.

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
- `OpenShell dedicated Codex requires one literal APP_TOKEN_SHA verifier.`
  Malformed deployment or raw app-server token.
- `OpenShell dedicated Codex does not yet support selected plugins or repository credentials.`
  Deploy a plugin-free Agent revision without repository bindings.
- A Sandbox that starts without serving the Codex app-server can report
  `Provider environment is unavailable or changed during preparation`. Confirm
  `/sandbox/.openclaw-runtime/home/.codex` is writable and no PVC mounts are
  below `/sandbox/.openclaw-runtime`; a Landlock write grant does not
  override Unix ownership on the image layer.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)
