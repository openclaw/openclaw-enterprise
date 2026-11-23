---
rfc: index.md
---

# GitHub App credentials through the Credential Proxy

This amendment proposes the GitHub integration for Credential Design 1.0. The OpenClaw Control Plane (OCC) admits the repository grants saved for an Agent. Its selected TokenService issues a usable GitHub App credential, and the selected CredentialProxyDriver configures delivery and the Git-specific network rules. OpenShell enforces the resulting Sandbox policy without exposing the real credential to the Agent. The integration reuses the existing repository editor, admission, grants, compiler, and tests.

## Ownership and execution

OCC admits the Agent's saved `repositoryNetworkPolicy` against the existing Installation ceiling, Namespace repository registrations, and selected repository bindings. It freezes the effective grants in the Agent revision and derives separate `NetworkAccessPolicy` and `CredentialInjectionPolicy` values. Network permission does not by itself authorize credential injection, and an available credential does not grant network access. Do not add another repository allowlist or policy resource.

The selected TokenService owns the GitHub App CredentialSource, App and installation identity, private key custody, issuance, expiry, renewal, and retirement. OCC authorizes Source creation and exact Source use. Source metadata and notifications contain no private key, App JWT, or installation token. Reuse the existing GitHub issuer and response validation for the finite `github-repository` selection in the first integration. How the admitted finite selection reaches that issuer must be settled in the Driver contract; this amendment does not require a contextual resolver or a new Source configuration format.

The canonical OpenShellCredentialProxyDriver owns credential-specific Git network rule generation, Provider association, injection configuration, delivery lifecycle, and readiness. Move or adapt Free Wortley's existing compiler and matcher to that canonical Driver during migration. The Proxy can configure an endpointless Provider and apply credential-related rules with `credential_binding.provider` to the target Sandbox through the OpenShell Gateway. It must preserve the Sandbox's baseline and generic rules when composing the one effective policy, and confirm the loaded policy, Provider association, recipient, and usable credential before reporting readiness. Coordinate existing policy version and update checks so concurrent changes cannot overwrite or widen the effective policy. The precise Driver handoff requires contract review; no new interface is assumed here.

SandboxDriver owns Sandbox provisioning, containment, and generic network and routing configuration. It does not interpret GitHub issuer identity, CredentialSources, credentials, or credential-specific Git rules. OpenShell physically enforces the complete combined policy. This changes the current [worker credential configuration draft](worker-credential-configuration.md), which assigns complete network-policy application to Sandbox, and the landed Git-aware Sandbox contract. Review and update those contracts before moving implementation.

For push delivery, TokenService notifies the Proxy after committing new material. The Proxy updates the existing delivery resource and acknowledges only when all serving copies can use the resolved version. With no resource, notification succeeds without creating one. An observed delivery failure does not roll back issuance; report a sanitized failure and permit authorized redelivery. Recovery from a notification lost before reaching the Proxy remains separate work under the [delivery contract](installation-credential-ownership.md#configure-delivery).

## Implemented support and remaining work

Free's merged work already provides the [per-Agent editor](https://github.com/openclaw/openclaw-enterprise/pull/6542), [deployment admission and revision snapshot](https://github.com/openclaw/openclaw-enterprise/pull/6543), and [native OpenShell Git rules and Provider binding](https://github.com/openclaw/openclaw-enterprise/pull/6533). A read grant permits Git discovery and upload-pack; write also permits receive-pack. The existing compiler matches the Git service query and HTTP method. It cannot enforce a branch or ref restriction. Credential association is at the endpoint; do not assume the HTTP method selects a different Provider.

Native delivery currently requires finite `github-repository` bindings with a common GitHub token permission map. Saved network grants can still permit read on repository A and write on B. [Scoped issue reads](https://github.com/openclaw/openclaw-enterprise/pull/6884) separately permit issue-list and issue-detail GET requests when the Namespace registration and App permissions allow them. Other REST operations, REST writes, and GraphQL are outside that native capability. Stronger ref and draft-PR grants retain their existing supported paths.

The first remaining integration connects the OCC TokenService GitHub App Source and issuer to the new CredentialProxyDriver push path using the existing finite repository selection and saved Agent rules. The [stock OpenShell integration suite](https://github.com/openclaw/openclaw-enterprise/pull/6764) already exercises grants, credential rotation, denial, and downgrade against a controlled Git fixture. It does not qualify the new TokenService-to-Proxy path or prove access to real GitHub.

Full inherited installation-token support comes later. The existing issuer can request the installation's inherited repositories and permissions with an empty access-token request body, but today's inherited `github-installation` binding does not select the native saved-policy delivery path. Adapt the existing owners before enabling that combination; do not claim it is supported by the finite path alone.

## Verification and deferred work

Before qualifying the first integration, create the Source through the authorized API, verify issuance and renewal, push it through the selected Proxy, and confirm readiness on the intended Sandbox. Through a real Agent and GitHub, fetch a previously absent object from approved private repository A; deny access to unapproved B and deny a push to read-only A before origin forwarding while the credential remains valid. Verify credential rotation, isolation, and the approved withdrawal boundary. `git ls-remote` proves discovery only.

Saving narrower grants changes desired policy; it does not immediately revoke a running native Sandbox. Confirm retirement of the old Sandbox before reporting withdrawal complete. Existing protected Git's request-time authorization and stronger ref guarantees remain distinct. Migration and caller switchover require their own qualification and approval; keep the working Git path until then.

After 1.0, review contextual `resolveCredential(source, admittedContext)` and variant renewal, push, and authenticated pull as separate work. Context derives from the admitted consumer and authorized use; repository issuance can derive from the same effective saved grants. OAuth audience or scope restrictions use their own admitted authority. Connection Template repository-policy integration is also deferred. Broader REST, GraphQL, branch/ref enforcement, and full inherited-token delivery require explicit supported semantics and proof.
