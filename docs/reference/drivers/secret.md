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

Trusted Installation YAML requires a bundled Secret Driver: Kubernetes or
[AWS Secrets Manager](#aws-secrets-manager). Delivery to SSH hosts is unsupported. Default
Compose without Installation YAML selects no Secret Driver. See
[Driver selection](selection.md) and the [Kubernetes implementation](kubernetes-secret.md).

## Interface

The [shared interface](../../../packages/contracts/src/secret.ts) requires four
storage and projection methods and optionally supports transient server-side use.

| Method                                    | Contract                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create(identity, value)`                 | Store the value for OCC's `{ id, namespaceId, name }` and return a safe backend reference.                                                                                      |
| `update(secret, value)`                   | Replace the value at the stored, owned backend identity. Returns no value and does not report delivery.                                                                         |
| `delete(secret)`                          | Remove only the backend object belonging to this Secret. Returns no value.                                                                                                      |
| `resolve(secret)`                         | Check live ownership and return only the reference safe to use for projection. Never return the value or substitute another object.                                             |
| `compareAndSwap(secret, expected, value)` | Optional atomic replacement of an exact current value. **Experimental** Codex OAuth device login uses it to serialize polling and fence cancellation; a mismatch returns false. |
| `withValue(secret, use)`                  | Optional. Verify ownership, pass the current value to the trusted callback, and return its result.                                                                              |
| `readCredentialInput(input)`              | Optional. Required for protected static sources. Read the authoritative value and its version from the owned Secret.                                                            |

The current `SecretBackendRef` contains `namespaceName`, `name`, `key`, and
`uid`; these are internal metadata, never caller-selected locations. The public
`SecretMetadata` contains only `id`, `namespaceId`, `name`, and a platform `ref`.
OCC rejects empty values, NUL, invalid text, and values above 65,536 UTF-8 bytes.

OCC uses `withValue` to register and update [credential sources](../credential-sources.md)
with the Credential Gateway. Other callers include
Secret-backed plugin discovery, channel credential validation and directory
lookup, and **experimental** Codex OAuth device login.

For `readCredentialInput`, [`CredentialInputRead`](../../../packages/contracts/src/credential-proxy.ts)
supplies the stored `secret`, `retention: "none"`, and a `lifetime`. Honor its
`signal` and absolute `deadlineAt` across backend calls and retries. Return a
`VersionedSecretValue` with `value`, `version`, `authoritativeObservedAt`, and
optional `expiresAt`. Read each value from the authoritative store without
caching it. Kubernetes verifies the stored UID and returns the object's
`resourceVersion` as the version.

## IAM

OCC authorizes creation on the Namespace's Secret collection.
`GET /namespaces/:namespaceId/secrets` requires Namespace `read` and returns
only Secrets on which the caller also has exact-resource `read`. An empty list
means no readable Secrets. Exact Secret reads, updates, and deletion require
`read`, `update`, and `delete`, respectively. Reads return metadata from OCC;
they do not call the Driver or return a value. Binding or assigning a Secret
also requires the caller to have `operate` on it. Deployment requires both the
deploying actor and the consuming Agent's ServicePrincipal to have `operate` on
each Secret; the worker rechecks them before preparing delivery. Registering a
credential source requires the caller's `operate` on each referenced Secret. Namespace
membership, possession of a reference, and backend permissions grant no OCC
authority. A Secret binding, Harness authentication source, credential source
Secret, or plugin discovery Secret that names another Namespace is rejected with
`400 INVALID_REQUEST`; a Secret the Namespace does not hold is `404`. Plugin discovery using a Secret also
requires caller `operate` on that exact Secret. Create Agent discovery also
requires Namespace Agent `create`; it does not require an Agent ServicePrincipal.
Saved-Agent discovery requires exact Agent `read` and `update`, plus `operate`
for both the caller and the Agent's ServicePrincipal. OCC derives the `codex_pat`
source from the Agent rather than accepting a Secret ID from the browser. It
rechecks those grants and the binding after the backend read, before sending
the value to the selected Plugin Driver. Never expose values in responses,
configuration documents, audit, or logs. A running version may still use an
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

For plugin discovery, OCC checks permissions and reads current Secret metadata,
then calls `withValue` without holding a platform transaction over backend or
provider I/O. The callback passes the value to the selected PluginDriver and
does not persist it. Discovery rechecks the caller's grants inside the callback
before that PluginDriver call; saved-Agent discovery also rechecks the binding. A Driver without this optional
capability cannot serve Secret-backed discovery. Each request reads the current
backend value; a concurrent rotation can take effect after an in-flight request
has already read the prior value. See
[plugin discovery](plugin.md#selection-and-catalogs).

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
- Kubernetes and AWS Secrets Manager are selectable. Arbitrary installed Secret
  packages and SSH delivery are unsupported; selection alone does not enable them.

## Troubleshooting

| Symptom                                 | What to check                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation or update fails before storage | Confirm the Namespace is ready and the input meets the size and text rules.                                                                                             |
| Binding or deployment is denied         | Check the caller's exact Secret grant and, for deployment, the Agent ServicePrincipal's `operate` grant. Backend RBAC cannot replace either.                            |
| A Secret cannot be resolved             | Check the selected Driver, backend availability, and whether the original owned object still matches OCC's identity. Do not point OCC to a replacement object manually. |
| Updated credentials are not visible     | Restart or redeploy the consuming workload and verify the new process became active; updating storage does not refresh existing environments.                           |
| Deletion is rejected                    | Remove Configuration and deployment references through OCC before retrying.                                                                                             |

## AWS Secrets Manager

Select `secret-aws-secrets-manager` in trusted Installation YAML:

```yaml
drivers:
  secret:
    id: secret-aws-secrets-manager
    configuration:
      region: us-east-1
      accountId: "123456789012"
      prefix: oce/production
      # kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/...
```

The AWS SDK uses its default credential provider chain. Prefer a workload IAM
role; do not put credentials in Installation YAML. Provision the account, region,
and optional KMS key separately. Before creation, the Driver captures credentials
once and calls STS `GetCallerIdentity`. A missing or mismatched account prevents
`CreateSecret`. STS and creation use copies of the same captured credentials.
STS and Secrets Manager use explicit regional AWS HTTPS endpoints, ignoring
SDK endpoint environment/shared-configuration overrides. Certificate verification
is enabled explicitly; Node's CA trust and credential-provider configuration
remain trusted operator inputs. No AWS infrastructure is created at startup.

Names use `<prefix>/<namespaceId>/<secretId>/<uuid>`, with the UUID and creation
token derived from the stable OCC Secret ID. OCC stores a UUID,
encoded AWS suffix, and SHA-256 binding to the complete ARN within the existing
backend-reference format, splitting the digest into DNS labels of at most
32 characters. Every operation reconstructs and verifies that ARN;
changed account, region, prefix, Namespace, Driver, or resource identity fails
closed. Requests use the complete ARN, never a partial ARN or name fallback.
Live ownership checks require `openclaw:managed-by`, `openclaw:namespace`,
`openclaw:secret`, and `openclaw:driver` tags.

Grant the controller role `secretsmanager:CreateSecret`, `TagResource`,
`DescribeSecret`, `GetSecretValue`, `PutSecretValue`, and `DeleteSecret` only
within its account, region, and prefix. Constrain creation with `aws:RequestTag`
and existing resources with `aws:ResourceTag` conditions for the ownership tags.
Deny changes to ownership tags after creation and deny resource replacement by
untrusted principals. Tag reads and writes are not an atomic authorization fence;
AWS IAM must enforce these boundaries too. A customer-managed KMS key also needs
appropriate `kms:GenerateDataKey` and `kms:Decrypt` grants and key policy.

Updates create an AWS version and move `AWSCURRENT`; they refuse an observed
separate `AWSPENDING` rotation version. Trusted reads request both the observed
VersionId and `AWSCURRENT`, then recheck ownership and the current version.
They return the AWS VersionId through `readCredentialInput`, with no value cache.
External rotation is visible on the next successful read. Concurrent changes can
still occur after the final check. Updates are last-writer-wins, not atomic CAS;
this Driver omits `compareAndSwap` and cannot support flows that require it.
AWS version quotas limit update frequency; see
[PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html).

Deletion schedules a 30-day recovery window. Retrying a scheduled deletion
succeeds only after exact ownership verification. Missing resources fail closed,
including deletion; an operator must reconcile lost resources. Restoration uses
AWS administration and does not recreate deleted OCC metadata. The Driver never
force-deletes, restores, or adopts a replacement automatically. Requests have a
30-second timeout, respect protected-read lifetimes, and disable SDK retries.
Credential acquisition also settles on cancellation or deadline; a late provider
result cannot resume creation. Every mutation resolves and validates its signing
credentials first, then uses a fixed snapshot with the pinned regional client.
Provider, STS, and read-only failures report no
mutation submission. Failures after mutation submission, including post-create
binding and ownership verification, report that reconciliation is required.
Failed mutations may have applied: reconcile AWS audit records and owned resources
before retrying. A failed create may leave an orphan; it is not blindly deleted.
Repeating creation for the same OCC ID uses the same name and version token;
it cannot allocate another name or overwrite a version with different material.
Existing resources are never adopted by a name lookup. OCC does not automatically
replay failed creates, but a new HTTP create request generates a new OCC ID.
There is no request-level idempotency key: repeated client requests after unknown
outcomes can still leave separate orphans. Reconcile first, rather than resubmit.

This implementation supports storage and trusted server-side reads, including
protected static credentials. It does not provision rotation Lambdas or project
AWS secrets into Kubernetes or SSH workloads. Existing Compute rejects its
backend-reference namespace. Use Kubernetes for environment projections.

## Implementations

- [Kubernetes Secret Driver](kubernetes-secret.md): backend configuration,
  Kubernetes permissions, operator procedures, and diagnostics.

## Related

- [Agent Harness authentication](../agents.md#harness-authentication) and [Configuration Secret bindings](../configuration/secrets.md)
- [Secret storage and delivery flow](../../flows/secret-storage-and-delivery.md)
- [OCC Secret operations](../../../packages/occ/src/index.ts) and [worker delivery](../../../apps/controller/src/worker.ts)
