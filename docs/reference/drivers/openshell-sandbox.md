# OpenShell SandboxDriver

The bundled OpenShell SandboxDriver integrates a deployment-paired OpenShell
Gateway with dedicated Codex and native OpenClaw Harnesses and the bundled
[Kubernetes Compute Driver](kubernetes-compute.md). OCC retains ownership of
Agents, revisions, Namespaces, routing, credentials, and authorization.

**The OpenShell integration is a work in progress.** Stock OpenShell
[`v0.1.3-pre.1`](https://github.com/NVIDIA/OpenShell/tree/v0.1.3-pre.1) cannot accept the
Secret-backed app-server token or projected workload identity a dedicated Agent
requires; the paired
[OpenShell Credential Gateway](openshell-credential-gateway.md) delivers the
model API key. The Enterprise Driver rejects deployment rather than starting an
incorrectly credentialed Harness. The real integration keeps that rejection
proof plus a verification-only compatibility bridge for a real in-Sandbox model
turn; that bridge is not a supported deployment path.

Embedded OpenClaw fails when OpenShell is selected; the integration supports
only dedicated Harnesses. Kubernetes Compute requires dedicated native OpenClaw
to use a provisioning SandboxDriver that declares networking, filesystem, and
process containment; the bundled OpenShell Driver currently implements that
contract. See the
[upstream requirements](#current-upstream-preconditions) before evaluating it.

## Ownership model

Kubernetes Compute remains the orchestration owner:

- It creates or adopts the OpenClaw Namespace and applies baseline isolation.
- It creates the per-Agent OpenClaw Gateway and private state in the control-plane
  target, with Harness workspace storage in the data-plane target. Compute owns
  their ServiceAccounts, Services, NetworkPolicies, revision records and activation
  state. This does not move the separate OpenShell gateway.
- It calls `SandboxDriver.ensureNamespace`, when implemented, after namespace
  isolation exists.
- It delegates dedicated Harness creation to `SandboxDriver.provisionHarness`,
  when implemented; otherwise, it creates the ordinary Harness Deployment.
- It routes only to the active revision and removes routing during
  deactivation when the Service still points at that revision.

The OpenShell SandboxDriver owns only the provider sandboxing delegation:

- `configureAgent` contributes provider-specific gateway configuration before
  OCC validates and freezes the immutable Agent revision.
- `ensureNamespace` requires the configured workspace mode. In `operator` mode,
  it applies configured operator labels and rendered workspace-chart resources,
  then provider NetworkPolicies, before checking Gateway health and creating or
  adopting the exact OpenShell Workspace corresponding to the Kubernetes
  namespace. Adoption requires OCC's exact ownership labels and an active
  Workspace.
- `provisionHarness` asks the OpenShell gateway to create one OpenShell Sandbox
  in that Workspace, with the
  [app-server exposure](#create-time-app-server-exposure) and
  [credential attachments](#credential-attachments), and returns the stable
  Sandbox reference. The Sandbox belongs to the AgentRevision. Its native
  OpenClaw node host admits the bounded, configured set of session-owned workers
  instead of creating another Sandbox for each session.
- OpenShell's controller creates and owns the provider Harness Pod behind that
  Sandbox.
- `cleanup` receives the immutable Agent revision during revision retirement and
  derives the stable provider Sandbox identity, so retirement works even when its
  Pod is gone. During Namespace deletion it receives no revision, verifies
  Workspace ownership, deletes the OpenShell Workspace, and removes configured
  workspace-chart and NetworkPolicy resources. Kubernetes Compute deletes the
  Kubernetes namespace only after that succeeds.

The returned provider-owned Pod is not re-verified as an OCC-owned workload:
Compute trusts OpenShell to enforce the Sandbox, but still requires ordinary
workload readiness and exact active-revision routing before serving traffic.
Each immutable Agent revision retains only `sandboxDriverId`, so workers resolve
the same driver for provisioning and cleanup without persisting provider
descriptors or facets.

## OpenShell containment facets

The Driver configures all three available
[SandboxDriver containment facets](sandbox.md#containment-facets). Applying them
to a running Agent requires upstream support:

| Facet        | Current OpenShell behavior                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `networking` | Binary-scoped OpenShell policies for Harness tool traffic, plus Kubernetes baseline policies. |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths.   |
| `process`    | OpenShell process policy, including the configured run-as user and group.                     |

The Driver sends `hard_requirement` for Landlock filesystem enforcement. Omit
`policy.landlockCompatibility` or set it to `hard_requirement`; any other value,
including `best_effort`, fails Installation startup.

There is no `exec` facet; command-level authorization and per-tool dynamic
sandbox creation are deferred. `exec` remains a tool invocation inside the
selected Harness sandbox.

## Configuration

Select `drivers.sandbox` in trusted Installation YAML. OpenShell requires the
bundled Kubernetes Compute Driver; installed Compute Drivers fail startup.
Select an [`openshell` Backend](../backends.md#openshell-gateway) whose
`drivers.sandbox` matches this ID and its
[Credential Gateway](openshell-credential-gateway.md#configure-the-driver) member.
The Backend owns the connection; Sandbox configuration rejects `endpoint`,
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

Do not add a policy for the model endpoint. The credential source's provider
profile allows `api.openai.com` with TLS inspection, and an uninspected rule for
the same host conflicts with it.

Each v0.1.3-pre.1 network policy requires at least one binary identity with a nonempty
executable path; OpenShell applies the endpoints only to those binaries. The
optional endpoint fields use OpenShell's spellings: `tls` accepts `skip` or
`terminate`; `enforcement` accepts `enforce` or `audit`; and `access` accepts
`read_only`, `read_write`, or `full`. v0.1.3-pre.1 treats `terminate` as a
deprecated alias for automatic TLS detection and termination and maps the old
`passthrough` spelling to that behavior, so the Driver rejects `passthrough` at
startup. Use `tls: skip` to retain uninspected TLS relay.
`gatewayConfigured` is the only ServiceAccount mode for `v0.1.3-pre.1`; the
gateway's configured sandbox ServiceAccount applies to every Sandbox it creates
and does not satisfy the per-Agent production requirement below.

When readiness is configured, it observes a Service and Pods in the OCC
namespace; a deployment-paired Gateway normally uses an explicit Backend
`endpoint` instead. Its timeout and polling interval must be positive safe
integers, and cancellation stops the wait.

Install the OpenShell gateway separately. Required `gateway.workspaceMode`
accepts `operator` or `managed`; deferred managed mode fails before Kubernetes
mutations or Gateway calls. Configure the Gateway's Kubernetes driver with `workspaceMode: operator` and a namespace selector
matching `operatorNamespaceLabels`. In this mode the OpenShell Workspace name
must equal its pre-provisioned Kubernetes namespace, so OCC uses a stable
`oce-` name with a 15-character digest to stay within OpenShell v0.1.3-pre.1's
19-character Workspace limit.

The Kubernetes development profile acts as the operator for its disposable
cluster. With Kubernetes Compute, `OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell`
installs one pinned Gateway with workspace resources disabled: in `oce-system`
for the Kubernetes-only control plane, or `openshell-system` for the default
Compose control plane. The upstream Agent Sandbox controller stays in
`agent-sandbox-system`. The helper renders the pinned `openshell-workspace`
chart once into the trusted Installation configuration; for every OCC
Namespace, the Driver applies those resources before creating its Workspace
through the Gateway API, with no per-Namespace Helm release.

The disposable profile enables OpenShell's unauthenticated development mode.
In the Kubernetes-only profile, Gateway ingress admits only the OCE API and
worker in `oce-system` and OpenShell supervisor Pods from OCE-owned tenant
Namespaces. Per-tenant callback egress selects only OpenShell-managed supervisor
Pods, so other tenant Pods cannot reach the Gateway administrative API.

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
under `/sandbox/`.

For dedicated Codex, OpenShell's `configureAgent` hook contributes the effective
configuration before OCC validates and freezes the revision, disabling the
inner Codex app-server sandbox:

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "sandbox": "danger-full-access"
          }
        }
      }
    }
  }
}
```

This avoids stacking the Codex sandbox inside OpenShell, which becomes the
dedicated Harness's outer containment boundary. Native OpenClaw already runs
with its inner runtime isolation disabled, so the hook leaves its configuration
unchanged. Native session workers have separate managed workspaces, but they share the Sandbox's
user, filesystem, process, and network boundary. OpenShell isolates the
AgentRevision from other workloads; it does not isolate mutually untrusted
sessions within one Agent. Kubernetes defaults to eight retained native workers
and accepts an explicit `runtime.nativeOpenClawSessionCapacity` from `1` through
`1024`. A stopped hosted session releases its slot; idle workers are not
automatically retired.

## Credential attachments

For a revision bound to a [credential source](../credential-sources.md),
Compute passes one attachment per source in `credentialAttachments`. The Driver
appends each attachment's provider name to the static `providers` list in
`SandboxSpec`, rejecting a name outside the OCC `oce-cs-` provider shape or one
that repeats a static provider. Startup rejects
static `providers` entries that use the OCC shape, so operator-configured
providers cannot impersonate a credential source. After the Harness is ready,
Compute requires every attachment to report `ready` before activation.

## Create-time app-server exposure

For a dedicated Codex request that reaches OpenShell, the Driver reads the literal
`APP_SERVER_PORT` prepared by Compute and includes one unnamed service exposure
in `CreateSandbox`, with the revision UUID as `request_id` (see
[request ID retries](../../flows/openshell-sandbox-provisioning.md#4-call-the-versioned-gateway-contract)).
It creates only an absent Sandbox (`GetSandbox` first) and adopts an existing one only when its
annotations name the revision and, for Codex, `GetService` finds the endpoint.
It requires an HTTP or HTTPS route and rewrites its port to the gateway
endpoint for port-forwards.

OCE omits `authorization_mode`, so OpenShell strips `Authorization` before proxying.
Upstream v0.1.3-pre.1 supports `BEARER_PASSTHROUGH`, which OCE leaves unselected.
Codex accepts only bearer authorization, so the integration expects the
protected app server's `401` through this route and runs its real model turn on
Pod loopback; the test bridge is unsupported and does not replace Compute's
Agent Service. Remove a Sandbox the Driver cannot adopt; it never calls
`ExposeService`.

Native OpenClaw accepts no inbound Harness traffic: its enrolled node host
connects out to the Agent gateway, so the Driver sends an empty service
exposure list and rejects any unexpected service URL returned by OpenShell.

## Kubernetes and admission requirements

OpenShell requires an operator-installed RuntimeClass or equivalent admission
exemption for its trusted privileged components. Because Pod Security Admission
exempts the whole Pod, the cluster must also install a fail-closed admission
policy that restricts the exemption to the approved OpenShell workload shape:
trusted OpenShell images by digest, expected ServiceAccounts, approved
Namespaces, expected labels, and the exact elevated capabilities needed by
OpenShell init and supervisor components.

Do not grant wildcard tenant permissions to the SandboxDriver. It uses the
Kubernetes Compute Driver's authenticated Kubernetes client, with no
provider-specific access adapter, so namespace-scoped RBAC must enforce the
tenant boundary on that shared client. The controller and worker should receive
only Compute's Kubernetes access plus the ability to apply configured
namespace-scoped NetworkPolicy resources and read gateway readiness. OpenShell
creates and deletes its Sandboxes through its own gateway; the Enterprise worker
needs no Sandbox custom-resource permissions.

Kubernetes NetworkPolicies are additive. Kubernetes Compute still installs
default-deny and Agent routing policies; OpenShell bootstrap policies must allow
only the gateway, control-plane, callback, and approved provider connectivity
OpenShell needs. Broad namespace egress or ingress allows can bypass the
boundary.

Compute passes the `provider-fenced-v1` network profile to the provider Harness
template; the provider must retain it on the resulting Pod. That profile
receives no Compute DNS, model, or authentication egress, so OpenShell's
workload fence alone governs egress. Gateway callback policies must select the
OpenShell supervisor labels rather than the Harness profile, and the separately
installed gateway needs its own scoped DNS/API policies. Redeploy the Agent
revision to apply the profile to an existing Sandbox. See the
[network profile reference](kubernetes-compute/networking-and-isolation.md#explicit-network-profiles).

## Current upstream preconditions

Production Agent deployment still requires the following OpenShell capabilities
and Driver integration:

- OpenShell must create Sandboxes with the per-Agent ServiceAccount that Compute
  creates for the Harness.
- OpenShell must preserve the Harness's exact audience-bound, short-lived
  projected ServiceAccount token and read-only mount. Its gateway bootstrap
  token is not a substitute. Stock OpenShell `v0.1.3-pre.1` does not support
  projected volumes in gateway driver configuration. An operator-created
  template bridge is not a supported workaround.
- OpenShell must preserve all approved Agent workspace PVC subpath mounts
  without falling back to its default workspace claim or mounting the PVC root.
- OpenShell must provide the Harness's bounded Pod-local writable home, which
  Kubernetes Compute backs with an emptyDir at `/home/node`. The Agent entrypoint
  writes runtime assets there and publishes plugin skills at
  `/home/node/.openclaw/plugin-skills`.
- OpenShell must preserve the immutable plugin-runtime `runtime.json` and
  `config.toml` ConfigMap entries at `/etc/openclaw/plugin-runtime`. The Codex
  entrypoint reads these files even when the Agent selects no optional plugins.
- OpenShell must support exact environment entries backed by Kubernetes
  `secretKeyRef` for the startup app-server token Secret. Stock OpenShell
  `v0.1.3-pre.1` cannot receive those entries through the current gateway API, and the
  Enterprise Driver rejects them. A credential bridge is not a supported
  workaround. The model API key uses the Credential Gateway instead.
- OpenShell gateway authentication must be bound to the trusted caller and the
  requested Sandbox or Pod identity.
- For Codex, OpenShell service routing must securely carry bearer authorization
  without exposing gateway credentials. The Driver does not yet select
  `BEARER_PASSTHROUGH` (see
  [app-server exposure](#create-time-app-server-exposure)).

If any of these conditions are unavailable, OpenShell-selected deployments must
fail closed instead of launching an unsandboxed or incorrectly credentialed
Harness.

## Sandbox log reads

`readSandboxLogs` calls only `GetSandboxLogs`. The OCC gateway identity needs
the `sandbox:read` scope and Workspace role `user`. OpenShell `NOT_FOUND`
becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND`. See
[Agent logs](../../guides/topics/agent-logs.md#sandbox-source).

## Troubleshooting

Common fail-closed errors include:

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
- `OpenShell v0.1.3-pre.1 cannot receive secretKeyRef environment APP_SERVER_TOKEN ...`
  Deployment status reports `SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED` after one
  attempt; redeploying the same revision cannot succeed on stock `v0.1.3-pre.1`.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)

## Changelog

- Removed the unused `gateway.bootstrapResources` manifest option. Gateway installation remains external to the bundled driver. (NOT_IN_SPEC)
