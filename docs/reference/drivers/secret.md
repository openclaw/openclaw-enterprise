---
kind: reference/driver
---

# SecretDriver contract

## Overview

`SecretDriver` stores secret values for an OpenClaw Namespace and validates the
backend references used to deliver them. OpenClaw Control Plane (OCC) owns the
Secret ID, Namespace, authorization, references, and public metadata. The Driver
owns backend storage and must verify that stored material still belongs to the
requested Secret. Compute delivers workload projections. OCC returns only Secret
metadata to API readers. Trusted server-side operations can read the current
value through the selected Secret Driver.

Trusted Installation YAML requires the bundled Kubernetes implementation,
including when Compute is SSH; delivery to SSH hosts is unsupported. Default
Compose without Installation YAML selects no Secret Driver. See
[Driver selection](selection.md) and the [Kubernetes implementation](kubernetes-secret.md).

## Interface

The [shared interface](../../../packages/contracts/src/drivers/secret/index.ts) requires four
storage and projection methods and optionally supports transient server-side use.

| Method                                    | Contract                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `create(identity, value)`                 | Store the value for OCC's `{ id, namespaceId, name }` and return a safe backend reference.                                          |
| `update(secret, value)`                   | Replace the value at the stored, owned backend identity. Returns no value and does not report delivery.                             |
| `delete(secret)`                          | Remove only the backend object belonging to this Secret. Returns no value.                                                          |
| `resolve(secret)`                         | Check live ownership and return only the reference safe to use for projection. Never return the value or substitute another object. |
| `compareAndSwap(secret, expected, value)` | Optional. Replace the value only if it matches the expected value. Return false on mismatch.                                        |
| `withValue(secret, use)`                  | Optional. Verify ownership, pass the current value to the trusted callback, and return its result.                                  |
| `readCredentialInput(input)`              | Optional. Required for protected static sources. Read the authoritative value and its version from the owned Secret.                |

The current `SecretBackendRef` contains `namespaceName`, `name`, `key`, and
`uid`; these are internal metadata, never caller-selected locations. The public
`SecretMetadata` contains only `id`, `namespaceId`, `name`, and a platform `ref`.
OCC rejects empty values, NUL, invalid text, and values above 65,536 UTF-8 bytes.

OCC uses `withValue` for trusted operations that need the current Namespace
Secret, such as Channel credential validation and directory lookup. Managed
model and Plugin credentials use the separate TokenService custody path.

For `readCredentialInput`, [`CredentialInputRead`](../../../packages/contracts/src/drivers/credential-proxy/index.ts)
supplies the stored `secret`, `retention: "none"`, and a `lifetime`. Honor its
`signal` and absolute `deadlineAt` across backend calls and retries. Return a
`VersionedSecretValue` with `value`, `version`, `authoritativeObservedAt`, and
optional `expiresAt`. Read each value from the authoritative store without
caching it. Kubernetes verifies the stored UID and returns the object's
`resourceVersion` as the version.

The optional `privateSecrets` store holds [TokenService Sources](../credential-sources.md) and [credential client secrets](../connection-templates.md). OCC supplies the Installation ID and an opaque address for the resource and its owner. The Driver creates, replaces, reads and deletes that value. Compare-and-swap fences OAuth grant replacement. An absent value counts as deleted, so the Worker can finish an interrupted retirement. Namespace Secret APIs and workload projections cannot access this material.

## IAM

OCC authorizes creation on the Namespace's Secret collection.
`GET /namespaces/:namespaceId/secrets` requires Namespace `read` and returns
only Secrets on which the caller also has exact-resource `read`. An empty list
means no readable Secrets. Exact Secret reads, updates, and deletion require
`read`, `update`, and `delete`, respectively. Reads return metadata from OCC;
they do not call the Driver or return a value. Binding or assigning a Secret
also requires the caller to have `operate` on it. Deployment requires both the
deploying actor and the consuming Agent's ServicePrincipal to have `operate` on
each Secret. The worker rechecks access before delivery. Namespace membership,
possession of a reference, and backend permissions grant no OCC authority.
Secret references must belong to the target Namespace. Keep values out of
responses, Configuration, audit, and logs. A running version can still use an
older projected value.
For channel directory lookup, the caller selects an existing same-Namespace
Secret while creating an Agent or editing an Agent or Configuration. OCC requires
the corresponding create/update permission and exact Secret `operate`, uses
`withValue` to read the current value, and rechecks the target permission and
Secret identity before passing it to the selected ChannelDriver in-process.
The lookup response contains IDs, names, and workspace identity, never the token.
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
Deletion is refused with `409` while a Configuration, credential source, Agent
draft, selected version, pending deployment, or queued or running Agent
provisioning request still references the Secret. The message names each
referencing resource the caller may read, by kind and ID, as many as fit the
256-character message, and only counts the others. The exact Secret read lists
the same references as `consumers`; see
[Find a Secret's consumers](kubernetes-secret.md#find-a-secrets-consumers).
A failed provisioning request does not block
deletion; reading or retrying it then names the deleted Secret. Otherwise OCC calls the
Driver before removing its own record.

After the Installation selects another Secret Driver, Secrets stored through the
previous one keep their metadata, and exact reads still work. Updating or
deleting one fails with `503` and a message naming the fix, only after the grant,
lookup, and reference checks: create a new Secret through the selected driver and
bind it instead, or delete the old Secret once the Installation selects its
Driver again. OCC never calls a Driver that does not own the Secret.

Hosted Codex Plugin discovery uses a ready TokenService account Source.
Curated catalogs can support discovery without a credential. See
[Plugin discovery](plugin.md#selection-and-catalogs).

To admit a protected static source, OCC checks the caller's `operate` grant on
the exact Secret and uses the selected provider to validate the value returned
by `readCredentialInput`. For a protected request, OCC checks the Agent
ServicePrincipal's `operate` grant on the Credential Source. Before calling
the Secret Driver, OCC verifies the stored Driver ID and checks that the
selected provider is still current. The sender needs separate authorization
from OCC before it can dispatch the request. See the
[protected request flow](../../flows/credential-source-egress.md).

During deployment admission, the API asks `resolve` to verify that the current
backend identity still matches OCC's record. The Agent revision pins the Driver ID
and normalized binding, not the backend locator or secret bytes. The worker
later rechecks permissions and loads current OCC metadata; it does not call the
Secret Driver. Compute receives a temporary delivery reference. In the current
Kubernetes implementation, gateway bindings go only to the selected gateways;
model API keys go only to the Harness that executes the model.

## Limits

- No public value reads, version history, rollback, credential issuance, or general
  per-access broker. Workload delivery uses environment projection. Protected
  static requests keep credential material out of the workload.
- Updating a Secret does not restart workloads. Redeploy consumers through OCE
  to refresh projections for the Agent revision before expecting a new environment value.
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
- [OCC Secret operations](../../../packages/occ/src/secret-operations.ts) and [worker delivery](../../../apps/controller/src/worker.ts)
