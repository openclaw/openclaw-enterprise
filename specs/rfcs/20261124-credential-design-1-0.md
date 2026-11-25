---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Credential Design 1.0

- **ID:** RFC-20261124-credential-design-1-0
- **Created:** 2026-11-24
- **Last updated:** 2026-11-25
- **RFC PR:** [#7223](https://github.com/openclaw/openclaw-enterprise/pull/7223)

Use one Credential Client catalog and one Source lifecycle for OAuth and GitHub App installation tokens. The cutover keeps credential custody with the selected TokenService.

## Client registration

Installation administrators use the Console catalog and `/credential-clients`. Create and rotate requests explicitly select `oauth2` or `github-app`. OAuth client registration is independent of Connection Templates and supplies its own scope, issuer, approved endpoints, and authentication method. GitHub App Clients have an immutable App ID. An administrator can register either Client kind for the Installation or for one Namespace. The stored Client kind remains canonical. The TokenService's client purpose type comes from the same typed Client union.

Keep [OAuth client selection and consent](0023-egress-proxy-credential-lifecycle/oauth-client-associations.md). The caller needs `credential_source:create` in the destination Namespace and explicitly selects an eligible OAuth client from that Namespace or the Installation. PostgreSQL enforces the client kind on saved references and blocks deletion while a Source or pending consent references the client. Built-in Codex OAuth Sources carry no registration reference.

## Private material and rotation

PostgreSQL stores client metadata. Administrators supply write-only material on create or rotation. The selected TokenService stores confidential OAuth client secrets and GitHub App signing keys in private custody for the exact client, owner, purpose, and scope. A public OAuth client has no secret. Client reads, errors, audit records, and logs contain metadata only.

The TokenService Driver's `clientScopes` lists supported scopes for each purpose. OAuth retains its approved token URL binding. Only OAuth client secrets support resolution for an approved token request. The GitHub App issuer uses the signing key inside TokenService. Before storing a new key or replacing an existing one, TokenService verifies that the key belongs to the registered App. Subsequent mints read the current key without an API or Worker restart.

## Proposed Client custody receipt amendment

A TokenService that creates private material in an external store must be able to retain the immutable identity returned by that store. A Client currently records its selected TokenService instance but no private store reference, while `registerClientSecret` returns no result. Looking up the same name again cannot establish that the stored object is the one originally registered.

Change `registerClientSecret` to return an optional private, nonsecret backend reference. The Client registration transaction saves that reference with the reserved Client and clears its cleanup reservation in the same transaction. Later secret resolution, rotation and deletion pass the saved reference to the selected TokenService. Rotation updates the registered object in place; an unexpected replacement fails explicitly. The public Client representation, audit and logs do not contain the reference or usable material. A Driver whose private address is already derived from Client identity returns no reference rather than storing redundant state.

If the external write succeeds but the receipt cannot be saved, the cleanup reservation does not identify the created object. Cleanup must refuse name-only deletion and expose the unconfirmed custody for recovery. Before enabling registration, review whether the store can recover the immutable identity from a preassigned identifier or an idempotent operation record, or whether a documented orphan/manual-recovery limit is acceptable. A request ID that requires replaying the original secret-bearing request does not by itself establish recoverability.

For OpenShell, the reference identifies the immutable Namespace Workspace and Secret. A shared Client Secret is non-injectable and is distinct from a Source's account Provider and its access credential. Enable Namespace Client scopes only when the selected runtime can enforce the exact registered identities. Installation-wide Clients, including public OAuth Clients, remain unsupported by native custody without Installation-wide secret support. The existing purpose-and-scope capability applies to public and confidential OAuth Clients alike; no public-only exception is proposed.

### Interface changes

- API and IAM: no public operation or permission changes.
- Database: add one private, nonsecret backend reference to the stored Client record; public OAuth Clients have none.
- Driver: return the reference from `registerClientSecret` and carry it with subsequent Client secret operations. Keep Source and Client custody references separate.

### Simplifications and qualification

Do not add a second Client table or a parallel Client administration flow. Reuse the existing reservation, registration, rotation and cleanup lifecycle. Qualify through the real Client API and PostgreSQL with the selected TokenService: register, resolve only for the approved OAuth endpoint, rotate, delete, refuse a same-name replacement before reading or changing its material, and exercise a remote-write success followed by a lost receipt without deleting any replacement by name. OpenShell qualification depends on [exact Workspace Secret identity](https://github.com/ai-openshell/openshell/issues/5961); use of Gateway-managed refresh also depends on [exact refresh and material references](https://github.com/ai-openshell/openshell/issues/5966). This amendment is proposed for review and does not approve a custody exception.

## Secret Driver placement

The OCC TokenService uses one private store from the selected Secret Driver. Each static, PAT, OAuth or Git Source address identifies its Namespace owner and Source. A Client secret follows the registered Client's owner. The Driver contract gives both Client kinds one scoped identity: the owning Installation or Namespace, the Client ID, and its selected TokenService instance. OAuth2 token endpoints and GitHub App IDs still bind the secret to its issuer-side use. The selected TokenService's `clientScopes` capability controls which registration scopes it supports. The OCC TokenService supports Installation and Namespace registration for both OAuth2 and GitHub App Clients. OCC enforces IAM and TokenService checks the exact owner, resource and purpose independently of storage placement. The Kubernetes Secret Driver uses the existing private backing namespace, outside tenant workload namespaces. The private store is separate from Namespace Secret inventory and delivery, which Channels continue to use.

The API creates and replaces private custody. The Worker retains its existing private-store read access and deletion authority for retired Sources and Clients. The private store supports atomic compare-and-swap for OAuth grants. The API runs the OAuth and Git renewal scans at five-second intervals and sends committed versions to Credential Proxy. The Worker uses an eligible committed credential for deployment and waits for API renewal if none is available. A failed delivery retries the committed version.

Private custody references can change. Verify that tenant-namespace administrators and workload identities cannot read backing Secrets. Exercise Source and Client lifecycles, OAuth refresh, and same-Agent Codex and Git delivery. Existing credentials need a separately approved preservation or re-enrollment plan before moving live custody.

## GitHub App Sources

A Namespace Source pins one App Client and records its GitHub installation and finite repository scope. The Source can use an Installation Client or a Client registered in that same Namespace. OCC checks this when saving Agent repository access and admitting Sources. PostgreSQL enforces it when creating a Source. TokenService checks the stored Client's scope before opening its signing key during enrollment or renewal. Client administration continues to require Installation administer access. At enrollment, renewal, and delivery, the App and installation must match the current Namespace registry and the scope must fit its approved ceiling. TokenService caches one installation token, expiry, and credential version per Source. Key rotation leaves that token in service. Renewal updates only the Source token and pushes its version through Credential Proxy. The previous token expires at GitHub. Source enrollment, Agent grants, and delivery follow the [GitHub App installation Source proposal](0023-egress-proxy-credential-lifecycle/github-app-template-policy.md). The OCC API process schedules Git token maintenance in its selected TokenService and uses its existing private custody permissions. If Proxy delivery fails after renewal, TokenService retries delivery of the committed version.

## Source lifecycle

Static Source enrollment and update take a single write-only credential string. TokenService registration uses the public Source types `static`, `oauth2-refresh-token`, and `github-app-installation`. Credential resolution returns the value and any applicable delivery version and expiry. Codex callers take account context from the Source's trusted consent metadata.

A caller with `credential_source:update` on the exact Namespace Source can request renewal with `POST /namespaces/{namespaceId}/credential-sources/{credentialSourceId}/rotate`. A ready OAuth or GitHub App installation Source renews through its selected TokenService's `forceRefresh` operation. The existing committed-update path delivers the replacement through Credential Proxy. If delivery fails after the commit, the delivery retry uses the committed version. Static credentials use the existing update operation.

The temporary native PAT transport exception covers manually enrolled and ServiceAccount-issued Codex PATs on the selected executable, two approved hosts and [seven fixed requests](../../docs/reference/credential-sources/managed-static.md#codex-pat). A matching plaintext request on port 443 can receive the PAT. Retire the exception when native substitution enforces HTTPS and rejects the matching plaintext request.

## Proposed change to protected GitHub metadata

Retire the built-in protected `github-app-metadata` Source that uses a Namespace Secret as its GitHub App signing key. The selected Credential Proxy stops offering and admitting this Source. Authenticated `GET /repos/{owner}/{repo}` through that offer requires a future TokenService-backed replacement.

Keep the credential-free protected repository metadata offer for qualified deployments. Ordinary repository Git uses the registered GitHub App Client, its TokenService installation Source, and each Agent's admitted Repository policy.

The product decision approves this retirement.

## Acceptance criteria

Verify existing OAuth consent and rotation. Verify that Installation administrators can register and rotate an App key, that a wrong-App key is refused, and that the next mint uses the replacement without changing the cached token at rotation time. Verify that reads and audit omit key material and that a referenced client cannot be deleted. Verify both manual renewal types, exact Source authorization, and scheduled Git renewal. Retry delivery after a committed update without minting a second time. Verify static enrollment and replacement through the supported callers.
