# Namespaces

A Namespace is an isolated environment for a team, tenant, or workload. It owns
its [Agents](agents.md), [service accounts](service-accounts.md), their
identities, and their access rules. Resources in one Namespace cannot be
discovered, changed, or used from another Namespace. See the
[IAM overview](../guides/topics/iam.md) for how access is granted.

Each OpenClaw Enterprise deployment has one Installation and can contain
multiple Namespaces:

```text
Installation
├── Namespace: support
│   ├── Agent: ticket-triage
│   └── Agent: customer-help
└── Namespace: research
    └── Agent: document-search
```

The Installation is selected by the server. You never provide an Installation
ID when creating a Namespace or accessing its Agents.

## Initial Namespace

Fresh Installation bootstrap creates one platform Namespace named `default`
with a server-assigned ID. It uses the ordinary Namespace creation path,
authorizes `create` for the bootstrap Principal through the selected IAM
Driver, and queues reconciliation in the same transaction as Installation
state and bootstrap audit. The worker provisions it through the selected
Compute Driver and transitions it from `provisioning` to `ready`. Bootstrap
success does not imply infrastructure readiness.

Use `GET /namespaces` to discover the ID. The name does not select Kubernetes'
built-in `default` namespace or an `existingNamespace`; normal Driver placement
and tenant permissions still apply. No Agent is created.

Repeated initializer runs preserve existing Namespaces and their resources.
They do not backfill an existing Installation, recreate a deleted Namespace,
or overwrite configuration. Additional named Namespaces remain available
through `POST /namespaces`.

In the console, open **Namespaces → Create Namespace**, enter a unique name,
and submit. The confirmation offers **Open Agents** for the new scope;
provisioning continues asynchronously. See the
[console workflow](../guides/console/create-namespace.md) for permissions and
creation recovery.

## Ownership and supported operations

The server assigns the Namespace's identifier and Installation ownership.
Creation requires Namespace `create` in the Installation. Reads and deletion
require the corresponding permission on the exact Namespace. Namespace lists
authorize each result separately; permission to access one Namespace does not
reveal another. [Authorization](authorization.md) defines scope and grants.

`POST /namespaces` accepts a name and returns `201` with a Namespace in
`provisioning` status. `GET /namespaces` lists authorized Namespaces;
`GET /namespaces/:namespaceId` reads one exact Namespace. The
[API reference](api.md) owns request schemas and response envelopes.

For the bundled Kubernetes Compute Driver, a representative creation body is:

```json
{
  "name": "support",
  "existingNamespace": "customer-support-prod"
}
```

The optional `existingNamespace` requires both Namespace creation and
Installation `administer` authorization. The selected name is persisted and
returned in the Namespace response. The worker verifies and binds that exact
operator-prepared Kubernetes namespace without adopting another tenant's
resources. Its external lifecycle, restricted Pod Security labels, and
tenant-local RoleBindings must already be in place; see
[Kubernetes namespace requirements](drivers/kubernetes-compute/networking-and-isolation.md#namespaces-and-isolation).
Docker and external Compute Drivers reject this option with
`409`; ordinary creation without the option remains supported. Creating a
Configuration in an explicitly selected external Namespace returns
`409 NAMESPACE_NOT_READY` until worker provisioning completes. Deleting the
OCC Namespace leaves its tenant markers on the Kubernetes namespace, so
selecting that namespace again ends `failed` until an operator clears them; see
[Namespace admission](security.md#namespace-admission-and-resource-isolation).

The API reports `failed` without a cause. Check the worker's `worker.completed`
line for `namespace.ensure`. It includes a `reason` when the Kubernetes Compute
Driver supplies one. For example, `Existing Kubernetes namespace customer-support belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.`
The message identifies the blocking marker's key and keeps the other tenant's value private.

A provisioning timeout alone does not identify the cause. See
[Kubernetes troubleshooting](drivers/kubernetes-compute.md#failure-conditions).
If the worker service account lacks its tenant runtime RoleBinding, restore it in
the backing Kubernetes namespace while the Namespace is still `provisioning`.
A later pass can then check readiness. Once the Namespace reaches `failed`,
there is no supported way to retry provisioning for that Namespace. Rechecking
in the Console reads its current status.

## Lifecycle

| Status         | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `provisioning` | The Namespace exists, but its required runtime infrastructure is not ready. |
| `ready`        | Its backing Namespace infrastructure has reported ready.                    |
| `failed`       | Provisioning encountered a permanent failure.                               |
| `deleting`     | Authorized deletion has started; new Agents and deployments are rejected.   |

The OpenClaw Controller owns these transitions. Its selected Compute Driver
reports infrastructure readiness, but does not choose whether a Namespace is
ready. An Agent can be created while its Namespace is `provisioning`; deploying
an Agent requires the Namespace to be `ready`.

The console's **Agents** page and **Create Agent** name a Namespace that is not
`ready`. A `provisioning` Namespace keeps **Create Agent** for drafts that need no
new Secret or sign-in. A `failed` or `deleting` Namespace, or a `provisioning` one
with `existingNamespace` (no Configuration until `ready`), disables it with the
reason. A status change rebuilds a retained Agents or Create Agent view. With no
URL selection, the console picks a `ready` Namespace first and skips `deleting`
ones while another remains.

The separate [controller worker](controller.md) processes Namespace lifecycle
work when the API uses PostgreSQL. Compose starts it after initialization and
API readiness; host-process debugging starts it independently because the API does
not embed the worker. Its default PostgreSQL-backed development Compute Driver
creates one Docker network per Namespace. An explicitly selected
[Kubernetes Compute Driver](drivers/kubernetes-compute.md) instead provisions
and verifies real tenant infrastructure in a driver-created namespace or the
exact dedicated existing namespace selected by `existingNamespace`; see the
[Kubernetes deployment guide](../guides/deploy.md).

## Deletion and tombstones

`DELETE /namespaces/:namespaceId` starts deletion of an empty Namespace.

The Console exposes this operation through each Namespace row's trash icon.
See [Delete a Namespace in the console](../guides/console/delete-namespace.md).

A successful request returns `202` and the Namespace with `status: "deleting"`.
Repeating the request while teardown is in progress changes nothing.
After teardown completes, the controller retains a durable internal tombstone;
the Namespace disappears from list results and direct reads return `404`.
`deleted` is not a public Namespace status. The tombstone keeps the Namespace's
name reserved: creating a Namespace with that name returns
`409 RESOURCE_CONFLICT` saying the name belongs to a deleted Namespace and
cannot be reused; choose a new name.

Deleting a tenant preserves its discovered, operator-owned Kubernetes namespace
and external resources, removing only OCC-owned infrastructure. Driver-owned
Kubernetes namespaces are deleted normally.

A Namespace containing any Agent, Configuration, Preset, service account, Secret,
or [credential source](credential-sources.md) cannot be deleted and returns
`409 NAMESPACE_NOT_EMPTY`. The error message lists the kinds that remain and
the IDs of their resources, as far as the 256-character message
allows; a kind with more says how many are left. The error also includes
`remainingResources`: up to seven entries with `kind`, `count`, and up to 20
`ids` each. Pending Agent provisioning has no resource IDs. Configurations have
no list route, so the deletion conflict provides their IDs. Namespace `delete`
does not grant reads: of the first 20 resources of each kind, the conflict
names only those that you can read, and it counts the others without IDs. Delete
unreferenced Agents, Configurations, [Presets](presets.md), service accounts,
Secrets, and credential sources before deleting their Namespace. A credential
source in `deleting` still counts; retry its deletion until it disappears.
Installation default Presets that still match their seeded template do not
block deletion: the request deletes them (this needs `preset:delete`) and
audits each one. A renamed or edited default counts as a Preset; delete it with
`DELETE /namespaces/:namespaceId/presets/:presetId`.
Agent deletion is asynchronous; wait until each deleted Agent disappears from
reads before retrying Namespace deletion.

## Isolation and gateways

Each Agent belongs to exactly one Namespace. Its API path includes the owning
Namespace, and a different Namespace cannot use that Agent ID to bypass
authorization or ownership checks.

Each deployed Agent owns exactly one gateway, created with its workload and
reused across its versions. A Namespace can therefore contain zero gateways
before deployment or multiple gateways for different Agents; Namespace
readiness does not depend on a gateway. When explicitly selected, the
Kubernetes Compute Driver uses one isolated Kubernetes namespace and,
for each deployed Agent, one gateway Deployment, ClusterIP Service, and
ServiceAccount. Each gateway Deployment specifies exactly one replica and has
one Pod in steady state; multiple replicas are unsupported. There is no
independently selected Gateway Driver. The default development server and worker
do not enable the Kubernetes driver automatically. Production workers process
Namespace operations and both embedded OpenClaw and dedicated Codex
AgentRevisions, activating only the exact Agent-owned gateway route after its
workload is ready.

## Failure semantics and limitations

- `401`: The session cookie or service API key is missing, invalid, expired,
  or revoked.
- `403`: Your identity does not have permission for the exact Namespace
  operation.
- `404`: The Namespace does not exist, belongs outside the requested scope, or
  has already been tombstoned.
- `409 NAMESPACE_NOT_EMPTY`: The message names what remains, with the IDs
  that you can read. Delete the named resources and retry to see any others. Remove the
  Namespace's unreferenced Agents, Configurations, edited or custom Presets,
  service accounts, Secrets, and credential sources before deletion. An Agent
  whose teardown is still in progress, or a credential source in `deleting`,
  continues to make the Namespace nonempty.
- Without an eligible [controller worker](controller.md) against the same
  PostgreSQL database, lifecycle work remains queued and the Namespace can stay
  `provisioning` or `deleting`. Infrastructure readiness is asynchronous.
- Teardown that fails permanently, exhausts its retries, or misses the worker's
  convergence deadline leaves the Namespace `deleting`. Correct the cause, for
  example a stuck Kubernetes finalizer, then have the caller who started
  deletion repeat `DELETE`. That requeues the teardown and adds an audit event.
  Another caller receives `403` while the initiator still holds delete
  permission; once it lost permission (for example, it was offboarded), another
  permitted caller takes over as the work's actor, audited as `takeover`. The
  original deadline still applies, so the retried pass succeeds only once the
  Compute namespace is gone.

## Related

- [Quickstart](../guides/quickstart.md)
- [Development and production deployment](../guides/deploy.md)
- [Agents](agents.md)
- [Service accounts](service-accounts.md)
- [Controller worker](controller.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [IAM](authorization.md)
- [Controller configuration](settings.md)
- [Platform architecture](../design.md)
- [Namespace lifecycle implementation](../../packages/occ/src/index.ts)
- [Local testing](../testing/local.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-18 21:10: The console names a Namespace's status where Agent creation starts and disables creation only where the API refuses new Agents. (ux-a5)
- 2026-10-06 18:55: The worker log names why a Namespace failed; the API still does not. (fix-d521)
- 2026-10-06 18:40: Note that a reused existing namespace fails until its old tenant markers are cleared, that `failed` carries no reason, and that `401` covers service API keys. (dogfood-r38)

- 2026-09-01 14:51: Document initial default Namespace creation and unchanged repeat-bootstrap behavior. (codex/01a05ef1-ee29-7941-80f2-448bb0789969 - 872fa544c98bb7ad11b2d92d777e49229ececbf5)

- [2026-08-28 17:55]: Recast Namespace ownership, operations, lifecycle, and deletion as current feature reference. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
