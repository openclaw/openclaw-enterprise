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
- `deviceAuthorization`: optional `{ harnessId }` declaring device login for this
  source type. The login path requires one matching type with no required user
  config or Secret inputs.
- `harnessAuth`: optional `{ modelProvider, loginMode }`. Only a type with this
  entry can authenticate a Harness. Login modes are `api_key` and, for dedicated
  Codex, `chatgptAuthTokens`.

### External ChatGPT authentication

The `chatgptAuthTokens` mode receives externally managed ChatGPT authentication
through a credential source. It is a receiving contract for a Credential
Gateway and paired Sandbox that already provide OAuth token injection. The
experimental OpenShell `codex-oauth` type requires the custom gateway and supervisor
described in the [OpenShell Driver reference](openshell-credential-gateway.md#experimental-codex-oauth-poc).

For an `openai`/`chatgptAuthTokens` source, `attachForRevision` must return
`externalChatgptAuth` on the source's attachment: `accessTokenPlaceholder`,
`accountId`, `planType`, and optional `userId`, `accountUserId`, `email`, and `isFedramp`. The
trusted Driver supplies account metadata from the authenticated connection;
these fields are not caller-selected Agent configuration. The placeholder must
be the exact value recognized by the egress injector. Real access tokens,
refresh tokens, and the original ID token stay outside the Harness.

Compute validates one attachment per authorized source and selects the Codex
attachment by `harnessAuth.sourceId`, independently of attachment order. It passes
every attachment to the Sandbox and the selected placeholder and account metadata
to the dedicated Codex entrypoint. The entrypoint writes an ephemeral `auth.json`
with `auth_mode: "chatgptAuthTokens"`, the unchanged access-token placeholder, an
empty refresh token, and a synthetic ID-token payload containing the account
metadata. Native Codex uses that metadata for account identity, plan and
workspace decisions. This external mode does not run native OAuth refresh;
the existing native model probe must still succeed before app-server starts.

The external credential service owns refresh and the gateway owns injection
for inference, hosted app/MCP, and authenticated account/configuration requests.
Metadata is projected at provisioning; account metadata changes require a new
revision. A fresh device login creates a new source for explicit replacement. Native user-identity checks that depend on
access-token claims are not established with an opaque placeholder.

This replaces the legacy runtime-owned OAuth binding. No persistent credential
bundle or native-refresh fallback is supported. See
[Experimental OAuth storage](kubernetes-compute/codex-oauth-storage.md).

### Optional additions

A device-login source requires `startDeviceAuthorization(context)` and
`pollDeviceAuthorization(context, privateState)`. Start returns device instructions,
expiry and an opaque handle. Poll returns `pending` or `ready`; `ready` means the
external service durably owns the connection. Neither returns provider tokens to
OCC. Calls operate on the exact registered source and must not recreate a removed
source. OCC serializes polling with Secret compare-and-swap and does not replay
an uncertain exchange.

`withSourceToken(context, use)` supplies a warm `CredentialSourceToken` only for
an authorized configuration callback: access token and optional trusted account
ID/FedRAMP classification. It must not initiate refresh or return the refresh
credential. The callback rechecks authorization before provider I/O; source
withdrawal and token readiness remain the external service's responsibility.

`SecretDriver.withValue` supplies static registration inputs. Withdrawal also
uses Compute's `withdrawCredentialSource` and the Sandbox's `harnessResource`.

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
3. **Dispatch.** The worker rechecks both `operate` grants, requires the
   selected gateway to match the snapshot, and loads the current source record.
   A missing, `deleting`, or mismatched source stops the revision. Compute
   revalidates the binding against the gateway's current catalog entry.
4. **Provisioning.** Compute calls `attachForRevision` and passes the result in
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
   Compute derives the revision's Sandbox and calls `withdraw`. Only `revoked`
   or `absent` marks it `revoked`; otherwise the work retries. The revision
   never re-attaches a withdrawn source.
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
- Compute accepts `openai`/`api_key` credential sources for dedicated Codex or
  native OpenClaw. `openai`/`chatgptAuthTokens` is dedicated-Codex-only and
  requires the external-auth attachment described above. The bundled catalog
  still exposes only static API-key sources; this contract does not implement
  an OAuth Token Service, OAuth source Driver, or token injection.
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
