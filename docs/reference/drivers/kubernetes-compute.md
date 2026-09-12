# Kubernetes Compute Driver

The Kubernetes Compute Driver runs OpenClaw Agents on Kubernetes. It provisions
or adopts an isolated namespace for each tenant and creates an OpenClaw gateway
for each deployed Agent, with either an embedded or dedicated Agent Harness. When the optional
[OpenShell SandboxDriver](openshell-sandbox.md) is selected, the Compute Driver still
owns namespace, gateway, ServiceAccount, PVC, routing, and revision lifecycle,
but delegates the dedicated Codex Harness Pod to the OpenShell Sandbox
controller.

For detailed operator contracts, see:

- [Storage and credentials](kubernetes-compute/storage-and-credentials.md): gateway disks, shared workspaces, and runtime Secrets.
- [Networking and isolation](kubernetes-compute/networking-and-isolation.md): DNS, private gateway routes, and tenant namespace ownership.

## Requirements

- A Kubernetes cluster dedicated to one OpenClaw Enterprise Installation.
- Enforced Kubernetes NetworkPolicies, verified Kubernetes API TLS, and
  restricted Pod security.
- Separate controller API and worker ServiceAccounts with operator-managed,
  tenant-local permissions.
- Approved, digest-pinned gateway and Agent images.
- Explicit container resource limits, namespace quotas, DNS settings, and
  approved gateway clients.
- For real gateways in either topology, an explicitly selected
  `runtime.gatewayStorageClassName` for a private disk supporting `10Gi`
  `ReadWriteOnce` filesystem claims. Use `local-path` in the disposable k3d
  suite; see the [gateway disk requirements](kubernetes-compute/storage-and-credentials.md#gateway-storage) before
  selecting a production StorageClass.
- For dedicated Agents, a default StorageClass that supports `40Gi`
  `ReadWriteMany` PersistentVolumeClaims.
- If `runtime.codexSeccompProfile` is configured, install that relative
  localhost seccomp profile on every eligible node before Agent startup.
  Kubernetes fails the Codex Pod when the configured profile is missing.

The worker manages PersistentVolumeClaims and, when private gateway routing is
enabled, HTTPRoutes through tenant-local RoleBindings. Only the controller API
receives narrowly scoped Secret permissions for provider-issued credentials.
The API does not need gateway Pod reads, exec, route writes, or certificate
management for workspace-file access. Do not grant wildcard permissions,
cluster-wide access to tenant resources, workload access to controller
credentials, or permission to create or escalate RoleBindings.

If OpenShell sandboxing is enabled, the Compute Driver's Kubernetes access is
also used directly by the optional `SandboxDriver.ensureNamespace` hook to
apply approved namespace-scoped OpenShell NetworkPolicy resources
and check gateway readiness. The selected driver's optional `provisionHarness`
hook creates the provider-owned Harness Sandbox; without that hook, Compute
creates the ordinary Harness Deployment. Revision cleanup is delegated to the
provider, so Compute does not need Sandbox custom-resource permissions. No
separate SandboxDriver Kubernetes access adapter is introduced. The privileged
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
        gatewayClients:
          - namespace: openclaw-system
            podLabels: { app: approved-gateway-client }
      servicePrincipalCredentials:
        mode: projectedServiceAccountToken
        audience: openclaw-enterprise
        expirationSeconds: 900
      runtime:
        gatewayStorageClassName: sqlite-block
        transportSecretPrefix: openclaw-agent-transport
        modelSecretPrefix: openclaw-agent-model
        # Optional; first install this reviewed profile on every eligible node.
        codexSeccompProfile: profiles/codex-0.152.1.json
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
and namespace-level resource quotas and container defaults. Production requires
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

- **Embedded:** OpenClaw runs the gateway and Harness in one Pod. This mode
  supports an Agent-scoped model API key and does not require shared storage.
- **Dedicated:** The gateway and Codex Harness run in separate Pods with
  separate ServiceAccounts. They communicate through authenticated app-server
  transport and share an Agent-owned PersistentVolumeClaim.

Provider-issued access tokens and enabled external channels require dedicated
execution. Unsupported Harness and execution-mode combinations fail deployment.
OpenShell sandboxing currently supports only this dedicated Codex path; embedded
OpenClaw Agents fail closed when the OpenShell SandboxDriver is selected.

See the [Harness execution topology flow](../../flows/harness-execution-topology.md)
for additional execution details.

## Failure conditions

- **Namespace provisioning fails:** Verify tenant-local RoleBindings, namespace
  ownership labels, restricted Pod Security labels, and enforced
  NetworkPolicies. Existing namespaces additionally require external lifecycle
  ownership, exclusive tenant use, and no foreign NetworkPolicies.
- **Gateway or Harness remains pending:** Check image digests, image pull
  permissions, CPU and memory limits, namespace quotas, required Secrets, and
  workload readiness. Dedicated Codex Harness containers clear the plugin
  readiness marker at process start so a marker left in the Pod's temporary
  volume by a previous container attempt cannot make a restarted runtime ready.
  Native plugin startup, authentication, transport, and installation failures
  remain generic workload startup failures unless the native runtime provides a
  trusted typed failure source.
- **Gateway storage is pending or rejected:** Check the configured
  `runtime.gatewayStorageClassName`, available `10Gi` capacity, filesystem
  support, worker PVC permissions, and the PVC's exact ownership. Preserve
  data when resolving an incompatible or foreign claim; the driver does not
  adopt or convert it.
- **Dedicated Harness cannot start:** Verify that the default StorageClass can
  provision a `40Gi` `ReadWriteMany` claim and that the worker can manage
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
