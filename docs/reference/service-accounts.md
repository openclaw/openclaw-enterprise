# Service accounts

A service account is an OCC-owned, Namespace-scoped identity that links Agents
to one credential without exposing its value. It is neither a platform
ServicePrincipal, a Kubernetes ServiceAccount, nor a provider account. Native
accounts accept existing API-key references; an optionally selected
`ServiceAccountDriver` can instead create and manage an upstream account while
keeping its provider-specific identity private. A managed account's private
binding records its exact Backend, Driver, and workspace ownership.

This page defines current account behavior and credential boundaries. For
controller setup and authentication, see the [quickstart](../guides/quickstart.md)
and [deployment guide](../guides/deploy.md).

## Account ownership and authorization

The server assigns each account an `sa_`-prefixed ID inside exactly one
Namespace. Multiple Agents in that Namespace may share the account. Each
account has at most one credential reference; its provider identity and
credential bytes remain private. Creating an account is supported while its
Namespace is `provisioning` or `ready`.

| Operation                                                                      | Required exact permission                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `POST /namespaces/:namespaceId/service-accounts`                               | `create` on the Namespace's account collection.                          |
| `GET /namespaces/:namespaceId/service-accounts`                                | `read` on the Namespace and each returned account.                       |
| `GET /namespaces/:namespaceId/service-accounts/:serviceAccountId`              | `read` on the account.                                                   |
| `POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials` | `update` on the account and `credential_source:create` on the Namespace. |
| `PATCH /namespaces/:namespaceId/service-accounts/:serviceAccountId/credential` | `update` on the native account.                                          |
| `DELETE /namespaces/:namespaceId/service-accounts/:serviceAccountId`           | `delete` on the unreferenced account.                                    |

Account creation and credential issuance are separate. OCC authorizes each
operation before provider or Kubernetes effects; provider authorization remains
independent. Responses expose only OCC account metadata and an optional generic
credential readiness metadata, never backend locators, provider identities, or credential bytes.
Collection reads require `read` on the Namespace and return only accounts for
which the caller also has exact-account `read`.

## Backend selection and configuration

The optional ChatGPT implementation requires an Installation-scoped Backend
and its matching selected `service_account` Driver. The [Backend
reference](backends.md#installation-configuration) owns the complete YAML,
client and membership contract, mounted key, and Helm values. The configuration
requires durable PostgreSQL persistence.

Both processes load nonsecret Backend definitions; only the API initializes
`Backend<ChatGPTClient>` and injects it into `ChatGPTServiceAccountDriver`.
The worker validates metadata without an admin credential or Backend client.

## Account and credential lifecycle

Creation and credential issuance are separate authorized operations. With the
ServiceAccount Driver selected, `POST /namespaces/:namespaceId/service-accounts`
accepts a name, returns `201` with an OCC account envelope, and privately links
the newly created upstream account. Without that Driver, creation produces a
native OCC account. Neither operation issues a credential automatically.

A representative account-creation body is:

```json
{ "name": "support-model" }
```

Issuance accepts `{}` at
`POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials`.
It requires exact ServiceAccount update and Namespace Source create grants.
The selected TokenService enrolls a static `codex-pat` Source. The `201`
account response includes `credential: { kind: "access_token", sourceId }`.
The PAT and the provider credential ID stay private. A second issuance
returns `409`.

Bind the Source to a Dedicated Codex Agent using
`harnessAuth: { method: "credential_source", sourceId }` and the ordinary exact
Source permissions. Reading the ServiceAccount lets a caller discover its
Source reference. Using the Source requires its own `operate` grant.

Deletion requires access to the exact account. Existing direct account
references in live Agent state can block deletion. A Source bound to an Agent
does not block issuer revocation. The Driver revokes the exact issuer
credential and deletes the upstream account. Retire its Source separately
through the [Source lifecycle](credential-sources.md#delete-a-source).

### Force-delete when the Backend is gone

If that Backend is retired for good and the Installation has no ChatGPT
Backend, force the delete with the same `delete` grant:
`DELETE .../service-accounts/:serviceAccountId?force=true`, or
`occ service-account delete ID --force`. OCC removes the account and its private Backend binding and answers `200` with
`revocation: "skipped"`. The token and the provider account (named
`<name>-<serviceAccountId>`, credential `occ-<serviceAccountId>`) stay at the
provider until an administrator deletes them there or the token expires. The
audit event records `force: true`, `revocation: "skipped"`, the actor, and the
binding's `backendId`, `workspaceId`, `externalAccountId`, and provider
`credentialId`, never the token.

Force changes nothing else. With a ChatGPT Backend configured it is ignored
(the audit event still records `force: true`): the token is revoked and the
answer is the usual `204`, so retried scripts stay safe. If a different ChatGPT
Backend replaced the old one, deletion still answers `503` because the binding
names another Backend; configure the old Backend again, or remove the ChatGPT
Backend, before deleting. Accounts without an issued token, and referenced accounts, behave as
without force. Callers without `delete` get the same `403` or `404`. The
choice is made on the locked account row, so a token issued meanwhile is
reported, not missed. An API Pod still running without the Backend during a
rollout that re-adds it can force-delete; avoid forcing until the rollout ends.

<a id="revision-snapshots-and-credential-delivery" class="anchor-alias"></a>

## Version snapshots and credential delivery

A Dedicated Codex revision freezes the TokenService Source binding and its
admitted native request policy. The Worker prepares a Proxy placeholder for
the Harness. The Source owns the stored bearer. See [PAT enrollment and
delivery](credential-sources.md#use-a-codex-pat-source).

### Native API-key references

`PATCH /namespaces/:namespaceId/service-accounts/:serviceAccountId/credential`
sets or replaces a native credential reference. It cannot set an `access_token`
or manually replace a provider-issued access token. The native API-key body
names an existing Secret and key in the account's exact backing namespace:

```json
{
  "kind": "api_key",
  "secretRef": { "name": "provider-key", "key": "api-key" }
}
```

Native account references are not model-auth selectors. To supply an OpenAI API
key to a supported Harness, [enroll a static Source](credential-sources.md#register-a-source) and select it in the Agent.

`oauth_access_token` references remain representable, but deployment and
refresh are unsupported. OAuth refresh belongs to a future credential-owning
provider, not IAM, Compute, OCC, or the Harness.

## Failures and current limitations

- `403` identifies a missing exact account or Source authorization.
- `409` can indicate an existing account credential, an unready Namespace or
  an Installation without a compatible TokenService.
- `409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED` means the ChatGPT Backend or
  selected Driver is unavailable for issuance or revocation. Configure the
  matching [ChatGPT Backend](../guides/integrations/chatgpt.md).
- `503 DEPENDENCY_UNAVAILABLE` indicates a provider or platform failure.
  Use the request ID to locate the sanitized API diagnostic. On confirmed
  enrollment or finalization failure, OCC revokes the new issuer credential.
  An operator investigates an unknown provider outcome before retrying.
- An expired PAT cannot authenticate. Issue a fresh PAT to replace it.

## Evidence and related references

The [account operations](../../packages/occ/src/service-account-operations.ts)
admit and delete accounts. [Harness authentication](../../packages/occ/src/harness-auth.ts)
checks the Agent's Source binding and saves its credential authority in the
revision. The
[ChatGPT Driver](../../apps/controller/src/drivers/service-account/chatgpt.ts)
owns private upstream bindings and compensation; the
[worker](../../apps/controller/src/worker.ts) reauthorizes the deployment actor.

- [Service-account testing](../testing/slack.md#service-account-coverage)
- [ServiceAccountDriver contract](drivers/service-account.md)
- [Kubernetes Compute reference](drivers/kubernetes-compute.md)
- [Authorization](authorization.md)
- [Backend-managed credential flow](../flows/service-account-driver-credential-delivery.md)
- [Harness authentication flow](../flows/native-service-account-credential-delivery.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 08:47: Centralize Provider configuration and document matching Agent and revision IDs. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 17:54]: Reorganize as a current feature reference; distinguish account lifecycle, immutable references, and supported credential delivery. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
