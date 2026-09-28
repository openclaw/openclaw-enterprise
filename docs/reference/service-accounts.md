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

| Operation                                                                      | Required exact permission                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| `POST /namespaces/:namespaceId/service-accounts`                               | `create` on the Namespace's account collection.    |
| `GET /namespaces/:namespaceId/service-accounts`                                | `read` on the Namespace and each returned account. |
| `GET /namespaces/:namespaceId/service-accounts/:serviceAccountId`              | `read` on the account.                             |
| `POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials` | `update` on the exact account.                     |
| `PATCH /namespaces/:namespaceId/service-accounts/:serviceAccountId/credential` | `update` on the native account.                    |
| `DELETE /namespaces/:namespaceId/service-accounts/:serviceAccountId`           | `delete` on the unreferenced account.              |

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

`POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials`
accepts `{}` and issues a credential through the selected Driver. The `201`
account envelope exposes safe credential readiness metadata; backend Secret
locators and Backend/workspace identities remain private.
Compute creates one account-owned token/workspace Secret in the tenant control plane; the Driver privately
persists the upstream credential ID for exact cleanup. A second issuance fails
with `409`; rotation and reconciliation are not implemented. Calling issuance
without a selected ServiceAccount Driver fails with `503 DEPENDENCY_UNAVAILABLE`.

An Agent binds the same-Namespace account through
`harnessAuth: { method: "chatgpt_service_account", serviceAccountId }`.
Association and deployment require `read` on the exact account. Updating or
detaching an associated account requires current-account `read`; replacement
requires `read` on both accounts. An Agent can reference an account before it
has a credential, but deployment rejects that state.

Deletion requires `delete` on the exact account and is rejected while an Agent
draft, active revision, or queued or claimed deployment references it. Detaching
the draft alone does not release an active or pending deployment's account.
Inactive historical revisions and permanently failed deployments do not block
deletion unless the account is still referenced by other live state.
Backend-managed deletion removes
the exact upstream credential, the account-owned Secret, and the upstream
account before deleting OCC account state. Native deletion removes OCC account
state; the operator owns the referenced source Secret.

## Revision snapshots and credential delivery

Deploying an Agent freezes the account ID, credential kind, Secret reference,
and nullable `backendId` in its immutable AgentRevision. It does not copy
credential bytes into the revision. Later account edits do not rewrite that snapshot. A Secret reference
is not a snapshot of the Secret's value. Before dispatch, the worker reauthorizes
exact-account `read` for the actor who requested the deployment.

### Backend-managed access tokens

For an `access_token`, the Agent must select the binding's exact nonnull
`backendId`, with its selected member Driver, workspace, and issued credential.
Admission and worker reconciliation validate that private metadata before
workload effects; a public credential kind is not proof of ownership. Only
dedicated Codex execution is supported. Kubernetes
delivers both keys from the account-owned CP source through a revision-owned
data-plane runtime Secret into the exact
Codex Pod:

| Account Secret key | Codex environment variable   | Purpose                              |
| ------------------ | ---------------------------- | ------------------------------------ |
| `token`            | `CODEX_ACCESS_TOKEN`         | One upstream account access token.   |
| `workspace-id`     | `CODEX_CHATGPT_WORKSPACE_ID` | Forced upstream workspace selection. |

Codex authenticates through
`codex -c cli_auth_credentials_store=file -c forced_chatgpt_workspace_id="<workspace-id>" login --with-access-token`
and saves login state only in its bounded ephemeral workload volume. Its
gateway receives neither key. The trusted worker reads the source and manages
the revision projection; workloads receive no Secret API permission. No API-key
fallback is used. The projection does not narrow provider-side token authority.

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
key to either supported Harness, store it as an OCC Secret and select
`harnessAuth.method: "api_key"`; see [Agent harness authentication](agents.md#harness-authentication).
The Compute-owned account Secret path applies only to Driver-issued access tokens.

`oauth_access_token` references remain representable, but deployment and
refresh are unsupported. OAuth refresh belongs to a future credential-owning
provider, not IAM, Compute, OCC, or the Harness.

## Failures and current limitations

- `403`: Missing exact OCC account permission.
- `404`: Account or Agent is outside its exact Namespace.
- `409 RESOURCE_CONFLICT`: Duplicate account name, existing credential,
  referenced-account deletion, missing credential, or unsupported Harness or
  OAuth deployment, or mismatched managed Backend binding.
- Provider denial or Kubernetes failure: Creation fails closed; compensation deletes
  only the newly created exact provider account, provider credential, or
  account-owned Secret when durable state confirms it was not committed.
- Expired token: Execution fails closed; automated refresh and rotation are
  not implemented.

## Evidence and related references

The [controller domain operations](../../packages/occ/src/index.ts) own account
admission, association, deletion, and revision snapshots. The
[ChatGPT Driver](../../apps/controller/src/drivers/service-account/chatgpt.ts)
owns private upstream bindings and compensation; the
[worker](../../apps/controller/src/worker.ts) reauthorizes the deployment actor.

- [Service-account testing](../testing/service-accounts.md)
- [ServiceAccountDriver contract](drivers/service-account.md)
- [Kubernetes Compute reference](drivers/kubernetes-compute.md)
- [Authorization](authorization.md)
- [Backend-managed credential flow](../flows/service-account-driver-credential-delivery.md)
- [Harness authentication flow](../flows/native-service-account-credential-delivery.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 08:47: Centralize Provider configuration and document matching Agent/revision ownership. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 17:54]: Reorganize as a current feature reference; distinguish account lifecycle, immutable references, and supported credential delivery. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
