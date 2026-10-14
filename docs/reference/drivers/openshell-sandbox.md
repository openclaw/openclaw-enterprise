# OpenShell SandboxDriver

The OpenShell SandboxDriver pairs its Gateway, dedicated Codex/native OpenClaw
Harnesses, and [Kubernetes Compute](kubernetes-compute.md). OCC owns Agents,
revisions, Namespaces, routing, credentials, and authorization.

Development supports native OpenClaw and plugin-free Codex with
[`v0.1.3-pre.2`](https://github.com/NVIDIA/OpenShell/tree/v0.1.3-pre.2). The pinned
OCE runtime declares native Dedicated support. The paired
[Credential Gateway](openshell-credential-gateway.md) delivers model credentials;
revision-owned providers supply node enrollment and Codex files. These APIs remain
experimental and unqualified for production.

Embedded OpenClaw is unsupported. The Driver supplies native OpenClaw's three
containment facets; see
[qualification](#qualification-contract).

## Ownership model

Kubernetes Compute owns the Namespace, isolation, per-Agent Gateway, storage,
Services, NetworkPolicies, and revision routing. It delegates Namespace setup
through `ensureNamespace` and the dedicated Harness through `provisionHarness`.

The SandboxDriver owns the sandboxing delegation:

- `configureAgent` contributes configuration before revision admission.
- In `operator` mode, `ensureNamespace` applies configured labels, workspace
  resources, and NetworkPolicies, then owns the exact active Workspace.
- `provisionHarness` asks the OpenShell gateway to create one OpenShell Sandbox
  in that Workspace. Dedicated Codex exposes its loopback app-server port in the
  same request; native OpenClaw requests no inbound service. The Driver adds each
  [credential attachment](#credential-attachments) to the Sandbox's providers,
  plus the selected Harness's revision-owned runtime provider,
  validates any Codex route, and returns the stable Sandbox reference.
- OpenShell's controller creates and owns the provider Harness Pod behind that
  Sandbox.
- `cleanup` derives the stable Sandbox identity during revision retirement, even
  when its Pod is gone. Namespace cleanup verifies Workspace ownership and
  removes the Workspace and configured resources before Compute deletes the
  Kubernetes namespace.

Compute trusts OpenShell's provider-owned Pod enforcement without re-verifying
OCC workload ownership. Serving still requires workload readiness and exact
active-revision routing.
Each immutable Agent revision retains only `sandboxDriverId`, so workers resolve
the same driver for provisioning and cleanup without persisting provider
descriptors or facets.

## OpenShell containment facets

The Driver configures all three available
[SandboxDriver containment facets](sandbox.md#containment-facets). Enforcement requires upstream support:

| Facet        | Current OpenShell behavior                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `networking` | Binary-scoped OpenShell policies for Harness tool traffic, plus Kubernetes baseline policies. |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths.   |
| `process`    | OpenShell process policy; v0.1.3-pre.2 ignores its run-as user and group.                     |

The Driver sends `hard_requirement` for Landlock filesystem enforcement. Omit
`policy.landlockCompatibility` or set it to `hard_requirement`; any other value,
including `best_effort`, fails Installation startup. Hosts lacking the requested Landlock operations fail launch.

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
      # See kubernetes-compute.md for the required Kubernetes Compute config.

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
OpenShell ignores them: its Kubernetes driver runs every Sandbox process as the
workload identity, default `10001:10001`.

Do not add a policy for the model endpoint. The credential source's provider
profile allows `api.openai.com` with TLS inspection, and an uninspected rule for
the same host conflicts with it.

Each v0.1.3-pre.2 network policy needs a unique name and nonempty executable path. `workspace-node-enrollment` is reserved. Optional
values are `tls: skip|terminate`, `enforcement: enforce|audit`, and
`access: read_only|read_write|full`. The Driver rejects the old `passthrough`
spelling; use `skip` for uninspected TLS relay.
`gatewayConfigured` is the only ServiceAccount mode for `v0.1.3-pre.2`; the
gateway's configured sandbox ServiceAccount applies to every Sandbox it creates
and does not satisfy the per-Agent production requirement below.

Optional readiness observes a Service and Pods in the OCC namespace and requires
positive `timeoutMs`; a paired Gateway normally uses a Backend `endpoint`.
Development sets `startupDelayMs: 30000` because v0.1.3-pre.2 exposes its service
before listening.

Install OpenShell separately. Required `gateway.workspaceMode` accepts `operator`
or `managed`; deferred managed mode fails before Kubernetes mutations or Gateway calls. Configure the Gateway's Kubernetes driver with `workspaceMode: operator` and a namespace selector
matching `operatorNamespaceLabels`. The Workspace name must equal its pre-provisioned Kubernetes namespace. OCC uses
`oce-` plus a stable 15-character digest for v0.1.3-pre.2's 19-character limit.

The Kubernetes development profile acts as the operator for its disposable
cluster. With Kubernetes Compute, `OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell`
installs one pinned Gateway with workspace resources disabled: in `oce-system`
for the Kubernetes-only control plane, or `openshell-system` for the default
Compose control plane. The upstream Agent Sandbox controller stays in
`agent-sandbox-system`. The helper renders the pinned `openshell-workspace`
chart once into the trusted Installation configuration; for every OCC
Namespace, the Driver applies those resources before creating its Workspace
through the Gateway API, with no per-Namespace Helm release.

The disposable profile uses unauthenticated development mode. The pinned release
shares one Gateway port for control-plane RPCs and provider-advertised Harness traffic. NetworkPolicies limit access to trusted OCE,
OpenShell, and dedicated Agent Gateway Pods, but cannot give Agent Gateways
service-only authority on that shared listener. Accept this only in an owned
disposable development cluster; never qualify this topology for production.

`gateway.operatorWorkspaceResources` accepts the namespace-scoped
ServiceAccount, Role, RoleBinding, and NetworkPolicy objects rendered from the
workspace chart. The Driver injects the current Compute-owned namespace and OCC
ownership metadata before server-side apply. Configure this field only for
`operator` mode; managed mode never applies it. Do not include Secrets or
cluster-scoped objects.

`gateway.networkPolicyResources` accepts namespace-scoped Kubernetes objects
for provider networking, applied during `ensureNamespace`. Secrets are rejected;
OpenShell credentials must not appear in startup YAML.

`kubernetes.sandboxDataMount` must match exactly one approved dedicated Harness
workspace mount. It may not mount the PVC root, may not use `..`, and must mount
under `/sandbox/`. Compute initializes
[private workspace inputs](../../flows/workspace-files.md#2-deployment-initializes-storage-before-execution)
on that PVC before Sandbox startup. Exact marker readiness and writer Pod
termination precede handoff; the Harness verifies completion at its effective path.

For dedicated Codex, OpenShell's `configureAgent` hook adds this to the effective
configuration before OCC validates and freezes the revision:

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

Codex's own sandbox cannot start inside OpenShell, the dedicated Harness's outer
boundary; the `user` reviewer stops the Gateway re-enabling it per turn.
Revisions admitted before #2079 lack the reviewer; deploy those Agents again
([notice](../../guides/deploy/breaking-changes-before-2026-10-11.md#2026-10-10-openshell-codex-agents-need-a-new-deployment)).
Native OpenClaw already disables inner isolation. Its hook sets
`agents.defaults.workspace` and any
`agents.entries.main.workspace` to the approved `sandboxDataMount.mountPath`,
which the Gateway, file transfer, and node address; admission refuses a roster
that makes another Agent the default. Native workers have separate
workspaces but share the Sandbox's user, filesystem, process, and network
boundary. OpenShell isolates the AgentRevision from other workloads, not mutually
untrusted sessions within one Agent. Kubernetes defaults to eight native workers;
`runtime.nativeOpenClawSessionCapacity` accepts `1` through `1024`. A stopped
hosted session releases its slot; idle workers are not automatically retired.

## Credential attachments

For a revision bound to a [credential source](../credential-sources.md),
Compute passes one attachment per source in `credentialAttachments`. The Driver
appends each attachment's provider name to the static `providers` list in
`SandboxSpec`, rejecting a name outside the OCC `oce-cs-` provider shape or one
that repeats a static provider. Startup rejects
static `providers` entries that use the OCC shape, so operator-configured
providers cannot impersonate a credential source. After the Harness is ready,
Compute requires every attachment to report `ready` before activation.

<span id="dedicated-codex-runtime-provider"></span>

## Dedicated runtime providers

Revision-owned providers use `oce-codex-runtime` or `oce-openclaw-runtime` profiles.
Both expose node-enrollment and Gateway CA files after the Agent Gateway issues
setup. Codex additionally requires bounded, nonsecret `runtime.json` and
`config.toml`, addressed through `OPENCLAW_PLUGIN_RUNTIME_MANIFEST` and
`OPENCLAW_PLUGIN_CODEX_CONFIG_TOML`; native OpenClaw rejects them. Ordinary
Secret-backed environment projections remain unsupported.

The expiring setup token is visible inside the Sandbox, without a production
credential guarantee. Policy limits node egress to the Gateway and executable.
Codex waits for its provider route; native OpenClaw connects outbound. Renewal
version-fences `node_setup_json`; endpoint, TLS fingerprint, runtime files, CA,
labels, and ownership stay exact. Native startup reads the envelope; the Codex
supervisor rereads it before node retries and retains valid setup during projection
gaps. The raw app-server token stays outside the provider. Plugins and repository
broker configuration fail before creation.

Revision cleanup deletes the Sandbox before its runtime provider; Namespace
cleanup removes unused profiles. Replays adopt only exact Namespace-, Agent-,
and revision-owned providers with identical nonsecret configuration except the
reconciled expired setup envelope. A failed
or timed-out Sandbox create does not eagerly delete that provider because the
remote mutation may still have completed; the normal revision cleanup path owns
both resources.

## Create-time app-server exposure

For dedicated Codex, `CreateSandbox` includes one unnamed exposure for Compute's
literal `APP_SERVER_PORT`. The revision UUID is the first `request_id`; bounded
[request ID retries](../../flows/openshell-sandbox-provisioning.md#4-call-the-versioned-gateway-contract)
handle unresolved refusals when no Sandbox exists. Reconciliation adopts only an
exact Sandbox and exposure. The client retains a normalized control URL and the
original advertised workload URL, which the optional Harness endpoint capability
returns as a WebSocket origin.

Compute supplies only `APP_TOKEN_SHA`; the raw token remains in the Agent
Gateway. Bearer passthrough lets Codex authenticate the forwarded header. Other
exposures keep OpenShell's authorization-stripping default. A Sandbox without a
replayable Create receipt must be removed, not mutated by `ExposeService`.

With that capability, Compute replaces the fail-closed Gateway target and omits
the direct Agent Service and Compute-owned Harness route. Drivers without it
retain the Kubernetes transport.

Native OpenClaw does not accept inbound Harness traffic. Its enrolled node host
opens the connection to the Agent Gateway, so the Driver sends an empty service
exposure list and rejects any unexpected service URL returned by OpenShell.

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

OpenShell remains experimental. Local contracts below are implemented; protected
cluster proof remains.

### Workload identity

The local profile disables the optional Harness workload credential. OpenShell
may then use its gateway-configured infrastructure ServiceAccount, but the
supervisor credential must remain inaccessible to the Agent. If a deployment
requests an Agent ServiceAccount and projected token, the Driver must preserve
both exactly or reject the revision.

Kubernetes ServiceAccount tokens cannot identify an OCE Agent across cluster
trust domains. Future exchange must scope evidence to its ServicePrincipal and
revision; Gateway and Harness authenticate separately. See
[authorization](../authorization.md#principals).

### Writable runtime state

OpenShell mounts `/sandbox/.openclaw-runtime` from a bounded revision subpath,
never the PVC root. Persistent categories use separate subpaths below
`/sandbox/.openclaw-mounts`. Exact mount paths, including
`OPENCLAW_NODE_STATE_DIR`, use a process-created `state` child so atomic writes
avoid symlinks and permission changes on root-owned mounts. PVC quota bounds
runtime storage; Agent deletion removes it.

The supervisor probes the image's `/tmp`; native OpenClaw uses its runtime-home
`tmp` child without changing supervisor directory permissions. Codex retains
bounded ephemeral temporary storage. Native provisioning preserves
retained entries while privatizing writable PVC subpaths in a restricted,
revision-owned Deployment. Ownership/mode verification, foreground deletion,
and writer termination precede Sandbox creation. This temporary preparation
requires `kubernetes.userNamespaces: false` and the pinned Gateway's default
identity selection, without UID/GID overrides.
Ordinary Kubernetes Compute may use bounded `/home/node` and `/tmp` `emptyDir`
volumes.

### Remaining qualification work

Production qualification is blocked until upstream OpenShell serves
provider-advertised Harness traffic on a port separate from control-plane and
management RPCs. OCE must then route Agent Gateways only to the service port and
reserve the control-plane port for authenticated Sandbox and Credential Gateway
callers. Real-cluster proof must show a model turn through the service port and
rejection of Agent Gateway management operations before this blocker is closed.

OpenShell gateway authentication must bind each trusted control-plane caller to
the requested Sandbox or Pod identity. Provider-managed files also require real
Kubernetes proof of their lifecycle, limits, direct-open behavior, and failures.
The proxy-mediated workspace-node enrollment above requires an exact k3d proof.
Missing admission, node enrollment, or gateway guarantees must fail the revision
instead of launching a weakened Harness.

## Sandbox log reads

`readSandboxLogs` calls only `GetSandboxLogs`. The OCC gateway identity needs
the `sandbox:read` scope and Workspace role `user`. OpenShell `NOT_FOUND`
becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND`. See
[Agent logs](../../guides/topics/agent-logs.md#sandbox-source).

## Troubleshooting

Common errors include:

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
  hours; unsuccessful records remain unresolved and have no reset API. Inspect
  the Gateway database before redeploying. Other `RESOURCE_EXHAUSTED` errors use
  ordinary dependency retries.
- `OpenShell dedicated Codex requires one literal APP_TOKEN_SHA verifier.`
  The deployment is malformed or attempted to pass the raw app-server token.
- `OpenShell dedicated Codex does not yet support selected plugins or repository credentials.`
  Deploy a plugin-free revision without repository bindings.
- A Sandbox that starts but never serves the Codex app-server can report
  `Provider environment is unavailable or changed during preparation`. Confirm
  `/sandbox/.openclaw-runtime/home/.codex` is writable and that no PVC mount is
  nested below `/sandbox/.openclaw-runtime`. A Landlock write grant does not
  override Unix ownership on the image layer.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)
