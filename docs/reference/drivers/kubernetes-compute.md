# Kubernetes Compute Driver

The Kubernetes Compute Driver runs OpenClaw Agents on Kubernetes. It provisions
or adopts an isolated namespace for each tenant and creates an OpenClaw gateway
for each deployed Agent, with either an embedded or dedicated Agent Harness. When the optional
[OpenShell SandboxDriver](openshell-sandbox.md) is selected, the Compute Driver still
owns namespace, gateway, ServiceAccount, PVC, routing, and revision lifecycle,
but delegates the dedicated Codex Harness Pod to the OpenShell Sandbox
controller.

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
  suite; see the [gateway disk requirements](#storage-and-credentials) before
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
configuration. See the [complete production Installation example](../../guides/deploy.md#configure-the-installation)
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

### Networking

Configure the cluster DNS namespace and Pod labels and the gateway port.
Without private routing, also configure the namespace and Pod selectors in
`network.gatewayClients` allowed to access Agent gateways.

Each tenant starts with default-deny ingress and egress. Explicit policies allow
DNS, approved gateway clients, and required communication between an Agent's
gateway and dedicated Harness. Cross-tenant traffic, traffic between different
Agents, Kubernetes API access, and cloud metadata access remain denied.

When private Agent routing is enabled, Compute derives the only allowed peer
from `gatewayRouting`: the Envoy namespace and the Gateway's exact owning name
and namespace labels. Omit `network.gatewayClients`; startup rejects explicit
clients in routed mode. The native gateway trusts
the proxy's source range; NetworkPolicy distinguishes the authenticated proxy
from other Pods in that range. Do not retain direct API or tenant-workload
access to the native gateway port for this mode.

When native Configuration selects `gateway.auth.mode: "trusted-proxy"`, Compute
omits automatic `OPENCLAW_GATEWAY_TOKEN` projection: native OpenClaw rejects a
simultaneous gateway token. Token mode remains the default. Readiness uses a
Pod-local HTTP request to `127.0.0.1:$OPENCLAW_GATEWAY_PORT/readyz`; TLS terminates
at Envoy, so native readiness probes remain unchanged.

Production currently permits public TCP/443 egress for model access; a
restricted model proxy is not yet available. Channels require an approved
literal-IP HTTP(S) proxy configured through `runtime.channels`; direct public
channel-provider access is denied.

## Private Agent gateway routes

See [gateway routing with Envoy](../gateway-routing.md) for shared infrastructure,
service-key bootstrap, TLS, and network enforcement.

Optional Installation Compute settings enable one stable route per Agent:

```yaml
gatewayRouting:
  gatewayName: oce-agent-gateways
  gatewayNamespace: openclaw-system
  envoyNamespace: envoy-gateway-system
```

The Gateway name and namespace must match the Helm-managed Gateway;
`envoyNamespace` identifies its Envoy data-plane Pods. The chart always creates
the Gateway in its release namespace. These three settings are required when
routing is enabled; `hostname` is optional.

When `hostname` is omitted or empty, Compute and Helm derive the same Service
name: `occ-gateway-` followed by the first 12 hexadecimal characters of the
SHA-256 of `<gatewayNamespace>/<gatewayName>`. The hostname is
`<serviceName>.<envoyNamespace>.svc`. It uses standard Linux Pod DNS search and
does not assume a `cluster.local` suffix. Set the same explicit `hostname` in
Compute and Helm for custom DNS or clients outside that cluster DNS context.
The default needs no existing Agent or Kubernetes lookup.
The operator installs Envoy Gateway and cert-manager and configures the
[private gateway infrastructure](../../guides/deploy.md#agent-workspace-files).
Do not put an Agent endpoint, service key, certificate, or file contents into
native Configuration or an AgentRevision.

`getGatewayEndpoint` derives
`wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>` without Kubernetes
API access. During preparation and activation, Compute reconciles an owned
`HTTPRoute` in the tenant namespace, attached to the configured Gateway's
`https` listener. It matches the exact Agent path and hostname, rewrites the
path to `/`, and targets the existing same-namespace gateway Service.
Namespaces receive the Gateway membership label used by `allowedRoutes`.

The Service and route remain stable across revision cutover. Retiring an old
revision preserves a newer gateway's route; final gateway cleanup removes the
owned route. Reconciliation runs through the existing revision lifecycle; this
Driver does not add periodic route drift repair. Missing CRDs or denied worker
permissions fail reconciliation rather than disabling routing silently.

Envoy's Gateway-level SecurityPolicy authenticates the OCC service key before
forwarding. The route overwrites the native identity and real-IP headers and
removes caller forwarding and scope headers. Native `allowRealIpFallback`
accepts Envoy's direct downstream connection address when OCC and Envoy share a
Pod CIDR. That source address must be nonloopback; a loopback port-forward alone
is not a working native attribution path.

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

## Namespaces and isolation

Each OpenClaw Namespace maps to one Kubernetes namespace. The driver applies
tenant resource quotas, container defaults, and network isolation before
starting Agent workloads. Each Agent receives its own gateway; dedicated Agents
also receive a separate Harness and workload identity.

Identity labels under `openclaw.dev/` contain the full platform Namespace,
Agent, revision, ServiceAccount, ServicePrincipal, or Configuration ID, not a
hash. Ownership checks, discovery, Service selectors, and NetworkPolicies use
those same raw IDs. Generated Kubernetes resource names still use bounded
hashes to satisfy their naming constraints.

An Installation administrator can select an existing, exclusively dedicated
Kubernetes namespace when creating the OpenClaw Namespace:

```json
{
  "name": "customer-support",
  "existingNamespace": "customer-support-prod"
}
```

Prepare the namespace by annotating
`openclaw.dev/namespace-lifecycle=external`, applying
`pod-security.kubernetes.io/enforce=restricted`,
`pod-security.kubernetes.io/audit=restricted`, and
`pod-security.kubernetes.io/warn=restricted`, and granting tenant-local worker
and API RoleBindings. The running worker rechecks Installation administrator
authorization, rejects foreign NetworkPolicies and competing tenant claims, and
binds the generated tenant identity through one resource-version-guarded,
non-forced Kubernetes patch. No worker pause or restart is required. Missing
worker permissions keep provisioning pending; missing API permissions prevent
Configuration access. Docker and external Compute Drivers reject
existing-namespace selection with `409`.

See [tenant RoleBindings](../../guides/deploy.md#grant-tenant-rolebindings)
for the required worker and API grants.

Workload Pods run as nonroot, use `RuntimeDefault` seccomp by default, drop
Linux capabilities, disable privilege escalation, and use read-only root
filesystems. When `runtime.codexSeccompProfile` is configured, only the
dedicated Codex Agent container uses
`seccompProfile: { type: "Localhost", localhostProfile: <profile> }`; the Pod,
gateway container, embedded runtime, controller, and init containers keep their
default seccomp settings. The profile path must be relative to the kubelet's
localhost seccomp profile root and cannot be empty, absolute, traversing, or
unconfined. Agent identity is provided through an audience-scoped, short-lived
projected ServiceAccount token. Workloads never receive controller credentials.

The driver deletes Kubernetes namespaces it created when their corresponding
OpenClaw Namespaces are deleted. For an operator-owned existing namespace, it
removes only its exact-owned quota, limit, and three tenant NetworkPolicies;
the Kubernetes namespace, ownership markers, RoleBindings, and unrelated
resources remain intact.

## Storage and credentials

Each real gateway, embedded or dedicated, receives one private `10Gi`
`ReadWriteOnce` filesystem claim named `gateway-state-<agent-hash>`, where
`agent-hash` is the first 12 hexadecimal characters of `sha256(agentId)`.
The required `runtime.gatewayStorageClassName` selects an operator-provisioned
StorageClass for a local or cloud block disk mounted as a filesystem.

"SQLite-compatible" describes the backing storage, not a Kubernetes feature or
certification. The filesystem must provide reliable file locking, durable
writes through `fsync`, and support for SQLite's database and companion WAL/SHM
files in the same directory. The driver checks the claim configuration, but
does not certify the storage provider's locking or durability guarantees.
See [SQLite's filesystem requirements](https://sqlite.org/useovernet.html).

Do not use NFS or SMB/CIFS for gateway databases:
[SQLite WAL does not support network filesystems](https://sqlite.org/wal.html).
A cloud block disk accessed over a network is different: the node mounts a
filesystem on that disk instead of accessing a shared network filesystem.

`ReadWriteOnce` (RWO) means read-write access from one **node**, not one Pod;
[multiple Pods on that node may still mount it](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).
It does not establish SQLite compatibility or single-gateway access. Normal
gateway replacement uses one replica with `Recreate`; node partitions and
forced replacements still require operator fencing before permitting another
writer.

Only the gateway Pod receives this claim. Its complete writable directories
include database files and their WAL/SHM siblings:

| Private subpath | Gateway mount                            |
| --------------- | ---------------------------------------- |
| `state`         | `/home/node/.openclaw/state`             |
| `agent`         | `/home/node/.openclaw/agents/main/agent` |
| `media`         | `/home/node/.openclaw/media`             |

Embedded gateways also mount the same private claim's `workspace` subpath at
`/home/node/.openclaw/workspace`, the default workspace under the configured
`OPENCLAW_STATE_DIR`. This retains the workspace files attested by gateway
SQLite so a continued turn after Pod replacement does not fail with
`WorkspaceVanishedError`. Native configurations that override the workspace
path are outside this default-workspace persistence contract. Dedicated
gateways keep their existing shared workspace at `/home/node/workspace`.

A nonroot init container prepares these directories using the gateway image,
without credentials or additional privileges. The nested
`agents/main/agent/codex-home` is overmounted from Pod-local `emptyDir` so
Codex credentials remain ephemeral. The remaining private runtime home is
also ephemeral. Persisting these directories does not persist the entire home.

Each dedicated Agent additionally receives its existing `40Gi`
`ReadWriteMany` shared workspace claim. Workspace, session sharing,
generated-image exchange, and skill mounts keep their existing directional
permissions. The dedicated Harness never receives the private gateway claim.
Embedded Agents receive the private claim but do not create a shared claim.

Both claims retain exact Namespace and Agent ownership across revision
cutover and gateway Pod replacement. Reconciliation rejects foreign,
terminating, or incompatible claims without mutating them. The driver creates
the claims before their consumers and relies on gateway workload readiness;
waiting for `Bound` before creating a Pod would deadlock
`WaitForFirstConsumer` storage classes. Retiring a predecessor preserves the
current gateway and its claims. Final gateway teardown requests deletion of
its owned claims using their exact Kubernetes UIDs before deleting the
gateway; PVC protection completes deletion after Pods unmount. Agent deletion
is not currently a supported API operation.

Before the first AgentRevision, the [console credential workflow](../console.md#initial-runtime-credentials)
can create initial per-Agent transport, OpenAI API key, and Slack Secrets through
the selected Driver. It derives their names internally, checks Namespace and
Agent ownership, and creates missing whole Secrets without replacing existing
values. Provider-managed credentials and Configuration Secret bindings retain
their separate provisioning paths.

Before deploying an Agent, provision its Agent-specific transport Secret using
the configured `runtime.transportSecretPrefix`. The Secret name appends the
first 12 hexadecimal characters of `sha256(agentId)`. Token-mode gateways use
`gateway-token`; dedicated Agents additionally require `app-server-token`. When
native Configuration explicitly selects `gateway.auth.mode: "trusted-proxy"`,
the generated Secret may still contain a `gateway-token` key, but the Driver
does not project it into the gateway environment. The initial credential API also
generates `gateway-password`. The Driver projects it as `OPENCLAW_GATEWAY_PASSWORD`
only when `gateway.auth.password` explicitly uses an environment SecretRef with
that ID. This supports native local-direct password access alongside trusted-proxy
authentication; the API never returns the password. Plaintext password Configuration
is rejected.

The selected model credential determines how model access is configured:

- **API key:** Provision the Agent's model Secret using
  `runtime.modelSecretPrefix` and the `OPENAI_API_KEY` key.
- **Provider-issued access token:** The selected Provider-owned ServiceAccount Driver
  creates an account-owned Secret projected only into the dedicated Codex Pod.

If channels are enabled, configure `runtime.channels.secretPrefix` and
`runtime.channels.proxyUrl`, then provide the Agent's channel credentials in
its corresponding Secret. Channel credentials are available only to the
dedicated gateway, never to its Codex Harness.

Use an approved secret manager, protected files, or standard input when
creating Secrets. Never expose credentials in command-line arguments or logs.
Missing or incorrectly scoped credentials fail deployment.

Use `runtime.codexSeccompProfile` only for a reviewed Codex compatibility
allowlist. The optional profile exists for source-backed compatibility cases
where Codex `0.152.1` cannot start because `RuntimeDefault` denies the
user-namespace `clone`, `unshare`, and `mount` calls used by bubblewrap. It
does not relax filesystem or network policy: Codex and bubblewrap still own
runtime filesystem boundaries, while Kubernetes NetworkPolicies and the
configured runtime channel proxy own network enforcement.

See [service-account credential delivery](../service-accounts.md#provider-managed-access-tokens)
for provider-issued credentials and supported execution modes.

## Failure conditions

- **Namespace provisioning fails:** Verify tenant-local RoleBindings, namespace
  ownership labels, restricted Pod Security labels, and enforced
  NetworkPolicies. Existing namespaces additionally require external lifecycle
  ownership, exclusive tenant use, and no foreign NetworkPolicies.
- **Gateway or Harness remains pending:** Check image digests, image pull
  permissions, CPU and memory limits, namespace quotas, required Secrets, and
  workload readiness.
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

## Verification evidence

[Real Kubernetes integration](../../../tests/integration/kubernetes-compute-real.test.mjs)
exercises disposable-cluster API, RBAC, workload, reconciliation, and networking
behavior. Its HTTP fixture does not prove a real gateway or model turn.
[Harness topology integration](../../../tests/integration/harness-topology-k3d-real.test.mjs)
adds actual OpenClaw and Codex runtimes and provider responses. Required cluster,
database, runtime, and credential inputs are listed in the
[repository integration instructions](../../../AGENTS.md#running-integration-tests).
The persistence cases for both topologies require an audited gateway image that
actually stores transcripts in SQLite. They query the test conversation through
`session_nodes` and `transcript_events`, then verify its history and media
after gateway Pod replacement. An older published image that writes JSONL
transcripts cannot prove this storage path, even if it contains SQLite code
for authentication or memory. Setting `OCC_TEST_KUBERNETES_OPENCLAW_VERSION`
alone is not proof of transcript storage behavior.

Neither suite should be treated as evidence for a live production installation
without its separate deployment and runtime checks. Missing cluster or runtime
prerequisites leave the persistence proof unverified.

## Related documentation

- [Production Kubernetes deployment](../../guides/deploy.md)
- [Installation startup configuration](../configuration.md#installation-startup-configuration)
- [Configuration reference](../settings.md#kubernetes-compute-driver)
- [Service accounts](../service-accounts.md)
- [ComputeDriver contract](compute.md)
- [SandboxDriver contract](sandbox.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Controller worker](../controller.md)
- [Harness execution topology](../../flows/harness-execution-topology.md)
- [Integration-test instructions](../../../AGENTS.md#running-integration-tests)
