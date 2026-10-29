---
rfc: index.md
---

# Driver contracts, failure, and verification for OAuth connections

This companion defines the Driver contract changes, failure behavior, and required
outcomes for [RFC-0024](index.md). The RFC owns the decision, connection
templates, consent rules, and personal-Agent boundary.

For either template type, the source becomes `ready` only after the OCE Token Service
durably accepts the grant and first access token. If the handoff outcome is unknown,
the source stays `registering` and OCC never replays the code. The Token Service keeps
the grant in encrypted custody, serializes background refresh per source, and commits
each access token with any replacement refresh token. OpenShell presents an eligible
prepared token for the deployed binding or refuses the request. [Credential access and lifecycle](../0023-egress-proxy-credential-lifecycle/contracts.md#credential-access-and-lifecycle)

## MCP authorization

OCE uses the official TypeScript MCP client to discover the protected resource and
authorization server for the MCP URL an administrator enters. Discovery runs under
the Installation's management egress policy and needs no client credentials. The
administrator supplies a preregistered client or approves Dynamic Client Registration
(DCR) at the advertised `registration_endpoint`. If the issuer omits that endpoint
or refuses registration, Console asks for a preregistered client.

On save, OCE rechecks the metadata and pins the server URL, resource, issuer,
endpoints, client registration, and at least one approved scope from the challenge
or resource metadata. Client ID Metadata Documents (CIMD) are deferred pending a
stable HTTPS document that the issuer can fetch with the installation's callback URI.

At **Connect**, the owner selects scopes in Console. Before creating the source,
OCC checks that the selection is a nonempty subset of the template version's
approved scopes and includes every required scope. OCE uses the SDK to start
authorization with those scopes, the pinned resource, a random `state`, and a
PKCE challenge. The owner grants consent at the issuer.
At callback, OCE checks the session, state, and issuer, then exchanges the code
once using the verifier, pinned client registration, token endpoint, and resource.

OCE checks the granted scopes against the owner's selection and hands the refresh
grant and first access token to the Token Service. The handoff identifies the
source, pinned client registration, issuer, token endpoint, resource, and selected
scopes. The Token Service uses those
values for refresh and checks each renewed grant before use. Changed endpoints
require a new version and consent. The worker exposes the tools the server lists
for the connection (`tools/list`). [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-registration-approaches) · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)

## Credential Refresh Driver

### Browser authorization

For a template with configured OAuth endpoints, OCC owns the session and calls
the Driver's optional browser methods.

- `startBrowserAuthorization(context, { connectionTemplateVersion, redirectUri })`
  returns `{ authorizationUrl, privateState }`. The Driver uses the version's fixed
  scopes and creates the PKCE verifier, a random `state`, and a nonce for
  `accountIdentity: oidc`. `privateState` is opaque to OCC.
- `completeBrowserAuthorization(context, privateState, { code, state, iss? })` verifies
  `state` and exchanges the code using the verifier and pinned client registration.
  The Driver hands the validated grant and first access token to the Token Service.
  OCC receives status and an optional verified `accountEmail`.

### Client registrations

OCE manages client registrations through the Driver. It keys each registration
by the trusted `issuer` and `clientId` pair because client IDs are unique only
within an authorization server. [RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2)

- `registerClient({ issuer, clientId }, clientSecret?)` stores the resolved client
  and any secret in the Driver's protected store. A public MCP client can omit the secret.
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
available across replicas and restarts. For a confidential MCP client, OCE must
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

For a configured HTTP template with `read-only` access, the sender permits only
`GET`, `HEAD`, and `OPTIONS`. MCP clients send both read and write tool calls by
`POST` to the declared endpoint. OCC rejects an `mcp_oauth` template with
`read-only` access before saving a version. The supported value, `full`, allows
the MCP transport at that exact endpoint. The MCP server enforces the owner's
selected scopes on each call. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server)

Every remote Streamable HTTP plugin uses the same credential policy helper. When
binding a ready connection, OCE matches its approved server URL and OAuth resource
to the plugin descriptor and release. The helper derives the bearer route from
the server URL’s HTTPS host, effective port and literal path. OpenShell permits
`POST` for messages, `GET` for streams and `DELETE` for session closure at that
endpoint. Installing the plugin alone grants no route.
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
| Exchange or grant handoff outcome unknown                   | Source stays `registering`                       | Delete and reconnect; OCC never replays a code |
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
- **MCP.** Verify supplied clients, successful DCR, and the prompt for a supplied
  client when DCR is unavailable or refused. With the Driver's browser methods
  unavailable, verify OCE discovers metadata, redirects the owner for consent,
  and exchanges the code with PKCE. Verify the Token Service then receives the
  grant for the pinned resource and selected scopes.
  Withhold handoff confirmation and verify the source stays `registering` and the
  issuer sees only one code exchange. On a dedicated worker, verify a tool call
  uses the selected scopes and an unselected scope stays unavailable after refresh.
  Bind two MCP servers, one on a nondefault port, and verify each placeholder
  works only at its own endpoint.
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
