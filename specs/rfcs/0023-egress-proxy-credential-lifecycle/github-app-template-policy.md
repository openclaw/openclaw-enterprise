---
rfc: index.md
---

# GitHub App credentials with Connection Template policy

This amendment proposes a GitHub App credential source whose issued token retains the App installation's GitHub permissions. The Connection Template defines where an Agent may use that credential. The selected TokenService owns the App private key, JWT, installation-token issuance, renewal, and retirement. Sandbox and Credential Proxy enforce the admitted network and injection policy.

## Source and issuer

Register the GitHub App ID, installation ID, and write-only private key through the selected TokenService's existing [source lifecycle](token-service-instance-and-updates.md). Bind the source by its Namespace and source ID. OCC must authorize both the deploying principal and the Agent to operate that exact source. The source and its private registration belong to one TokenService instance. Public metadata and update notifications carry no private key, JWT, or installation token.

Reuse the existing issuer's inherited installation-token issuance and response validation. It submits `{}` to `POST /app/installations/{installation_id}/access_tokens`, without `repository_ids` or permission overrides. Register the App and installation as issuer authority owned by the source. Do not reuse the Agent's `github-installation` repository grant for this purpose: that grant authorizes installation-wide use and omits OCE ref restrictions. GitHub's App installation controls the issued token's actual authority. The issuer retains cleanup responsibility for a rejected or uncertain issuance. The worker renews the token before expiry. After committing a new usable version, TokenService sends Credential Proxy a material-free source update through the existing notification contract. Resolution is source-bound. No request-time token pull is introduced.

The existing `github-app-metadata` source has a different, narrow grant and cannot be widened or reused as this source. Existing repository grants, ref checks, and credential retirement continue to apply to their current consumers.

## Template and delivery

The Connection Template records the approved repository and URL restrictions. Deployment derives generic Sandbox network policy and Credential Proxy injection policy from that template and the Agent's approved use. The policy does not change the GitHub token. Deny credential injection unless the actual request matches the approved HTTPS origin, port, method, and canonical repository path. A redirect is a new request that needs its own policy check. Reject ambiguous path encodings and alternate origins. Keep GitHub GraphQL unavailable unless a separately reviewed policy can enforce the approved repository and operation inside its request body.

Git smart HTTP reads use upload-pack, and writes use receive-pack. Their advertisements use the same `GET /OWNER/REPO.git/info/refs` path and differ in the `service` query parameter. Generic method/path policy cannot distinguish them. Git also needs the existing reviewed repository credential presentation for Basic authentication. Qualify query matching and Git presentation before enabling Git through generic delivery. A URL restriction alone cannot restrict the refs inside a receive-pack request. Preserve the Repo owner's existing authorization of repository, operation, and writable ref before allowing a Git write. Do not advertise REST, GraphQL, push, or branch restrictions that the selected sender cannot enforce. A credential may have broader GitHub permissions than the Agent's admitted policy, so Sandbox must prevent a direct route around Credential Proxy.

## Interface and proof

**API:** Propose a `github-app-installation` source type with rotation `refresh`. Register it through `POST /namespaces/{namespaceId}/credential-sources` using a `name`, `config.app_id`, `config.installation_id`, a required `connectionTemplateId`, and write-only `secret.private_key`. The template holds the approved repositories and URLs; the source does not copy those restrictions. Agent binding continues to identify the source by ID. The source type, required template association, and template's GitHub configuration and public schema require review before implementation.

**IAM:** Require `credential_source:create` on the Namespace collection at registration. Keep the existing exact-source operate checks for the deploying principal and Agent. Issuer authority does not grant installation-wide Agent use.

**Database:** Keep the source's private TokenService instance association and issuer registration. Reuse existing durable token custody, attempts, and retirement. Do not persist a second repository policy or expose private registration details in source metadata.

**Driver contracts:** Keep `registerSource`, `updateSource`, `resolveCredential`, `forceRefresh`, `getRefreshStatus`, and `removeSource` unchanged. For this refreshing source, `resolveCredential` must return the current credential, version, and expiry to an authorized consumer. `notifyCredentialUpdated` receives only the source reference and optional version, with a resolver restricted to that source. The query and Git credential-presentation requirements must be submitted for review before changing required Sandbox or Credential Proxy behavior. This amendment does not select new Agent operations.

First integrate and verify the source and issuer lifecycle: registration, exact IAM, worker issuance and renewal, material-free notification, withdrawal, and rejection of a mismatched source instance. Verify `{}` at the issuer. Calling the GitHub installation-token endpoint is issuer activity, not Agent access to the GitHub REST API.

The primary end-to-end proof is a protected `git fetch` from an already authorized Agent against an approved private repository. Verify transfer of an object that was absent locally, and independently observe that the template limits actual credential use. `git ls-remote` proves only ref discovery. Agent use of GitHub REST or GraphQL is separate scope and is not required for Git. Test a disallowed repository, redirect, alternate origin, ambiguous encoding, GraphQL request, and unauthorized ref as applicable to the approved operation.
