# Credential sources

A credential source registers a Namespace Secret with the Installation's
selected [Credential Gateway](drivers/credential-gateway.md). The gateway keeps
its own copy of the value and applies it outside the Agent workload, so the
Harness never receives the real credential. An Agent uses a model source through
[`harnessAuth`](agents.md#harness-authentication) and other sources through its
`credentialSources` list.

Credential sources require a selected Credential Gateway. The only
implementation is the [OpenShell Credential Gateway](drivers/openshell-credential-gateway.md).
Its `openai` type authenticates dedicated Codex models, and its `bearer-token`
type carries a static token to one API endpoint. OpenShell is not a supported
production Agent path; see its
[qualification requirements](drivers/openshell-sandbox.md#qualification-contract).

## Register a source

1. Wait for the Namespace to become `ready`.
2. [Create a Secret](drivers/kubernetes-secret.md#create-a-namespace-owned-secret)
   that holds the value, and keep its `ref`.
3. Send `POST /namespaces/:namespaceId/credential-sources`. The caller needs
   `credential_source:create` on the Namespace and `secret:operate` on every
   referenced Secret:

   ```json
   {
     "name": "openai-production",
     "type": "openai",
     "secrets": {
       "api_key": {
         "kind": "secret",
         "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
         "id": "sec_123e4567-e89b-42d3-a456-426614174000"
       }
     }
   }
   ```

A successful request returns `201` with the source metadata. Its `id` starts
with `cs_`, and `ref` is the reference used in Agent bindings. The response
includes the gateway's `status` but never a credential value.

The request fields are:

- `name`: required; unique within the Namespace.
- `type`: required; a type from the gateway catalog. Unknown types fail with
  `404` before any gateway call.
- `config`: optional nonsecret strings keyed by catalog field name.
- `secrets`: Secret references keyed by catalog field name. Each Secret must
  belong to the same Namespace: a reference to another Namespace fails with
  `400 INVALID_REQUEST` before any Secret is read, and a reference to a Secret
  the Namespace does not hold fails with `404`.

OCC rejects unknown fields and missing required fields before it reads any
Secret. It reads each value through the Secret Driver, sends the values to the
gateway, and stores only the Secret references. OCC records the source as
`registering` before the gateway call. If the gateway rejects the registration,
OCC deletes any copy and the record. If the call fails without an answer, such as
on a timeout, a copy may still appear later, so the record stays listed as
`deleting`; send DELETE to remove it.

## Read and list sources

`GET /namespaces/:namespaceId/credential-sources/:credentialSourceId` requires
exact `read`. It returns the record plus live `status` from the gateway:
`ready`, `pending`, `failed`, or `absent`, with an optional `reason`. If the
gateway cannot answer, `status` is `failed` with a fixed reason; the read still
succeeds.

`GET /namespaces/:namespaceId/credential-sources` requires Namespace `read`
and returns only sources on which the caller has exact `read`. Lists
do not call the gateway and omit `status`.

The record's `state` is `registering`, `ready`, or `deleting`. A source left
`registering` by an interrupted request never becomes usable; delete it to
remove any gateway copy. A `registering` or `deleting` source cannot be
bound or deployed.

## Bind a source to an Agent

List every source the Agent uses in its `credentialSources`, up to eight
entries of `{ "sourceId": "cs_…" }`, on create or update. An update replaces the
list, `[]` removes it, and a source cannot appear twice. Any catalog type can be
listed.

To have the Harness authenticate its model with a source, also set
`harnessAuth` to `{ "method": "credential_source", "sourceId": "cs_…" }`. It
names one listed entry whose catalog type has `harnessAuth`; it does not bind
the source separately. A request that names an unlisted source, or removes the
named source from the list, fails with `404`.

The caller needs `credential_source:operate` on each exact
source, including any the update removes. Deployment also requires the Agent's
service principal to have `operate` on each source; grant it with a
[Namespace IAM](authorization.md#manage-namespace-policy) Role and an exact
`credential_source` AccessBinding. The principal needs no permission on the
underlying Secret. The worker rechecks both grants before it
provisions the revision. See [Harness execution](harness-execution.md#harness-authentication)
for the supported topology.

While a Credential Gateway is selected, deployment rejects `api_key`,
and `codex_pat` bindings (both Secret and ServiceAccount sources) with `409`. Guided Agent
provisioning rejects credential sources with `400`; create the Agent, then
deploy it.

## Update a source

Updating the underlying Secret does not change the gateway's copy. To push a new
value, send
`PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId`. The
caller needs exact `credential_source:update` and `secret:operate` on every
Secret the update reads:

- An empty body `{}` re-reads the source's current Secrets.
- `{ "secrets": { "api_key": <SecretReference> } }` switches each named field to
  a replacement same-Namespace Secret. The field set stays the source type's
  catalog fields, and non-secret `config` cannot change; register a new source
  instead.

A successful update returns `200` with the source and its live gateway `status`.
Only a `ready` source can be updated. A gateway failure returns `503` and leaves
the Secret references unchanged. The gateway is updated before OCC commits, so
if the request fails after that, repeating the same request converges. If the
gateway no longer holds a copy (`absent`), the update also returns `503`;
delete the source and register it again.

Migration `0048_administrator_credential_source_grants` adds the current
`credential_source` grants, including `update`, to an unchanged built-in
Installation administrator Role from an earlier bootstrap. Other Roles keep
their exact grants; grant `update` through a Namespace Role where needed.

A running Agent keeps the previous value until its Harness restarts, because the
gateway gives updated values only to new processes. To rotate a key:

1. Update the Secret's value (`occ secret update`), or create a replacement
   Secret.
2. Run `occ credential-source update ID`, adding `--file` with replacement
   `secrets` if you created a new Secret.
3. Redeploy each Agent that uses the source.

## Withdraw a source from an Agent

Withdrawal revokes a source from an Agent's active revision while the revision
keeps running. Send
`POST /namespaces/:namespaceId/agents/:agentId/credential-sources/:credentialSourceId/withdraw`.
The caller needs `agent:operate`, and the active revision must have been
admitted with that source, as its Harness authentication or in
`credentialSources`. The request returns `202` with the withdrawal in state `pending`.
A replay returns the same withdrawal. It queues another attempt only if no
attempt is already queued or running.

The worker detaches the source from the revision's Sandbox and records
`revoked` only after the gateway confirms that the revision's placeholders no
longer resolve, even in running processes. Requests already forwarded upstream
are not undone. Read the state with
`GET /namespaces/:namespaceId/agents/:agentId/credential-sources/:credentialSourceId/withdrawal`,
which requires `agent:read`. It returns `requestedBy`, the principal whose
`agent:operate` the worker rechecks, `reason` with `lastAttemptAt` for the
worker's latest attempt, and `withdrawalInProgress`, which is `true` while an
attempt is queued or running. A `pending` withdrawal with reason
`CREDENTIAL_WITHDRAWAL_PENDING` is waiting for the gateway; a Sandbox without a
running process never confirms revocation. `AUTHORIZATION_DENIED` or
`ACTOR_REVOKED` means the requester lost `agent:operate`.

The worker retries an unconfirmed withdrawal a few times with backoff
(`OCC_WORKER_MAX_ATTEMPTS`). When those attempts run out, the withdrawal stays
`pending` with `withdrawalInProgress: false`, and nothing retries it on its own
unless the revision has maintenance (see below). Send the withdraw request
again to queue another attempt.

A withdrawn source never re-attaches to that revision. If its Sandbox is
recreated, a withdrawn source is left out and the revision keeps running
without it, unless `harnessAuth` names it. A withdrawn Harness source instead fails provisioning with
`CREDENTIAL_WITHDRAWN`, and maintenance of the revision stops preparing it. While any
withdrawal is `pending`, each maintenance pass queues another attempt if none is
outstanding. After model-source withdrawal, maintenance never prepares the revision
again. It continues recovering pending tool withdrawals even when the model
source is already `revoked`, and stops only when every withdrawal is `revoked`.
Redeploy to resume Compute repair.

Withdrawals of different sources on one revision share one worker attempt, but
each is authorized by its own `requestedBy`. A requester who lost
`agent:operate` leaves only their withdrawal `pending` with
`AUTHORIZATION_DENIED`; the others are still revoked.

The revision still references the source, so the source cannot be deleted until
a redeploy replaces the revision. Redeploy the Agent with a replacement source
or another authentication method.

## Delete a source

`DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId`
requires exact `delete` and returns `204`:

- It returns `409` while an Agent draft, active revision, or pending deployment
  references the source.
- It marks the record `deleting` before it asks the gateway to remove its copy.
  A gateway failure returns `503` and leaves the record `deleting`. Send the same
  request again; an already-removed copy counts as deleted.
- Within 70 seconds of registration, deletion removes the copy but returns `503`
  and keeps the record, because a timed-out registration could still create a
  copy. Retry after that window.

While a source exists, including one in `deleting`, its Namespace cannot be
deleted, and its referenced Secrets cannot be deleted.

## Errors

| Status                                  | Meaning                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`                   | The body or a field name is malformed, or a Secret reference names another Namespace.                                                                                                    |
| `403 FORBIDDEN`                         | A required `credential_source` or `secret` permission is missing.                                                                                                                        |
| `404 NOT_FOUND`                         | The source, Secret, or type is not in the exact Namespace or catalog, or a catalog field is invalid; or the Agent's active revision does not use the source or has no withdrawal for it. |
| `409 NAMESPACE_NOT_READY`               | The Namespace is not `ready`.                                                                                                                                                            |
| `409 RESOURCE_CONFLICT`                 | The source is still referenced, not `ready` for an update, or changed during the request; or the Agent has no active revision to withdraw from.                                          |
| `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` | Registration on an Installation that selects no Credential Gateway.                                                                                                                      |
| `503 DEPENDENCY_UNAVAILABLE`            | The selected Credential Gateway or the Secret Driver is unavailable, or the gateway call failed.                                                                                         |

## Related

- [CredentialGatewayDriver contract](drivers/credential-gateway.md)
- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Secrets](../guides/topics/secrets.md) and [Permissions](cheatsheets/permissions.md)
- [HTTP API: credential sources](api.md#credential-sources)
