---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Credential Design 1.0

- **ID:** RFC-20261124-credential-design-1-0
- **Created:** 2026-11-24
- **Last updated:** 2026-11-24
- **RFC PR:** [#7223](https://github.com/openclaw/openclaw-enterprise/pull/7223)

This proposal covers client registration and custody for Credential Design 1.0. It builds on [OAuth client selection](0023-egress-proxy-credential-lifecycle/oauth-client-associations.md) and [GitHub App installation Sources](0023-egress-proxy-credential-lifecycle/github-app-template-policy.md).

## Decision

An Installation administrator registers an OAuth 2.0 client or a GitHub App in the existing Console and API. The OpenClaw Control Plane (OCC) authorizes and audits registration, rotation, and deletion. The selected TokenService owns confidential client material and replaces it at the same private reference. A running API or Worker uses the current material for subsequent exchanges and mints.

Use one typed registration model, `CredentialClient = OAuth2Client | GitHubAppClient`. Keep one client catalog and administration flow. Reuse the existing `/oauth-clients` routes and URL paths. The existing OAuth operations keep their issuer, endpoints, client identity, authentication method, scope checks, and consent behavior. The GitHub App branch has a distinct purpose and supplies its GitHub App ID and signing key.

The Installation-scoped `GitHubAppClient` identifies the App and owns one long-lived signing key in the selected TokenService. A `GitHubAppInstallationCredentialSource` in a Namespace pins the OCC client registration ID, a GitHub installation ID, and a finite repository permission scope. One client can back multiple eligible Sources. TokenService caches one usable `{token, expiresAt, version}` per Source. Agents bind the Source. The signing key and cached token stay private.

## Interfaces

| Surface               | Proposed change                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client metadata       | Tag the branches `oauth2` and `github-app`. Both have an OCC registration ID, display name, and creation time. OAuth clients keep their provider fields and scope. `GitHubAppClient` has an immutable App ID and Installation scope, with no `namespaceId` input or stored value. Return nonsecret metadata only.                                                                          |
| Client administration | Extend the existing list, create, exact-client rotation, and delete operations. The OAuth branch accepts its existing write-only client secret when required. The GitHub App branch accepts a write-only private key on create and rotation. The Console uses separate forms in the same catalog. Ordinary OAuth consent and discovery select OAuth 2.0 clients.                           |
| TokenService Driver   | Advertise supported scope per client purpose. Client-secret create, update, and remove use a typed reference for the exact client, owner, scope, and purpose. OAuth secret resolution accepts only the OAuth reference.                                                                                                                                                                    |
| GitHub App Source     | Add an immutable reference to an eligible `GitHubAppClient` in the later typed Git Source contract. The registration identifies the App. The Source separately identifies the verified GitHub installation, finite repositories, permissions, and one current token. Keep the static and OAuth Source foundation independent.                                                              |
| Persistence           | PostgreSQL enforces each kind’s row shape and the client kind of each reference. Template-backed OAuth consent and Sources reference OAuth 2.0 clients. Built-in Codex OAuth Sources carry no registration reference. Git Sources reference GitHub App clients. Preserve scope and owner checks and block removal while a dependent Source or pending consent still references the client. |

An administrator registers an OAuth client with its own scope, issuer, approved endpoints, and authentication method, independently of Connection Templates. GitHub App create is explicitly tagged. Rotation dispatches on the stored client kind and validates that branch’s write-only body. The admin list returns tagged entries for both kinds. Update its Console and generated clients in the same cutover.

OAuth discovery and consent keep `credential_source:create` on the exact destination Namespace. An OAuth 2.0 client registered for that Namespace or the Installation is eligible if it matches the template’s issuer, approved token endpoint, applicable revocation endpoint, and authentication method. The Console defaults its dropdown to the first eligible client and submits the selected client ID and template ID. The API requires that explicit selection.

The GitHub App branch uses neither OAuth browser consent nor an OAuth token endpoint. Its key arrives through the administrator's write-only request after startup. The issuer uses private custody for every signing operation.

## Authorization and use

Client administration requires Installation `administer`. For 1.0, GitHub App clients use Installation-private custody. Namespace-scoped GitHub App registration is deferred. OAuth clients retain the existing Installation and exact Namespace scope rules, including their Workspace mapping.

Use a single Driver `clientScopes` map from purpose to supported scopes. For example, `oauth2` may support Installation or Namespace. A Driver that supports GitHub App clients advertises `"github-app": ["installation"]`. An absent entry means the Driver does not support that purpose. Check the exact purpose and scope at registration and discovery, including public OAuth clients. Reject unsupported registration before contacting the provider or writing custody. Exclude unsupported clients from eligibility.

The OAuth private reference retains the approved token URL binding. The GitHub reference binds the verified App ID and uses the issuer's trusted GitHub origin. TokenService uses the key only within its signing operation and returns no key to OCC.

To enroll Git, a caller needs `credential_source:create` on the exact ready Namespace. OCC and the selected TokenService verify the exact typed client, its owner and scope, and the ready Namespace. The client must identify the App approved by the Namespace registry. The installation must match the registry. The selected repositories and permissions must fit within its Namespace ceiling. Save the exact client reference and verified scope. A Namespace selector may show only eligible nonsecret client metadata. It needs the same Source-create and registry checks. Two eligible registrations for the same verified App produce the same issuer authority within that Namespace ceiling. The Source still pins exactly one client ID. Revalidate the saved Source against the current registry before minting, renewing, or delivering the cached token.

A Source supplies one shared current token to its Provider. The Agent's Repository grants and Source-use permission still apply separately. Key rotation leaves those grants, network and injection policy, ref limits, Git discovery distinctions, and PR controls intact.

## Key validation, replacement, and retirement

Validate before storing or replacing. Reuse the existing Git signer requirements: a canonical decimal App ID, an unencrypted RSA private key of 2048–8192 bits, and an RS256 JWT sent only to the trusted GitHub HTTPS origin. Propose a bounded JWT-authenticated `GET /app` and an exact comparison of the returned App ID. This verifies the candidate key's App association without issuing an installation token. Refuse a malformed key, wrong App, or failed validation before replacing the prior key. [GitHub App identity endpoint](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app) · [GitHub JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)

Reuse the existing client-secret update, audit, and error semantics. Responses, errors, audit, and logs contain metadata, never a key, JWT, or bearer token.

On key rotation, the administrator updates only the client key. A mint that reads custody after replacement uses the new key. A mint already in progress may finish with the previous key. Sources reuse their cached tokens until ordinary renewal. For a manual or due mint, TokenService reads the client key, checks the verified Source scope, and updates only the Source’s token, expiry, and credential version. Its existing update notification asks Credential Proxy to push the new version to the shared Provider. GitHub expires the previous token at its original deadline. Failed mint retries on the next maintenance pass. Failed push leaves the committed token for the existing authorized Agent credential retry. Deleting one Source leaves the client and other Sources available.

## Delivery dependency

Scheduled installation-token renewal requires a separately approved Worker receipt-write boundary. Client registration and rotation use the existing Installation admin boundary.

## Simplifications and delivery

Reuse client administration, private custody, and registration identity rather than creating a second Git credential catalog. Keep OAuth client-secret resolution and Git App signing purpose-specific. Review the shared client contract and API-generated artifacts first. The subsequent implementation supplies persisted metadata and reference guards, TokenService custody and validation, and Console forms. Git issuance owns the client-to-Source link and JWT/mint path. The Git changes activate with their real caller in the coordinated cutover.

## Acceptance criteria

Exercise ordinary OAuth registration, consent, and hot rotation through existing PostgreSQL and identity-provider workflows. Through real Fastify, IAM, PostgreSQL, and a signed TLS GitHub fixture, register a GitHub App client and enroll a finite Source. Reject unauthorized registration or rotation, unsupported Driver purpose or scope, and a Namespace-scoped GitHub App request before contacting GitHub or writing custody. Reject an otherwise valid key for another App and prove the prior key still mints. Rotate to a second key for the same App and prove that the same running API and Worker use it on a subsequent manual and due mint without changing Source identity, token scope, or the current token at key-rotation time. Verify deletion conflict while a Source references the client and material-free API, Console, and audit output. Qualify live GitHub, shared OpenShell Provider update, and Agent allow/deny and peer continuity in the completed cutover.
