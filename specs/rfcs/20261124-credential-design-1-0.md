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

Use one Credential Client catalog and one Source lifecycle for OAuth and GitHub App installation tokens. The cutover keeps credential custody with the selected TokenService.

## Client registration

Installation administrators use the Console catalog and `/credential-clients`. Create and rotate requests explicitly select `oauth2` or `github-app`. OAuth client registration is independent of Connection Templates and supplies its own scope, issuer, approved endpoints, and authentication method. GitHub App clients have an immutable App ID and Installation scope. The stored Client kind remains canonical. The TokenService's client purpose type comes from the same typed Client union.

Keep [OAuth client selection and consent](0023-egress-proxy-credential-lifecycle/oauth-client-associations.md). The caller needs `credential_source:create` in the destination Namespace and explicitly selects an eligible OAuth client from that Namespace or the Installation. PostgreSQL enforces the client kind on saved references and blocks deletion while a Source or pending consent references the client. Built-in Codex OAuth Sources carry no registration reference.

## Private material and rotation

PostgreSQL stores client metadata. Administrators supply write-only material on create or rotation. The selected TokenService stores confidential OAuth client secrets and GitHub App signing keys in private custody for the exact client, owner, purpose, and scope. A public OAuth client has no secret. Client reads, errors, audit records, and logs contain metadata only.

The TokenService Driver's `clientScopes` lists supported scopes for each purpose. OAuth retains its approved token URL binding. Only OAuth client secrets support resolution for an approved token request. The GitHub App issuer uses the signing key inside TokenService. Before storing a new key or replacing an existing one, TokenService verifies that the key belongs to the registered App. Subsequent mints read the current key without an API or Worker restart.

## GitHub App Sources

A Namespace Source pins one App client and records its GitHub installation and finite repository scope. At enrollment, renewal, and delivery, the App and installation must match the current Namespace registry and the scope must fit its approved ceiling. TokenService caches one installation token, expiry, and credential version per Source. Key rotation leaves that token in service. Renewal updates only the Source token and pushes its version through Credential Proxy. The previous token expires at GitHub. Source enrollment, Agent grants, and delivery follow the [GitHub App installation Source proposal](0023-egress-proxy-credential-lifecycle/github-app-template-policy.md). The OCC API process schedules Git token maintenance in its selected TokenService and uses its existing private custody permissions. If Proxy delivery fails after renewal, TokenService retries delivery of the committed version. Worker does not need write access to the Installation-private store.

## Source lifecycle

Static Source enrollment and update take a single write-only credential string. TokenService registration uses the public Source types `static`, `oauth2-refresh-token`, and `github-app-installation`. Credential resolution returns the value and any applicable delivery version and expiry. Codex callers take account context from the Source's trusted consent metadata.

A caller with `credential_source:update` on the exact Namespace Source can request renewal with `POST /namespaces/{namespaceId}/credential-sources/{credentialSourceId}/rotate`. A ready OAuth or GitHub App installation Source renews through its selected TokenService's `forceRefresh` operation. The existing committed-update path delivers the replacement through Credential Proxy. If delivery fails after the commit, the delivery retry uses the committed version. Static credentials use the existing update operation.

## Proposed change to protected GitHub metadata

Retire the built-in protected `github-app-metadata` Source that uses a Namespace Secret as its GitHub App signing key. The selected Credential Proxy would stop offering and admitting this Source. Authenticated `GET /repos/{owner}/{repo}` through that offer would be unavailable until there is a TokenService-backed replacement.

Keep the credential-free protected repository metadata offer for qualified deployments. Ordinary repository Git uses the registered GitHub App Client, its TokenService installation Source, and each Agent's admitted Repository policy.

This retirement requires a product decision before implementation.

## Acceptance criteria

Verify existing OAuth consent and rotation. Verify that Installation administrators can register and rotate an App key, that a wrong-App key is refused, and that the next mint uses the replacement without changing the cached token at rotation time. Verify that reads and audit omit key material and that a referenced client cannot be deleted. Verify both manual renewal types, exact Source authorization, and scheduled Git renewal. Retry delivery after a committed update without minting a second time. Verify static enrollment and replacement through the supported callers.
