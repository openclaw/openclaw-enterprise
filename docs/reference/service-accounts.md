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
Compute creates one account-owned token Secret in the tenant control plane; the Driver privately
persists the upstream credential ID for exact cleanup. A second issuance fails
with `409`; rotation and reconciliation are not implemented. On an Installation
with no ChatGPT Backend, and so no ServiceAccount Driver, issuance fails with
`409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED` naming the fix, after the account
`update` check and lookup. A selected Driver that is unavailable or fails
returns `503 DEPENDENCY_UNAVAILABLE`.

An Agent binds the same-Namespace account through
`harnessAuth: { method: "codex_pat", source: { kind: "service_account", namespaceId, id: serviceAccountId } }`.
Association and deployment require `read` on the exact account. Updating or
detaching an associated account requires current-account `read`; replacement
requires `read` on both accounts. An Agent can reference an account before it
has a credential, but deployment rejects that state.

Deletion requires `delete` on the exact account and is rejected with `409` while
an Agent draft, active revision, queued or claimed deployment, or queued or running
Agent provisioning request references it; the message lists these kinds, not the
specific resources. Detaching
the draft alone does not release an active or pending deployment's account.
Inactive historical revisions and permanently failed deployments do not block
deletion unless the account is still referenced by other live state.
Backend-managed deletion removes
the exact upstream credential, the account-owned Secret, and the upstream
account before deleting OCC account state. If the account holds an issued
access token and the Installation no longer has a ChatGPT Backend, deletion
fails with `409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED`, after the `delete`
grant and the account lookup, and keeps the account: configure the same
ChatGPT Backend again (same `backendId`), then retry. Native deletion removes OCC account
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
delivers the token from the account-owned CP source through a revision-owned
data-plane runtime Secret into the exact
Codex Pod:

| Account Secret key | Codex environment variable | Purpose                            |
| ------------------ | -------------------------- | ---------------------------------- |
| `token`            | `CODEX_ACCESS_TOKEN`       | One upstream account access token. |

Both managed-account and Secret sources use `codex_pat` with
`CODEX_LOGIN_MODE=codex_pat`. Codex authenticates through
`codex -c cli_auth_credentials_store=file login --with-access-token`, derives
account identity from the token, and saves login state only in its bounded
ephemeral workload volume. Workspace ownership remains a control-plane
admission and reconciliation check; no workspace override is projected into
Codex. The separate Gateway receives no model credential. The trusted worker reads the source and manages
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
  leftover credential Secret, referenced-account deletion, missing credential,
  or unsupported Harness or OAuth deployment, or mismatched managed Backend binding.
- `409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED`: The Installation has no ChatGPT
  Backend, so issuance, deploying an Agent bound to an account without an
  access token, and deleting an account that holds one cannot succeed. Configure the
  [ChatGPT Backend](../guides/integrations/chatgpt.md).
- Provider denial or Kubernetes failure: Creation fails closed; compensation deletes
  only the newly created exact provider account, provider credential, or
  account-owned Secret when durable state confirms it was not committed.
- Unknown provider outcome: when an account create's reply is lost or unreadable,
  OCC cannot prove which provider account is its own (OCC requires only write
  scope and has no account read, and a name is not proof), so it deletes nothing
  and answers `503`. Check the workspace for an orphan named
  `<account name>-sa_…` whose ID no OCC account has. A reply that names a disabled
  account in this workspace removes that account. Provider deletion cannot be undone: if it applied but the request
  failed, the account stays in OCC and a retried delete completes.
- Invalid credential reply: a reply that names a credential under the requested
  account in this workspace revokes that credential before failing; if that fails,
  it answers `503`, and the API log says the credential could not be removed.
- Unknown Secret outcome: a failed token Secret create deletes the account-owned
  Secret holding this request's token, so issuance can be retried. If it cannot
  read or delete that Secret, it answers `503`. The leftover Secret then blocks
  each retry with a `409 RESOURCE_CONFLICT` that names it: `service-account-` plus
  the first 32 hex digits of the account ID's SHA-256, in the Namespace's control
  namespace (omitted when that name is long). An operator deletes it, for example
  `kubectl delete secret -n <namespace> <name>`, then retries. The failed issuance
  still revokes its token.
- Expired token: Execution fails closed; automated refresh and rotation are
  not implemented.

Every `503 DEPENDENCY_UNAVAILABLE` above answers the generic "A required platform
dependency is unavailable." The specific cause, such as "could not be removed" or
"outcome is unknown", is only in the API's own log: a WARN `http.dependency_unavailable`
record with the response's `meta.requestId`, the route, the error class and message,
and its causes' class and code. The logging Collector exports only the event and request ID.

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
