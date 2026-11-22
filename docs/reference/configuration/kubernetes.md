# Kubernetes Configuration storage

Use this reference to configure tenant placement and Kubernetes permissions for [Configuration resources](../configuration.md) and immutable version snapshots.

## Kubernetes placement and RBAC

`KubernetesConfigurationDriver` creates exactly one ConfigMap per Configuration
in the verified tenant namespace for its exact logical Namespace. Single-cluster
Compute shares this target with Gateway and Harness workloads, including an
operator-owned `existingNamespace`. Only the two-cluster profile uses a separate
control-cluster storage target. Wait for Namespace readiness and grant API ConfigMap access there
before creating Configuration resources. The ConfigMap remains OCC-owned.
See [namespace requirements](../drivers/kubernetes-compute/networking-and-isolation.md#namespaces-and-isolation).
Its data contains exactly one entry:

```json
{
  "data": {
    "openclaw.json": "<JSON-serialized values document>"
  }
}
```

The driver validates and parses that document when reading it; malformed JSON,
extra data entries, excessive size, or incorrect ownership fail closed. It
cannot select another tenant namespace, share tenant objects,
read Kubernetes Secrets, create Pods, or store Installation settings. ConfigMap
updates are not watched or automatically reloaded into saved AgentRevisions.
The serialized values must be smaller than 1 MiB, or a write is refused with
`400 INVALID_REQUEST` naming the limit; Kubernetes may also reject an object
that exceeds its total object limit. Reads reject invalid kind or
generation and binary ConfigMap data. Updates require a resource version and a
generation difference of exactly one; the reverse direction is reserved for OCC
rollback. Deletion checks ownership and uses the observed UID as a precondition
when available. Missing objects, conflicts, or unavailable access fail without
adopting another object.

PostgreSQL stores only server-owned Configuration metadata: its identifier,
owning Namespace, immutable kind, current generation, and creation time. The
ConfigMap in the tenant namespace carries matching kind and generation
annotations and stores only the live native configuration document in `openclaw.json`; values
are not duplicated in Configuration metadata. Deployment separately persists
its immutable version snapshot.

When Kubernetes Compute prepares a saved AgentRevision, it creates a
**separate, immutable, Agent-owned snapshot ConfigMap** containing the version's
native configuration with [Driver-owned proxy trust](../drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication)
rendered from the Installation. This rendering does not rewrite the stored
Configuration or AgentRevision. The Gateway mounts the snapshot read-only.
Compute sets `OPENCLAW_CONFIG_PATH` to `/etc/openclaw/openclaw.json` or to the path
of a [writable copy in the Pod](../drivers/kubernetes-compute/managed-native-configuration.md).
The Gateway never mounts the mutable Configuration Driver ConfigMap or receives
raw configuration through the Pod environment. When OpenClaw starts from the
read-only file, the startup wrapper also sets `OPENCLAW_CONFIG_READONLY=1`, so
OpenClaw treats the file as externally managed and does not try to write its
last-known-good backup beside it. Compute prepares a separate immutable snapshot
ConfigMap for each Agent revision. When Compute stops or replaces a revision, it
can delete that ConfigMap before Namespace deletion.

Startup validates the selected Configuration Driver's closed schema and
authentication options but does not probe tenant ConfigMaps or their RBAC:
such a preflight would require a known object or broader access. OCC validates
native Configuration semantics before calling the Driver; Drivers enforce their
backing-storage ownership and identity checks. Kubernetes namespace existence
and exact ConfigMap authorization are checked lazily on the first requested CRUD
operation. An authorized Configuration request can return `503` while a
driver-managed provisioning Namespace's Kubernetes namespace or API RoleBinding
does not yet exist; retry after provisioning and its exact grants are ready. An
explicitly selected existing Namespace instead rejects creation with `409`
until it is ready; after readiness, a missing API RoleBinding returns `503`.

Use the existing cluster-scoped namespace-observer `get`/`list` grant to
discover the exact tenant namespace. Provision tenant-data access through
namespaced ConfigMap CRUD only. Kubernetes cannot restrict `create` by
`resourceNames`; keep it in a separate namespaced rule. Scope the remaining
verbs to exact object names when those names are known:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: occ-configuration
  namespace: <tenant-storage-namespace>
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["cfg-123e4567-e89b-42d3-a456-426614174000-0123456789ab"]
    verbs: ["get", "update", "delete"]
```

The object name is illustrative; use the exact name generated by the selected
implementation. Create the RoleBinding in the tenant storage namespace. Bind this
Role only to the identity that the Configuration Driver uses. With the Helm chart,
this is normally the OCC API ServiceAccount in the installation namespace. OCC
still verifies exact Namespace placement, object naming, and ownership before
every mutation. Never add ConfigMap `list`/`watch`,
cluster-wide tenant-resource access, Secret access, or Pod-creation privileges;
the existing Namespace-only observer grant does not permit any of them.

The separately selected Kubernetes Compute Driver also requires tenant-local
ConfigMap `get`, `create`, and `patch` to prepare its immutable Agent-owned
version snapshots. Compute also needs `delete` to remove retired snapshot
ConfigMaps. Those Compute permissions and snapshots are independent of the
Configuration Driver's `cfg-*` object allowlist and CRUD identity. Keep Compute
`create` in its own namespaced rule because Kubernetes cannot scope creation by
`resourceNames`. Restrict `get`, `patch`, and `delete` to known exact Agent-owned
snapshot names when practical. These Configuration and snapshot operations do
not require Kubernetes Secret access. Secret CRUD and delivery
validation use the separately selected SecretDriver and the API's tenant-local
Secret RBAC. The separately authorized provider-managed service-account
credential path uses exact account-owned Secrets through Compute; see
[service accounts](../service-accounts.md).
