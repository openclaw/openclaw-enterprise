---
created: "2026-11-04"
updated: "2026-11-06"
last_updated_session: "authoring-run/12b5a135-b3b1-4d2e-bd32-259e373e9abe"
---

# How OCC saves an OAuth connection template

## Overview

An Installation administrator defines where an account can connect and which OAuth client represents the Installation. A person then selects that template to connect an account in a Namespace. OCC runs the browser authorization flow. The Token Service stores and renews the grant. The person can finish connecting before choosing an Agent.

## Entry Points

- An Installation administrator opens **Credentials → Connection templates** to edit a template, or **OAuth clients** to register a client against a template version. `apps/controller/src/http/connection-templates.ts:connectionTemplateHandlers`
- A signed-in person with permission to create a credential in the destination Namespace starts consent with a template available there. The OAuth provider returns the browser to OCC's shared callback. `packages/occ/src/index.ts:startNamespaceConnection` and `packages/occ/src/index.ts:completeNamespaceConnection`

## Flow

### Template and client setup

```mermaid
graph TD
  Admin["Administrator"] -->|Manual settings| Version["OCC saves the template version"]
  Admin -->|MCP server URL| Discovery["OCC reads provider metadata"]
  Discovery --> Version
  Version -->|Register a confidential client| Secret["Secret Driver stores its secret"]
  Version -->|Register a public client| Publish["OCC publishes the registration"]
  Secret --> Publish
```

### Consent and token custody

```mermaid
graph TD
  Start["Person selects a template"] --> Attempt["OCC records the browser attempt"]
  Attempt --> Provider["Provider asks for consent"]
  Provider -->|Authorization code| Callback["OCC consumes the attempt and exchanges the code"]
  Callback --> Custody["Token Service stores the grant"]
  Custody --> Account["OCC records the owner's saved account"]
  Account -->|Renewal due| Renew["Token Service refreshes at the pinned endpoint"]
```

## Execution Trace

### 1. Save the template version

`packages/occ/src/index.ts:createConnectionTemplate` and `apps/controller/src/connections/mcp-discovery.ts:discoverMcpAuthorization`

OCC checks Installation administration before it accepts manual settings or starts MCP discovery. For MCP, it reads the protected resource metadata over HTTPS, pins each request to public addresses and contacts the selected advertised authorization server. The version records what OCC discovered, the OAuth resource and the MCP transport destination. An administrator can also edit the installed Google OAuth template and its prefilled Google Workspace destinations. OCC keeps the template ID and commits each new version with its audit record.

### 2. Register and maintain the OAuth client

`packages/occ/src/index.ts:createOAuthClient` and `packages/occ/src/index.ts:cleanupOAuthClients`

`createOAuthClient` and `rotateOAuthClientSecret` reject calls inside `OpenClawController.transact`, including an inherited transaction context, before private operations. Their independent commits preserve the cleanup reservation or, when the caller supplies an audit event, the requested-rotation audit if a later operation fails. The HTTP handlers call these methods directly and supply audit events. `deleteOAuthClient` only stages database work for worker cleanup and remains composable.

A template can exist before its OAuth client. OCC takes the registration's availability and endpoints from the selected version. For a confidential client, it reserves a hidden row and asks the Installation's Secret Driver to store the secret under the registration ID. A public registration supplies a client ID and skips this private write. OCC rechecks the version, publishes the registration and records the audit. If the template lacked a client, that transaction also selects the new one.

Rotation replaces the confidential client's secret at the same private reference. Code exchange and renewal read its current value. A template version that still references the client prevents deletion. On deletion or interrupted creation, the worker uses the hidden registration to retry private cleanup.

### 3. Authorize the account in the browser

`packages/occ/src/index.ts:startNamespaceConnection` and `packages/occ/src/browser-authorization.ts:startBrowserAuthorization`

OCC verifies the person's Namespace permission and pins the selected template version. It reserves a pending credential source and records the state hash, browser session, principal, requested scopes and Proof Key for Code Exchange (PKCE) verifier in a private, expiring attempt. The provider receives the state and the challenge derived from that verifier. OCC includes the OAuth resource for MCP consent and omits the scope parameter when the person requests provider defaults.

### 4. Exchange the code and save the account

`packages/occ/src/index.ts:completeNamespaceConnection` and `apps/controller/src/backends/token-service/oauth-connection.ts:register`

On callback, OCC consumes the matching attempt once and rechecks the person's session and authority. It checks a returned issuer against the pinned issuer. If another issuer has a registered client at consent start or callback, OCC requires the issuer in the response. OCC sends the code and verifier to the pinned token endpoint, includes the MCP resource when applicable, and reads the current client secret if the registration requires one. If the exchange times out, the person starts a new attempt.

At startup, the API and worker each install an `oauth_refresh_token` issuer in their Token Service. After exchange, OCC registers the grant with that kind, naming the pending source, approved template version and selected OAuth client. The service checks that approval against the source and reads the issuer, token endpoint, authentication method and MCP resource from the stored configuration. It stores the access token and refresh grant in a private Secret. OCC records the approved recipient, reported scopes and template version, marks the account ready and grants its owner access. When the provider omits scopes after a provider-default request, the receipt records an empty list.

### 5. Resolve current destinations and renew the grant

`packages/occ/src/index.ts:effectiveConnectionDestinations` and `apps/controller/src/backends/token-service/oauth-connection.ts:renew`

When listing a manual account, OCC returns the current destinations from the same template if its issuer and mode still match. For MCP it returns the original destinations only while the issuer, mode, server URL and protected resource match. A missing or incompatible template yields an empty list. The original consent receipt identifies the registration and token endpoint for renewal.

OCC registers the returned grant under the Namespace and credential source ID. The worker renews due accounts. A trusted consumer resolves the same reference with a deadline and required remaining lifetime. If it needs a fresher token, the Token Service starts or joins renewal for that account. It rechecks that the account is active before releasing the committed token. On renewal, the Token Service checks the saved grant against its registration and reads the current client secret through OCC when required. A conditional write protects against concurrent renewal or disconnect. OCC records the next renewal and any narrower grant.

## Debugging and Verification

- If registration or rotation raises `ResourceConflictError` with `cannot run in a controller transaction`, call the lifecycle method outside that transaction. Preserve the independent reservation commit and any caller-supplied audit commit.

- If the callback redirects with `unknown_session`, start consent again in the signed-in browser that opened it. An expired or consumed attempt cannot complete.
- If it redirects with `issuer_required`, check whether another configured issuer has a registered client. Inspect the provider's callback configuration for issuer reporting.
- If refresh reports `client_refused`, check the current OAuth client registration and its secret. If the provider refused the user's refresh grant, reconnect the account. The [connection template reference](../reference/connection-templates.md) describes the recovery actions.

## Related docs

- [Manage credentials in the Console](../guides/console/secrets.md)
- [OAuth connection templates and clients](../reference/connection-templates.md)
- [Secret storage and delivery](secret-storage-and-delivery.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-05 23:59: Document independent client mutations and structure the existing flow. (authoring-run/12b5a135-b3b1-4d2e-bd32-259e373e9abe - e9cce241a2776521b745c22cd336cdb112444afb)

- 2026-11-05 21:47: Traced administrator setup, OCC browser consent and Token Service custody with the accompanying ownership change. (codex/01a1aad6-adec-7fa0-802a-50b5e0486319 - d32f76579)
