---
status: Proposed
implementation_status: Not implemented
author: mrunalp
---

# Proposal: Connect a user's OAuth account to a personal Agent from the console

- **ID:** RFC-0023
- **Created:** 2026-10-20
- **Last updated:** 2026-10-21
- **RFC PR:** [#3068](https://github.com/openclaw/openclaw-enterprise/pull/3068)
- **Implementation plan:** [RFC-0023 plan](../../plans/0023-agent-oauth-connections.md)
- **Companion:** [Driver contracts, failure, and verification](contracts.md)
- **Related:** [RFC-0016](../0016-sandbox-credential-injection/index.md) and its
  [Credential Refresh companion](../0016-sandbox-credential-injection/credential-refresh.md);
  [RFC-0010 personal access](../0010-agent-access.md#access-contract);
  [credential sources](../../../docs/reference/credential-sources.md);
  [per-Agent sandbox policies](../../../docs/reference/sandbox-policies.md);
  open [PR #2484](https://github.com/openclaw/openclaw-enterprise/pull/2484)

## Summary

A user signs in to the OCE console, opens their personal Agent, selects
**Connect Google**, approves access on Google's consent page, and then deploys the
Agent. The Agent's tool, such as `gog`, can then read that user's Gmail. Only that
user can use the Agent.

Installation administrators define connections as Installation-wide **connection
templates**, which Presets can reference. The Credential Refresh Driver exchanges
the authorization code and gives the refresh grant to the Credential Gateway, and
OpenShell refreshes the access token. The browser, OCC storage, and the Agent never
receive the refresh token; the tool receives only a placeholder. OCE core contains
no provider-specific endpoints, scopes, or binaries.

## Motivation

Today a user who wants an Agent to read their Gmail must export a refresh token
with a local sign-in tool, store it and the client secret as Namespace Secrets,
register an `oauth2-refresh-token` source, bind it, grant the Agent's service
principal `operate`, and deploy
([credential sources](../../../docs/reference/credential-sources.md)). The refresh
token passes through the user's terminal and the OCC Secret store, and anyone with
access to the Agent can use the mailbox.

Device login, used only by the experimental `codex-oauth` model source, does not
help: Google's device-code flow does not permit Gmail scopes. Gmail needs the
browser authorization-code flow, with an OCC callback.

This proposal reuses the custody model of
[device login](../../../apps/controller/src/drivers/credential-refresh/openshell.ts),
which hands the grant to OpenShell without persisting the refresh token.

## Goals

- A user connects their own account in the console without handling a client
  secret, refresh token, or access token, then deploys their Agent.
- Only the connecting user can use, deploy, or open an Agent that holds their
  connection, until every copy of the credential is withdrawn.
- Administrators add a provider by creating a connection template, not by
  changing OCE code or Installation configuration.
- The credential reaches only the connection template's binary, endpoint, and
  allowed HTTP methods.
- Revocation, a denied consent, and an uncertain exchange each produce a visible
  state and one recovery action.

## Non-goals

- Shipping `gog` or any provider tool in the OCE runtime image. Operators supply an
  image that contains the connection template's binary.
- Device-code connections for tool credentials, and changes to model
  authentication (`harnessAuth`).
- Service-account or domain-wide delegation.
- Reducing what the approved scope can read. `gmail.readonly` exposes the whole
  mailbox to the tool.
- Shared Agents with connections, and per-message user identity inside an Agent.
- Namespace-owned connection templates. Start with the Installation-wide catalog;
  add Namespace templates later only if Namespaces need different providers or
  OAuth clients.

## Proposal

### Connection templates

A connection template is an Installation-scoped resource with IAM kind
`connection_template` and actions `create`, `read`, `update`, `delete`, and `use`.
Installation administrators manage the catalog through the API, CLI, and console.
They grant `use` on an exact connection template to a person, or to a Namespace so
that anyone connecting an Agent in that Namespace may use it. IAM gains
Installation-level access bindings for this ([IAM changes](contracts.md#iam-driver)).
A user needs `use` to see a connection template under **Connect** and to start a
connection from it. Credential sources created from it stay in the Agent's
Namespace.

| Field                               | Why it is needed                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName`                       | The label on the **Connect** button and consent warning.                                                                                        |
| `issuer`                            | The authorization server's identifier, an exact `https` URL. It scopes the client ID and is the expected `iss` for `accountIdentity: oidc`.     |
| `authorizationUrl`, `tokenUrl`      | Where OCC sends the user, and where the Driver exchanges the code. Exact `https` URLs.                                                          |
| `clientId`, `clientSecret`          | The administrator's OAuth client at `issuer`. The Refresh Driver keeps the secret; OCC stores no value.                                         |
| `scopes`, `authorizationParameters` | The fixed access the user approves. Users cannot add scopes. Google needs `access_type=offline` and `prompt=consent` to return a refresh token. |
| `endpoint`                          | The API `host`, `port`, `path`, and `access` (`read-only` or `full`) that receive the credential.                                               |
| `envVar`, `binary`                  | The placeholder variable and the one executable that may send it.                                                                               |
| `accountIdentity`                   | `none` (default) or `oidc`. With `oidc`, OCC also requests `openid email` and shows the connected address.                                      |
| `jwksUri`                           | Optional with `oidc`. Without it, the Driver discovers the signing keys from `issuer`.                                                          |

OCC rejects a connection template whose URLs are not `https` or whose `binary` is
not in the Gateway's `toolBinaries`. Startup configuration keeps `toolBinaries` and
`drivers.credential_refresh`, which describe the runtime image and Drivers.

The callback URI is derived from the console origin as
`https://<console-host>/oauth/callback`. Administrators register that exact URI
with the provider. The connection template response shows it.

With `accountIdentity: oidc`, the Refresh Driver verifies the provider before it
accepts the connection template version, and verifies each ID token against it
([OIDC verification](contracts.md#oidc-account-identity)). OCC stores the verified
address on the credential source and shows "Connected as alice@example.com". The
consent screen lists the two extra scopes. Use it to catch a user who approved the
wrong account; it does not affect who may use the Agent.

### Versions and consent

An edit never changes what an existing connection does. Changing any field except
`displayName` creates a new connection template version. The credential source
records the version and the values its owner approved: issuer and its URLs, client
registration, scopes, authorization parameters, endpoint and access, variable,
binary, and OIDC settings. OCC and both Drivers use only that record, so an
administrator cannot redirect a user's refresh grant or credential. Source
configuration is already immutable.

After a new version, existing connections keep working and Agent details show
**Reconnect to apply changes**. Reconnecting asks for consent again and creates a
new source. To stop an old version, for example after an endpoint compromise,
administrators disconnect the affected sources. OCC refuses to delete a connection
template while any source references one of its versions.

Rotating the client secret is not a consent change. The secret belongs to a client
registration for one `issuer` and `clientId` pair, so the same client ID at another
issuer stays independent. Rotation applies to new connections; existing
connections keep the secret they were configured with until the provider disables
it ([client registrations](contracts.md#client-registrations)).

### Personal Agents

A connection belongs to the human who completed consent. OCC records that
identity on the credential source and applies the
[RFC-0010 personal choice](../0010-agent-access.md#access-contract) to every Agent
that holds the source:

- Only the connection owner can bind the source to an Agent, and only to an Agent
  where the owner is the only human grantee.
- OCC refuses Agent grants to other humans and refuses Slack, Teams, or other
  channel bindings, because channel members could invoke the tool.
- Deploying, opening the native admin UI, and starting a chat require the owner's
  signed-in session. Service keys cannot deploy the Agent.
- Installation administrators can stop the Agent, delete it, and disconnect the
  source. They cannot deploy it or use it.

An Agent holds the source while its saved settings list it, a pending deployment
includes it, or any deployed revision retains it. Removing the saved binding does
not end the restriction: revisions keep their own source snapshots, and withdrawal
is asynchronous. The restriction ends only when every revision's attachment
reports `revoked`, or the revision is retired, with no pending deployment or
reattachment that includes the source. A failed or stalled withdrawal keeps it in
force; administrators can stop or delete the Agent.

An administrator, or a user with `agent:create`, creates the Agent for the owner.
The Agent's `connections` list names each required connection template, and
deployment returns `409` until each has a `ready` source. OCE has no per-message
identity, so this boundary covers access paths, not individual messages.

### Presets and connection templates

A [Preset](../../../docs/reference/presets.md) is a Namespace copy of Agent launch
settings that the creator edits; later Preset changes never affect the Agent. A
connection template defines how one person's account is connected and where its
credential may go, and only Installation administrators change it. A Preset
therefore references connection templates instead of copying them.

Add `agent.connections` to the Preset template, a list of
`{ "connectionTemplateId": "…" }` entries. Creating an Agent from the Preset copies
that list into the Agent's `connections`; the console shows one **Connect** button
per entry. One Preset can combine several connection templates, such as Gmail and
Calendar read-only, with the Configuration and instructions that use those tools.
An unknown or unusable connection template fails Agent creation with `400`; the
Preset stays valid.

### Driver contract changes

These changes require review of this RFC before implementation. The
[companion](contracts.md) defines their inputs, results, and failure behavior.

1. **`CredentialRefreshDriver`** gains browser authorization, client registration,
   and OIDC provider verification. It keeps OAuth client secrets; the OpenShell
   implementation adds a `clientWorkspace` setting for them.
2. **`CredentialGatewayDriver`** accepts an `access` field on tool-source
   endpoints, so `read-only` permits only `GET`, `HEAD`, and `OPTIONS`.
3. **The OpenShell tool profile** releases the credential only to the connection
   template's `binary`.
4. **Attachment opens the endpoint** for that binary. The current provider profile
   already does this; the contract makes it required behavior.
5. **`IAMDriver`** gains Installation-level access bindings, a `namespace` subject
   kind, and an optional Namespace context on authorization requests.

Connections create sources of the existing `oauth2-refresh-token` type. The type
keeps its Secret-backed registration path for manual use.

### Console and API flow

```mermaid
sequenceDiagram
  participant User as Owner browser
  participant API as OCC API and console
  participant Refresh as Credential Refresh Driver
  participant Issuer as OAuth issuer
  participant Gateway as Credential Gateway
  User->>API: Connect on the personal Agent
  API->>Refresh: startBrowserAuthorization
  Refresh-->>API: authorizationUrl, privateState
  API-->>User: Consent warning, then popup to authorizationUrl
  User->>Issuer: Approve the fixed scopes
  Issuer->>API: GET /oauth/callback with code and state
  API->>Refresh: completeBrowserAuthorization
  Refresh->>Issuer: Exchange code with PKCE verifier
  Refresh->>Gateway: Configure refresh custody and mint
  alt Exchange and mint succeed
    Refresh-->>API: ready
    API-->>User: Connected; Deploy becomes available
  else Consent denied, state invalid, or exchange refused
    Refresh-->>API: failure code
    API-->>User: Show the failure; remove the pending source
  end
```

_Proposed flow; none of these paths is implemented._

1. `POST /namespaces/:namespaceId/agents/:agentId/connections` with a connection
   template ID. OCC checks connection template `use`, confirms the caller is the
   Agent's personal grantee, registers an empty source as `registering`, and calls
   `startBrowserAuthorization`. It stores `privateState` in a Namespace Secret, as
   device login does, and returns the source ID and `authorizationUrl`.
2. The console shows which account data the tool can read, then opens the URL in a
   popup. When a browser blocks popups, it redirects the page.
3. `GET /oauth/callback` requires the session that started the connection. OCC
   finds the session by a hash of `state`, rejects reuse or an age above ten
   minutes, and calls `completeBrowserAuthorization` once. The response sets
   `Referrer-Policy: no-referrer` and redirects without the query string. OCC
   excludes the code from logs and audit.
4. On `ready`, OCC adds the source to the Agent's `credentialSources` and grants
   the Agent's service principal exact source `operate`.
5. Agent details show the connection with **Reconnect** and **Disconnect**.
   Reconnect creates a new source and replaces the binding. Disconnect removes the
   binding and requests withdrawal through the existing paths.

Audit records connection start, completion, failure, reconnect, and disconnect
with the actor, connection template ID, Agent ID, and source ID. It never records
codes, tokens, or provider account content.

## Delivery and verification

An implementation plan will order the resource and IAM, Driver contracts,
connection API and enforcement, console with Storybook coverage, and a Google Gmail
operator guide. The [companion](contracts.md#required-outcomes) lists the required
integration, real-cluster, and live-provider outcomes.

## Rationale and alternatives

- **Connection templates in Installation configuration.** Startup configuration
  describes the installation's Drivers and images. Providers change more often and
  need IAM, so they fit an API-managed resource.
- **Connection settings inside Presets.** A Preset copy is editable by the Agent
  creator, which would let a creator change scopes, endpoints, or the OAuth client.
  It would also copy client secrets into every Namespace that holds the Preset.
- **OCC exchanges the code and stores the refresh token as a Secret.** This needs no
  new Refresh Driver methods, but it puts a rotating refresh token in OCC storage
  and inherits the `issuerRotated` update hazards.
- **Installation-owned Secrets for the OAuth client secret.** This keeps the
  Refresh Driver contract smaller, but adds a Secret scope that only this feature
  would use and splits refresh material between two owners. The Refresh Driver
  already holds the per-source refresh material, so it also holds the client
  secret.
- **A Google-specific Gateway type.** Each new provider would need an OCE release.
- **Shared Agents with a warning.** Anyone with access could read the mailbox.
- **Wait for the Credential Proxy in PR #2484.** That RFC replaces the Credential
  Gateway but keeps `CredentialRefreshDriver`, so the browser methods remain valid.
  The endpoint `access` field, per-connection-template binary, and attachment
  egress would move to its proxy contract.

## References

- [Credential sources](../../../docs/reference/credential-sources.md)
- [CredentialRefreshDriver contract](../../../docs/reference/drivers/credential-refresh.md)
- [OpenShell Credential Gateway](../../../docs/reference/drivers/openshell-credential-gateway.md)
- [Console Agent creation](../../../docs/reference/console/create-and-deploy.md)
- [Per-Agent sandbox policies](../../../docs/reference/sandbox-policies.md)
- [Shared Driver contracts](../../../packages/contracts/src/index.ts)
- [Google limited-input device scopes](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
