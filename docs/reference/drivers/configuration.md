# ConfigurationDriver contract

## Overview

`ConfigurationDriver` stores native Agent configuration for a specific OpenClaw
Namespace. OpenClaw Control Plane (OCC) assigns resource IDs, owns generations,
authorizes requests, and creates immutable revision snapshots. The Driver owns
the storage representation; it does not deploy Agents or authorize callers.

Trusted Installation YAML requires this capability. It defaults to bundled
Kubernetes storage; an operator can select an installed package. Default Compose
development uses filesystem storage. See [Driver selection](selection.md).

## Interface

### Operations and ownership

The [shared interface](../../../packages/contracts/src/index.ts) requires all five
core methods. Optional value validation supports Preset admission.

| Method                        | Contract                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `create(configuration)`       | Store the OCC-approved Configuration and return it with the same identity and metadata.                         |
| `read({ namespaceId, id })`   | Return only the Configuration with that ID in that Namespace.                                                   |
| `update(configuration)`       | Store the approved replacement without changing its identity or immutable metadata; return the stored resource. |
| `delete({ namespaceId, id })` | Remove only that Configuration from the backend.                                                                |
| `validate(configuration)`     | Reject a Configuration the backend cannot represent. This adds to OCC validation; it does not authorize use.    |

A Configuration has `id`, `namespaceId`, `kind`, `generation`, `values`, and
`createdAt`. The current kind is `agent`; `values` is native OpenClaw JSON. OCC
checks returned resources against its metadata. A result for another Namespace,
ID, kind, or generation cannot substitute for the requested resource.

### Optional validation

`validateValues?(values)` validates native JSON without a Configuration identity
or storage writes. OCC calls it before persisting a [Preset](../presets.md) that
contains native values, after resolving available variable defaults. Unfilled
variables remain tokens. The Driver owns native credential restrictions; OCC
owns template structure, Namespace scope, and authorization.

Bundled filesystem and Kubernetes Drivers implement this method. A Driver that
omits it still supports ordinary Configuration operations, but OCC rejects
Preset writes containing `configuration.values` with dependency unavailable.

## IAM

OCC authorizes `create` on the Namespace's Configuration collection and `read`,
`update`, or `delete` on the specific Configuration. Binding a Secret requires
separate authorization on that Secret. Backend access does not grant platform
permissions; a Driver cannot bypass resource ownership or deletion rules. Put
credential references in the supported [Secret binding](../configuration/secrets.md)
fields instead of treating Configuration storage as a secret store. See
[authorization](../authorization.md).

## Lifecycle

Startup creates the selected Driver and validates its configuration. The shared
interface has no startup or disposal method. Resource operations begin when OCC
accepts a request; shutting down the process does not delete configurations.

OCC starts new configurations at generation 1 and checks generation before
accepting a replacement. It reads and retains the prior document during an
update or deletion so it can attempt to restore it on transaction rollback; after
a create it registers deletion for rollback. OCC refuses deletion while an Agent
still references the Configuration. This is not permission for callers to roll
back generations themselves. See the [persistence flow](../../flows/configuration-driver/persistence-and-revisions.md).

Deployment reads the selected Configuration and freezes the effective values in
the AgentRevision. Later storage updates or deletion cannot change that revision.

## Limits

- The current resource kind is `agent`. This Driver does not select Harnesses,
  restart workloads, or update previously admitted revisions.
- A backend can reject values it cannot represent. Size, storage permissions, and
  conflict behavior specific to Kubernetes are documented in [Kubernetes Configuration storage](../configuration/kubernetes.md).
- Installed packages must implement all five methods and provide their own closed
  startup schema; selecting a different backend is not a data-migration contract.

## Troubleshooting

| Symptom                                     | What to check                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A read fails or returns an invalid resource | Check Namespace, ID, kind, and generation against OCC metadata; verify the selected backend can read the owned document. Do not adopt another object.                        |
| An update conflicts                         | Reload the current generation and resubmit the intended change. If an OCC transaction failed, check the backend before retrying because restoration can fail independently.  |
| Deletion is rejected                        | Find the Agent that still references the Configuration and change that reference through OCC before retrying.                                                                |
| Storage is unavailable                      | Check selected-Driver startup settings, backend availability, and resource permissions. For Kubernetes use the [storage and RBAC reference](../configuration/kubernetes.md). |

## Implementations

### Bundled implementations

- [Kubernetes Configuration storage](../configuration/kubernetes.md): default for
  trusted YAML; one OCC-owned ConfigMap per Configuration in the tenant Namespace. Its [implementation](../../../apps/controller/src/drivers/configuration/kubernetes/index.ts)
  validates ownership and storage before use.
- [Filesystem development Driver](../../../apps/controller/src/drivers/configuration/filesystem/index.ts): default Compose storage beneath `OCC_DEVELOPMENT_CONFIGURATION_ROOT`, persisted in a controller-only named volume. It writes through a private temporary file; directories use `0700` and files `0600`. It validates safe IDs; OCC still validates the document.

## Related

- [Configuration resource](../configuration.md), [settings](../settings.md), and [deployment](../../guides/deploy.md)
- [Configuration execution flow](../../flows/configuration-driver.md)
- [OCC resource operations](../../../packages/occ/src/index.ts)
