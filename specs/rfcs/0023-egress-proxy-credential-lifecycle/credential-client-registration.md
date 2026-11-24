---
rfc: index.md
---

# Proposed amendment: Credential client registration and custody

This amendment completes the client administration contract for [OAuth client selection](oauth-client-associations.md) and [GitHub App installation Sources](github-app-template-policy.md). It requires human review before Driver or privileged UI implementation.

## Decision

An Installation administrator registers an OAuth 2.0 client or a GitHub App in the existing Console and API. The OpenClaw Control Plane (OCC) authorizes and audits registration, rotation, and deletion. The selected TokenService owns confidential client material and replaces it at the same private reference. A running API or Worker uses the current material for subsequent exchanges and mints.

Use one typed registration model, `CredentialClient = OAuth2Client | GitHubAppClient`. Keep one client catalog and administration flow. Reuse the existing `/oauth-clients` routes and URL paths. The existing OAuth operations keep their issuer, endpoints, client identity, authentication method, scope checks, and consent behavior. The GitHub App branch has a distinct purpose and supplies its GitHub App ID and signing key.

GitHub has two canonical objects. The admin-managed `GitHubAppClient` identifies the App and owns one long-lived signing key in the selected TokenService. The Namespace’s `GitHubAppInstallationCredentialSource` pins that `clientId`, a GitHub `installationId`, and a finite repository permission scope. TokenService caches one usable `{token, expiresAt, version}` for the Source. Agents bind the Source. The signing key and cached token stay private.

## Interfaces

| Surface               | Proposed change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client metadata       | Common OCC registration ID, display name, creation time, and Installation or exact Namespace scope. Tag the branches `oauth2` and `github-app`. `OAuth2Client` keeps the OAuth provider fields. `GitHubAppClient` has an immutable App ID. The public response contains no confidential material.                                                                                                                                                                                                                                            |
| Client administration | Extend the existing list, create, exact-client rotation, and delete operations. The OAuth branch accepts its existing write-only client secret when required. The GitHub App branch accepts a write-only private key on create and rotation. The Console uses separate forms in the same catalog. Ordinary OAuth consent and discovery select OAuth 2.0 clients.                                                                                                                                                                             |
| TokenService Driver   | Let selected Drivers declare supported `secretScopes`. Reuse client-secret register, update, and remove operations with a typed reference that binds the exact client, owner instance, scope, and purpose. The OAuth reference carries the approved token endpoint. The GitHub signing reference carries the expected App ID and uses the issuer's trusted GitHub origin. Keep OAuth secret resolution restricted to the OAuth reference. The selected TokenService's Git issuer reads the signing key within its private signing operation. |
| GitHub App Source     | Add an immutable reference to an eligible `GitHubAppClient` in the later typed Git Source contract. The registration identifies the App. The Source separately identifies the verified GitHub installation, finite repositories, permissions, and one current token. Keep the static and OAuth Source foundation independent.                                                                                                                                                                                                                |
| Persistence           | Store typed nonsecret metadata in the shared client catalog. Keep one private value per confidential client and one current token receipt per GitHub App Source. The App ID belongs to the client. Block client deletion while any Source references it, including a Source still retiring.                                                                                                                                                                                                                                                  |

Keep the OAuth create and rotate request bodies accepted today. GitHub App create is explicitly tagged. Rotation dispatches on the stored client kind and validates that branch’s write-only body. The admin list returns tagged entries for both kinds. Update its Console and generated clients in the same cutover. Ordinary OAuth eligibility still returns only OAuth 2.0 clients.

The GitHub App branch uses neither OAuth browser consent nor an OAuth token endpoint. Its key arrives through the administrator's write-only request after startup. The issuer uses private custody for every signing operation.

## Authorization and use

The admin operations keep exact Installation `administer`. Client-secret operations check the selected TokenService owner and its supported purpose and scope. A Driver with Installation custody can still lack GitHub signing and issuance. Refuse unsupported registrations before making them visible or eligible. For the initial GitHub App branch, propose Installation-scoped client administration. The OAuth branch retains its reviewed Installation and Namespace/Workspace placement behavior.

To enroll Git, a caller needs `credential_source:create` on the exact ready Namespace. OCC and the selected TokenService verify the exact typed client, its owner and scope, and the ready Namespace. The client must identify the App approved by the Namespace registry. The installation must match the registry. The selected repositories and permissions must fit within its Namespace ceiling. Save the exact client reference and verified scope. A Namespace selector may show only eligible nonsecret client metadata. It needs the same Source-create and registry checks. Two eligible registrations for the same verified App produce the same issuer authority within that Namespace ceiling. The Source still pins exactly one client ID. Revalidate the saved Source against the current registry before minting, renewing, or delivering the cached token.

A Source supplies one shared current token to its Provider. The Agent's Repository grants and Source-use permission still apply separately. Key rotation leaves those grants, network and injection policy, ref limits, Git discovery distinctions, and PR controls intact.

## Key validation, replacement, and retirement

Validate before storing or replacing. Reuse the existing Git signer requirements: a canonical decimal App ID, an unencrypted RSA private key of 2048–8192 bits, and an RS256 JWT sent only to the trusted GitHub HTTPS origin. Propose a bounded JWT-authenticated `GET /app` and an exact comparison of the returned App ID. This verifies the candidate key's App association without issuing an installation token. Refuse a malformed key, wrong App, or failed validation before replacing the prior key. [GitHub App identity endpoint](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app) · [GitHub JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)

Reuse the existing client-secret update, audit, and error semantics. Responses, errors, audit, and logs contain metadata, never a key, JWT, or bearer token.

On key rotation, the administrator updates only the client key. A mint that reads custody after replacement uses the new key. A mint already in progress may finish with the previous key. Sources reuse their cached tokens until ordinary renewal. For a manual or due mint, TokenService reads the client key, checks the verified Source scope, replaces only the current token receipt, and pushes through the existing Proxy operation. GitHub expires the previous token at its original deadline. Failed mint retries on the next maintenance pass. Failed push leaves the committed token for the existing authorized Agent credential retry. Deleting one Source leaves the client and other Sources available.

## Scope for review

Confirm Installation-only GitHub App registration for the first version, or define when the selected TokenService may own a Namespace-scoped App registration. The OAuth branch keeps its existing scope rules. Approval of this amendment does not grant the Worker broad Secret `update`. Scheduled short-lived token writes still require the separate approved custody boundary.

## Simplifications and delivery

Reuse client administration, private custody, and registration identity rather than creating a second Git credential catalog. Keep OAuth client-secret resolution and Git App signing purpose-specific. Review the shared client contract and API-generated artifacts first. The subsequent implementation supplies persisted metadata and reference guards, TokenService custody and validation, and Console forms. Git issuance owns the client-to-Source link and JWT/mint path. The Git changes activate with their real caller in the coordinated cutover.

## Acceptance criteria

Exercise ordinary OAuth registration, consent, and hot rotation through existing PostgreSQL and identity-provider workflows. Through real Fastify, IAM, PostgreSQL, and a signed TLS GitHub fixture, register a GitHub App client and enroll a finite Source. Reject unauthorized registration or rotation before contacting GitHub or writing custody. Reject an otherwise valid key for another App and prove the prior key still mints. Rotate to a second key for the same App and prove that the same running API and Worker use it on a subsequent manual and due mint without changing Source identity, token scope, or the current token at key-rotation time. Verify deletion conflict while a Source references the client and material-free API, Console, and audit output. Qualify live GitHub, shared OpenShell Provider update, and Agent allow/deny and peer continuity in the completed cutover.
