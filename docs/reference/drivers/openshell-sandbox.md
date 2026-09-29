# OpenShell SandboxDriver

The bundled OpenShell SandboxDriver connects a deployment-paired Gateway to
dedicated Codex/native OpenClaw Harnesses and
[Kubernetes Compute](kubernetes-compute.md). OCC owns Agents, revisions,
Namespaces, routing, credentials and authorization.

**The OpenShell integration is a work in progress.** Stock
[`v0.1.0`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0) cannot accept dedicated
Agents' Secret-backed app-server token or projected workload identity. The paired
[Credential Gateway](openshell-credential-gateway.md) supplies the model key;
remaining blockers cause rejection, never an incorrectly credentialed Harness.
Tests retain a verification-only PVC staging fixture, which is not an accepted
material supplier and cannot enable current Codex provisioning.

Embedded OpenClaw is rejected. Dedicated native OpenClaw requires a provisioning
SandboxDriver declaring networking, filesystem and process containment; this
Driver implements that contract. Read the
[upstream preconditions](#current-upstream-preconditions) before evaluation.

Repository-bound revisions and plugin-runtime material are refused before Sandbox
creation. Even plugin-free Codex needs its immutable runtime manifest/configuration.
Snapshots, paths, inline documents and ready-marker entries do not prove delivery.
A producer must bind the complete set to the current revision/provider workload
across restart/replacement; the PVC bridge does not satisfy this requirement.

## Ownership model

This wiring remains subject to stock OpenShell's upstream provisioning blockers.
Kubernetes Compute owns orchestration:

- Create/adopt the OpenClaw Namespace and baseline isolation.
- Create per-Agent OpenClaw Gateway/private state in the control-plane target and
  Harness workspace storage in the data-plane target. Compute owns their
  ServiceAccounts, Services, NetworkPolicies, revision records and activation;
  the separate OpenShell gateway does not move.
- Call `SandboxDriver.ensureNamespace`, if implemented, after isolation exists.
- Delegate dedicated creation to `provisionHarness`, if implemented; otherwise
  create the ordinary Harness Deployment.
- Route only to the active revision; remove routing on deactivation when the
  Service still points to that revision.

OpenShell SandboxDriver owns provider delegation:

- `configureAgent` contributes gateway configuration before OCC validates/freezes
  the immutable revision.
- `ensureNamespace` requires a workspace mode. Operator mode applies configured
  labels, rendered workspace-chart resources, then provider NetworkPolicies before
  Gateway health checks and Workspace creation/adoption. The Workspace matches the
  physical Kubernetes namespace; adoption requires exact OCC ownership labels and
  active state.
- `provisionHarness` requests one Sandbox in that Workspace. Codex includes its
  loopback app-server exposure at creation; native OpenClaw connects outbound with
  no inbound service. The Driver adds [credential attachments](#credential-attachments)
  as providers, validates the returned route, and returns the stable reference.
  The Sandbox belongs to the AgentRevision; native OpenClaw's node host admits a
  bounded configured set of session-owned workers, not one Sandbox per session.
- OpenShell's controller owns the provider Harness Pod.
- Revision `cleanup` derives stable Sandbox identity from the immutable revision,
  even after Pod removal. Namespace cleanup receives no revision: it verifies
  Workspace ownership, deletes the Workspace, and removes configured chart and
  NetworkPolicy resources. Compute deletes the Kubernetes namespace only afterward.

Compute trusts OpenShell's Sandbox enforcement rather than re-verifying its Pod
as OCC-owned. Ordinary readiness and exact active-revision routing remain required
before traffic. Immutable revisions retain only `sandboxDriverId`; workers resolve
the same Driver for provisioning/cleanup without duplicate descriptors or facets.

## OpenShell containment facets

The Driver configures all three available
[SandboxDriver containment facets](sandbox.md#containment-facets). Applying them
to a running Agent requires upstream support:

| Facet        | Current OpenShell behavior                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `networking` | Binary-scoped OpenShell policies for Harness tool traffic, plus Kubernetes baseline policies. |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths.   |
| `process`    | OpenShell process policy, including the configured run-as user and group.                     |

There is no `exec` facet. Command-level authorization and per-tool dynamic
sandbox creation are deferred; `exec` remains a tool invocation that runs inside
the selected Harness sandbox.

## Configuration

Select `drivers.sandbox` in the trusted Installation startup YAML. The bundled
OpenShell SandboxDriver can only be composed with the bundled Kubernetes Compute
Driver; selecting any installed Compute Driver with `drivers.sandbox` fails
startup. It also requires an [`openshell` Backend](../backends.md#openshell-gateway)
whose `drivers.sandbox` matches this ID, and the Backend's
[Credential Gateway](openshell-credential-gateway.md#configure-the-driver) member
must be selected too. The Backend owns the gateway connection; the Sandbox
rejects `endpoint`, `scheme`, `serviceName`, `port`, `auth`,
`requestTimeoutMs`, and `rootCertificatePath` in its `gateway` block.

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

Each v0.1.0 network policy requires at least one binary identity with a nonempty
executable path. OpenShell applies the endpoints only to those
binaries. The optional endpoint fields use OpenShell's configuration spellings: `tls`
accepts `skip` or `terminate`; `enforcement` accepts `enforce` or `audit`; and
`access` accepts `read_only`, `read_write`, or `full`. OpenShell v0.1.0 treats
`terminate` as a deprecated alias for automatic TLS detection and termination.
It also changed the old `passthrough` spelling to that behavior, so the Driver
rejects `passthrough` at startup. Replace `tls: passthrough` with `tls: skip` to
retain uninspected TLS relay.
`gatewayConfigured` is the only ServiceAccount mode for `v0.1.0`; the
gateway's configured sandbox ServiceAccount applies to every Sandbox it creates
and does not satisfy the per-Agent production requirement below.

When readiness is configured, it observes a Service and Pods in the OCC
namespace. A deployment-paired Gateway normally uses an explicit Backend
`endpoint` instead. A configured timeout and polling interval must be positive safe
integers, and cancellation stops the wait.

The OpenShell gateway must be installed separately. The bundled driver does not
install it. `gateway.workspaceMode` is required and accepts `operator` or
`managed`. Managed mode is reserved for the future and currently fails before
the Driver mutates Kubernetes or calls the Gateway. Configure the Gateway's
Kubernetes driver with `workspaceMode: operator` and a namespace selector
matching `operatorNamespaceLabels`. In this mode the OpenShell Workspace name
must equal its pre-provisioned Kubernetes namespace, so OCC uses a stable
`oce-` name with a 15-character digest to stay within OpenShell v0.1.0's
19-character Workspace limit.

The Kubernetes development profile acts as the operator for its disposable
cluster. With Kubernetes Compute, `OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell`
installs one pinned Gateway with workspace resources disabled. The explicitly
selected Kubernetes-only control plane places it in `oce-system`; the default
Compose control plane places it in `openshell-system`.
The upstream Agent Sandbox controller remains in `agent-sandbox-system`. The helper renders the
pinned `openshell-workspace` chart once and stores its namespace-agnostic
resources in the trusted Installation configuration. For every OCC Namespace,
the Driver applies those resources before creating its Workspace through the
Gateway API. There is no per-Namespace Helm release.

The disposable profile enables OpenShell's unauthenticated development mode.
In the Kubernetes-only profile, its Gateway ingress policy admits only the OCE
API and worker in `oce-system` and OpenShell supervisor Pods from OCE-owned
tenant Namespaces. The per-tenant
callback egress policy selects only Pods labeled as OpenShell-managed
supervisors. Other tenant Pods cannot reach the Gateway administrative API.

`gateway.operatorWorkspaceResources` accepts the namespace-scoped
ServiceAccount, Role, RoleBinding, and NetworkPolicy objects rendered from the
workspace chart. The Driver injects the current Compute-owned namespace and OCC
ownership metadata before server-side apply. Configure this field only for
`operator` mode; managed mode never applies it. Do not include Secrets or
cluster-scoped objects.

`gateway.networkPolicyResources` accepts namespace-scoped Kubernetes resource
objects for provider networking. They are applied into the OpenClaw Namespace
during `ensureNamespace`. Do not include Secrets in this array; the driver
rejects Secret resources because OpenShell credentials must not be embedded in
startup YAML.

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

This avoids stacking the Codex sandbox inside OpenShell. OpenShell becomes the
outer containment boundary for the dedicated Harness. Native OpenClaw already
runs with its inner runtime isolation disabled; the hook preserves its
configuration unchanged because OpenShell supplies that outer boundary. Native
session workers have separate managed workspaces, but they share the Sandbox's
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
`SandboxSpec`. It rejects an attachment whose name does not have the OCC
`oce-cs-` provider shape or that repeats a static provider. Startup rejects
static `providers` entries that use the OCC shape, so operator-configured
providers cannot impersonate a credential source. After the Harness is ready,
Compute requires every attachment to report `ready` before activation.

## Create-time app-server exposure

For a dedicated Codex request that reaches OpenShell, the Driver reads the literal
`APP_SERVER_PORT` prepared by Compute and includes one unnamed service exposure
in `CreateSandbox`. It uses the Agent revision UUID as OpenShell's `request_id`,
so retries receive the same service URL. The Driver accepts only an HTTP or HTTPS
origin, rewrites its port to the configured gateway endpoint for local
port-forwards, and requires a valid route before provisioning succeeds.

OpenShell v0.1.0 strips `Authorization` before proxying, while Codex accepts only
bearer authorization. The retained compatibility fixture expects the protected
app server's `401` through this route and places its model turn on Pod loopback.
Current Codex requests are blocked by material admission before Sandbox creation,
so those fixture expectations are not current positive execution evidence. The
bridge is not supported and does not replace Compute's Agent Service. A Sandbox
without a replayable Create receipt must be removed; the Driver does not mutate
it with a later `ExposeService` call.

Native OpenClaw does not accept inbound Harness traffic. Its enrolled node host
opens the connection to the Agent Gateway, so the Driver sends an empty service
exposure list and rejects any unexpected service URL returned by OpenShell.

## Kubernetes and admission requirements

OpenShell requires an operator-installed RuntimeClass or equivalent admission
exemption for its trusted privileged components. Because Pod Security Admission
exempts the whole Pod, the cluster must also install a fail-closed admission
policy that restricts the exemption to the approved OpenShell workload shape:
trusted OpenShell images by digest, expected ServiceAccounts, approved
Namespaces, expected labels, and the exact elevated capabilities needed by
OpenShell init and supervisor components.

Do not grant wildcard tenant permissions to the SandboxDriver. It is wired to
use the same authenticated Kubernetes client as the Kubernetes Compute Driver;
there is no provider-specific Kubernetes access adapter. The
controller and worker should receive only the Kubernetes access already
required by Compute plus the OpenShell-specific ability to apply configured
namespace-scoped NetworkPolicy resources and read gateway
readiness. OpenShell creates and deletes its Sandboxes through its own gateway;
the Enterprise worker needs no Sandbox custom-resource permissions.
Namespace-scoped RBAC must enforce the tenant boundary on the shared client.

Kubernetes NetworkPolicies are additive. The Kubernetes Compute Driver still
installs default-deny and Agent routing policies; OpenShell bootstrap policies
must allow only gateway, control-plane, callback, and approved provider
connectivity needed for OpenShell to function. Broad namespace egress or ingress
allows can bypass the intended boundary.

Compute passes the provider-fenced network profile (`provider-fenced-v1`) to the
provider Harness template; the provider must retain it on the resulting Pod.
That profile admits Gateway transport ingress but none of Compute's DNS, model
or authentication egress, so OpenShell's workload fence alone governs egress. The gateway's callers are
OpenShell supervisor Pods (`openshell.ai/managed-by=openshell`,
`openshell.ai/boundary-role=supervisor`), which carry no `openclaw.dev` labels,
so gateway callback policies must select those supervisor labels rather than the
Harness profile. The separately installed OpenShell gateway needs its own scoped
DNS/API policies because it does not receive ordinary tenant DNS by omission.
Existing Sandboxes keep their template: redeploy the Agent revision to apply the
profile. See the
[network profile reference](kubernetes-compute/networking-and-isolation.md#explicit-network-profiles).

## Current upstream preconditions

The following upstream OpenShell capabilities are being worked on to enable
production Agent deployment:

- OpenShell must create Sandboxes with the per-Agent ServiceAccount that Compute
  creates for the Harness.
- OpenShell must preserve the Harness's exact audience-bound, short-lived
  projected ServiceAccount token and read-only mount. Its gateway bootstrap
  token is not a substitute. Stock OpenShell `v0.1.0` does not support
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
  `v0.1.0` cannot receive those entries through the current gateway API, and the
  Enterprise Driver rejects them. A credential bridge is not a supported
  workaround. The model API key uses the Credential Gateway instead.
- OpenShell gateway authentication must be bound to the trusted caller and the
  requested Sandbox or Pod identity.
- For Codex, OpenShell service routing must securely carry bearer authorization
  without exposing gateway credentials. Stock v0.1.0 strips it before proxying.

If any of these conditions are unavailable, OpenShell-selected deployments must
fail closed instead of launching an unsandboxed or incorrectly credentialed
Harness.

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
- `OpenShell material delivery is unavailable for ...`
  The selected adapter has no accepted repository/plugin material producer. Do not
  remove the requirement or substitute shared environment/PVC content.
- `OpenShell SandboxDriver supports only dedicated Codex or OpenClaw Harness revisions.`
- `OpenShell v0.1.0 cannot receive secretKeyRef environment APP_SERVER_TOKEN ...`

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
