# Connection templates and personal Agents

A connection lets one person connect their own OAuth account, such as Google
Gmail, to their Agent. An Installation administrator defines the provider once as
a **connection template**. The person approves access on the provider's consent
page; the Credential Refresh Driver exchanges the code and gives the refresh grant
to the Credential Gateway. The Agent's tool receives only a placeholder, and only
that person can deploy or use the Agent while it holds the connection.

The design is [RFC-0023](../../specs/rfcs/0023-agent-oauth-connections/index.md).
To set up Gmail, follow
[Connect Google Gmail](../guides/deploy/google-gmail-connection.md).

## Requirements

- A [Credential Gateway](drivers/openshell-credential-gateway.md) with
  `toolBinaries` that include the tool that sends the credential, such as `gog`.
- The OpenShell Credential Refresh Driver with `clientWorkspace`, and
  `operatorTls` on the OpenShell Backend; see
  [browser connections](drivers/openshell-credential-gateway.md#configure-the-driver).
- A Secret Driver that can read stored values.
- Network access from the OCC API, as well as the OpenShell gateway Pod, to the
  token endpoint: the code exchange runs in the API.
- A configured public origin. The callback URI is `<public origin>/oauth/callback`;
  OCC answers `503` to a connect request without one.

Without the Drivers, template and connect operations return `501`.

## Connection templates

A connection template is an Installation resource of IAM kind
`connection_template`, managed through the
[HTTP API](api.md#get-connectiontemplates). Credential sources created from it
belong to the Agent's Namespace.

| Field                     | Meaning                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `displayName`             | The label people see.                                                                           |
| `issuer`                  | The authorization server identifier, an `https` URL. It scopes the client ID.                   |
| `authorizationUrl`        | The provider consent page.                                                                      |
| `tokenUrl`                | The token endpoint the Refresh Driver and gateway call.                                         |
| `clientId`                | The administrator's OAuth client at `issuer`.                                                   |
| `clientSecret`            | Write-only. Required only when this `issuer` and `clientId` pair is not registered yet.         |
| `scopes`                  | The fixed scopes the person approves.                                                           |
| `authorizationParameters` | Extra consent-URL parameters, such as Google's `access_type=offline`. Reserved names fail.      |
| `endpoint`                | The API `host`, `port` (default `443`), and `path` (default `/**`) that receive the credential. |
| `envVar`                  | The placeholder variable in the Sandbox.                                                        |

PostgreSQL enforces value formats: `https` URLs, RFC 6749 scope tokens, a DNS
endpoint host (not an IP address), and the variable rules of
[tool sources](drivers/openshell-credential-gateway.md#source-type-catalog).
The selected Credential Gateway also checks the endpoint and token URL when a
template is created or changed, as it does for a source. The OpenShell gateway
refuses an IP address or `localhost` token host, because it refreshes from its
own network position (`400`). Responses include `redirectUri`, the exact URI to
register with the provider.

### Versions and consent

Changing any field except `displayName` creates a new immutable version. A
connection keeps the version its owner approved, and its credential source keeps
that version's endpoint and issuer, so an edit never redirects an existing
connection. A concurrent edit returns `409`. Deletion returns `409` while any
connection uses one of the template's versions; disconnect those first.

### Client registrations

OCC records one client registration per `issuer` and `clientId` pair. Templates
with the same pair share it; the same client ID at another issuer is separate. The
Credential Refresh Driver keeps the secret, and OCC stores no copy. The OpenShell
Driver stores it in a Driver-owned `oce-cr-*` provider in `clientWorkspace` that no
Sandbox attaches, and reads it back over operator TLS. Sending
`clientSecret` for a registered pair returns `409`.

[Rotating the client secret](api.md#post-connectiontemplatesconnectiontemplateidrotateclientsecret)
affects new connections only. Existing connections keep refreshing with the
secret they were configured with until the provider disables it; then their
source reports `reauthorize` and the owner connects again. Overlap secrets where
the provider allows it.

Deleting the last template that uses a registration also removes the stored
secret. That removal is best effort: if the Driver fails, an unreferenced secret
remains in its storage.

## Who can use a connection template

Installation administrators hold every connection template action. Other people
need `use`, granted through an
[Installation access binding](api.md#post-iamaccessbindings) of the built-in
Installation Role `role_connection_template_user`:

- `subjectKind: identity` grants one person.
- `subjectKind: namespace` grants anyone acting for an Agent in that Namespace.

OCC checks `use` with the Agent's Namespace as context, so a Namespace grant does
not apply to Agents elsewhere. Service keys and Namespace-bound identities cannot
use templates. Creating or deleting a binding requires
`installation:administer`; deleting a template or a Namespace removes its
bindings. [Usable templates](api.md#get-namespacesnamespaceidconnectiontemplates)
lists the ones the caller may connect in a Namespace.

## Connect an account

1. The person signs in to OCC and
   [starts a connection](api.md#post-namespacesnamespaceidagentsagentidconnections)
   with a connection template ID. Only a human session can start one. OCC checks
   exact `agent:read` and `agent:update`, `use`, and the
   [personal-Agent rules](#personal-agents). These checks authorize the source and
   Secret the connection creates; no Namespace `credential_source` or `secret`
   grant is needed.
2. OCC registers a pending `oauth2-refresh-token` credential source with the
   approved values and no refresh material, and stores the Refresh Driver's
   private state in a Namespace Secret. It returns `authorizationUrl` (S256 PKCE),
   `credentialSourceId`, and `expiresAt`, ten minutes later.
3. The person approves on the provider's page, which redirects to
   [`/oauth/callback`](api.md#get-oauthcallback) with `code` and `state`.
4. The callback needs the session that started the connection. OCC consumes the
   session once, rechecks `agent:update`, `use`, and the personal-Agent rules, and
   has the Refresh Driver exchange the code and mint the first token.
5. OCC adds the source to the Agent's `credentialSources`, grants the Agent's
   service principal `operate` on it, and records the connection. It redirects to
   the Agent's console page with `connection=connected`.

The callback always answers `303`, with `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`, and its redirect drops the query string. Codes and
tokens never appear in responses or audit records. OCC audits a started and a
completed connection on the Agent, and a refused or failed callback with its
reason code and the person who sent it.

[List connections](api.md#get-namespacesnamespaceidagentsagentidconnections)
returns each source, its owner, and the approved template version. Deploy the
Agent to use the connection. The owner can update or deploy that Agent while
retaining a completed connection without a separate `credential_source:operate`
grant. Other sources and Harness authentication still require their usual
grants. Use the disconnect operation to withdraw a connected source.

### Disconnect

[Disconnect](api.md#delete-namespacesnamespaceidagentsagentidconnectionscredentialsourceid)
requires exact `agent:update`. OCC removes the source from the Agent, requests
[withdrawal](credential-sources/withdrawal.md) when the active revision holds it
(which also requires `agent:operate`), and deletes the source when nothing holds
it. Like connecting, it needs no `credential_source:delete` grant. The response
reports `withdrawalRequested` and `deleted`. When `deleted` is `false`, deploy a
new version or wait for withdrawal, then disconnect again.

## Personal Agents

An Agent is personal while it holds a connection. The restriction lasts until
the connected credential source is deleted. OCC refuses that deletion while the
saved Agent, a pending deployment, an admitted revision, or withdrawal work still
holds the source, so the restriction outlives every copy of the credential.

While an Agent is personal:

- Only the connection owner can connect more accounts to it (`403`).
- Only the owner can deploy it (`403`). The worker rechecks queued work and fails
  it with `PERSONAL_AGENT_OWNER_REQUIRED`, including redeploys an administrator
  starts.
- Only the owner can open its native admin UI (`403`).
- OCC refuses exact-Agent grants to anyone else and refuses Group grants (`409`).
  Connecting also fails while such a grant exists.
- OCC refuses enabled channels in its Configuration, at connect, at deploy, and
  when anyone saves that Configuration (`409`). A channel counts as enabled
  unless it sets `enabled: false`.
- OCC refuses plugin approvers at connect and deploy (`409`).
- Its connected source cannot be listed on another Agent (`409`).

Administrators can still stop, delete, and disconnect the Agent. OCE has no
per-message identity, so these rules cover access paths, not individual messages.

## Callback failures

A failed callback redirects to `/console/?connection=failed&reason=<code>`.

| Reason                                   | Cause                                                                               | Recovery                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `session_required`                       | No signed-in session, or a service key.                                             | Sign in and connect again.                                 |
| `missing_state`, `unknown_session`       | No session for this `state`, or another person's session. The session stays unused. | The owner opens the link in their session.                 |
| `session_used_or_expired`                | A replay, or more than ten minutes passed.                                          | Connect again.                                             |
| `consent_denied`, `provider_error`       | The provider reported `access_denied` or another error.                             | Connect again.                                             |
| `state_mismatch`, `invalid_session`      | The callback does not match the stored session.                                     | Connect again.                                             |
| `grant_refused`                          | The issuer refused the code.                                                        | Connect again.                                             |
| `client_refused`                         | The issuer refused the client ID or secret.                                         | An administrator fixes the template or rotates the secret. |
| `no_refresh_token`                       | The issuer returned no refresh token.                                               | An administrator adds offline access parameters.           |
| `exchange_refused`, `issuer_unavailable` | The token endpoint failed.                                                          | Fix the template, or retry later.                          |
| `unavailable`                            | Any other failure, such as a lost grant or a timeout.                               | Check the source; delete it if unbound.                    |

From `consent_denied` through `issuer_unavailable`, OCC deletes the pending
source. After `session_used_or_expired`, a timeout, or another uncertain failure,
the source stays registered but unbound; delete it and connect again. OCC never
replays a code.

## Limits

- The console has no connection controls yet; use the HTTP API.
- Presets cannot reference connection templates yet, and OCC does not hold back
  deployment for missing connections.
- The credential is released to every `toolBinaries` entry and every HTTP method
  on the endpoint; per-template binaries and read-only access are not available.
- OCC does not show which provider account was connected.
- OpenShell remains an unsupported production path; see its
  [qualification contract](drivers/openshell-sandbox.md#qualification-contract).

## Related

- [Agent connection lifecycle](../flows/agent-oauth-connections.md)
- [Credential sources](credential-sources.md)
- [CredentialRefreshDriver](drivers/credential-refresh.md) and
  [IAMDriver](drivers/iam.md#installation-access-bindings)
- [Permissions](cheatsheets/permissions.md)
