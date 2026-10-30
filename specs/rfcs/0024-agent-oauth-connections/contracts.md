---
rfc: index.md
---

# Driver contracts, failure, and verification for OAuth connections

This companion defines the Driver contract changes, failure behavior, and required
outcomes for [RFC-0024](index.md). The RFC owns the decision, connection
templates, consent rules, and personal-Agent boundary.

## MCP template setup

An administrator can create an `OAuthConnectionTemplate` from an MCP server URL.
OCE uses the official TypeScript MCP client to discover protected-resource and
authorization-server metadata under the Installation's management egress policy.
The administrator reviews the resource, issuer, and endpoints, and approves one
or more scopes from the challenge or resource metadata. They choose which scopes
the owner must request. They can supply a preregistered client ID and any required
secret or approve DCR at the issuer's advertised `registration_endpoint`. OCE
applies the same egress policy to DCR. If registration is unavailable or refused,
Console offers the preregistered option.

MCP setup proposes `revocationUrl` from the authorization server's optional
`revocation_endpoint` metadata. If the issuer omits it, OCE leaves the field
unset. [OAuth authorization server metadata](https://www.rfc-editor.org/rfc/rfc8414#section-2)

Before saving, OCE rechecks the discovered settings against what the administrator
approved. Changed settings require another review. The version pins the OAuth
resource, approved and required scopes, endpoints, and client registration. It
also records the MCP server URL for credential delivery and plugin binding.
Client ID Metadata Documents (CIMD) remain deferred until the Installation can
host a stable HTTPS client document that the issuer can fetch. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-registration-approaches) · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)

## Browser authorization

OCE runs one authorization-code flow from the saved `OAuthConnectionTemplate`
version. With fixed scopes it requests the approved set. With selectable scopes
it verifies the displayed version is current and the owner's selection is a
nonempty subset of approved scopes that includes every required scope. It does
this before creating the source. The authorization request uses the pinned client,
redirect URI, scopes, and any extra authorization parameters. OCE rejects extras
that set reserved fields, including the client, redirect, response type, scope,
resource, state, nonce, and PKCE parameters. It binds a random `state` and a PKCE
challenge to the session. For `accountIdentity: oidc`, it also sends a nonce
and keeps the expected value in private session state.

At callback, OCE validates the session, state, and issuer, then exchanges the code
once at the pinned token endpoint with the verifier and the same client registration.
When the template specifies a `resource`, OCE sends it in both the authorization and
token requests and pins it for refresh. Before storing tokens, OCE checks granted
scopes against those requested for this connection. For OIDC it passes the ID
token, pinned template version, and session nonce to the shared verifier. A
missing or invalid ID token fails the connection before the Secret write. Console
can show the verified email when consent completes. [OIDC verifier](#oidc-account-identity) · [Token storage and refresh](#token-storage-and-refresh)

## Token storage and refresh

After the code exchange, OCE stores the validated refresh token, access token, and
expiry together through the Secret Driver. It records a durable refresh registration
for the source with the Secret reference, client registration and version, issuer,
token endpoint, granted scopes, and OAuth resource when present. OCE could submit
it through a Token Service API or write it to shared PostgreSQL for the Token
Service to poll. With a valid initial token, the source can become
`ready` once token storage and registration are confirmed.
If either outcome is unknown, the source stays `registering` and OCC never replays
the authorization code. Deleting a pending source withdraws any refresh
registration and removes its token Secret. [Secret Driver](../../../docs/reference/drivers/secret.md)

On a background tick, the Token Service checks a registered Secret through the Secret
Driver. If the access token has enough lifetime left, it skips the issuer and leaves
the Secret unchanged. By default it renews before expiry, allowing time for the
next tick and the issuer call. The renewal window should account for token lifetime
so freshly issued short-lived tokens do not trigger renewal on every tick.

When renewal is due, the Token Service invokes the provider's refresh operation
using the pinned settings, including the resource when present. A sidecar alongside
the Token Service could expose OpenShell's provider refresh code over RPC. The
provider interface and deployment are open. The Token Service checks the renewed
scopes against the stored grant and writes the updated tokens through the Secret
Driver, retaining the current refresh token if the issuer omits a replacement. It serializes refresh attempts that share a rotating grant and
prevents stale writes. If a write is uncertain, it checks which version
was stored before refreshing again. If the replacement was lost and the old token
may have been consumed, the owner must reconnect. OpenShell can present the renewed
access token only after the write succeeds. [Credential lifecycle](../0023-egress-proxy-credential-lifecycle/protocol.md#prepare-and-renew-credentials)

## Credential Refresh Driver

### Client registrations

OCE manages client registrations through the Driver. It keys each registration
by the trusted `issuer` and `clientId` pair because client IDs are unique only
within an authorization server. [RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2)

- `registerClient({ issuer, clientId }, clientSecret?)` stores the resolved client
  and any secret in the Driver's protected store. Public clients can omit the secret.
  Templates with the same pair share the returned `clientRegistrationId`. The
  same `clientId` at another issuer gets a separate registration.
- For clients with a secret, `rotateClientSecret(clientRegistrationId, clientSecret)`
  sets the version for new connections. Each connection pins the version used
  for its exchange. Existing connections continue refreshing
  with that version until the provider disables it, then report `reauthorize`.
- `removeClient(clientRegistrationId)` removes the stored registration and any
  secret it holds. OCC calls it only when no template version or source uses it.

Each connection template version and credential source records its
`clientRegistrationId`. The Driver keeps referenced client secret versions
available across replicas and restarts. For a confidential client, OCE must
authenticate the code exchange with the pinned registration and secret version.
The Token Service uses the same pinned version for refresh. OCC stores the
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

For an HTTP destination with `read-only` access, the sender permits only
`GET`, `HEAD`, and `OPTIONS`. MCP clients send both read and write tool calls by
`POST` to the declared endpoint. OCC rejects an MCP transport destination with
`read-only` access before saving a version. The supported value, `full`, allows
the MCP transport at that exact endpoint. The MCP server enforces the owner's
selected scopes on each call. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server)

Every remote Streamable HTTP plugin uses the same credential policy helper. When
binding a ready connection, OCE matches its approved server URL and OAuth resource
to the plugin descriptor and release. The helper derives the bearer route from
the server URL’s HTTPS host, effective port and literal path. OpenShell permits
`POST` for messages, `GET` for streams and `DELETE` for session closure at that
endpoint. The worker exposes all tools the server lists for the connected account
(`tools/list`). Installing the plugin alone grants no route.
Discovery, registration and refresh use separate management endpoints.

RFC-0023 authenticates an execution. Listing a binary in a connection template
does not establish which process sent a request. Refuse deployment when the
installation cannot enforce the executable restriction recorded at consent.

## Failure and recovery

| Condition                                                   | Result                                           | Recovery                                       |
| ----------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Consent denied, popup closed, or session expired            | Pending source deleted                           | Connect again                                  |
| `state` mismatch, reuse, or another user's session          | `400`; no exchange                               | The owner connects again                       |
| Exchange refused or no refresh token returned               | Source deleted; `fix_configuration`              | Administrator corrects the connection template |
| Exchange, Secret write, or refresh registration uncertain   | Source stays `registering`                       | Delete and reconnect; OCC never replays a code |
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
- **Connection profiles.** For a source with only `profile.name`, verify that
  a credential source read and its Agent's connection list return the same name.
  Repeat with a second account using the same template on another Agent. An
  absent profile is omitted from both responses and the source can still refresh.
- **Refresh ownership.** For either setup path, verify that a source with a valid
  initial token is ready before its first background tick. Under the
  default strategy, a tick outside the renewal window makes no issuer call or
  Secret write. Advance into the window and verify that the Token Service renews
  the credential and writes the result through the Secret Driver. Have the issuer
  rotate the refresh token once and omit its replacement on the next renewal.
  Verify that the following refresh uses the rotated token. Fail a Secret write
  and verify OpenShell never serves the candidate access token. After a successful write, verify OpenShell presents
  the new access token for the same worker placeholder. With no eligible prepared
  token, verify that OpenShell refuses the request without contacting the issuer.
- **Template setup and consent.** Save one template from manual settings and one
  from MCP discovery. Check that an advertised `revocation_endpoint` is saved
  and an omitted one stays absent. Reject an HTTP revocation URL. Edit the URL
  and verify an existing source still pins the original endpoint.
  With the Refresh Driver's browser authorization methods unavailable, complete
  Connect and callback for both saved versions. Connect a
  fixed-scope template by ID alone. Exercise scope selection and reject stale
  versions or out-of-policy selections before source creation. Reject an extra
  parameter that sets `resource`. For a template with an approved resource, verify
  that the issuer receives it on authorization, code exchange, and refresh. Withhold
  confirmation of storage or refresh registration and verify the source stays
  `registering` and the issuer sees only one code exchange.
- **MCP.** Verify supplied clients, successful DCR, and fallback when DCR is
  unavailable or refused. Connect using the saved client without repeating
  discovery or DCR at consent. Reject `read-only` for the MCP endpoint before a
  version is created. On a dedicated worker, verify a tool call uses the selected
  scopes and an unselected scope stays unavailable after refresh.
  Bind two MCP servers, one on a nondefault port, and verify each placeholder
  works only at its own endpoint.
- **Client registrations.** Two connection templates with the same `clientId` in
  two Keycloak realms keep independent secrets: rotating one leaves the other's
  sources refreshing.
- **IAM.** A person with an identity binding and a person connecting an Agent in a
  Namespace with a `namespace` binding can connect; the same person connecting an
  Agent in another Namespace, a service key, and a caller without a binding are
  refused. Only Installation administrators can create or delete the bindings.
- **OIDC.** For either setup path, reject a version whose metadata issuer or
  endpoints differ. Reject an ID token with a wrong issuer, untrusted signing key,
  wrong audience, or wrong nonce before storing the token set. Show the verified
  address on success.
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
