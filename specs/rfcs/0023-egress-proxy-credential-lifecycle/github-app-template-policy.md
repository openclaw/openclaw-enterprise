---
rfc: index.md
---

# Shared GitHub App token and Agent repository access

Credential Design 1.0 uses one shared GitHub App installation token per CredentialSource and installation scope. TokenService stores the GitHub App's private signing key as issuer material. The key is distinct from a CredentialSource: a Source identifies the installation and token scope, and TokenService uses the key to mint and maintain that Source's token. Agents can share the token without receiving either the token or the key.

The OpenClaw Control Plane (OCC) admits each Agent's repository controls against the applicable repository ceilings and bindings, then saves the effective grants in its revision. These controls belong to the Agent and remain independent of its CredentialSource. OCC uses the admitted grants to check issuer scope and derive a distinct network policy and credential-injection policy for each Agent. CredentialProxyDriver configures the credential-specific rules and injection; SandboxDriver retains generic containment and networking. OpenShell blocks requests outside the Agent's grants and injects the shared token only on permitted requests. Overlapping rules must not bypass those grants, and loaded policy must be verified before delivery is ready.

TokenService renews the token independently of deployed Sandboxes and pushes updates through the [credential delivery contract](installation-credential-ownership.md#configure-delivery). Withdrawal removes the Agent's authority without revoking the shared token or disrupting peers. An expired grant stops authorizing requests autonomously at its deadline, independently of token renewal. Stop removes that Agent's deployment. Rotating or revoking the shared token affects all consumers; OCC refuses Source deletion while blocking references remain.

Git Read and Write must preserve the discovery `service` query distinction and upload/receive-pack rules. Network rules cannot restrict Git refs or fully authorize PR creation fields supplied in the body or query. A shared token covering A and B could let an Agent granted only B create a pull request into B using an ungranted fork head from A. Do not enable PR creation on the shared-token path until this security decision is resolved. Keep existing PR-capable and stronger prepared-ref modes serving until equivalent repository, ref and head/base guarantees are proved. First qualify finite repository scope using two Agents with different allow/deny grants and verify withdrawal, expiry and peer continuity; unrestricted installation scope remains unqualified.

Future pull-based delivery may mint downscoped installation tokens for individual Agents from their admitted grants. That requires a separate issuance and delivery design; it is not part of the 1.0 push/shared-token model. Connection Template repository-policy integration is also deferred.
