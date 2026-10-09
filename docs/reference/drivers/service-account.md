# ServiceAccountDriver contract

## Overview

`ServiceAccountDriver` creates provider accounts and credentials for
Namespace-scoped OCC ServiceAccounts. OpenClaw Control Plane (OCC) owns the
platform resource, its identity and Agent references, authorization, and API
responses. The Driver performs provider operations and privately maps OCC
accounts to provider accounts. The external provider retains its own authority.

The Driver is optional. Today trusted startup can select only the bundled
ChatGPT Backend member; it cannot load arbitrary ServiceAccount packages. With
no Driver, OCC can still create native accounts, but it cannot issue a
provider credential. See [Driver selection](selection.md).

## Interface

### Operations and credential boundary

The [shared interface](../../../packages/contracts/src/index.ts) requires all
three methods; none is optional once a Driver is selected.

| Method                      | Contract                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `create(account)`           | Provision the upstream account for the approved OCC ServiceAccount. Does not issue a credential.                       |
| `createCredential(account)` | Issue a credential for that account and return its kind and a safe Secret reference.                                   |
| `delete(account)`           | Revoke and remove provider resources owned by that account; do not delete a different account on an identity mismatch. |

A returned credential contains `kind` and `secretRef: { name, key }`, never the
credential value. The type includes `api_key`, `access_token`, and
`oauth_access_token`, but OCC's provider-issuance operation currently accepts
only `access_token`. The type does not promise a provider or Harness supports
every kind.

## IAM

OCC separately authorizes `create` on the Namespace's ServiceAccount collection,
`update` on the specific account for credential issuance, and `delete` on the
specific account. It checks permission before upstream or storage effects.
Provider credentials do not grant OCC access; provider account and credential IDs
and workspace bindings remain private. Public responses cannot contain credential
values. See the [resource permissions](../service-accounts.md#account-ownership-and-authorization).

## Lifecycle

Trusted startup checks the selected Driver and its Backend membership. In the
current composition, only the API initializes the Backend client; the worker
receives nonsecret Backend metadata. The interface has no startup, shutdown, or
credential-renewal method.

Creating an OCC account and issuing its credential are separate operations. An
account can hold at most one credential; issuance fails if it already has one,
if the account is outside the specified Namespace, or if the Driver is missing
(`409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED`, after the grant and lookup).
Deletion is blocked while an Agent draft, active revision, pending deployment, or
queued or running Agent provisioning request still references the account. OCC calls the selected Driver before deleting its
own account record; without a Driver, an account holding an issued access token
is not deleted (`409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED`) unless the caller
[forces it](../service-accounts.md#force-delete-when-the-backend-is-gone), which
leaves the token unrevoked. See the [credential delivery flow](../../flows/service-account-driver-credential-delivery.md).

## Limits

- The shared interface has no account update, credential refresh or rotation, or
  standalone credential deletion. An expired or revoked managed credential does
  not silently fall back to an operator API key.
- Current Harness bindings accept managed ChatGPT `access_token` credentials only
  for dedicated Codex. API keys use Namespace-owned OCC Secrets through
  [Agent Harness authentication](../agents.md#harness-authentication).
- Callers cannot select upstream account identifiers or install an arbitrary
  Driver through the `package` selector.

## Troubleshooting

| Symptom                                         | What to check                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account creation succeeds but has no credential | Creation and issuance are separate. Request issuance with `update` permission on that account.                                                             |
| Credential issuance fails                       | Check the selected Backend/Driver pair, the private account binding, provider authority, Secret storage, and whether the account already has a credential. |
| Deletion is rejected                            | Remove or update any Agent draft, active revision, or pending deployment reference through OCC, or let provisioning finish, before retrying.               |
| A managed credential is expired or revoked      | Restore access through the supported provider/account workflow. Do not substitute a different identity or assume automatic renewal.                        |

## Implementations

### Bundled ChatGPT implementation

The [ChatGPT Driver](../../../apps/controller/src/drivers/service-account/chatgpt.ts)
requires a matching `type: chatgpt` Backend and an empty Driver configuration.
It stores the private Namespace binding in PostgreSQL and asks selected Compute
credential storage to write the token and workspace identity to an account-owned
Secret. Issuance and deletion recheck Backend, Driver, and workspace ownership.
A missing binding makes provider deletion a no-op; conflicting ownership fails.
Backend and Secret creation register compensation with OCC; a create whose
reply is lost is not compensated, since nothing proves which account it made.
A credential reply that fails validation revokes the credential it names under
the requested account in this workspace. A Secret create that fails removes the
Secret it may have stored, only when that Secret holds this request's token.
A later failure's compensation runs after the account lock is released, when
another issuance may already hold the same Secret name, so it also deletes the
Secret only while it holds this request's token, with uid and resourceVersion
preconditions.
Deletion revokes the credential, removes its Secret, and deletes the upstream
account; each step treats an already-absent resource as done, so a retry
completes a deletion that applied but failed. See
[Backend configuration](../backends.md) and [service accounts](../service-accounts.md).

## Related

- [ServiceAccount resource](../service-accounts.md), [settings](../settings.md), and [deployment](../../guides/deploy.md)
- [OCC account operations](../../../packages/occ/src/index.ts)
