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
type carries a static token to one API endpoint. With a
[Credential Refresh Driver](drivers/credential-refresh.md) selected, its
`oauth2-client-credentials` and `oauth2-refresh-token` types carry OAuth2
access tokens that the gateway mints and refreshes itself. OpenShell is not a supported
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
- `type`: required; a type from the gateway catalog. A type the selected gateway
  does not offer fails with `409 RESOURCE_CONFLICT` and a message naming the
  fix, before any gateway call.
- `config`: optional nonsecret strings keyed by catalog field name. For the
  OpenShell `openai` type, `base_url` selects an HTTPS OpenAI-compatible `/v1`
  endpoint and defaults to `https://api.openai.com/v1`. Codex requires the
  OpenAI Responses API. Its optional `auth_header` selects `authorization`
  (Bearer, default) or `x-api-key` (raw key, dedicated Codex only). Endpoint
  and header selection are immutable; register a new source to change them.
  Invalid endpoint or header values return `400 INVALID_REQUEST`
  before OCC reads Secrets or stores a source record.
- `secrets`: Secret references keyed by catalog field name. Each Secret must
  belong to the same Namespace: a reference to another Namespace fails with
  `400 INVALID_REQUEST` before any Secret is read, and a reference to a Secret
  the Namespace does not hold fails with `404`.

OCC rejects unknown fields, missing required fields, and Driver-invalid configuration
before it reads any Secret. It reads each value through the Secret Driver, sends the values to the
gateway, and stores only the Secret references. OCC records the source as
`registering` before the gateway call. If the gateway rejects the registration,
OCC deletes any copy and the record. If the call fails without an answer, such as
on a timeout, a copy may still appear later, so the record stays listed as
`deleting`; send DELETE to remove it.

A `refresh`-type source becomes `ready` only after the gateway mints its first
token. If the issuer refuses the material or cannot be reached, registration
fails with `503` naming the Driver's failure code, and OCC removes the source.

## Read and list sources

`GET /namespaces/:namespaceId/credential-sources/:credentialSourceId` requires
exact `read`. It returns the record plus live `status` from the gateway:
`ready`, `pending`, `failed`, or `absent`, with an optional `reason`. If the
gateway cannot answer, `status` is `failed` with a fixed reason; the read still
succeeds. For a `refresh` type, `status.refresh` adds the token's `state`,
`expiresAt`, `nextRefreshAt`, `lastRefreshAt`, and, after a failure, a
`failureCode` and `recoveryAction`. It never contains a token.

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
named source from the list, fails with `400` "The Harness credential source must
be listed in the Agent's credentialSources." after the grant checks below.

The caller needs `credential_source:operate` on each exact
source, including any the update removes. Every source a request lists, including
one it keeps, must be `ready` and registered through the selected Credential
Gateway. Sources the Agent already binds need only `operate`, so after the
Installation selects another Credential Gateway, an update that leaves
`credentialSources` out still succeeds, and one that sets `harnessAuth` to
another method or source and lists only new sources, or `[]`, removes the old
ones. Listing an old source again fails with `503`, and so does deploying an
Agent that still lists one; see [After a Credential Gateway change](#after-a-credential-gateway-change). Deployment also requires the Agent's
service principal to have `operate` on each source; grant it with a
[Namespace IAM](authorization.md#manage-namespace-policy) Role and an exact
`credential_source` AccessBinding. The principal needs no permission on the
underlying Secret. The worker rechecks both grants before it
provisions the revision. On an Installation with no Credential Gateway, binding
any source fails with `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED`, as registration
does, once the caller holds `operate` on it. The paired Sandbox applies the
sources, and a Credential Gateway requires a Sandbox Driver, so on an
Installation without one, deploying an Agent that binds a source normally fails
with that `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED`. Only an Agent whose
`harnessAuth` names no source, but whose list kept sources from an earlier
configuration, fails first with `409 RESOURCE_CONFLICT` "Agent credential
sources require a selected Sandbox Driver." See [Harness execution](harness-execution.md#harness-authentication)
for the supported topology.

While a Credential Gateway is selected, deployment rejects `api_key` and
`codex_pat` bindings (both Secret and ServiceAccount sources) with `409`. Guided Agent
provisioning rejects credential sources with `400`; create the Agent, then
deploy it.

## Update a source

Updating the underlying Secret does not change the gateway's copy. To push a new
value, send
`PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId`. The
caller needs exact `credential_source:update` and `secret:operate` on every
Secret the update reads:

- An empty body `{}` re-reads the source's current Secrets. An
  `oauth2-refresh-token` source refuses it; see below.
- `{ "secrets": { "api_key": <SecretReference> } }` switches each named field to
  a replacement same-Namespace Secret. The field set stays the source type's
  catalog fields, and non-secret `config` cannot change; register a new source
  instead.

A successful update returns `200` with the source and its live gateway `status`.
Only a `ready` source can be updated. A gateway failure returns `503` and leaves
the Secret references unchanged; once the gateway may have changed, the failure
is audited. The gateway is updated before OCC commits, so
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

A `refresh`-type source keeps no static value: an update replaces its refresh
material and mints a new token, and OCC commits replacement Secret references
only after that mint succeeds. If the mint fails, the update returns `503`, but
the gateway keeps the new material; the source stays `ready` and its
`status.refresh` reports the failure. OCC does not restore the previous
material; update again with corrected Secrets. Running Agents lose the source's
token within about 10 seconds of an update, even a failed one, and receive none
until you redeploy them.

The issuer can replace an `oauth2-refresh-token` source's refresh token each
time the gateway uses it, so the recorded Secret may hold an already-used
token. Re-sending it can fail or make the issuer revoke the sign-in, so an
update that keeps the `refresh_token` Secret, including `{}`, returns `409`.
Complete a new sign-in, store its refresh token in a new Secret, and reference
that Secret.

## Rotate a refresh source

The gateway re-mints a `refresh`-type source's token before it expires, and
running Agents use the new token with the same placeholder. To replace a token
immediately, for example after a suspected leak, send
`POST /namespaces/:namespaceId/credential-sources/:credentialSourceId/rotate`
or run `occ credential-source rotate ID`. The caller needs exact
`credential_source:update`; rotation reads no Secret. The request returns `200`
with the source and its `status.refresh`, `409` for a static source, and `503`
when the gateway is unavailable or minting fails; a failed mint is audited.
Rotation does not revoke the previous token at the issuer, and Agents need no
redeploy.

When `status.refresh.recoveryAction` is `reauthorize`, the issuer revoked the
refresh token. Complete a new sign-in, store its refresh token in a new Secret,
and update the source to reference it.

## Withdraw a source from an Agent

Withdrawal revokes a source from an Agent's active revision while the revision
keeps running, and the source cannot be deleted until a redeploy replaces that
revision. [Credential source withdrawal](credential-sources/withdrawal.md)
covers the request, its retries, and maintenance.

## Delete a source

`DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId`
requires exact `delete` and returns `204`:

- It returns `409 RESOURCE_CONFLICT` while an Agent draft, active revision, or
  pending deployment references the source. Remove it from those Agents and
  redeploy, or delete them.
- When only a withdrawal attempt or retry series, queued or running for a
  revision that held the source, blocks it, the `409` is
  `CREDENTIAL_WITHDRAWAL_IN_PROGRESS`. A withdrawal that never confirms keeps
  its series queued for up to about an hour, even after a redeploy, and the
  withdraw request no longer applies once the active revision drops the
  source. Wait for the series to finish, or delete the Agent: a completed Agent
  deletion drops that work.
- On an Installation with no Credential Gateway it returns
  `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED`, and for a source the selected driver
  did not register it returns `503`; neither changes the record.
- It marks the record `deleting` before it asks the gateway to remove its copy.
  A gateway failure returns `503` and leaves the record `deleting`. Send the same
  request again; an already-removed copy counts as deleted.
- Within 70 seconds of registration, deletion removes the copy but returns `503`
  and keeps the record, because a timed-out registration could still create a
  copy. Retry after that window.

While a source exists, including one in `deleting`, its Namespace cannot be
deleted, and its referenced Secrets cannot be deleted.

## After a Credential Gateway change

A source belongs to the Credential Gateway Driver that registered it. After the
Installation selects another driver in `drivers.credential_gateway`, binding,
deploying, updating, or deleting an old source returns
`503 DEPENDENCY_UNAVAILABLE` with one fixed message: "The selected Credential
Gateway Driver did not register this credential source. …". OCC answers it only
after the caller's grant and the source lookup. `GET` on such a source reports a
`failed` status whose reason names the driver change.

- To keep an Agent running, register a replacement source through the selected
  driver, list it in place of the old one, and deploy again.
- To delete an old source, an administrator changes the Installation
  configuration to select the driver ID that registered it again, deletes the
  source, then selects the new driver. The same steps finish a source that an earlier release left
  `deleting` after a gateway change, which otherwise keeps its Namespace and
  Secrets from being deleted.

## Errors

| Status                                  | Meaning                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `400 INVALID_REQUEST`                   | The body, field name, or configuration value is invalid, a Secret reference names another Namespace, or a credential-source `harnessAuth` is not listed.                                                                                               |
| `403 FORBIDDEN`                         | A required `credential_source` or `secret` permission is missing.                                                                                                                                                                                      |
| `404 NOT_FOUND`                         | The source or Secret is not in the exact Namespace, or a catalog field is invalid; or the Agent's active revision does not use the source or has no withdrawal for it.                                                                                 |
| `409 NAMESPACE_NOT_READY`               | The Namespace is not `ready`.                                                                                                                                                                                                                          |
| `409 RESOURCE_CONFLICT`                 | The source is still referenced, not `ready` for an update or rotation, static for a rotation, or changed during the request; the gateway does not offer its type; the Agent has no active revision to withdraw from; or sources need a Sandbox Driver. |
| `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` | Registration, update, rotation, deletion, Agent binding, or deploying an Agent that binds a source, on an Installation that selects no Credential Gateway.                                                                                             |
| `503 DEPENDENCY_UNAVAILABLE`            | The selected Credential Gateway, Credential Refresh Driver, or Secret Driver is unavailable, the gateway call failed, a `refresh` type could not mint a token, or the source was registered through a previously selected gateway.                     |

## Related

- [CredentialGatewayDriver contract](drivers/credential-gateway.md)
- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Credential source withdrawal](credential-sources/withdrawal.md)
- [Secrets](../guides/topics/secrets.md) and [Permissions](cheatsheets/permissions.md)
- [HTTP API: credential sources](api.md#credential-sources)
