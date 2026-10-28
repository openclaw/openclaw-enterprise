---
rfc: index.md
---

# Driver contracts, failure, and verification for OAuth connections

This companion defines the Driver contract changes, failure behavior, and required
outcomes for [RFC-0024](index.md). The RFC owns the decision, connection
templates, consent rules, and personal-Agent boundary.

## Credential Refresh Driver

`CredentialRefreshDriver` gains these optional methods beside the existing device
methods. A Driver that omits them offers no browser connections.

### Browser authorization

For connections created from either template protocol, the OCE Token Service
implements the browser operations behind `CredentialRefreshDriver`. It retains
the refresh grant in encrypted custody and renews access tokens in the
background. It serializes refresh per source and atomically commits each new
access token with any replacement refresh token. At request time, OpenShell
presents an eligible, prepared access token for the deployed binding. If none
is available, egress refuses the request. A worker request never triggers a
refresh. [Credential access and lifecycle](../0023-egress-proxy-credential-lifecycle/contracts.md#credential-access-and-lifecycle)

- `startBrowserAuthorization(context, { connectionTemplateVersion, redirectUri, selectedScopes? })`
  returns `{ authorizationUrl, privateState }`. MCP requires the owner's validated
  `selectedScopes`. Configured OAuth uses the version's fixed scopes. The Driver
  creates the PKCE verifier, a random `state`, and a nonce for `accountIdentity: oidc`.
  `privateState` is opaque to OCC.
- `completeBrowserAuthorization(context, privateState, { code, state, iss? })` verifies
  `state`, exchanges the code with the verifier and the version's client
  registration, and commits the grant and first usable access token in the Token
  Service. It then returns `ready` with an optional verified
  `accountEmail`. On failure it returns a code. It never returns a token.

### MCP authorization

For an `mcp_oauth` version, the Credential Refresh Driver uses the official
TypeScript MCP client (`@modelcontextprotocol/client`). The plugin declares its
MCP server URL. After the owner connects their account and deploys the Agent,
the dedicated worker exposes every tool the server returns from `tools/list`
for that connection. The server authorizes each `tools/call` under the user's
grant and account permissions.

1. **Approve the template.** The Driver reads the server's authentication
   challenge and uses the SDK to discover protected resource and authorization
   server metadata. Discovery uses credential-free requests subject to management
   egress policy, including redirects. The administrator approves the server URL,
   exact resource identifier, issuer, authorization and token endpoints, registered
   client, and allowed scopes as one immutable version. The administrator reviews
   the scopes in the challenge and in the protected resource's `scopes_supported`.
   Either source can name scopes the other omits. The challenge identifies the
   scopes needed for the current request. Without a scoped challenge, the SDK
   suggests the advertised resource scopes. The administrator decides which
   scopes the template offers, including any required for identity or refresh.
   Saving a version requires at least one approved scope so that the owner
   can make an explicit request.
2. **Connect.** Console shows the owner the version's entire approved list.
   The owner chooses which scopes to request for this connection. Console labels
   any required scopes and includes them in the selection. OCC validates that
   selection against the displayed version before creating a source or redirect.
   It rejects a missing or empty selection, an unlisted scope, an omitted
   required scope, or a stale version. The source records the validated set.
   The Driver passes that set to SDK `auth()` with the version's registered
   client. Before redirecting, it checks the consent URL's destination,
   `resource`, and exact scope set, including any scope the SDK adds.
   Token requests go directly to the pinned endpoint with redirects disabled.
   A changed destination requires a new version and fresh consent.
   A tool that needs additional scopes can return `insufficient_scope`. The
   owner can request more through **Reconnect**. Scopes outside the approved
   list require a new template version first.
   The Driver keeps the PKCE verifier and SDK discovery state in the private
   authorization session. OCC checks the initiating user, Agent, and single-use
   callback state, and forwards the callback's optional `iss` to the Driver. The
   SDK rejects an issuer mismatch, or a missing issuer when the authorization
   server advertises issuer identification, before exchanging the code.
3. **Refresh and present.** The Token Service uses the SDK
   for exchange and refresh so both requests include the approved resource.
   Before activating an access token, the service verifies that the user's
   effective grant matches the selection recorded for this connection. Under
   OAuth, an issuer may omit `scope` when it grants exactly the requested set.
   A refresh without a scope change retains the original grant. If the effective
   set differs or cannot be established, the service withholds the token and
   requires reconnection.
   Deployment matches the ready connection to the plugin's server, resource, and
   issuer. The worker uses the same placeholder across access-token rotations.

Verify the following with a controlled MCP server and issuer.

- Offer `files:read` and `files:write` in the template. When the server challenges
  for `files:read`, the owner still sees both approved scopes. Select only
  `files:read`. Inspect the outgoing consent URL and the saved connection for
  exactly that scope. Reject a forged scope before creating a source. Withhold
  a refreshed token that adds `files:write`, even though the template allows it.
  Repeat discovery without a challenge scope and verify the SDK suggests the
  resource's advertised scopes.
- Inspect the OAuth authorization request, the code exchange, and the refresh
  request. Each must send the template's exact MCP resource identifier as the
  `resource` parameter. This identifies the server the token is intended for.
- Try saving an MCP template with the HTTP-method filter `endpoint.access: read-only`.
  Verify that OCC rejects the save and creates no version. A connection with
  only `files:read` must still be able to send a tool call by HTTP `POST`.

Change the advertised token endpoint and verify it receives no secret or code.
An invalid callback issuer must fail before exchange.
After rotation, the same worker placeholder must reach the server with the second
access token. With an authorized test account, compare the worker's tool catalog
with the server's `tools/list` for that connection and invoke a tool from Console.

[MCP scope selection](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-selection-strategy) · [OAuth token response](https://www.rfc-editor.org/rfc/rfc6749#section-5.1) · [SDK OAuth client](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)

### Client registrations

The Token Service manages OAuth client registrations for the Installation.
A client identifier is unique only within its authorization server
([RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2)), so the
Token Service keys each registration by the trusted `issuer` and `clientId` pair.

- `registerClient({ issuer, clientId }, clientSecret)` returns an opaque
  `clientRegistrationId` bound to that pair. Connection templates with the same
  pair share one registration. The same `clientId` at a different `issuer` gets
  a separate registration.
- `rotateClientSecret(clientRegistrationId, clientSecret)` sets the secret
  version for new connections. The Token Service pins each connection to the
  version used for its exchange. Existing connections continue refreshing with
  that version until the provider disables it, then report `reauthorize`.
- `removeClient(clientRegistrationId)` deletes the secret. OCC calls it only when
  no connection template version or source carries the registration.

Each connection template version and credential source records its
`clientRegistrationId`. The Token Service keeps the referenced client secret
versions available across replicas and restarts. OCC stores only the
registration reference. Client secrets and refresh grants stay out of the
worker's OpenShell attachment.

### OIDC account identity

For `accountIdentity: oidc`, the Refresh Driver establishes the trusted provider
before OCC accepts the connection template version:

1. Without `jwksUri`, it reads `<issuer>/.well-known/openid-configuration`
   ([provider metadata](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)).
   The metadata `issuer` must equal the configured `issuer` exactly, and its
   `authorization_endpoint` and `token_endpoint` must equal the connection
   template's URLs. The Driver records the metadata's `jwks_uri`.
2. With `jwksUri`, it uses that `https` URL and skips discovery.
3. A mismatch, an unreachable provider, or a non-`https` value rejects the version
   with `400`, and the version is not created.

The recorded `issuer` and JWKS URL become part of the version and of each source's
approved values. At completion, the Driver validates the ID token
([OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation))
against keys from that JWKS URL only: signature, `iss` equal to the recorded
`issuer`, `aud` containing the client ID, expiry, and nonce. It refetches the key
set once for an unknown key ID, then rejects. It returns only a verified `email`.

## IAM Driver

IAM matches a Namespace-scoped binding only to resources in that Namespace, and has
no API for Installation-level bindings. Granting `use` on an Installation-wide
connection template needs these additions:

- **Installation access bindings.** Optional `listInstallationAccessBindings`,
  `createInstallationAccessBinding`, and `deleteInstallationAccessBinding`, with
  `listInstallationRoles`. They accept only Installation-scoped resource kinds, which
  this RFC limits to `connection_template`, and require Installation `administer`
  inside the caller's policy-and-audit transaction, as Namespace policy writes do.
- **Built-in role.** Bootstrap seeds an Installation role, "Connection template
  user", with `use` on `connection_template`. A migration adds it to existing
  Installations. No role-creation API is added.
- **`namespace` subject kind.** `AccessBindingSubjectKind` adds `namespace`, valid
  only on Installation access bindings. Its `subjectId` is a Namespace ID.
- **Namespace context.** `AuthorizationRequest` gains optional `namespaceContext`.
  A `namespace` binding matches only when the request's `namespaceContext` equals its
  subject. OCC sets it to the Agent's Namespace when it checks `use` at connect time,
  after the caller passes `agent:update` there. Requests without a context never
  match `namespace` bindings.
- **Identity bindings** for a person use `subjectKind: identity` and match without a
  context. Namespace-bound identities, such as service principals, still cannot use
  Installation resources.
- **Deletion.** Deleting a connection template removes its bindings; deleting a
  Namespace removes `namespace` bindings that name it.

A Driver without these methods cannot grant `use` to anyone except Installation
administrators, who hold every action through the built-in administrator role.

## Protected egress

Use [RFC-0023 admission and sender contracts](../0023-egress-proxy-credential-lifecycle/contracts.md)
for the deployed revision. Limit the authorized route to the endpoint the owner
approved. Attaching a source cannot expand an installation's egress ceiling.

For a configured HTTP template with `read-only` access, the sender permits only
`GET`, `HEAD`, and `OPTIONS`. MCP clients send both read and write tool calls by
`POST` to the declared endpoint. OCC rejects an `mcp_oauth` template with
`read-only` access before saving a version. The supported value, `full`, allows
the MCP transport at that exact endpoint. The owner can still select only read
scopes. The MCP server enforces the user's grant on each call. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server)

RFC-0023 authenticates an execution. Listing a binary in a connection template
does not establish which process sent a request. Refuse deployment when the
installation cannot enforce the executable restriction recorded at consent.

## Failure and recovery

| Condition                                                   | Result                                           | Recovery                                       |
| ----------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Consent denied, popup closed, or session expired            | Pending source deleted                           | Connect again                                  |
| `state` mismatch, reuse, or another user's session          | `400`; no exchange                               | The owner connects again                       |
| Exchange refused or no refresh token returned               | Source deleted; `fix_configuration`              | Administrator corrects the connection template |
| Timeout after the exchange started                          | Source stays `registering`                       | Delete and reconnect; OCC never replays a code |
| Issuer revokes the grant                                    | `status.refresh.recoveryAction: reauthorize`     | **Reconnect** and redeploy                     |
| Driver unavailable before source creation                   | `503`; no source created                         | Retry                                          |
| OIDC metadata mismatch or unreachable provider              | Version rejected with `400`                      | Administrator corrects `issuer` or URLs        |
| ID token from a wrong issuer, untrusted key, or wrong nonce | Source deleted; `fix_configuration`              | Administrator checks the provider; reconnect   |
| Connection template edited after consent                    | Source unchanged; **Reconnect to apply changes** | Owner reconnects; administrator can disconnect |
| Withdrawal pending or failed after disconnect               | Personal restriction stays in force              | Retry withdrawal, or stop or delete the Agent  |
| Provider disables a rotated-out client secret               | Older connections report `reauthorize`           | Owners **Reconnect**                           |

The operator guide documents provider rules. Google requires verification for
public applications requesting `gmail.readonly`, and External Testing applications
issue seven-day refresh tokens.

## Required outcomes

- **HTTP and PostgreSQL integration.** Use a real Keycloak issuer with
  authorization code, PKCE, and refresh tokens. Prove success, denied consent,
  state reuse, a cross-session callback, an expired session, and a missing grant.
  Prove that a second user cannot connect, deploy, chat with, or receive grants on
  a connected Agent, including through inherited admin permissions. Accept a
  channel only when it enforces owner identity and private delivery. Reject a
  second sender and a shared reply destination, including while withdrawal is
  delayed or has failed after disconnect. Prove that codes and
  tokens are absent from responses, logs, and audit.
- **Refresh ownership.** For both configured OAuth and MCP, observe the Token
  Service refresh the access token with the issuer in the background. Send a
  worker request with the same placeholder and verify that OpenShell presents
  the new access token. With no eligible prepared token, verify that OpenShell
  refuses the request without contacting the issuer.
- **Client registrations.** Two connection templates with the same `clientId` in
  two Keycloak realms keep independent secrets: rotating one leaves the other's
  sources refreshing.
- **IAM.** A person with an identity binding and a person connecting an Agent in a
  Namespace with a `namespace` binding can connect; the same person connecting an
  Agent in another Namespace, a service key, and a caller without a binding are
  refused. Only Installation administrators can create or delete the bindings.
- **OIDC.** Reject a version whose metadata issuer or endpoints differ, and an ID
  token with a wrong issuer, an untrusted signing key, a wrong audience, or a wrong
  nonce. Show the verified address on success.
- **Real k3d and OpenShell.** Through the regular Agent create path, connect via
  Keycloak and prove: a tool reaches its endpoint with no added network policy; a
  write fails under `read-only`; another tool binary cannot send the placeholder;
  rotate, revoke, and reconnect work; an edited `tokenUrl` or endpoint leaves an
  existing source unchanged; after client secret rotation, existing sources keep
  refreshing until the old secret is disabled, then report `reauthorize`, and new
  connections use the new secret.
- **Live Google proof.** Run manually with an authorized account: `gog` reads Gmail
  through a dedicated Codex Agent, and a write method is denied. This proof is
  outside CI.
- **Dedicated Codex environment.** Verify that Codex shell commands receive the
  connection template's variable. Codex may filter variable names that contain
  `TOKEN`; if it does, Compute must allow exactly the connected variables.
