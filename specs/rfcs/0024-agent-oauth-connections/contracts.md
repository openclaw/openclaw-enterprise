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

- `startBrowserAuthorization(context, { connectionTemplateVersion, redirectUri })`
  returns `{ authorizationUrl, privateState }`. The Driver creates the PKCE
  verifier, a random `state`, and a nonce for `accountIdentity: oidc`.
  `privateState` is opaque to OCC.
- `completeBrowserAuthorization(context, privateState, { code, state, iss? })` verifies
  `state`, exchanges the code with the verifier and the version's client
  registration, and establishes refresh custody for this protocol. After it obtains
  a usable access token, it returns `ready` with an optional verified
  `accountEmail`. On failure it returns a code. It never returns a token.

### MCP authorization

For an `mcp_oauth` version, the Credential Refresh Driver uses the official
TypeScript MCP client (`@modelcontextprotocol/client`). Slack's plugin declares
its server at `https://mcp.slack.com/mcp`. Selecting the plugin installs the
server configuration. After the owner connects their account through **Connect**
and deploys the Agent, the dedicated worker exposes every tool that Slack returns
through `tools/list` for that connection. Slack authorizes each `tools/call`
using the user's grant and workspace permissions.

1. **Approve the template.** The Driver reads the server's authentication
   challenge and uses the SDK to discover protected resource and authorization
   server metadata. Discovery uses credential-free requests subject to management
   egress policy, including redirects. The administrator approves the server URL,
   exact resource identifier, issuer, authorization and token endpoints, registered
   client, and requested scopes as one immutable version. The SDK takes scope
   guidance from the server's challenge and falls back to the protected resource's
   `scopes_supported` when the challenge omits scope. The administrator reviews
   those scopes and can choose a narrower set. Slack's template uses a preregistered
   app. Its resource is `https://mcp.slack.com` and its OAuth endpoints are on
   `slack.com`.
2. **Connect.** The Driver calls SDK `auth()` with the approved scopes and an
   `OAuthClientProvider` backed by the version's client registration. It checks
   the SDK's consent URL against the approved destination and scope set before
   redirecting the user. Token requests go directly to the pinned endpoint with
   redirects disabled. Changed destinations require a new version and consent.
   Newly advertised scopes do not change an existing grant.
   If a later challenge requires additional scopes, the owner can reconnect
   after an administrator approves them in a new version.
   The Driver keeps the PKCE verifier and SDK discovery state in the private
   authorization session. OCC checks the initiating user, Agent, and single-use
   callback state, and forwards the callback's optional `iss` to the Driver. The
   SDK rejects an issuer mismatch, or a missing issuer when the authorization
   server advertises issuer identification, before exchanging the code.
3. **Refresh and present.** The credential service behind the Driver uses the SDK
   for exchange and refresh so both send the approved resource. Before activating
   either token it compares the granted scopes with the approved set. Slack
   reports the user's scopes in `authed_user.scope`. The adapter must check that
   field before SDK parsing discards it. A different grant requires reconnection.
   The service serializes refresh per source and atomically saves the new access
   token and any replacement refresh token. It reports `ready` once it holds a
   usable access token and refresh grant. Deployment matches the ready connection
   to the plugin's server, resource, and issuer. Protected egress presents the
   prepared access token at the approved MCP endpoint. The worker uses the same placeholder
   across rotations.
   A Driver that only hands a refresh token to OpenShell cannot admit this protocol
   until it supports that handoff of prepared access tokens.

Verify the adapter against a controlled MCP server and issuer. Observe the same
resource on consent, exchange, and refresh. With a scoped challenge, verify the
SDK proposes that scope. Without one, verify it proposes the resource's advertised
scopes and the consent URL requests only the set approved for the version.
Change the advertised token endpoint and verify it receives no secret or code.
An invalid callback issuer must fail before exchange, and a broader scope in a
token response must keep that token out of egress.
After rotation, the same worker placeholder must reach the server with the second
access token. When a test account is available, compare the tools exposed by the
worker with Slack's `tools/list` for that account and invoke a tool from Console.

[MCP scope selection](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-selection-strategy) · [SDK OAuth client](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts) · [Slack protected resource](https://mcp.slack.com/.well-known/oauth-protected-resource) · [Slack authorization server](https://mcp.slack.com/.well-known/oauth-authorization-server) · [Slack token response](https://docs.slack.dev/reference/methods/oauth.v2.user.access/#response)

### Client registrations

OCE has no Installation-owned Secrets, so the Refresh Driver keeps OAuth client
secrets. A client identifier is unique only within its authorization server
([RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2)), so the
Driver keys each secret by the trusted `issuer` and `clientId` pair:

- `registerClient({ issuer, clientId }, clientSecret)` returns an opaque
  `clientRegistrationId` bound to that pair. Connection templates with the same
  pair share one registration. The same `clientId` at a different `issuer` gets
  a separate registration.
- `rotateClientSecret(clientRegistrationId, clientSecret)` replaces the stored
  secret. New connections that carry the registration use it for the code exchange
  and refresh. Existing connections keep the secret they were configured with:
  OpenShell replaces refresh material only as a whole, never returns a stored
  refresh token, and starts a new authorization epoch that revokes running
  Sandboxes' placeholders. When the provider disables the old secret, those
  connections report `reauthorize`. Operators overlap secrets where the provider
  allows it; Google keeps two client secrets active during rotation.
- `removeClient(clientRegistrationId)` deletes the secret. OCC calls it only when
  no connection template version or source carries the registration.

Each connection template version and credential source records its
`clientRegistrationId`. The Driver stores secrets durably for every API replica
and across restarts. OCC stores no secret value.

OpenShell keeps providers per Workspace, and each OCE Namespace has its own
Workspace, so the OpenShell Credential Refresh Driver needs one Installation-level
place for client secrets. Its configuration gains a required `clientWorkspace`
when browser connections are enabled: an operator-provisioned OpenShell Workspace
that holds one Driver-owned provider per client registration. The Driver reads a
secret back over the operator-TLS connection, so operator TLS is a prerequisite.
The Workspace grants no Agent access; no Sandbox attaches its providers.

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
approved. For a configured HTTP template with `read-only` access, the sender
permits only `GET`, `HEAD`, and `OPTIONS`. Slack MCP sends JSON-RPC over
`POST /mcp`. The sender must admit that method at the exact server endpoint.
Attaching a source cannot expand an installation's egress ceiling.

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

For templates with configured OAuth endpoints, OpenShell refreshes access tokens.
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
