# Credential sources

A credential source is a named Namespace record that an Agent can bind by ID.
OpenClaw Control Plane (OCC) records the Driver that owns it. The
record contains configuration and any Secret references. The delivery
mode determines who can read the underlying credential and when.

| Delivery mode            | Who holds or reads the credential                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway copy             | The selected OpenShell Credential Gateway stores a copy of a static Secret. The workload receives a placeholder. Its supervisor injects the real value on eligible traffic. Editing the Secret alone leaves the copy unchanged.     |
| Gateway-managed OAuth    | The Credential Refresh Driver holds issuer material and manages access tokens for the Gateway. The workload keeps its placeholder across token renewal.                                                                             |
| Protected live Secret    | After OCC authorizes an individual request, the trusted resolver reads the current Secret version. The authenticated sender receives the credential header for that request. An existing Gateway source requires explicit adoption. |
| Worker-prepared token    | For `github-app-metadata`, the issuer owner uses the App key to prepare a GitHub installation token in the background. The request path can select a usable committed token. It cannot mint one.                                    |
| Credential-free metadata | The source admits a specific repository identity read. Its resolver reads no Secret and its sender adds no credential header. Request and response controls still apply.                                                            |

Gateway delivery supports `openai` API keys for dedicated Codex and native
OpenClaw models, `codex-pat` for dedicated Codex and `bearer-token` for a
single API endpoint. Selecting a [Credential Refresh Driver](drivers/credential-refresh.md) also enables experimental
`codex-oauth` device login, `oauth2-client-credentials` and `oauth2-refresh-token`.
OpenShell is a development integration. See the
[OpenShell qualification requirements](drivers/openshell-sandbox.md#qualification-contract),
[Credential Proxy overview](../design/credential-proxy.md) and
[threat model](security/credential-proxy.md).

## Register a source

1. Wait for the Namespace to become `ready`.
2. For a Secret-backed source, [create a Secret](drivers/kubernetes-secret.md#create-a-namespace-owned-secret) and keep its `ref`.
3. Send `POST /namespaces/:namespaceId/credential-sources`. The caller needs
   `credential_source:create` on the Namespace and `secret:operate` on each
   referenced Secret. A protected metadata source also requires `agent:operate`
   on the active, dedicated Agent named by `config.agent_id` in that Namespace.

For example, these registration fields identify a model key without including its value.

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

Success returns `201` with a `cs_` source ID, binding `ref` and status. Use
the returned ID in the Agent draft. Keep the `sec_` reference on the source.

- `name` is unique within the Namespace.
- `type` must be offered by the installation. With a Credential Proxy selected,
  registration also requires a protected profile for that type.
- `config` contains nonsecret catalog fields. OpenShell's `openai` type defaults
  to `https://api.openai.com/v1`. A custom `base_url` must use HTTPS, a DNS
  hostname and a path ending in `/v1`. Codex requires the Responses API.
  OCC normalizes the endpoint before storage. Changing it requires a new source.
- `secrets` maps catalog fields to same-Namespace Secret references. OCC rejects
  cross-Namespace references with `400` and missing Secrets with `404`.

OCC rejects unknown fields, missing required fields, and Driver-invalid configuration
with `400 INVALID_REQUEST`, which names the field and points at `/config/<field>` or
`/secrets/<field>`, before reading Secrets through
the Secret Driver. OCC records `registering` before the external operation.
For Gateway copies, definitive rejection triggers cleanup. An uncertain write,
such as a timeout, leaves the source `deleting` because a copy may still
appear. Use DELETE to finish cleanup.

Secret-backed refresh sources complete registration only after the gateway
mints the first token. If the issuer refuses the material or cannot be reached,
registration fails with `503` naming the Driver's failure code, and OCC removes
the source. Device-authorized sources register before login; their live status
stays `pending` until login and managed-token setup complete.

## Read and list sources

`GET /namespaces/:namespaceId/credential-sources/:credentialSourceId` requires
exact `read`. A Gateway copy reports the Gateway's live `status` as `ready`,
`pending`, `failed` or `absent`, with an optional reason. A Gateway outage
produces `failed` status on a successful read. For a refresh source,
`status.refresh` reports state, expiry and refresh times, and any failure code
and recovery action, never a token. A prepared source can have record state `ready` and live
status `pending` while its worker prepares the token.

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

The caller needs permission to create or update the Agent and exact `credential_source:operate` on every current and requested
source, including removals. OCC requires each requested source to be ready and
its recorded owner to be selected. A newly registered protected metadata source records its Proxy
owner. A Gateway source retains its Gateway owner even if a Proxy enforces a
protected plan for it. Omitting the list leaves bindings unchanged. To remove an
old binding after a Driver change, replace the list and change `harnessAuth` if
necessary.

At deploy, both the actor and the Agent service principal need exact source
`operate`. Grant the principal a [Namespace IAM Role and AccessBinding](authorization.md#manage-namespace-policy)
for this source. The Agent needs no underlying Secret permission. The immutable
Agent revision records the source ID, type and owning Driver ID. Its protected
plan also fixes the execution, source generation, allowed operation and routes.
The worker rechecks both principals before provisioning. For a protected
request, OCC checks current Agent permission before material access and before send.

| What the workload may know                       | What it can do with it                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source ID (`cs_…`) or Secret reference (`sec_…`) | Identify a record. The identifier alone conveys no permission to read a value or use the source.                                                                               |
| OpenShell placeholder                            | Use eligible traffic from the configured Sandbox. The placeholder cannot authenticate directly to the provider.                                                                |
| Native repository session bearer                 | Present delegated authority to the credential service within the live session's scope. A process that obtains it can use that authority subject to the service's other checks. |

Git clone, push and approved GitHub API operations use separately admitted
[`repositoryBindings`](repository-credentials.md). Binding a metadata source for
one repository does not grant Git or pull request access. To authenticate the Harness with a
credential source, select a compatible Gateway source. Source-backed deployment requires a Sandbox. See the [binding and deployment trace](../flows/credential-source-lifecycle.md#4-bind-the-source-to-an-agent).

While a Credential Gateway is selected, deployment and guided provisioning reject
`api_key` and `codex_pat` bindings (both Secret and ServiceAccount sources) with `409`.
Guided provisioning accepts a ready model source in `harnessAuth`, records it in
the Agent's `credentialSources`, and grants its service principal exact source
`operate` access. The caller needs source `operate`; the Agent receives no
permission on the underlying model Secret. Queued and running provisioning jobs
keep their source referenced before the Agent exists.

The Console uses the selected gateway catalog from Installation capabilities.
For supported Dedicated API-key creation, it registers the selected model Secret
before submitting the provisioning request; the provider and Secret controls are
shared by both Harnesses. See [Console creation](console/create-and-deploy.md).

## Update a source

Device-authorized sources reject PATCH with `409` before reading Secrets or
changing refresh state. Sign in again and replace the Agent binding instead.

For an ordinary static Gateway source, updating the Secret does not change the copy. To push a new
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

Prepared and credential-free sources reject PATCH and rotation with `409`. Register a replacement source. For a live static source, changing the referenced Secret value affects subsequent eligible reads. Changing its reference or adopting a legacy source requires an unbound source. See [protected static inference](credential-sources/protected-inference.md#static-source-and-response-policy).

Migration `0048_administrator_credential_source_grants` adds the current
`credential_source` grants, including `update`, to an unchanged built-in
Installation administrator Role from an earlier bootstrap. Other Roles keep
their exact grants; grant `update` through a Namespace Role where needed.

Updated Gateway copies reach new Harness processes only. To rotate a copied key, follow these steps.

1. Update the Secret's value (`occ secret update`), or create a replacement
   Secret.
2. Run `occ credential-source update ID`, adding `--file` with replacement
   `secrets` if you created a new Secret.
3. Redeploy each Agent that uses the source.

A Secret-backed `refresh` source keeps no static value: an update replaces its refresh
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
refresh token. For a Secret-backed source, store new authorization material in a
new Secret and update the source. For device authorization, sign in again and
replace the Agent binding.

## Withdraw a source from an Agent

Withdrawal revokes a source from an Agent's selected version while the version
keeps running, and the source cannot be deleted until a redeploy replaces that
version. [Credential source withdrawal](credential-sources/withdrawal.md)
covers the request, its retries, and maintenance.

## Delete a source

`DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId`
requires exact `delete` and returns `204`:

- It returns `409 RESOURCE_CONFLICT` while an Agent draft, selected version, pending deployment, or queued/running provisioning request references the source. Wait for provisioning, remove the binding and redeploy, or delete the Agent.
- When only a queued/running withdrawal attempt or retry series blocks it, the `409` is `CREDENTIAL_WITHDRAWAL_IN_PROGRESS`. A withdrawal that never confirms keeps its series queued for up to about an hour, even after redeployment; the request no longer applies once the selected version drops the source. Wait for the series to finish, or delete the Agent: completed deletion drops that work.
- With neither a Credential Gateway nor a Credential Proxy selected, deletion returns
  `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED`. Selecting a different Driver for the recorded owner returns
  `503`. OCC keeps the source record in both cases.
- OCC marks the record `deleting` before cleanup. For a Gateway copy, OCC asks the Gateway to remove it.
  A dependency failure returns `503`; an OpenShell provider ownership mismatch
  returns `404`. Both retain `deleting`. Resolve ownership drift before retrying;
  an already-removed copy counts as deleted.
- For a prepared GitHub source, `409 CREDENTIAL_TOKEN_UNSETTLED` means a token
  it issued may still be valid: GitHub's answer to an issue or revocation was lost.
  The record stays `deleting`. Retry after the time in the message, at most 72
  minutes after the attempt. A refused issue with no token does not block deletion.
  While the worker is revoking a token, deletion waits up to 25 seconds for GitHub's answer.
- Within 70 seconds of registration, cleanup returns `503`
  and keeps the record, because a timed-out registration could still create a
  copy. The message names the seconds left; retry after them.

While a source exists, including one in `deleting`, its Namespace cannot be
deleted, and its referenced Secrets cannot be deleted.

## After a Credential Gateway change

A Gateway-owned source belongs to the Driver that registered it. After the
Installation selects another driver in `drivers.credential_gateway`, binding,
deploying, updating, or deleting an old source returns
`503 DEPENDENCY_UNAVAILABLE` with one fixed message: "The selected Credential
Gateway Driver did not register this credential source. …". OCC answers it only
after the caller's grant and the source lookup. `GET` on such a source reports a
`failed` status whose reason names the driver change.

- To keep an Agent running, register a replacement source through the selected
  driver, list it in place of the old one, and deploy again.
- To delete an old source, an administrator reselects its original driver ID,
  deletes it, then selects the new driver. This also finishes sources left
  `deleting` by earlier releases, unblocking Namespace and Secret deletion.

## Errors

| Status                                  | Meaning                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`                   | Invalid request, catalog field, configuration or cross-Namespace Secret reference, or an unlisted Harness source.                                                   |
| `403 FORBIDDEN`                         | A required permission on the source, Secret or Agent is missing.                                                                                                    |
| `404 NOT_FOUND`                         | The exact Namespace lacks the source, Secret or named Agent, or the selected version has no matching withdrawal.                                                    |
| `409 NAMESPACE_NOT_READY`               | Wait for the Namespace to become ready.                                                                                                                             |
| `409 AGENT_DELETING`                    | A protected source names an Agent being deleted.                                                                                                                    |
| `409 RESOURCE_CONFLICT`                 | The type, Agent, Driver selection or requested operation is incompatible, the source is still referenced, or its state changed. The message describes the conflict. |
| `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` | The operation requires a Credential Gateway and none is selected.                                                                                                   |
| `503 DEPENDENCY_UNAVAILABLE`            | A required Driver or issuer is unavailable, a Gateway operation or mint failed, or the selected Driver differs from the recorded owner.                             |

## Related

- [Protected credential request flow](../flows/credential-source-egress.md)
- [OpenShell Credential Gateway](drivers/openshell-credential-gateway.md)
- [CredentialGatewayDriver contract](drivers/credential-gateway.md)
- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Credential source withdrawal](credential-sources/withdrawal.md)
- [Secrets](../guides/topics/secrets.md) and [Permissions](cheatsheets/permissions.md)
- [HTTP API: credential sources](api.md#credential-sources)
