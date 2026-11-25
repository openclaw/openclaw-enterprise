---
rfc: index.md
---

# Client registration and custody

This page preserves the client registration and custody proposal from [#7223](https://github.com/openclaw/openclaw-enterprise/pull/7223), submitted on 2026-11-24.

Add GitHub App clients to the existing client catalog and define how TokenService stores private client material. This proposal covers client registration and custody.

## Client registration

Installation administrators use the existing Console catalog and `/oauth-clients` operations. The catalog returns `oauth2` and `github-app` variants. GitHub App create sets `kind: "github-app"`. Rotation uses the stored client kind. The untagged OAuth create request supplies its own scope, issuer, approved endpoints, and authentication method independently of Connection Templates. GitHub App clients have an immutable App ID and Installation scope.

Keep [OAuth client selection and consent](oauth-client-associations.md). The caller needs `credential_source:create` in the destination Namespace and explicitly selects an eligible OAuth client from that Namespace or the Installation. PostgreSQL enforces the client kind on saved references and blocks deletion while a Source or pending consent references the client. Built-in Codex OAuth Sources carry no registration reference.

## Private material and rotation

PostgreSQL stores client metadata. Administrators supply write-only material on create or rotation. The selected TokenService stores confidential OAuth client secrets and GitHub App signing keys in private custody for the exact client, owner, purpose, and scope. A public OAuth client has no secret. Client reads, errors, audit records, and logs contain metadata only.

The TokenService Driver's `clientScopes` lists supported scopes for each purpose. OAuth retains its approved token URL binding. The GitHub App issuer uses the key only to sign. Before storing a new key or replacing an existing one, TokenService verifies that the key belongs to the registered App. Subsequent mints read the current key without an API or Worker restart.

## GitHub App Sources

A Namespace Source pins one App client and records its GitHub installation and finite repository scope. At enrollment, renewal, and delivery, the App and installation must match the current Namespace registry and the scope must fit its approved ceiling. TokenService caches one installation token, expiry, and credential version per Source. Key rotation leaves that token in service. Renewal updates only the Source token and pushes its version through Credential Proxy. The previous token expires at GitHub. Source enrollment, Agent grants, and delivery follow the [GitHub App installation Source proposal](github-app-template-policy.md). Scheduled renewal still requires approval for the Worker's receipt-write permission.

## Acceptance criteria

Verify existing OAuth consent and rotation. Verify that Installation administrators can register and rotate an App key, that a wrong-App key is refused, and that the next mint uses the replacement without changing the cached token at rotation time. Verify that reads and audit omit key material and that a referenced client cannot be deleted.
