# SecretDriver contract

## Overview

`SecretDriver` stores secret values for an OpenClaw Namespace and validates the
backend references used to deliver them. OpenClaw Control Plane (OCC) owns the
Secret ID, Namespace, authorization, references, and public metadata. The Driver
owns backend storage and must verify that stored material still belongs to the
requested Secret. Compute handles workload delivery; this Driver does not issue
credentials or return secret values to API readers.

Trusted Installation YAML requires the bundled Kubernetes implementation,
including when Compute is SSH; delivery to SSH hosts is unsupported. Default
Compose without Installation YAML selects no Secret Driver. See
[Driver selection](selection.md) and the [Kubernetes implementation](kubernetes-secret.md).

## Interface

The [shared interface](../../../packages/contracts/src/index.ts) requires all
four methods; it has no value-read or optional Secret-specific method.

| Method                    | Contract                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `create(identity, value)` | Store the value for OCC's `{ id, namespaceId, name }` and return a safe backend reference.                                          |
| `update(secret, value)`   | Replace the value at the stored, owned backend identity. Returns no value and does not report delivery.                             |
| `delete(secret)`          | Remove only the backend object belonging to this Secret. Returns no value.                                                          |
| `resolve(secret)`         | Check live ownership and return only the reference safe to use for projection. Never return the value or substitute another object. |

The current `SecretBackendRef` contains `namespaceName`, `name`, `key`, and
`uid`; these are internal metadata, never caller-selected locations. The public
`SecretMetadata` contains only `id`, `namespaceId`, `name`, and a platform `ref`.
OCC rejects empty values, NUL, invalid text, and values above 65,536 UTF-8 bytes.

## IAM

OCC authorizes creation and listing on the Namespace's Secret collection.
`GET /namespaces/:namespaceId/secrets` requires collection `read` and returns
only Secrets on which the caller also has exact-resource `read`. An empty list
means no readable Secrets. Exact Secret reads, updates, and deletion require
`read`, `update`, and `delete`, respectively. Reads return metadata from OCC;
they do not call the Driver or return a value. Binding or assigning a Secret
also requires the caller to have `operate` on it. Deployment requires both the
deploying actor and the consuming Agent's ServicePrincipal to have `operate` on
each Secret; the worker rechecks them before preparing delivery. Namespace
membership, possession of a reference, and backend permissions grant no OCC
authority. Cross-Namespace bindings are rejected.

Never expose values in responses, configuration documents, audit, or logs.
Backend permissions and encryption remain the operator's responsibility. See
[Secret binding permissions](../configuration/secrets.md) and [authorization](../authorization.md).

## Lifecycle

Startup constructs the selected Driver from trusted configuration. The shared
interface has no initializer or destructor; process shutdown does not delete
Secrets. OCC requires a ready Namespace for creation and updates; the current
projection path also requires the tenant infrastructure to be ready.

On creation, the Driver writes the value and OCC stores the returned identity.
OCC registers backend deletion for a known failed transaction; it does not do
so when the commit outcome is unknown. Updates overwrite the backend value: OCC
keeps no prior value for rollback, and success means stored, not delivered.
Deletion is refused while a Configuration, active revision, or pending
deployment still references the Secret. Otherwise OCC calls the Driver before
removing its own record.

During deployment admission, the API asks `resolve` to verify that the current
backend identity still matches OCC's record. The revision pins the Driver ID
and normalized binding, not the backend locator or secret bytes. The worker
later rechecks permissions and loads current OCC metadata; it does not call the
Secret Driver. Compute receives a temporary delivery reference. In the current
Kubernetes implementation, gateway bindings go only to the selected gateways;
model API keys go only to the Harness that executes the model.

## Limits

- No value reads, version history, rollback, credential issuance, or per-access
  brokering. The supported delivery mechanism is environment projection.
- Updating a Secret does not restart workloads. Redeploy or restart consumers
  before expecting a new value to appear in their environment.
- Kubernetes is the only selectable implementation. Arbitrary installed Secret
  packages and SSH delivery are unsupported; selection alone does not enable them.

## Troubleshooting

| Symptom                                 | What to check                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation or update fails before storage | Confirm the Namespace is ready and the input meets the size and text rules.                                                                                             |
| Binding or deployment is denied         | Check the caller's exact Secret grant and, for deployment, the Agent ServicePrincipal's `operate` grant. Backend RBAC cannot replace either.                            |
| A Secret cannot be resolved             | Check the selected Driver, backend availability, and whether the original owned object still matches OCC's identity. Do not point OCC to a replacement object manually. |
| Updated credentials are not visible     | Restart or redeploy the consuming workload and verify the new process became active; updating storage does not refresh existing environments.                           |
| Deletion is rejected                    | Remove Configuration and deployment references through OCC before retrying.                                                                                             |

## Implementations

- [Kubernetes Secret Driver](kubernetes-secret.md): backend configuration,
  Kubernetes permissions, operator procedures, and diagnostics.

## Related

- [Agent Harness authentication](../agents.md#harness-authentication) and [Configuration Secret bindings](../configuration/secrets.md)
- [Secret storage and delivery flow](../../flows/secret-storage-and-delivery.md)
- [OCC Secret operations](../../../packages/occ/src/index.ts) and [worker delivery](../../../apps/controller/src/worker.ts)
