# Programmatic settings

This reference owns programmatic settings. Start with the
[settings reference](../settings.md) for startup configuration and precedence.

## Programmatic configuration

The following options are TypeScript integration seams. They are not
environment variables, public API parameters, or operator configuration.

### Controller and admission

[`ControllerOptions`](../../../packages/occ/src/index.ts) can inject an authorization
callback, clock, resource-ID generator, `PlatformStateStore`, and
`recordOperations` flag. Its optional `defaultPresets` list contains generic
name/template definitions; application composition owns loading bundled native
templates from the Installation setting. The supported development and production paths use
PostgreSQL composition with `recordOperations: true`.

[`ControllerAppOptions`](../../../apps/controller/src/index.ts) supplies the existing
controller or controller factory, selected IAM and optional Compute Drivers,
audit sink, required controller auth, optional audit factory, and optional
positive request-body limit.

[`ControllerAuthOptions`](../../../apps/controller/src/auth/index.ts) requires an
explicit runtime mode, Installation ID, Better Auth base URL, high-entropy
secret, and either memory or PostgreSQL-backed Better Auth storage. Development
can use insecure cookies for loopback; production uses secure cookies.

[`NativeIAMDriverOptions`](../../../packages/iam/src/index.ts) accepts an optional
nonempty Driver `id` and `implementation`. Its standalone defaults are
`occ-native-iam` and `native`; application compositions choose their own Driver
IDs selected by their composition. The Driver reads current policy from controller-owned
platform state for each identity lookup and authorization decision.

[`PostgresPlatformStateOptions`](../../../packages/occ/src/state/postgres-state.ts)
accepts optional bootstrap native IAM policy. Groups, memberships, Roles,
bindings, and deny-only Restrictions are persisted policy data, not
environment-configurable authorization rules.

[`InMemoryPlatformStateOptions`](../../../packages/occ/src/state/platform-state.ts)
accepts an optional transactional audit sink.

[`AuditEventFactoryOptions`](../../../packages/audit/src/index.ts) accepts an optional
clock and audit-ID generator; their defaults are the current time and a new
`aud_`-prefixed UUID.

### Kubernetes Compute Driver

[`KubernetesComputeDriver` and `createKubernetesComputeDriver`](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
accept an explicit `authentication` mode
(`"inCluster"` or `"kubeconfig"`); approved `images` and immutable-image
policy; explicit gateway, Agent, and namespace `resources`; exact DNS and
either private `gatewayRouting` or direct gateway-client `network` peers;
required `network.gatewayTrustedProxyCidrs`;
`servicePrincipalCredentials` policy; and an
explicit production `runtime` containing per-Agent operator-provisioned
the transport Secret-name prefix and required
`gatewayStorageClassName` selecting the StorageClass for each gateway's private
disk, not its shared workspace. The operator must verify the backing disk's
filesystem locking and durability guarantees.
The Codex port and volume sizes are driver-owned constants; see the
[storage contract](../drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).
Production currently permits temporary Agent public TCP/443 egress until a
restricted model proxy exists. Every tenant gateway Deployment
has exactly one replica because the OpenClaw gateway does not support multiple
replicas. The kubeconfig mode requires both an explicit file and named context;
in-cluster mode uses the controller's ServiceAccount. The driver never selects
the ambient kubeconfig or context. Driver options do not accept injected
Kubernetes clients or bypass selected credentials, HTTPS, or TLS verification.

Production persists the exact Compute Driver ID and implementation selected by
the startup YAML, such as `compute-kubernetes` / `occ/kubernetes`. Existing
direct development constructors retain their own local default identities.
Neither identity restricts verified cluster authentication or Kubernetes API
endpoints to local-only access.

Production API and worker entrypoints both load the same explicit
`drivers.compute.configuration` section
from the Installation startup YAML at `OCC_CONFIG_PATH`; each resolves the
bootstrapped singleton Installation internally. Development callers may
also pass the driver programmatically to
`composePostgresDevelopment(config, { computeDriver })`. The selected
driver preserves tenant-local RBAC boundaries, enforced NetworkPolicies,
hardened workloads, and projected Agent ServicePrincipal tokens. When the
explicit production runtime is enabled, it routes dedicated Codex or combined
embedded OpenClaw Agents only after their exact revisions become active. Each
production Harness receives only its own Agent's projected identity and
operator-owned model key. See the
[Kubernetes Compute Driver guide](../drivers/kubernetes-compute.md) for the exact options,
installation prerequisites, and k3d verification.

### SSH Compute Driver

[`SshComputeDriver` and `createSshComputeDriver`](../../../apps/controller/src/drivers/compute/ssh/index.ts)
accept `ssh`, a `hosts` map keyed by exact Namespace name, `runtime`, and
`network.gatewayPortRange` as documented in the
[SSH reference](../drivers/ssh-compute.md#requirements-and-configuration). The
closed static schema and `validateConfiguration` reject unknown keys, unsafe
paths, non-root SSH users, and invalid ports/ranges. `runtime.user` is the prefix
for Driver-managed per-Agent system users and private groups, rather than an
existing shared gateway account. The Driver refuses to adopt unowned accounts.

The optional constructor/factory `selection` accepts `id`, `implementation`,
`lifecycleDrivers`, and the internal `SshCommandExecutor` transport seam.
Defaults are `compute-ssh` and `occ/ssh`. Installation YAML cannot inject an
executor or lifecycle owners. Production selection skips Kubernetes-only
Compute configuration checks, retains the required Secret selection, and
rejects `drivers.sandbox`. `preflight` probes configured hosts; `bindAgent`
captures server-owned Namespace and ServicePrincipal identity before revisions.
There is no gateway endpoint resolver or periodic runtime maintenance.

### Kubernetes Configuration Driver

The selected Kubernetes Configuration Driver stores Namespace-owned native
OpenClaw configuration documents. It maps each
Configuration to one ConfigMap in the Kubernetes namespace selected by OCC for
that exact tenant, with exactly one `openclaw.json` data entry. Nested values
and canonical inline SecretRefs retain their original structure; references
remain unresolved. Installation settings and Driver options remain in startup
YAML; ConfigMaps do not store Installation configuration. Its
namespaced Kubernetes Role requires only ConfigMap `create`, `get`, `update`,
and `delete`.

Each selected Driver exposes its closed configuration schema and validates its
own startup settings before OCC constructs the implementation. API operations
are authorized against their exact Namespace or Configuration, OCC validates
native Configuration semantics, and deployment deeply snapshots the complete
document into immutable AgentRevisions. See
[Namespace configuration](../configuration.md) for CRUD, exact permissions,
minimal RBAC, startup validation, revision safety, and troubleshooting.
Configuration Driver Kubernetes access is checked lazily during the first exact
CRUD request, not by startup preflight; a provisioning Namespace without its
Kubernetes namespace or tenant grant may return `503` until infrastructure is
ready.

### Durable controller-work queue

[`PostgresWorkQueueOptions`](../../../packages/occ/src/state/postgres-work-queue.ts)
accepts these constructor options:

| Option             | Default       | Constraint                                        |
| ------------------ | ------------- | ------------------------------------------------- |
| `maxAttempts`      | `10`          | Positive safe integer.                            |
| `leaseDurationMs`  | `60000`       | Positive safe integer, expressed in milliseconds. |
| `claimRaceRetries` | `3`           | Positive safe integer.                            |
| `random`           | `Math.random` | Function returning a finite number in `[0, 1)`.   |
| `workKind`         | `all`         | `all` or `namespace`; production uses `all`.      |

Retry backoff starts at `1000 ms`, is capped at `300000 ms`, and includes the
configured jitter source. Stale-claim recovery defaults to `100` rows and
rejects limits above `1000`. The worker overrides the queue's standalone
`maxAttempts` and `leaseDurationMs` defaults through its
[environment settings](operations.md#controller-worker-environment). Development and
production workers consume Namespace work and selected AgentRevision work
through the configured bundled or installed Compute Driver. The bundled
Kubernetes Driver activates approved embedded OpenClaw and dedicated Codex
revisions. Pending Namespace convergence
returns the live claim
to the queue without consuming a failure attempt and remains bounded by
`OCC_WORKER_CONVERGENCE_TIMEOUT_MS`.
Retry backoff, queue jitter, claim-race retries, and stale-recovery limits have
no environment-variable overrides.
