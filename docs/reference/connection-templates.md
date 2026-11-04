# Connection templates and saved accounts

An Installation administrator defines a connection template for an OAuth provider.
A person signs in to that provider once and saves the connection in their
Namespace. They can then grant individual Agents access to the same account.
OCC records who consented and which template version they approved. Each Agent
gets its own credential binding and operates under its own policy.

The design is [RFC-0027](../../specs/rfcs/0027-agent-oauth-connections/index.md).
To set up Gmail, follow
[Connect Google Gmail](../guides/deploy/google-gmail-connection.md).

## Requirements

- A [Credential Gateway](drivers/openshell-credential-gateway.md) with
  `toolBinaries` that include the tool that sends the credential, such as `gog`.
- The OpenShell Credential Refresh Driver with `clientWorkspace`, and
  `operatorTls` on the OpenShell Backend; see
  [browser connections](drivers/openshell-credential-gateway.md#configure-the-driver).
- A Token Service with a Secret Driver that supports private reads and
  compare-and-swap, and a sender that accepts expiring access tokens.
- Network access to the token endpoint from the OCC API for code exchange and
  from the worker for background refresh.
- A configured public origin. The callback URI is `<public origin>/oauth/callback`;
  OCC answers `503` to a connect request without one.

Without the Drivers, template and connect operations return `501`.

## Connection templates

A connection template is an Installation resource of IAM kind
`connection_template`, managed through the
[HTTP API](api.md#get-connectiontemplates). Credential sources created from it
belong to the Namespace where the person connects the account.

| Field                     | Meaning                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `displayName`             | The label people see.                                                                           |
| `issuer`                  | The authorization server identifier, an `https` URL. It scopes the client ID.                   |
| `authorizationUrl`        | The provider consent page.                                                                      |
| `tokenUrl`                | Where the Refresh Driver exchanges codes and the Token Service renews access tokens.            |
| `clientId`                | The administrator's OAuth client at `issuer`.                                                   |
| `clientSecret`            | Write-only. Required only when this `issuer` and `clientId` pair is not registered yet.         |
| `scopes`                  | The fixed scopes the person approves.                                                           |
| `authorizationParameters` | Extra consent-URL parameters, such as Google's `access_type=offline`. Reserved names fail.      |
| `endpoint`                | The API `host`, `port` (default `443`), and `path` (default `/**`) that receive the credential. |
| `envVar`                  | The placeholder variable in the Sandbox.                                                        |

The endpoint also accepts an `access` setting. The default, `full`, allows requests within its host, port, path, and provider scopes. A template can request `read-only` only when the installed Credential Gateway can enforce it for every matching request. Stock OpenShell currently refuses this option at setup. A provider-enforced read-only OAuth scope still restricts what that provider accepts.

PostgreSQL enforces value formats: `https` URLs, RFC 6749 scope tokens, a DNS
endpoint host (not an IP address), and the variable rules of
[tool sources](drivers/openshell-credential-gateway.md#source-type-catalog).
The selected Credential Gateway also checks the endpoint and token URL when a
template is created or changed, as it does for a source. The OpenShell gateway
rejects an IP address or `localhost` token host (`400`). Responses include `redirectUri`, the exact URI to
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
- `subjectKind: namespace` grants eligible people acting in that Namespace.

OCC checks `use` with the Namespace where the person connects the account as context, so a Namespace grant does
not apply to Agents elsewhere. Service keys and Namespace-bound identities cannot
use templates. Creating or deleting a binding requires
`installation:administer`; deleting a template or a Namespace removes its
bindings. [Usable templates](api.md#get-namespacesnamespaceidconnectiontemplates)
lists the ones the caller may connect in a Namespace.

## Connect an account

1. The person signs in to OCC and starts a connection with `POST /namespaces/{namespaceId}/connections` and a `connectionTemplateId`. OCC requires a human session, Namespace read access, and permission to use the template in that Namespace. The Agent-scoped start endpoint also accepts the template ID and requires read and update access to that Agent.
2. OCC registers a pending `oauth2-refresh-token` source. Its private database row holds the PKCE verifier and identifies the browser session that started consent. The response includes the provider's `authorizationUrl` with S256 PKCE, the source ID, and a ten-minute expiry. A pending source cannot be attached or deployed.
3. The person approves on the provider's page. The [callback](api.md#get-oauthcallback) checks the browser session, consumes the state once, and rechecks access. The Credential Refresh Driver exchanges the code once. The Token Service takes custody of the grant and first access token. The issuer may return a narrower scope. On renewal, the Token Service refuses scopes beyond the effective grant.
4. Once the sender has the first access token and its expiry, OCC saves the consent owner, template version, ready source and the owner's exact-source `read` and `operate` grants together. The callback redirects to the Console with `connection=connected`. The source becomes available for explicit attachment.

The issuer can return its identifier in the `iss` query parameter. When present,
it must exactly match the approved issuer. If another issuer has a client
registration when consent starts or when the callback arrives, OCC requires
`iss` before exchanging a code. This prevents the shared callback from sending a
code from one provider to another provider's token endpoint.

The callback returns `303` with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. OCC strips the provider query from the redirect and logs the connection outcome without codes or tokens.

## Grant an Agent access

List saved connections with `GET /namespaces/{namespaceId}/connections`. The list requires `namespace:read` and shows connections the caller can read. A Namespace administrator can grant a person or Group `credential_source:read` to see a connection and `credential_source:operate` to attach it.

`POST /namespaces/{namespaceId}/agents/{agentId}/connections/{credentialSourceId}` attaches a completed connection to the named Agent. The caller needs `agent:update` on the target Agent and `credential_source:operate` on the source, including when they originally connected it. OCC saves the source on the Agent and grants the Agent's service principal permission to operate it. Repeat the attachment for each Agent that needs the account. The Agent's connections endpoint requires `agent:read` and lists attached accounts the caller can read.

Deploy the Agent to use the account. Its authorized execution can send requests within the source's approved endpoint and access policy. The name of a program sending a request does not identify the consenting person or grant another Agent access.

## Detach or disconnect

`DELETE /namespaces/{namespaceId}/agents/{agentId}/connections/{credentialSourceId}` removes that Agent's saved binding and its connection grant. If an admitted or serving revision can still hold the source, OCC queues [withdrawal](credential-sources/withdrawal.md) under the caller's `agent:operate` permission. A running revision can keep sending approved requests until withdrawal succeeds or that revision stops. Check the withdrawal status and retry a failed attempt. Other Agents keep their access.

The consent owner can revoke the account everywhere by calling `DELETE /namespaces/{namespaceId}/connections/{credentialSourceId}`. A caller with `delete` on the source can do the same. OCC closes the source to new deployments, removes its Agent bindings and grants, and requests withdrawal for revisions already holding it. The Token Service retires its grant and OpenShell removes the source's provider. If cleanup fails, the worker retries using the recorded revocation. OCC retains the internal record until the outstanding references clear. Agent editors can select a replacement for any plugin or Harness that relied on the retired source.

Use the credential source ID from the Namespace connections list to manage a saved account with the CLI.

```sh
occ --namespace "$NAMESPACE_ID" agent connection attach "$AGENT_ID" "$SOURCE_ID"
occ --namespace "$NAMESPACE_ID" agent connection list "$AGENT_ID"
occ --namespace "$NAMESPACE_ID" agent connection detach "$AGENT_ID" "$SOURCE_ID"
```

## Callback failures

A failed callback redirects to `/console/?connection=failed&reason=<code>`.

| Reason                                   | Cause                                                                             | Recovery                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session_required`                       | No signed-in session, or a service key.                                           | Sign in and connect again.                                                               |
| `missing_state`, `unknown_session`       | The attempt is missing, spent, expired or belongs to a different browser session. | Use the original session, or connect again.                                              |
| `consent_denied`, `provider_error`       | The provider reported `access_denied` or another error.                           | Connect again.                                                                           |
| `state_mismatch`, `invalid_session`      | The callback does not match the stored session.                                   | Connect again.                                                                           |
| `issuer_required`, `issuer_mismatch`     | OCC cannot identify the approved issuer on this callback.                         | Configure the provider to return the exact template issuer in `iss`, then connect again. |
| `grant_refused`                          | The issuer refused the code.                                                      | Connect again.                                                                           |
| `client_refused`                         | The issuer refused the client ID or secret.                                       | An administrator fixes the template or rotates the secret.                               |
| `grant_scope_mismatch`                   | The issuer returned scopes outside the approved template.                         | Check the OAuth client's provider-side default scopes and reconnect.                     |
| `no_refresh_token`                       | The issuer returned no refresh token.                                             | An administrator adds offline access parameters.                                         |
| `exchange_refused`, `issuer_unavailable` | The token endpoint failed.                                                        | Fix the template, or retry later.                                                        |
| `unavailable`                            | Any other failure, such as a lost grant or a timeout.                             | Check the source; delete it if unbound.                                                  |

The worker removes expired, unused attempts and their pending sources. OCC also
removes a pending source after a definite exchange refusal. If an exchange or
token handoff has an uncertain outcome, the source can remain `registering`.
Delete the unbound source and start a fresh connection. OCC never replays a code.

## Limits

- The console has no connection controls yet; use the HTTP API.
- Presets cannot reference connection templates yet, and OCC does not hold back
  deployment for missing connections.
- OpenShell lets the Installation’s admitted binaries use its approved endpoint. The template’s `full` access allows the route’s supported HTTP methods. Provider scopes may restrict the operations further.
- OCC does not show which provider account was connected.
- OpenShell remains an unsupported production path; see its
  [qualification contract](drivers/openshell-sandbox.md#qualification-contract).

## Related

- [Agent connection lifecycle](../flows/agent-oauth-connections.md)
- [Credential sources](credential-sources.md)
- [CredentialRefreshDriver](drivers/credential-refresh.md) and
  [IAMDriver](drivers/iam.md#installation-access-bindings)
- [Permissions](cheatsheets/permissions.md)
