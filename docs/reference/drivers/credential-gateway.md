# CredentialGatewayDriver contract

## Overview

`CredentialGatewayDriver` holds credentials outside the Agent workload and
applies them to the Agent's outbound requests. OpenClaw Control Plane (OCC) owns
the [credential source](../credential-sources.md) record, its Secret references,
authorization, and Agent bindings. The Driver owns the stored copy of the value,
the source-type catalog, and how a credential reaches a request. The paired
[SandboxDriver](sandbox.md) consumes the Driver's per-revision attachments when
it creates the Harness, and [Compute](compute.md) waits for those attachments
before activation.

Selection is optional. The only implementation is the bundled
[OpenShell Credential Gateway](openshell-credential-gateway.md), which requires
the bundled Kubernetes Compute Driver, the bundled OpenShell SandboxDriver, and
an `openshell` [Backend](../backends.md) that declares both. See
[Driver selection](selection.md#backend-membership).

When a Credential Gateway is selected, it replaces Secret-backed model
delivery. Agents must authenticate their Harness through a credential source;
there is no fallback to environment delivery.

## Interface

### Core interface

The [shared interface](../../../packages/contracts/src/index.ts) requires every
method below. Startup rejects a Driver that omits one.

| Operation           | Inputs and preconditions                                                                   | Result or side effects                                                                                                                                   | Failure or absence                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `listSourceTypes`   | Cancellation signal.                                                                       | The implementation's catalog of `CredentialSourceType` entries.                                                                                          | OCC treats a failure as dependency unavailable.                                   |
| `registerSource`    | Ready Namespace, the new source record, and resolved Secret values.                        | Stores the value in the gateway and returns `ready`, `pending`, `failed`, or `absent`.                                                                   | `failed` or `absent` fails registration; OCC then calls `removeSource`.           |
| `updateSource`      | Existing source and new resolved values.                                                   | Replaces the stored values for processes started afterwards and returns the source state.                                                                | `failed` or `absent` fails the update; OCC keeps the Secret references unchanged. |
| `rotateSource`      | Existing source.                                                                           | Rotates gateway-refreshed credentials.                                                                                                                   | No OCC caller yet; no delivered source type uses gateway refresh.                 |
| `sourceStatus`      | Existing source.                                                                           | Live source state and an optional safe reason.                                                                                                           | OCC reports `failed` with a fixed reason when the call throws.                    |
| `removeSource`      | Source record.                                                                             | Deletes the stored copy. An already-absent source counts as removed.                                                                                     | A failure leaves the OCC record `deleting` for retry.                             |
| `attachForRevision` | Namespace, immutable revision, and the bound source records.                               | Exactly one `{ sourceId, ref }` attachment per bound source. `ref` is opaque to OCC.                                                                     | Throws when a source is unavailable or foreign; the revision does not provision.  |
| `attachmentStatus`  | The same context plus the provisioned `SandboxResourceRef`.                                | Per-source state: `ready`, `pending`, `withheld`, `failed`, `revoked`, or `absent`.                                                                      | Compute blocks activation on any state other than `ready` or `pending`.           |
| `withdraw`          | Placement, revision, its required `SandboxResourceRef`, and one source ID; no source list. | Revokes that revision's access, including running processes. `revoked` only on gateway evidence, `absent` when the Sandbox is gone, otherwise `pending`. | Anything but `revoked` or `absent` keeps the OCC withdrawal `pending` for retry.  |

A `CredentialSourceType` declares:

- `type`: an implementation-defined name, such as `openai`.
- `config` and `secrets`: field specifications with `name`, `required`, and an
  optional description. `config` fields are nonsecret strings; `secrets` fields
  are supplied as OCC Secret references.
- `rotation`: `none`, `external`, or `gateway`.
- `harnessAuth`: optional `{ modelProvider, loginMode }`. Only a type with this
  entry can authenticate a Harness. The current login mode is `api_key`. An Agent
  lists every source it uses, of any type, in `credentialSources`.

### Optional additions

The contract has no optional methods. `SecretDriver.withValue` is the
[Secret Driver](secret.md#interface) method OCC uses to obtain the values it
passes to `registerSource` and `updateSource`. Withdrawal also needs two optional
methods on its collaborators: Compute's `withdrawCredentialSource`, which the
worker calls, and the Sandbox Driver's `harnessResource`, which returns the exact
Sandbox a revision runs in without side effects.

## IAM

The selected IAM Driver authorizes every OCC operation before the Driver is
called:

- Registration requires `credential_source:create` on the Namespace and
  `secret:operate` on every referenced Secret. OCC reads Secret values only after
  those checks.
- Binding a source to an Agent requires the caller's `credential_source:operate`
  on the exact source, including the current source when PATCH replaces or clears it.
- Deployment admission and the worker require `credential_source:operate` for both
  the deploying actor and the Agent's service principal. The Agent principal needs
  no permission on the underlying Secret.

The Driver receives only authorized, exact-Namespace sources. It must never log,
return, or persist a secret value outside its own credential store. OCC never
stores the value, and revisions and audit records carry only the source ID.
Gateway credentials, such as the OpenShell Backend's bearer token, are separate
from OCC authority; see [Permissions](../cheatsheets/permissions.md).

## Lifecycle

The Driver is constructed at API and worker startup from trusted Installation
configuration. The interface has no initializer or destructor.

1. **Registration.** The API validates the request against `listSourceTypes`:
   unknown types, unknown fields, and missing required fields fail before any
   gateway call. Compute's `resolveSandboxNamespace` supplies the Namespace's
   runtime placement, which the gateway shares with the paired Sandbox. The API
   reads each Secret value and commits the record as `registering`, then calls
   `registerSource` outside the transaction. A second transaction moves the
   record to `ready` with its audit event. If `registerSource` returns `failed` or
   `absent`, OCC calls `removeSource` and deletes the record. If it throws, a
   create may still land, so OCC calls `removeSource` but keeps the record
   `deleting`. OCC finalizes a deletion only 70 seconds after `createdAt`, and a
   Driver must finish every effect of an aborted registration within 30 seconds
   of the abort. A record left `registering` or `deleting` is never usable, and
   the caller retries DELETE to remove any gateway copy. See
   [credential sources](../credential-sources.md#register-a-source).
2. **Admission.** `deployAgent` freezes `{ method, sourceId,
credentialGatewayId, sourceType, loginMode }` in the revision. The source must
   be `ready`, and its type must declare `harnessAuth`. A Sandbox must be
   selected, and Compute validates the combination; see
   [Harness authentication](../harness-execution.md#harness-authentication).
   Every listed source, including the Harness source, is frozen as
   `{ sourceId, credentialGatewayId, sourceType }` in `credentialSources`.
3. **Dispatch.** The worker rechecks both `operate` grants, requires the
   selected gateway to match the snapshot, and loads the current source record.
   A missing, `deleting`, or mismatched source stops the revision. Compute
   revalidates the binding against the gateway's current catalog entry. The
   worker passes the other listed sources it loaded in
   `ComputeRevisionContext.credentialSources`, omitting the Harness source and any
   withdrawn from the revision.
4. **Provisioning.** Compute calls `attachForRevision` with the Harness source
   first and the other sources after it, and passes the result in
   `HarnessWorkloadRequirements.credentialAttachments` to `provisionHarness`.
   The paired Sandbox must consume every attachment and reject any it did not
   issue.
5. **Activation.** After the Harness is ready, Compute calls
   `attachmentStatus`. `pending` or a missing status retries reconciliation;
   `failed`, `withheld`, `revoked`, or `absent` fails it. Only `ready` for every
   attachment lets the revision activate.
6. **Update.** The API locks the source, reads its current or replacement Secret
   values, and calls `updateSource`. Running Harness processes keep the previous
   value until they restart.
7. **Withdrawal.** The API records a `pending` withdrawal for the Agent's active
   revision and queues worker work. The worker rechecks `agent:operate`, and
   Compute derives the revision's Sandbox and calls `withdraw` for each pending
   withdrawal of the revision. Only `revoked` or `absent` marks one `revoked`;
   otherwise the work retries. The revision never re-attaches a withdrawn
   source.
8. **Deletion.** The API refuses deletion while an Agent draft, active revision,
   or pending deployment references the source. Otherwise it marks the record
   `deleting`, calls `removeSource`, then deletes the record. Revision stop
   and retirement remove attachments with the Sandbox. A failed Sandbox
   cleanup leaves the stop or retirement pending for retry.

Registration and removal must be idempotent for one source ID so that retries
adopt or delete the same stored copy.

## Limits

- One Credential Gateway can be selected per Installation, and it must belong to
  a configured Backend.
- OCC has no rotate operation, because no delivered source type uses gateway
  refresh. Update pushes new static values; running Agents use them after a
  redeploy.
- Compute accepts a model credential source only for dedicated Codex with a
  source type whose `harnessAuth` is `openai`/`api_key`. Other listed sources
  need a SandboxDriver that provisions the Harness.
- Guided Agent provisioning rejects credential-source Harness authentication.
  Create the Agent, then deploy it.
- Installed Credential Gateway packages are unsupported.

## Troubleshooting

| Symptom                                              | What to check                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Registration returns `400` or `404`                  | Compare the type and field names with the Driver catalog, and confirm each Secret belongs to the same Namespace.                  |
| Registration or binding returns `403`                | Check `credential_source:create` or `operate`, and `secret:operate` on each referenced Secret.                                    |
| Deployment returns `409` with a gateway selected     | Change `harnessAuth` to `credential_source`. Secret-backed and account methods are rejected while a gateway is selected.          |
| Registration, read status, or deletion returns `503` | Check gateway connectivity and credentials. Retry deletion; the record stays `deleting` until the stored copy is removed.         |
| A revision never activates                           | Check the worker's reason code and the source's live `status`. A `failed` attachment state requires repairing the gateway source. |

## Implementations

- [OpenShell Credential Gateway](openshell-credential-gateway.md): bundled; stores
  sources as OpenShell providers and injects them at the Sandbox egress proxy.

## Related

- [Credential sources](../credential-sources.md) and [Agent Harness authentication](../agents.md#harness-authentication)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [OCC credential source operations](../../../packages/occ/src/index.ts) and [Kubernetes Compute caller](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
- [OpenShell verification](../../testing/openshell.md)
