---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Issue GitHub App tokens through OpenShell

- **ID:** RFC-0030
- **Created:** 2026-11-05

## Decision for review

A build Agent needs write access to repository A and read access to B. An operator must be able to withdraw its Git access while its chat and another Agent’s Git access continue.

**Signing and credential resolution belong in the control plane.** The separate OpenShell credential issuer holds the GitHub App private key, signs the App JWT, and exchanges it with GitHub for an installation token. The OpenClaw Control Plane (OCC) owns the Agent’s grant and decides which credential an actual request may use. The data-plane proxy asks OCC once for authorization and the credential to inject, attaches the approved value and forwards the request. Neither the Agent nor the credential gateway receives the App key or signed App JWT.

## Follow a push to A

1. **Approve access.** An operator makes A and B eligible in the Namespace. The Agent owner selects them in `repositoryBindings`. The existing `github-repository` profile requires one permission map. This proposal gives the same execution distinct grants for A-write and B-read, including the approved code and issue permissions. GitHub enforces branch and tag rules. [Current enrollment](../../../docs/guides/repository-credentials/openshell-enrollment.md)
2. **Authorize and resolve.** The proxy sends the actual request to OCC’s declarative credential API. OCC identifies the execution from the authenticated proxy–workload binding. OCC checks the current grant, matches the origin, repository and operation, and selects the bound source. A static source supplies its existing credential. For a lazy source, OCC obtains a usable scoped token from the issuer, which may mint one on a miss. The issuer requests the exact repository IDs and permission map and checks the result. OCC rechecks authority after a slow mint before returning injection material to the requesting proxy. Ambiguous targets or denied requests produce no credential. [Existing resolution and send checks](../../../docs/flows/credential-source-egress.md#follow-the-metadata-get)
3. **Send.** The proxy injects only the value OCC returned into that approved request. A placeholder chosen by the Agent cannot select A’s credential for a push to B. Block direct credentialed egress, unsafe redirects and operations that could return a reusable credential. A GitHub request already authorized may finish.
4. **Withdraw.** With an OCC lookup on each send, withdrawing Agent 1’s grant denies its next request, even on a reused connection while the token is valid. Agent 2 keeps its own grant. Verified Git-only detach and independent model access let Agent 1 continue the same chat. If the runtime cannot verify isolation, retire that execution under the existing route policy.

[Lifecycle diagram](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd)

## Connect the two control-plane services

OpenShell proposes `CredentialRefresh` for issuer grants, `CredentialStore` for versioned outputs and `TokenMinter` for provider strategies. Its draft makes the **gateway** the remote client and permits signing material to pass through it by value. For OCE, enroll the App key directly at the issuer and authorize OCC, or a control-plane adapter acting for OCC, to use a bounded signer reference. The proxy calls OCC. The OpenShell team and OCE must agree on that client identity and signer-enrollment contract. The landed Rust issuer code is a starting point for the GitHub strategy. Running it inside the credential gateway would violate the custody requirement. [OpenShell issuer proposal](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#credentialrefresh-contract) · [Embedded implementation](https://github.com/NVIDIA/OpenShell/pull/5283)

## Proxy deployments and caching

Qualify the OpenShell supervisor proxy first. AWS Strands/Box is the planned second implementation of the same OCC contract. [Strands Box proxy work](https://github.com/openclaw/openclaw-enterprise/pull/4007) For local development and CI, pursue an explicit mode without a credential proxy or managed credential injection. A lightweight enforcing proxy for those environments remains open. OCE’s existing native Git broker covers a narrower Git workflow and does not yet implement this integration. [Native Git contract](../../../docs/reference/repository-credentials/prepared-native-git.md)

A possible optimization lets the proxy reuse an **authorization and its credential together** for a bounded TTL. For the first acceptance run use a fresh OCC decision on each send. Before enabling reuse, decide whether withdrawal waits for invalidation or permits use until expiry. Keep the grant portable across providers so a GitLab adapter can supply its own credentials. [Implementation, recovery and installed acceptance](implementation-and-test.md)
