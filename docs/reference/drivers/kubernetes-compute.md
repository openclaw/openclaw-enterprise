# Kubernetes Compute Driver

The Kubernetes Compute Driver runs OpenClaw Agents on Kubernetes. It provisions
or adopts a data-plane namespace for each tenant and creates an OpenClaw gateway
for each deployed Agent. Dedicated Gateways run in a separate managed control-plane
runtime namespace; embedded OpenClaw remains in the data plane.
The experimental `executionCluster` configuration selects a second Kubernetes
API for dedicated Harness resources. See the [two-cluster validation profile](../../testing/two-cluster-local.md)
before using it; cloud deployment and complete runtime acceptance remain pending.
Kubernetes supports a managed model API key for both modes and a managed
ChatGPT service-account credential for dedicated Codex only.

New managed tenant namespaces use the opaque physical name `oce-` plus the first
15 hexadecimal characters of the Namespace ID's SHA-256 digest. This is stable,
DNS-safe, and short enough to serve as an OpenShell pre.5 operator Workspace
name. A previously created managed namespace that uses the earlier
`oce-<slug>-<hash12>` canonical name remains valid only when Kubernetes
discovery finds its exact tenant label, matching `namespace-id` annotation, and
OpenClaw manager label. The Driver does not create new namespaces with the
previous name form, and wrong names or duplicate tenant claims fail closed. An
explicitly adopted existing namespace retains its operator-selected name;
OpenShell selection rejects it if it exceeds that Workspace limit.

The optional [OpenShell Sandbox Driver](openshell-sandbox.md) is designed to
own the dedicated Codex Harness Pod while Compute keeps the other resources.
Stock OpenShell cannot provide required credential and workload-identity
projections; Agent deployment with OpenShell is unsupported.

For detailed operator contracts, see:

- [Storage and credentials](kubernetes-compute/storage-and-credentials.md): separate Gateway state, Harness workspaces, and runtime Secrets.
- [Networking and isolation](kubernetes-compute/networking-and-isolation.md): DNS, private gateway routes, and tenant namespace ownership.

## Requirements

- Kubernetes 1.35 or later. On an older API server, API and worker startup each
  emit `compute.preflight-warning`; its message includes the observed and
  minimum versions. Startup continues, but versions below 1.35 are outside the
  supported and CI-verified boundary even though this advisory does not block
  startup.
- A Kubernetes cluster dedicated to one OpenClaw Enterprise Installation.
- Enforced Kubernetes NetworkPolicies, verified Kubernetes API TLS, and
  restricted Pod security.
- Separate controller API and worker ServiceAccounts with operator-managed,
  tenant-local permissions.
- API and worker permission to `GET` the Kubernetes `/version` non-resource URL.
  The production chart grants it through the same narrowly scoped ClusterRoles
  used for startup Namespace observation and management.
- Approved, digest-pinned gateway and Agent images.
- Explicit container resource limits, namespace quotas, DNS settings, approved
  proxy clients, and `network.gatewayTrustedProxyCidrs` for gateway trust.
  Native workspace initialization uses `resources.gateway`, including in dedicated
  Harness Pods, because it loads the OpenClaw CLI.
- For real gateways in either topology, an explicitly selected
  `runtime.gatewayStorageClassName` for a private disk supporting `10Gi`
  `ReadWriteOnce` filesystem claims. Use `local-path` in the disposable k3d
  suite; see the [gateway disk requirements](kubernetes-compute/storage-and-credentials.md#gateway-storage) before
  selecting a production StorageClass.
- For dedicated Agents, a default StorageClass that supports `40Gi`
  `ReadWriteOnce` PersistentVolumeClaims.
- If `runtime.codexSeccompProfile` is configured, install that relative
  localhost seccomp profile on every eligible node before Agent startup.
  Kubernetes fails the Codex Pod when the configured profile is missing.

The worker manages PersistentVolumeClaims and, when private gateway routing is
enabled, HTTPRoutes through tenant-local RoleBindings. Only the controller API
issues provider credentials. The worker reads admitted transport/channel material
and maintains revision-owned Gateway Secret projections in the separate target.
The API does not need gateway Pod reads, exec, route writes, or certificate
management for workspace-file access. Do not grant wildcard permissions,
cluster-wide access to tenant resources, workload access to controller
credentials, or permission to create or escalate RoleBindings.

If OpenShell sandboxing is enabled, the Compute Driver's Kubernetes access is
also used directly by the optional `SandboxDriver.ensureNamespace` hook to
apply approved namespace-scoped OpenShell labels and NetworkPolicy resources,
check Gateway readiness, and create or adopt the Namespace Workspace. The
selected driver's optional `provisionHarness` hook creates the provider-owned
Harness Sandbox; without that hook, Compute creates the ordinary Harness
Deployment. Stop and retirement delete that ordinary Deployment when present
and then always invoke the selected provider's required revision cleanup. An
absent Deployment does not skip cleanup. Namespace deletion calls the selected
provider's Namespace cleanup first and does not delete Kubernetes infrastructure
when that provider cleanup fails.
Provider-owned Harness removal remains delegated to the provider, so Compute
does not need Sandbox custom-resource permissions. No separate SandboxDriver
Kubernetes access adapter is introduced. The privileged
OpenShell init or sidecar containers must be allowed only through an
operator-approved RuntimeClass or equivalent admission exemption with a
matching fail-closed policy; the Harness container itself remains unprivileged.

For a provider-owned dedicated Harness, readiness requires exactly one live Pod
in the resolved namespace with the Agent, revision, and `agent` workload-role
labels used by the active Service selector. The Pod must also carry all supplied
Harness requirement labels and report `Ready=True`. Zero candidates, multiple
live candidates (including one Ready and one unready), or a single unready
candidate leave preparation at `ready: false` and prevent activation. Pods with
a valid deletion timestamp are excluded; Pods in another namespace or with
another Agent, revision, or role do not count.

Malformed or incomplete Pod-list observations raise an error, including invalid
identity or condition fields, duplicate condition types, contradictory Harness
requirement labels, and pagination indicating more results. Missing optional
Pod status or conditions means not ready. Preparation errors run the existing
workload cleanup hooks; activation errors occur before changing routing.
Cancellation of the observation cannot yield a successful readiness result.
This checks Kubernetes workload readiness and label uniqueness; it does not
attest a provider Sandbox ID or Pod UID, authenticate the guest, or fence a
runtime generation.

Shared Kubernetes clusters are not currently supported.

## Configuration

Select the Kubernetes Compute Driver in the Installation startup YAML. Set
`OCC_CONFIG_PATH` to that file's absolute path for both the controller API and
worker.

```yaml
drivers:
  compute:
    id: compute-kubernetes
    configuration:
      authentication:
        mode: inCluster
      images:
        gateway: registry.example/openclaw-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        agent: registry.example/openclaw-codex@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        requireImmutableDigest: true
      resources:
        gateway:
          requests: { cpu: 100m, memory: 128Mi }
          limits: { cpu: 500m, memory: 256Mi }
        agent:
          requests: { cpu: 100m, memory: 128Mi }
          limits: { cpu: 500m, memory: 256Mi }
        namespace:
          quota: { pods: "10" }
          containerDefaults:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
      network:
        dns:
          namespace: kube-system
          podLabels: { k8s-app: kube-dns }
        gatewayPort: 8080
        # Replace with verified source CIDRs for your authenticated proxy.
        gatewayTrustedProxyCidrs: ["<actual-proxy-source-cidr>"]
        gatewayClients:
          - namespace: openclaw-system
            podLabels: { app: approved-gateway-client }
      servicePrincipalCredentials:
        mode: projectedServiceAccountToken
        audience: openclaw-enterprise
        expirationSeconds: 900
      runtime:
        gatewayStorageClassName: sqlite-block
        nodeSelector: { oce-role: agents }
        gatewayNodeSelector: { oce-role: control-plane }
        transportSecretPrefix: openclaw-agent-transport
        # Optional; first install this reviewed profile on every eligible node.
        codexSeccompProfile: profiles/codex-0.156.0.json
```

This example shows only the Compute Driver portion of the Installation
configuration. See the [complete production Installation example](../../guides/deploy/production-installation.md#configure-the-installation)
for the other required Drivers and settings.

### Authentication

Choose exactly one Kubernetes authentication mode:

- `inCluster` uses the controller Pod's ServiceAccount and the cluster
  certificate authority.
- `kubeconfig` requires an explicit `kubeconfigPath` and named `context`.

The driver does not fall back to the ambient kubeconfig or current context.
Kubernetes API certificates must be verified in either mode.

### Images and resources

Configure separate gateway and Agent images, CPU and memory requests and limits,
namespace-level resource quotas and container defaults. `runtime.nodeSelector`
selects Harness and embedded Pods; dedicated real Gateways require
`runtime.gatewayNodeSelector`, including their private-state initializer. Use
disjoint trusted and tenant node pools in production. Quotas and defaults apply
separately to each physical namespace. Production requires
`images.requireImmutableDigest: true` and SHA-256 image digests.

See [network configuration](kubernetes-compute/networking-and-isolation.md#networking)
for DNS, gateway clients, proxy trust, and egress requirements.

## Execution modes

Each Agent-owned gateway Deployment has exactly one desired replica and uses
`Recreate`: Kubernetes stops the previous Pod before starting its replacement,
so gateway rollout can cause transient downtime. A Deployment cannot guarantee
an absolute process singleton during node partitions or manual replacement.
OCC's single active revision and guarded routing do not provide independent
node-level execution fencing.

The Agent's Harness configuration determines its execution topology:

- **Embedded:** OpenClaw runs the gateway and Harness in one Pod. It accepts
  an Agent-scoped model API key, uses `openai/` models, and does not require
  shared storage.
- **Dedicated:** The gateway and Codex Harness run in separate namespaces and
  Pods, with separate ServiceAccounts and storage. They communicate through
  authenticated app-server transport. The Gateway uses fully qualified Harness
  Service DNS and the paired node for workspace operations. Codex accepts an
  Agent-scoped model API key or a managed ChatGPT service-account credential,
  and permits `openai/` or `codex/` models.

Dedicated replacement opts into the [exclusive preparation contract](compute.md#production-revision-stages):
the worker stops predecessors before starting the new Harness. This permits RWO
workspace storage and introduces deployment downtime; restore a previous
configuration through a new revision instead of restarting its old snapshot.

Enabled external channels require dedicated execution. Unsupported Harness and
execution-mode combinations fail deployment. OpenShell is designed for
dedicated Codex only, but stock OpenShell currently blocks that deployment;
embedded OpenClaw is rejected as well.

Stopping an Agent first deletes its exact gateway route and gateway runtime,
then removes the dedicated Harness Deployment or delegates provider-owned
Harness removal. A selected Sandbox Driver's revision cleanup always runs after
an ordinary Harness Deployment is absent. Stop retains Agent-owned
PersistentVolumeClaims and runtime credential Secrets. Retirement remains the
destructive revision cleanup operation. Repeated stop observes exact ownership
and converges when the runtime objects are already absent.

### Plugin startup status

Compute-owned embedded OpenClaw and dedicated Codex runtimes publish a private
current-startup result after attempting requested plugins and verifying effective
configuration. The result identifies the revision and runtime instance, with
successful selection IDs and safe `PLUGIN_INSTALL_FAILED` or
`PLUGIN_AUTH_REQUIRED` warnings for disabled selections.

Kubernetes Compute reads the exact owned workload's status endpoint through the
authenticated Kubernetes Pod proxy. Tenant-local controller RBAC permits this
read; workload ServiceAccounts receive no Kubernetes write credentials. The
endpoint is not part of the public gateway API. Compute validates workload
ownership, startup identity, admitted selection keys, and closed warning codes.
Missing, malformed, or foreign status cannot establish readiness.

For embedded OpenClaw, startup explicitly disables failed plugin entries and
removes their managed tool allowances before starting the gateway. For dedicated
Codex, the separate gateway applies the Agent's current result to its bridge
configuration before serving and refreshes that configuration after a changed
restart result. Failed-only Codex app bindings are disabled; successful selections
retain their admitted policy, including shared app bindings they require.

The Codex app-server credential is derived from the Agent's transport Secret,
revision, and startup identity. A gateway configured for the previous startup
cannot authenticate to a restarted Agent. Its supervisor obtains the new status,
applies the matching exclusions, and starts the gateway with the new credential.
This closes the interval before the supervisor's next status poll.

The worker records warnings with successful deployment completion under its live
claim. A runtime restart recomputes status instead of preserving the first
failure. There are no plugin receipt ConfigMaps, Pod finalizers, failure latches,
or post-commit acknowledgment steps. This behavior does not mutate requested
revision selections, uninstall account-wide plugins, or promise rollback.

### Current runtime diagnostics

Kubernetes Compute implements the optional deployment diagnostics contract. OCC
authorizes the exact Agent and revision, then the Driver reads the owned
runtime Pods through the Kubernetes apiserver Pod proxy. The private runtime
endpoint returns bounded generic checks for the requested revision. The API needs
Pod `get`/`list` and `pods/proxy` `get` permission in each runtime namespace.
Dedicated Gateways are read in their managed Gateway namespace, while Harnesses
are read in the tenant namespace. The chart adds these read permissions to the
unbound tenant API and Gateway observer roles; operators retain control of their
namespace-local bindings.
Missing Pods or unavailable private endpoints report unknown diagnostic checks
instead of mutating deployment status. The Agent container currently returns no
channel checks.

The bundled gateway currently maps Slack channel status into configuration,
authentication, and connectivity checks. These diagnostics do not include raw
Slack responses, credential values, logs, or message text, and they do not post
a message or run a model turn.

See the [Harness execution topology flow](../../flows/harness-execution-topology.md)
for additional execution details.

## Failure conditions

- **Namespace provisioning fails:** Verify tenant-local RoleBindings, namespace
  ownership labels, restricted Pod Security labels, and enforced
  NetworkPolicies in both the Harness and Gateway runtime namespaces. Existing namespaces additionally require external lifecycle
  ownership, exclusive tenant use, and no foreign NetworkPolicies.
- **Gateway or Harness remains pending:** Check image digests, image pull
  permissions, CPU and memory limits, namespace quotas, required Secrets, and
  workload readiness. Dedicated Codex Harness containers clear the plugin
  readiness marker at process start so a marker left in the Pod's temporary
  volume by a previous container attempt cannot make a restarted runtime ready.
  Access-token login retries only native process timeouts, up to three 30-second
  attempts. Credential refusals and model probes are not retried; exhausted
  startup remains unready until an explicit restart.
  Native plugin startup, authentication, transport, and installation failures
  remain generic workload startup failures unless the Compute-owned runtime
  reports a verified current-startup warning for an admitted selected plugin.
- **Gateway storage is pending or rejected:** Check the configured
  `runtime.gatewayStorageClassName`, available `10Gi` capacity, filesystem
  support, worker PVC permissions, and the PVC's exact ownership. Preserve
  data when resolving an incompatible or foreign claim; the driver does not
  adopt or convert it.
- **Dedicated Harness cannot start:** Verify that the default StorageClass can
  provision a `40Gi` `ReadWriteOnce` claim and that the worker can manage
  PersistentVolumeClaims in the tenant namespace.
- **Agent configuration is rejected:** Confirm the selected Harness supports
  its execution mode; external channels and provider-issued access tokens
  require dedicated execution.
- **Approved traffic fails or denied traffic succeeds:** Verify NetworkPolicy
  enforcement, configured DNS selectors, gateway-client selectors, and any
  configured channel proxy address.
- **Production startup fails:** Confirm the controller API and worker share the
  same `OCC_CONFIG_PATH`, image digests are immutable, Kubernetes credentials
  are valid, and required runtime Secret prefixes are configured.

## Selected-driver lifecycle hooks

The Driver invokes selected non-Compute lifecycle hooks around Namespace
preparation and workload startup or teardown. Hooks receive the current
operation's cancellation signal; a failed revocation blocks resource teardown.
The [ComputeDriver contract](compute.md#optional-selected-driver-hooks) owns the
hook ordering and environment restrictions, and the
[lifecycle-hook flow](../../flows/compute-driver-lifecycle-hooks.md) traces the
implementation.

## Related documentation

- [Production Kubernetes deployment](../../guides/deploy.md)
- [Installation startup configuration](../configuration.md#installation-startup-configuration)
- [Configuration reference](../settings/programmatic.md#kubernetes-compute-driver)
- [Service accounts](../service-accounts.md)
- [ComputeDriver contract](compute.md)
- [SandboxDriver contract](sandbox.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Controller worker](../controller.md)
- [Harness execution topology](../../flows/harness-execution-topology.md)
- [Kubernetes testing](../../testing/kubernetes.md)
