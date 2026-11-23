# Other credential delivery modes

This page describes legacy serving paths. The current Source API no longer admits or returns Gateway or old Proxy Source formats, so the former Source CRUD examples below cannot enroll or manage new Sources. Use the [TokenService Source API](../credential-sources.md#register-a-source) for current registration.

For a dedicated Agent, the **OpenClaw Gateway Pod** reads its admitted channel credentials and any configured Gateway password from Kubernetes Secrets. It does not receive the Harness model credential. Embedded execution combines Gateway and Harness in one workload. See [runtime credential placement](../drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials).

The **OpenShell Credential Gateway** is a separate credential service. When selected, the **Harness** runs in an OpenShell Sandbox. The Credential Gateway manages Providers: static Sources copy Secrets, while refresh Sources keep issuer or grant material in OpenShell custody. The trusted supervisor substitutes credentials for placeholders on matching outbound requests.

- **Static Credential Gateway Source:** `openai` supports dedicated OpenClaw and Codex model keys, `codex-pat` supports dedicated Codex, and `bearer-token` supports one API endpoint. OCC copies the referenced Secret into an OpenShell Provider. Editing the Secret alone does not update that copy.
- **Credential Gateway OAuth Source:** for example, a Sandbox tool can use `oauth2-client-credentials` to call an OAuth API. The [Credential Refresh Driver](../drivers/credential-refresh.md) configures OpenShell with issuer material; OpenShell obtains and renews the access token while the tool keeps its placeholder. `oauth2-refresh-token` and experimental `codex-oauth` device login still use this Driver. Device starts commit audit with source and session writes; see the [device authorization flow](../../flows/credential-source-refresh.md#device-authorization-and-configuration).
- **Protected static Secret delivery:** this contract requires a qualified sender. OCC authorizes the request, a trusted resolver reads the current Secret, and the sender adds the approved credential header. The Harness does not receive the Secret. Bundled OpenShell refuses new protected static OpenAI Sources and revisions with `409 RESOURCE_CONFLICT`. See [protected static inference](protected-inference.md#bundled-openshell-admission).
- **Prepared GitHub token:** for `github-app-metadata`, TokenService renews installation tokens in the background. An authorized Credential Proxy request can also start or join issuance for its exact registered grant.
- **Credential-free repository metadata:** `credential-free-repository-metadata` permits an admitted repository identity read without reading a Secret or adding a credential header. Request and response controls still apply.

OpenShell is a development integration. See the
[OpenShell qualification requirements](../drivers/openshell-sandbox.md#qualification-contract),
[Credential Proxy overview](../../design/credential-proxy.md) and
[threat model](../security/credential-proxy.md).

## Register a source

1. Wait for the Namespace to become `ready`.
2. For a Secret-backed source, [create a Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret) and keep its `ref`.
3. Send `POST /namespaces/:namespaceId/credential-sources`. The caller needs
   `credential_source:create` on the Namespace and `secret:operate` on each
   referenced Secret. A protected metadata source requires `agent:operate`
   on the active, dedicated Agent named by `config.agent_id` in that Namespace.

The protected GitHub metadata example requires a qualified sender and Sandbox that enforce the protected exchange. Stock OpenShell does not provide this path; see [protected-exchange requirements](../../design/credential-proxy.md#which-checks-does-openshell-provide).

Replace the sample IDs and Secret reference. Execution authority admits every process in that execution.

```json
{
  "name": "widgets-metadata",
  "type": "github-app-metadata",
  "config": {
    "app_id": "1001",
    "installation_id": "2002",
    "repository_id": "12345",
    "repository": "acme/widgets",
    "agent_id": "agt_123e4567-e89b-42d3-a456-426614174000",
    "authority": "execution"
  },
  "secrets": {
    "private_key": {
      "kind": "secret",
      "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
      "id": "sec_123e4567-e89b-42d3-a456-426614174000"
    }
  }
}
```

The `201` response includes the `cs_` ID and binding `ref`. Gateway registrations also report status. Secret-backed sources retain their `sec_` references.

- `name` is unique within the Namespace.
- Select an offered `type`. With a Proxy selected, fresh Gateway registration requires
  a static Harness model type and the bundled Proxy handling only Git. Refresh, device
  authorization and ChatGPT OAuth are ineligible. Other registrations require protected
  admission. Explicit live adoption preserves ownership.
- `config` contains nonsecret catalog fields. OpenShell's `openai` type accepts
  `authorized_base_url` as immutable destination authorization. Omission authorizes
  only `https://api.openai.com/v1`. Custom authorization must match the
  [revision provider](../drivers/kubernetes-compute/model-provider.md) at deployment and delivery.
  `base_url` cannot select a route. Register a replacement Source to change destination authorization.
- `secrets` maps catalog fields to same-Namespace Secret references. OCC rejects
  cross-Namespace references with `400` and missing Secrets with `404`.

Before reading Secrets, OCC rejects invalid fields or configuration with `400 INVALID_REQUEST`
at `/config/<field>` or `/secrets/<field>`. OCC records `registering` before the external operation.
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

The record's `state` is `registering`, `ready`, or `deleting`. Bind only ready sources. Delete interrupted registrations to retire owner material.

## Bind a source to an Agent

Set `credentialSources` to a list of up to 64 distinct
`{ "sourceId": "cs_…" }` entries. On update, the list replaces the draft's
bindings. Omit it to keep them or send `[]` to remove them all.

| When                       | Required source permissions                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create or update the Agent | The caller needs the corresponding `agent:create` or `agent:update` and `credential_source:operate` on each current and requested source, including removals.                              |
| Deploy                     | The caller needs `agent:deploy`. Both the caller and the Agent service principal need `credential_source:operate` on each listed source. The worker checks both again before provisioning. |
| Use a protected source     | OCC checks the Agent service principal's current `credential_source:operate` before it releases material and again before it authorizes the send.                                          |

[Grant the Agent service principal access to the source](../authorization.md#manage-namespace-policy)
with a Namespace IAM Role and AccessBinding. The Agent needs no permission on the
underlying Secret. Each requested source must be ready and its recorded owner
selected. Newly registered metadata sources belong to the Credential Proxy.
A Gateway source retains its Gateway owner even when the Proxy enforces its plan.

Deployment with credential sources requires a selected Sandbox Driver. For these delivery modes, the revision records each Source's ID, type, and owning Driver ID. For the `widgets-metadata` example, the protected
plan allows `GET /repos/acme/widgets` for that execution and source generation. Follow the
[request to GitHub and its reply](../../flows/credential-source-egress.md#follow-the-metadata-get).
Cloning, pushing or creating a pull request requires a separately admitted
[repository binding](../repository-credentials.md).

For **source-backed Harness authentication**, set `harnessAuth` to
`{ "method": "credential_source", "sourceId": "cs_…" }`. Choose a listed
Gateway source whose catalog type supports Harness authentication. Naming an
unlisted source, or removing it while `harnessAuth` still names it, fails after the grant checks with `400`: "The Harness credential source must be listed in the Agent's credentialSources." When replacing a binding after a Driver change,
update `harnessAuth` if it names the old source.

| What the workload may know       | What it can do with it                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Source ID or Secret reference    | Identify a record. An ID conveys no permission to use a source or read a value.                           |
| OpenShell placeholder            | Use eligible traffic from the configured Sandbox. The provider requires the real credential.              |
| Native repository session bearer | Exercise delegated authority within the live session's scope, subject to the credential service's checks. |

While a Credential Gateway is selected, deployment and guided provisioning reject
`api_key` and `codex_pat` bindings (both Secret and ServiceAccount sources) with `409`.
Guided provisioning accepts a ready Gateway model source in `harnessAuth`, records it in
the Agent's `credentialSources`, and grants its service principal exact source
`operate` access. The caller needs source `operate`; the Agent receives no
permission on the underlying model Secret. Queued and running provisioning jobs
keep their source referenced before the Agent exists.

The Console reads the Gateway catalog from Installation or [Namespace Agent capabilities](../authorization/default-users.md#create-agents-in-the-console).
Both Dedicated Harnesses share provider and Secret controls. API-key provisioning registers the Secret first. See [Console creation](../console/create-and-deploy.md).

For an Agent without repositories on the bundled Git-only Proxy, bind the matching
ready static Harness model source from the selected Gateway as the Agent’s only
credential source. See the [OpenShell Gateway request path](../drivers/openshell-credential-gateway.md#follow-a-codex-request-through-openshell).

## Update a source

Device-authorized sources reject PATCH with `409` before reading Secrets or
changing refresh state. Sign in again and replace the Agent binding instead.

To replace a static Gateway copy, send
`PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId` with exact
`credential_source:update` and `secret:operate` on every Secret read. Updating
the Secret alone does not change the copy:

- `{}` re-reads current Secrets; `oauth2-refresh-token` refuses it (see below).
- `{ "secrets": { "api_key": <SecretReference> } }` switches each named field to
  a replacement same-Namespace Secret. The field set stays the source type's
  catalog fields, and non-secret `config` cannot change; register a new source
  instead.

Only a `ready` source can be updated. Success returns `200` with the source and
live Gateway `status`. A Gateway failure returns `503`, preserves Secret references,
and is audited if the Gateway might have changed. The Gateway updates before OCC
commits, so retrying converges. If its copy is `absent`, delete and register the source again.

Prepared and credential-free sources reject PATCH and rotation with `409`. Register a replacement source. For a live static source, changing the referenced Secret value affects subsequent eligible reads. Changing its reference or adopting a legacy source requires an unbound source. See [protected static inference](../credential-sources/protected-inference.md#static-source-and-response-policy).

Updated Gateway copies reach new Harness processes only. To rotate a copied key, follow these steps.

1. Update the Secret's value (`occ secret update`), or create a replacement
   Secret.
2. Run `occ credential-source update ID`, adding `--file` with replacement
   `secrets` if you created a new Secret.
3. Redeploy each Agent that uses the source.

With OpenShell, step 2 [briefly interrupts running Agents](../drivers/kubernetes-secret.md#update-and-redeploy) that use the Source.

A Secret-backed `refresh` source keeps no static value: an update replaces its refresh
material and mints a new token, and OCC commits replacement Secret references
only after that mint succeeds. If the mint fails, the update returns `503`, but
the gateway keeps the new material; the source stays `ready` and its
`status.refresh` reports the failure. OCC does not restore the previous
material; update again with corrected Secrets. Running Agents lose the source's
token within about 10 seconds of an update, even a failed one, and receive none
until you redeploy them.

An issuer may rotate a refresh token on use. Reusing the recorded Secret can
fail or revoke the sign-in. An `oauth2-refresh-token` update that retains the
`refresh_token` Secret, including `{}`, returns `409`. Sign in again, save the
new token in a new Secret, and reference it.

## Rotate a refresh source

For sources with `rotation: refresh`, the Gateway renews the access token before
it expires. Running Agents keep the same placeholder. To rotate immediately, call
`POST /namespaces/:namespaceId/credential-sources/:credentialSourceId/rotate`
or run `occ credential-source rotate ID`. Rotation requires exact
`credential_source:update`, reads no Secret, and needs no redeploy. It does
not revoke the previous token at the issuer.

Success returns `200` with the source and `status.refresh`. Static sources
return `409`; an unavailable gateway or failed mint returns `503`. Failed
mints are audited.

`status.refresh.recoveryAction: reauthorize` means the issuer revoked the refresh
token. Update a Secret-backed source with a new authorization Secret. For device
authorization, sign in again and replace the Agent binding.

Prepared issuers cannot rotate on demand. If their provider advertises
`rotation: refresh`, enrollment returns `501` before reading Secret material,
configuring the issuer, or calling Credential Refresh.

## Withdraw a source from an Agent

Withdrawal revokes a source from an Agent's selected version while the version
keeps running, and the source cannot be deleted until a redeploy replaces that
version. [Credential source withdrawal](../credential-sources/withdrawal.md)
covers the request, its retries, and maintenance.

## Delete a source

`DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId`
requires exact `delete` and returns `204`:

- It returns `409 RESOURCE_CONFLICT` while an Agent draft, selected version, pending deployment, or queued/running provisioning request references the source. Wait for provisioning, remove the binding and redeploy, or delete the Agent.
- When only a queued/running withdrawal attempt or retry series blocks it, the `409` is `CREDENTIAL_WITHDRAWAL_IN_PROGRESS`. A withdrawal that never confirms keeps its series queued for up to about an hour, even after redeployment; the request no longer applies once the selected version drops the source. Wait for the series to finish, or delete the Agent: completed deletion drops that work.
- Gateway or Proxy deletion requires its recorded owner: no selection returns
  `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED`; a different Driver returns `503`.
  OCC retains the record.
- OCC marks the record `deleting` before cleanup. For a Gateway copy, OCC asks the Gateway to remove it.
  A dependency failure returns `503`; an OpenShell provider ownership mismatch
  returns `404`. Both retain `deleting`. Resolve ownership drift before retrying;
  an already-removed copy counts as deleted.
- For a prepared GitHub source, `409 CREDENTIAL_TOKEN_UNSETTLED` means a token
  it issued may still be valid: GitHub's answer to an issue or revocation was lost.
  The record stays `deleting`. Retry after the time in the message, at most 72
  minutes after the attempt. A refused issue with no token does not block deletion.
  While the worker is revoking a token, deletion waits up to 25 seconds for GitHub's answer.
- For a Gateway source, `503 DEPENDENCY_UNAVAILABLE` retains the record for 70
  seconds after registration against a late write. `error.reason: "credential_registration_pending"`
  identifies this refusal; `Retry-After` gives the remaining whole seconds.
  Wait that long before retrying the same deletion. Other `503` responses
  do not authorize an automatic retry.

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
  deletes it, then selects the new driver.

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

- [OAuth connection templates](../connection-templates.md)
- [Protected credential request flow](../../flows/credential-source-egress.md)
- [OpenShell Credential Gateway](../drivers/openshell-credential-gateway.md)
- [CredentialGatewayDriver contract](../drivers/credential-gateway.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [Credential source withdrawal](../credential-sources/withdrawal.md)
- [Secrets](../../guides/topics/secrets.md) and [Permissions](../cheatsheets/permissions.md)
- [HTTP API: credential sources](../api.md#credential-sources)
