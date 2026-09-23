# OpenShell SandboxDriver

The bundled OpenShell SandboxDriver integrates a Namespace-local OpenShell
gateway with a dedicated Codex Harness and the bundled
[Kubernetes Compute Driver](kubernetes-compute.md). OCC retains ownership of
Agents, revisions, Namespaces, routing, credentials, and authorization.

**OpenShell is not supported for production Agent deployment.** The stock
OpenShell version this integration targets,
[`v0.1.0-pre.7`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0-pre.7), cannot accept the
Kubernetes Secret-backed environment entries or projected workload identity a
dedicated Codex Agent requires. The Enterprise Driver rejects deployment rather
than starting an incorrectly credentialed Harness. The real integration keeps
that rejection proof and has a separate CI-only compatibility bridge for a real
in-Sandbox model turn. That bridge is not a supported deployment path. Use
Kubernetes Compute without OpenShell when you need to run Agents.

Embedded OpenClaw also fails when OpenShell is selected; the integration is
designed only for dedicated Codex. See the [upstream requirements](#current-upstream-preconditions)
before evaluating OpenShell.

## Ownership model

The following describes how the integration is wired. Stock OpenShell cannot
complete dedicated Harness provisioning until it meets the upstream
requirements. The Kubernetes Compute Driver remains the orchestration owner:

- It creates or adopts the OpenClaw Namespace and applies baseline isolation.
- It creates the per-Agent gateway, ServiceAccount, shared workspace PVC,
  Services, NetworkPolicies, revision records, and activation state.
- It calls `SandboxDriver.ensureNamespace`, when implemented, after namespace
  isolation exists.
- It delegates dedicated Harness creation to `SandboxDriver.provisionHarness`,
  when implemented; otherwise, it creates the ordinary Harness Deployment.
- It routes only to the active revision and removes routing during
  deactivation when the Service still points at that revision.

The OpenShell SandboxDriver owns only the provider sandboxing delegation:

- `configureAgent` contributes provider-specific gateway configuration before
  OCC validates and freezes the immutable Agent revision.
- `ensureNamespace` applies configured NetworkPolicy resources,
  waits for the namespace-local OpenShell gateway when readiness is configured,
  and checks gateway health. These operations are idempotent so multiple
  workers converge on one gateway.
- `provisionHarness` asks the OpenShell gateway to create one OpenShell Sandbox
  and expose its loopback Codex app-server port in the same request. It validates
  the returned service route and returns the stable Sandbox reference.
- OpenShell's controller creates and owns the provider Harness Pod behind that
  Sandbox.
- `cleanup` receives the immutable Agent revision and derives the stable
  provider Sandbox identity, so retirement works even when its Pod is gone.
  Namespace cleanup also removes the configured NetworkPolicy resources.

The returned provider-owned Pod is not re-verified as an OCC-owned workload.
Compute trusts OpenShell to enforce the Sandbox it provisions, while OCC still
requires ordinary workload readiness and exact active-revision routing before
traffic is served. Each immutable Agent revision retains only
`sandboxDriverId`, so workers resolve the same selected driver for provisioning
and cleanup without persisting duplicate provider descriptors or facets.

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
startup.

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
        serviceName: openshell-gateway
        port: 8080
        workspace: default
        readiness:
          serviceName: openshell-gateway
          podSelector:
            app.kubernetes.io/name: openshell
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
          - name: model-egress
            binaries:
              - path: /path/to/model-client
            endpoints:
              - host: api.openai.com
                ports: [443]
                protocol: tcp
                tls: skip
```

Each pre.7 network policy requires at least one binary identity with a nonempty
executable path. OpenShell applies the endpoints only to those
binaries. The optional endpoint fields use OpenShell's configuration spellings: `tls`
accepts `skip` or `terminate`; `enforcement` accepts `enforce` or `audit`; and
`access` accepts `read_only`, `read_write`, or `full`. OpenShell pre.7 treats
`terminate` as a deprecated alias for automatic TLS detection and termination.
It also changed the old `passthrough` spelling to that behavior, so the Driver
rejects `passthrough` at startup. Replace `tls: passthrough` with `tls: skip` to
retain uninspected TLS relay.
`gatewayConfigured` is the only ServiceAccount mode for `v0.1.0-pre.7`; the
gateway's configured sandbox ServiceAccount applies to every Sandbox it creates
and does not satisfy the per-Agent production requirement below.

The OpenShell gateway must be installed separately before this driver's
`ensureNamespace` runs. The bundled driver does not install the gateway.

`gateway.networkPolicyResources` accepts namespace-scoped Kubernetes resource
objects for provider networking. They are applied into the OpenClaw Namespace
during `ensureNamespace`. Do not include Secrets in this array; the driver
rejects Secret resources because OpenShell credentials must not be embedded in
startup YAML.

`kubernetes.sandboxDataMount` must match exactly one approved dedicated Harness
workspace mount. It may not mount the PVC root, may not use `..`, and must mount
under `/sandbox/`.

OpenShell's `configureAgent` hook contributes the effective Codex configuration
before OCC validates and freezes the revision, disabling the inner Codex
app-server sandbox:

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
outer containment boundary for the dedicated Harness.

## Create-time app-server exposure

For a request that reaches OpenShell, the Driver reads the literal
`APP_SERVER_PORT` prepared by Compute and includes one unnamed service exposure
in `CreateSandbox`. It uses the Agent revision UUID as OpenShell's `request_id`,
so retries receive the same service URL. The Driver accepts only an HTTP or HTTPS
origin, rewrites its port to the configured gateway endpoint for local
port-forwards, and requires a valid route before provisioning succeeds.

OpenShell pre.7 strips `Authorization` before proxying, while Codex accepts only
bearer authorization. The positive integration therefore expects the protected
app server's `401` through this route and runs its real model turn on Pod
loopback. It does not treat the test bridge as supported or replace Compute's
Agent Service. A Sandbox without a replayable Create receipt must be removed;
the Driver does not mutate it with a later `ExposeService` call.

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
Namespace-local RBAC must enforce the tenant boundary on the shared client.

Kubernetes NetworkPolicies are additive. The Kubernetes Compute Driver still
installs default-deny and Agent routing policies; OpenShell bootstrap policies
must allow only gateway, control-plane, callback, and approved provider
connectivity needed for OpenShell to function. Broad namespace egress or ingress
allows can bypass the intended boundary.

## Current upstream preconditions

The current integration cannot run production Agents. Production support would
require upstream OpenShell to satisfy all of these conditions:

- OpenShell must create Sandboxes with the per-Agent ServiceAccount that Compute
  creates for the Harness.
- OpenShell must preserve the Harness's exact audience-bound, short-lived
  projected ServiceAccount token and read-only mount. Its gateway bootstrap
  token is not a substitute. Stock OpenShell `v0.1.0-pre.7` does not support
  projected volumes in gateway driver configuration. An operator-created
  template bridge is not a supported workaround.
- OpenShell must preserve all approved Agent workspace PVC subpath mounts
  without falling back to its default workspace claim or mounting the PVC root.
- OpenShell must preserve the immutable plugin-runtime `runtime.json` and
  `config.toml` ConfigMap entries at `/etc/openclaw/plugin-runtime`. The Codex
  entrypoint reads these files even when the Agent selects no optional plugins.
- OpenShell must support exact environment entries backed by Kubernetes
  `secretKeyRef`, including the startup app-server token Secret. Stock
  OpenShell `v0.1.0-pre.7` cannot receive those entries through the current gateway
  API, and the Enterprise Driver rejects them. A credential bridge is not a
  supported workaround.
- OpenShell gateway authentication must be bound to the trusted caller and the
  requested Sandbox or Pod identity.
- OpenShell service routing must securely carry Codex bearer authorization
  without exposing gateway credentials. Stock pre.7 strips it before proxying.

If any of these conditions are unavailable, OpenShell-selected deployments must
fail closed instead of launching an unsandboxed or incorrectly credentialed
Harness.

## Troubleshooting

Common fail-closed errors include:

- `drivers.sandbox requires the bundled Kubernetes Compute Driver.`
- `OpenShell gateway Service is unavailable.`
- `OpenShell gateway Pod is not ready.`
- `OpenShell SandboxDriver only supports dedicated Codex Harness revisions.`
- `OpenShell v0.1.0-pre.7 cannot receive secretKeyRef environment ...`

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [SandboxDriver contract](sandbox.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)

## Changelog

- Removed the unused `gateway.bootstrapResources` manifest option. Gateway installation remains external to the bundled driver. (NOT_IN_SPEC)
