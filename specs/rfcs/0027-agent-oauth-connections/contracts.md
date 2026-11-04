---
rfc: index.md
---

# Driver contracts, failure, and verification for OAuth connections

This companion defines the Driver contract changes, failure behavior, and required
outcomes for [RFC-0027](index.md). The RFC owns the decision, connection
templates, consent rules, and Agent attachment boundary.

## Credential Refresh Driver

`CredentialRefreshDriver` gains these optional methods beside the existing device
methods. A Driver that omits them offers no browser connections.

### Browser authorization

OCC owns the connection session and calls the Driver's browser authorization
methods for setup and code exchange. After exchange, the OCE Token Service
keeps the grant in encrypted custody and refreshes access tokens in the
background. It serializes refresh per source and atomically commits the access token
with any replacement refresh token. OpenShell presents an eligible, prepared
token for the deployed binding or refuses the request. [Credential access and lifecycle](../0023-egress-proxy-credential-lifecycle/contracts.md#credential-access-and-lifecycle)

- `startBrowserAuthorization(context, { connectionTemplateVersion, redirectUri, selectedScopes? })`
  returns `{ authorizationUrl, privateState }`. OCC validates the requested
  scopes before the Driver starts consent. The Driver
  creates the PKCE verifier, a random `state`, and a nonce for `accountIdentity: oidc`.
  `privateState` is opaque to OCC.
- `completeBrowserAuthorization(context, privateState, { code, state, iss? })` verifies
  `state` and exchanges the code using the verifier and pinned client registration.
  The Driver hands the validated refresh grant and first usable access token to
  the Token Service, bound to the source and its approved OAuth context. It returns
  `ready` only after the Token Service durably accepts them. An uncertain handoff
  leaves the source `registering` and never replays the code. OCC receives status
  and an optional verified `accountEmail`.

### MCP authorization

The administrator enters the MCP server URL. OCE uses the official TypeScript
MCP client to discover the protected resource and its authorization server under
the Installation's management egress policy. The administrator supplies a
preregistered client ID and any required secret, or approves Dynamic Client
Registration (DCR) at the issuer's advertised `registration_endpoint`. If the
issuer omits that endpoint or refuses registration, Console asks for a
preregistered client.

Client ID Metadata Documents (CIMD) are deferred. Supporting CIMD would require
a stable HTTPS document the issuer can fetch, listing the installation's exact
callback URI.

A version pins the server, resource, issuer, endpoints and optional client.
An administrator can limit requested scopes to a list of any length or choose
**No template limit**. An empty list records that choice. At consent, the
user can select individual scopes. OCC enforces any list and required MCP
challenge scopes. With a fixed manual list, OCC requests those configured
scopes. Without a limit or requested scopes, it omits `scope` so the provider
can apply its defaults. Discovery alone requests no optional scopes.
Changed endpoints require a new version and consent. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-registration-approaches) · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)

At Agent setup, Console uses `tools/list` to show available tools. An authorized
caller selects tools by exact name for that Agent and server. By default the
selection is empty. The deployed worker exposes only selected tools permitted
by the Agent's policy. Newly advertised tools require explicit selection and deployment.

### Client registrations

OCE manages client registrations through the Driver. It keys each registration
by the trusted `issuer` and `clientId` pair because client IDs are unique only
within an authorization server. [RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2)

- `registerClient({ issuer, clientId, tokenUrl, tokenEndpointAuthMethod }, clientSecret?)` stores the resolved client
  and any secret in the Driver's protected store. A public MCP client can omit the secret.
  Templates with the same pair share the returned `clientRegistrationId`. The
  same `clientId` at another issuer gets a separate registration.
- `rotateClientSecret(clientRegistrationId, clientSecret)` replaces the secret
  at the same private reference. An exchange, refresh or revocation that
  authenticates the client resolves its current secret before the request.
- `removeClient(clientRegistrationId)` removes the private registration once
  its template versions and saved accounts have been released. OCC cleans up
  interrupted creations and deletions after a restart.

Each saved grant records the registration reference. The selected Driver
supplies its current client authentication for the pinned issuer, client ID
and provider endpoints. The Token Service keeps the user's refresh token.
A rejected client secret requires an administrator to fix the registration.
A revoked user grant requires the user to reconnect.

### Client authentication and account custody

The Credential Refresh Driver supports independently registered clients. It
advertises the authentication methods it implements and accepts a registration
with a method and the corresponding write-only material. A public client has
method `none`. Confidential clients may use `client_secret_basic` or
`client_secret_post`. A method requiring a signing key is offered only by a
Driver that implements signing. The registration pins the destination that may
receive its credentials. Browser start, exchange and renewal use the resolved
client and the same protected resource when resource indicators apply.

Connecting an account commits the grant in Token Service custody. The Token
Service records the requested scopes and the scopes the provider granted.
When the provider omits `scope`, the Token Service records the requested
scopes. If both omitted it, it records no known scopes. Explicit requests and
renewals cannot acquire permissions beyond those requested or previously
granted. Only an authorized consumer with a compatible destination receives
prepared material. Its binding supplies local delivery names.

### Named plugin accounts

A Plugin Driver describes each account by stable slot ID, label, accepted
issuers, and trusted recipient requirements. It can supply multiple slots,
including slots accepting the same issuer. Local variable aliases for one
slot share a single selection. The Driver interprets its own selection
policy and reports its selected slot-to-source bindings to OCC. It validates
and projects delivery for the selected release and consumer.

The enablement modal lists Namespace accounts the caller may use and filters
them by issuer. A saved grant that covers the approved target can be assigned
when the caller saves the Agent draft. OCC atomically grants that Agent access
and saves the exact slot assignment. A grant for another resource requires
explicit authorization for this target before the sender can use a token.
Generic slot eligibility does not require a list of tool scopes. OCC enforces
Agent tool and request policy before sending. The resource server enforces
its scopes and may request additional consent. Installation-wide and Namespace
authority still bound all listing and use.

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
set once for an unknown key ID, then rejects the connection if it cannot validate
the token.

The Driver returns `accountEmail` only when that validated ID token contains a
nonempty `email` string and the boolean claim `email_verified` is `true`.
When either condition is unmet, the connection can complete without `accountEmail`.

## IAM Driver

This extension describes optional grants on an individual template. The scoped
catalog and account flow use the existing Installation `administer` and
Namespace `credential_source:create` permissions.

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
  subject. OCC sets it to the connection's Namespace when it checks `use` at
  connect time, after checking the caller's access to that Namespace. Requests without a context never
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

The template pins the recipient's host, port and path. The plugin and deployed
request policy govern allowed operations there. MCP sends both read and write
tool calls by HTTP POST. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server)

Every remote Streamable HTTP plugin uses the same credential policy helper. When
binding a ready connection, OCE matches its approved server URL and OAuth resource
to the plugin descriptor and release. The helper derives the bearer route from
the server URL’s HTTPS host, effective port and literal path. OpenShell permits
`POST` for messages, `GET` for streams and `DELETE` for session closure at that
endpoint. Installing the plugin alone grants no route.
OAuth metadata discovery, registration and refresh use separate management endpoints.

The sender authenticates the deployed execution and checks its current authority
to use the attached source. It evaluates the actual request before presenting the
credential. A connector policy can restrict the operation and its arguments:
for a Gmail metadata-only binding, `format=metadata` may pass while
`format=full` fails on the same message URL. Apply those checks both to `gog` and
to a direct script. For each MCP `tools/call`, the sender checks the requested
name against the deployed selection for that Agent and server and enforces any
argument restrictions before forwarding the call.
If the selected route cannot enforce a promised restriction, refuse deployment.

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
| Withdrawal pending or failed after detach or disconnect     | Affected attachments deny further use            | Retry withdrawal, or stop the affected Agent   |
| Provider rejects the current client secret                  | Client authentication fails                      | Admin corrects secret, then refresh retries    |

The operator guide documents provider rules. Google requires verification for
public applications requesting `gmail.readonly`, and External Testing applications
issue seven-day refresh tokens.

## Required outcomes

- **HTTP and PostgreSQL integration.** Use a real Keycloak issuer with
  authorization code, PKCE, and refresh tokens. Prove success, denied consent,
  state reuse, a cross-session callback, an expired session, and a missing grant.
  Connect once, attach to Agents A and B, and refuse a third Agent without a
  grant. Refuse attachment or deployment of a pending source before and during
  callback. Refuse a caller who can only read the source, a caller who cannot
  update the Agent, and an attachment across Namespaces. Detach A, including
  with queued and serving revisions: A loses access, B can still send approved
  requests, and neither action repeats consent. Disconnect the account and
  verify B also loses access. Verify no codes or tokens appear in responses,
  logs, or audit.
- **Refresh ownership.** For both configured OAuth and MCP, observe the Token
  Service refresh the access token with the issuer in the background. Send a
  worker request with the same placeholder and verify that OpenShell presents
  the new access token. With no eligible prepared token, verify that OpenShell
  refuses the request without contacting the issuer.
- **MCP.** Verify supplied clients, successful DCR, and the prompt for a supplied
  client when DCR is unavailable or refused. On a dedicated worker, verify a
  Console tool call uses the selected scopes and an unselected scope stays
  unavailable after refresh. Deploy an Agent with only a search tool selected,
  then have the server advertise a write tool covered by the same OAuth grant.
  Refresh the picker and verify it lists the write tool. Verify the Agent can
  still call search and its tool list omits the write tool. Send a direct
  `tools/call` for the write tool and verify the sender denies it before it
  reaches the server. Bind two different MCP servers, including one on a
  nondefault port, and verify each placeholder works only at its own endpoint.
- **Client registrations.** Two connection templates with the same `clientId` in
  two Keycloak realms keep independent secrets: rotating one leaves the other's
  sources refreshing.
- **IAM.** A person with an identity binding and a person connecting in a
  Namespace with a `namespace` binding can connect; the same person connecting
  in another ungranted Namespace, a service key, and a caller without a binding are
  refused. Only Installation administrators can create or delete the bindings.
- **OIDC.** Reject a version whose metadata issuer or endpoints differ, and an ID
  token with a wrong issuer, an untrusted signing key, a wrong audience, or a wrong
  nonce. With a valid token, store and display the address when
  `email_verified` is `true`. With the same address and a false or missing
  claim, verify the source becomes ready without a stored or displayed address.
- **Real k3d and OpenShell.** Through the regular Agent create path, connect via
  Keycloak and prove: a tool reaches its endpoint with no added network policy; a
  write fails under the plugin’s read-only request policy; a tool and a script get the same allow and deny
  decisions from the protected sender on the same requests;
  rotate, revoke, and reconnect work; an edited `tokenUrl` or endpoint leaves an
  existing source unchanged. Connect with A, rotate to B, disable A, then refresh
  the same saved account and use its new access token without another consent flow.
- **Live Google proof.** Run manually with an authorized account: `gog` reads Gmail
  through a dedicated Codex Agent, and a write method is denied. This proof is
  outside CI.
- **Dedicated Codex environment.** Verify that Codex shell commands receive the
  connection template's variable. Codex may filter variable names that contain
  `TOKEN`; if it does, Compute must allow exactly the connected variables.
