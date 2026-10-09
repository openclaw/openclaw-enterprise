# Configuration persistence and revision snapshots

Follow Configuration storage transactions into immutable Agent revision admission. See the [parent flow](../configuration-driver.md) for its context and overall sequence.

## Execution trace

### 4. Lock metadata and invoke the selected Configuration Driver

`apps/controller/src/drivers/configuration/kubernetes/index.ts:KubernetesConfigurationDriver.create`

Configuration ownership, immutable `kind: "agent"`, generation, creation time,
normalized Secret bindings, and server-generated `cfg_` identity are persisted by
[PostgreSQL platform state](../../../packages/occ/src/state/postgres-state.ts);
the live configuration document is not duplicated into Configuration metadata.
OCC owns API-level native Configuration validation before it calls the selected
bundled or installed Configuration Driver: model provider settings, and
`requireDeployableRoster` in
[the roster rules](../../../packages/occ/src/openclaw-roster.ts), which refuses
an `agents` roster every deployment refuses with deployment's own text. The Driver owns backing document
storage and checks storage-specific identity and ownership. When the bundled
Kubernetes implementation is selected, `KubernetesConfigurationDriver` in
[the Kubernetes Configuration implementation](../../../apps/controller/src/drivers/configuration/kubernetes/index.ts)
validates its storage envelope, discovers its exact tenant-labeled Kubernetes
namespace using the existing cluster-scoped namespace-observer `get`/`list`
grant, and derives its deterministic ConfigMap name. For an externally owned
namespace explicitly selected by `existingNamespace`, the Compute worker first
binds its tenant identity during provisioning; Configuration creation returns
`409` until that explicitly external platform Namespace is `ready`. It then
checks object
ownership labels, kind/generation annotations, and creation time. Each ConfigMap
has exactly one data entry: `openclaw.json`, containing the serialized native
configuration document and its unresolved inline SecretRefs. Kubernetes driver
reads reject malformed stored objects, extra entries, and oversized documents.
Create calls
`createNamespacedConfigMap`, read calls `readNamespacedConfigMap`, replace calls
`replaceNamespacedConfigMap` with the observed `resourceVersion`, and delete
calls `deleteNamespacedConfigMap` with the observed object identity when
available. Creation starts at generation `1`; each successful PATCH replaces
the entire native document and advances the generation exactly once. Metadata
and ConfigMap updates share OCC's existing transactional/compensating boundary;
create, update and delete register their compensation before the write, so a write
that applied but answered an error is undone as well. A failed create deletes only
the exact Configuration `inspectExact` finds, a failed delete recreates the previous
one only when it is gone, and a failed update restores the stored generation. When
that check cannot read the backend, the request fails as a rollback failure (503).
A Driver without `inspectExact`, such as the filesystem development Driver, compensates
only a write it saw succeed. Compensations run after the failed transaction released
its row locks, so delete and update compensations first re-read the metadata row and
act only while it is unchanged: a Configuration another request deleted or updated
in the meantime is left as that request committed it. If that re-read fails, the
compensation proceeds as before. A write still in flight, or
another change that lands between that re-read and the compensation, is not covered.
A referenced Configuration cannot be deleted. Tenant child-data access remains
limited to namespaced ConfigMap `create`, `get`, `update`, and `delete`;
Kubernetes cannot restrict `create` by `resourceNames`, so that verb must use
its own namespaced Role rule. ConfigMap `list`/`watch`, Secrets, Pods, and
cluster-wide tenant-resource access remain unavailable.

Startup validates the bundled Kubernetes Configuration Driver's authentication
configuration but does not probe tenant ConfigMaps or ConfigMap RBAC. Its first
exact CRUD call checks actual tenant namespace existence and authorization; a
driver-managed provisioning Namespace can return `503` until its Kubernetes
namespace and API RoleBinding are ready. Explicitly selected external Namespaces
instead reject Configuration creation with `409` before readiness; after
readiness, a missing API RoleBinding returns `503`. The development filesystem
Driver persists OCC-validated
documents under the configured root and checks only server-generated file
ownership. Installed implementations validate and use their own backing-storage
prerequisites.

### 5. Resolve the Agent reference and freeze an immutable revision

`packages/occ/src/index.ts:OpenClawController.deployAgent`

`createAgent` and `updateAgent` in
[OCC](../../../packages/occ/src/index.ts) separately authorize and verify the
Agent's exact same-Namespace `configurationId` and ensure its Configuration kind
is `"agent"`. `deployAgent` then locks the Agent, authorizes a read of the
referenced Configuration, and locks its ownership metadata. It authorizes the
caller's selected Secret bindings and the Agent service principal's consumption,
checks topology/model-source compatibility, and asks the selected Secret Driver
to verify each backend reference. This resolves backend identity, not credential
bytes or inline SecretRefs.

Next OCC reads the selected Configuration Driver's stored document. For the
bundled Kubernetes Driver, that document is the `openclaw.json` ConfigMap entry.
When the selected Sandbox Driver exposes `configureAgent`, OCC transforms a
frozen copy before Configuration Driver validation and Harness selection. The
stored reusable Configuration and its generation remain unchanged. Compute then
checks the Harness authentication binding (Kubernetes Compute also runs the shared
`requireOpenClawRoster`, then the dedicated OpenClaw and Codex `main` Agent rules) and, through optional
`validateGatewaySettings`, the native gateway settings: Kubernetes Compute refuses
a setting every preparation would refuse with `409`, naming the setting and never
its value, before a revision exists. OCC freezes
the admitted values, including any remaining inline unresolved SecretRefs, into
`AgentRevision.configuration`; separate `configurationId`, `configurationKind`,
and `configurationGeneration` fields pin the selected Configuration metadata.
The revision also pins the selected OpenClaw or Codex Harness descriptor,
execution mode, Compute identity, optional Sandbox identity, Agent service
principal, and any selected Secret Driver identity and normalized bindings.
Backend locators and value bytes are not stored in the revision. Subsequent nested
Configuration edits increment its generation but affect only later explicit
deployments; historical revisions and their admitted snapshots remain unchanged.
PostgreSQL enforces the supported kind, positive generation, exact admitted
snapshot shape, ownership, and revision immutability. OCC records an
attributable sanitized admission event and hands the immutable revision to
Compute-owned reconciliation without resolving credential bytes or starting a
gateway during HTTP admission. A development worker can subsequently create or
reuse exactly one gateway for the owning Agent during revision preparation.
When Kubernetes Compute owns that gateway, it creates a distinct immutable,
Agent-owned ConfigMap from the admitted configuration and mounts it
read-only at `OPENCLAW_CONFIG_PATH=/etc/openclaw/openclaw.json`. The gateway
wrapper (`GATEWAY_RUNTIME_ENTRYPOINT` in `kubernetes/runtime-entrypoints.ts`)
starts OpenClaw with `OPENCLAW_CONFIG_READONLY=1` whenever that file's directory
is not writable, so OpenClaw skips its last-known-good backup. It never mounts
the mutable Configuration Driver ConfigMap; each changed admitted generation
selects a new immutable snapshot and rolls the stable Agent gateway. Previous
snapshots remain until Namespace deletion because earlier Pods may still mount
them; safe earlier cleanup is deferred. Production workers also reconcile
embedded OpenClaw and dedicated Codex Agent revisions, connecting each
Agent-owned gateway only to its own active workload.

## Related

- [Return to the parent flow](../configuration-driver.md).
