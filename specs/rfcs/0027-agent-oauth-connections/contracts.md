---
rfc: index.md
---

# Contracts, failure, and verification for OAuth connections

This companion defines the platform contracts, failure behavior, and required
outcomes for [RFC-0027](index.md). The RFC owns the decision, connection
templates, consent rules, and Agent attachment boundary.

<a id="credential-refresh-driver"></a>

## Token Service and OAuth enrollment

### Browser authorization

OCC owns browser consent for connection templates. An Installation can connect
an account and renew it with the Credential Refresh Driver and OpenShell
unconfigured.

1. OCC validates the requested scopes against the template. It generates a
   random `state` and a PKCE verifier and stores the attempt in private
   control-plane storage, bound to the initiating browser session and the
   template version. For `accountIdentity: oidc`, OCC also generates a nonce.
   The browser receives the authorization URL with the PKCE challenge.
2. On callback, OCC checks the browser session, state, expiry and issuer,
   then claims the attempt once. It reads the pinned registration's current
   secret if required and posts the code and verifier to the approved token
   endpoint. OCC never replays the code after an uncertain exchange.
3. OCC hands the first access token and refresh grant to the Token Service for
   this source. OCC marks the connection ready only after the Token Service
   commits them. An uncertain handoff leaves the source `registering`.

The Token Service serializes renewals per source and commits the new access
token and any replacement refresh token together. The Credential Proxy
presents an eligible prepared token for an authorized Agent request.
[Credential access and lifecycle](../0023-egress-proxy-credential-lifecycle/contracts.md#credential-access-and-lifecycle)

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
Changing the MCP server URL, protected resource or issuer requires new consent. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-registration-approaches) · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)

At Agent setup, Console uses `tools/list` to show available tools. An authorized
caller selects tools by exact name for that Agent and server. By default the
selection is empty. The deployed worker exposes only selected tools permitted
by the Agent's policy. Newly advertised tools require explicit selection and deployment.

### Client registrations

OCC owns the OAuth client registration. An Installation administrator registers the provider-issued client ID against a template. OCC records the registration's availability, issuer, client ID, authentication method and allowed token endpoint. A client ID identifies an application within its issuer. [RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2)

A public client uses `none` and needs only its client ID. For `client_secret_basic` or `client_secret_post`, OCC stores the secret with the Installation's Secret Driver and keeps a private reference on the registration. The Console and public API expose only registration metadata. OCC can create a template, register a client, rotate a secret and delete an unused registration with OpenShell unconfigured. It durably tracks interrupted secret creation and deletion so cleanup can finish after a restart.

### Client authentication and account custody

At the initial code exchange, OCC resolves the current secret for the pinned registration if its authentication method requires one. A successful exchange hands the user's refresh grant and first access token to the Token Service. On subsequent renewal the Token Service obtains the same registration's current client authentication for the pinned issuer and token endpoint. Rotation at the same registration applies to existing accounts. If the provider rejects the client secret, the administrator can fix the registration and retry. Revoking the user's grant requires new consent.

OCC registers the exchanged grant with the Token Service and keeps the stable account reference. Resolution checks the token’s remaining lifetime. Authorized delivery can start or join renewal as [RFC-0023 specifies](../0023-egress-proxy-credential-lifecycle/contracts.md#credential-access-and-lifecycle). The Token Service records the requested scopes and the scopes the provider granted.
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

For `accountIdentity: oidc`, OCC establishes the trusted provider before it accepts
the connection template version:

1. Without `jwksUri`, it reads `<issuer>/.well-known/openid-configuration`
   ([provider metadata](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)).
   The metadata `issuer` must equal the configured `issuer` exactly, and its
   `authorization_endpoint` and `token_endpoint` must equal the connection
   template's URLs. OCC records the metadata's `jwks_uri`.
2. With `jwksUri`, it uses that `https` URL and skips discovery.
3. A mismatch, an unreachable provider, or a non-`https` value rejects the version
   with `400`, and the version is not created.

The recorded `issuer` and JWKS URL become part of the version and of each source's
approved values. At completion, OCC validates the ID token
([OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation))
against keys from that JWKS URL only: signature, `iss` equal to the recorded
`issuer`, `aud` containing the client ID, expiry, and nonce. It refetches the key
set once for an unknown key ID, then rejects the connection if it cannot validate
the token.

OCC records `accountEmail` only when that validated ID token contains a
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

## Update a running sender

The worker compares the current delivery policy with the policy installed for that
Agent. Before changing the recipients, Credential Proxy disables use of the affected binding, including its installed token. Once withdrawal is confirmed, the paired Sandbox applies the updated policy and prevents direct egress. Compute verifies the installed policy for that revision. OCC then rechecks the grant, template and Agent binding before allowing the proxy to use a token prepared by Token Service.
A failed or superseded update leaves that sender without a usable token until
reconciliation succeeds. A different Agent can keep using its own sender.

## Protected egress

The sender authenticates the deployed execution and checks its authority to
use the source for the actual request within the Installation’s egress ceiling.
[RFC-0023 admission and sender contracts](../0023-egress-proxy-credential-lifecycle/contracts.md)

For manual OAuth, OCC reads the current rows from the same manual template and
checks the issuer against the grant. An administrator can replace hosts for
existing accounts. OCC reconciles affected senders on running revisions and
retries failed updates. Each request must match a host, port and path, the
release’s reviewed operations, granted scopes and deployed Agent policy.

For MCP, the approved resource and server must match the release. OpenShell
binds the bearer to the server’s HTTPS host, port and literal path. It permits
`POST` for messages, `GET` for streams and `DELETE` for session closure.
Discovery, registration and refresh use separate management endpoints.
[MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server)

For every `tools/call`, enforce the deployed tool name and argument
restrictions. For Google, match each request against reviewed operations.
A Gmail metadata-only policy allows `format=metadata` and rejects
`format=full` for both `gog` and direct scripts. Refuse deployment if the
sender cannot enforce the policy.

## Failure and recovery

| Condition                                                   | Result                                         | Recovery                                       |
| ----------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Consent denied, popup closed, or session expired            | Pending source deleted                         | Connect again                                  |
| `state` mismatch, reuse, or another user's session          | `400`; no exchange                             | The owner connects again                       |
| Exchange refused or no refresh token returned               | Source deleted; `fix_configuration`            | Administrator corrects the connection template |
| Timeout after the exchange started                          | Source stays `registering`                     | Delete and reconnect; OCC never replays a code |
| Issuer revokes the grant                                    | `status.refresh.recoveryAction: reauthorize`   | **Reconnect** and redeploy                     |
| Token custody unavailable before source creation            | Connection cannot start                        | Restore the Token Service and Secret Driver    |
| OIDC metadata mismatch or unreachable provider              | Version rejected with `400`                    | Administrator corrects `issuer` or URLs        |
| ID token from a wrong issuer, untrusted key, or wrong nonce | Source deleted; `fix_configuration`            | Administrator checks the provider; reconnect   |
| Manual destination rows edited                              | Existing senders reconcile the current rows    | Retry a failed reconciliation                  |
| OAuth identity or MCP target changed                        | Original grant cannot authorize the new target | Owner reconnects for the new identity          |
| Withdrawal pending or failed after detach or disconnect     | Affected attachments deny further use          | Retry withdrawal, or stop the affected Agent   |
| Provider rejects the current client secret                  | Client authentication fails                    | Admin corrects secret, then refresh retries    |

The operator guide documents provider rules. Google requires verification for
public applications requesting `gmail.readonly`, and External Testing applications
issue seven-day refresh tokens.

## Required outcomes

- **HTTP and PostgreSQL integration.** With Keycloak, PKCE and refresh tokens,
  connect and renew with OpenShell and the Credential Refresh Driver unconfigured.
  Verify denied consent, state reuse, cross-session callbacks, expired sessions
  and missing grants. Attach one account to Agents A and B. Deny an
  ungranted Agent, a pending source before or during callback, a caller without
  source-use or Agent-update permission, and cross-Namespace attachment.
  Detach A with queued and serving revisions: A loses access and B retains it
  without reauthorization. Disconnect the account and verify B loses access.
  Keep codes and tokens out of responses, logs and audit.
- **Manual destination changes.** Replace a host for a running Agent. After
  reconciliation, verify delivery to the new host and no bearer at the old
  one. Attempt a call between withholding the token and confirming the new policy. Verify that neither host receives a bearer and that another Agent using an unaffected template can still use its account. Change the default client: refresh still uses the original registration.
  Change the issuer and verify delivery stops.
- **Refresh ownership.** For manual OAuth and MCP, observe background issuer
  refresh. With the same worker placeholder, OpenShell presents the new token.
  Without an eligible token it refuses the request without contacting the issuer.
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
  rotate, revoke, and reconnect work; a token URL edit preserves the original
  grant’s refresh endpoint. Connect with A, rotate to B, disable A, then refresh
  the same saved account and use its new access token without another consent flow.
- **Live Google proof.** Run manually with an authorized account: `gog` reads Gmail
  through a dedicated Codex Agent, and a write method is denied. This proof is
  outside CI.
- **Dedicated Codex environment.** Verify that Codex shell commands receive the
  connection template's variable. Codex may filter variable names that contain
  `TOKEN`; if it does, Compute must allow exactly the connected variables.
