---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Issue GitHub App tokens through OpenShell

- **ID:** RFC-0030
- **Created:** 2026-11-05

## Decision for review

Give a running Agent read/write access to repository A and read access to B. The operator needs to withdraw its Git access while its chat and another Agent’s Git access continue.

Move GitHub App signing to the separate OpenShell control-plane issuer. Only the issuer holds the App key. It signs an App JWT and exchanges it with GitHub for a scoped installation token. The OpenClaw Control Plane (OCC) owns each Agent’s grant. On a cache miss, the data-plane proxy calls OCC once for both authorization and the credential to inject. The Agent sees a placeholder.

## Follow a push to A

1. **Approve.** The operator makes repositories eligible in the Namespace. The Agent owner selects them in `repositoryBindings`. The current profile requires one permission map. This proposal gives A and B separate maps for code and issues. GitHub enforces branch and tag rules. [Current enrollment](../../../docs/guides/repository-credentials/openshell-enrollment.md)
2. **Authorize and resolve.** OCC identifies the execution from the authenticated proxy binding and checks the actual origin, repository and operation. For a static source, OCC returns the existing credential. For a lazy GitHub App source, OCC asks the issuer for a matching installation token. If the issuer needs to mint one, it checks the scope and expiry GitHub returns. OCC rechecks the grant after minting. A denied or ambiguous request receives no credential.
3. **Send.** The proxy injects the approved token and forwards the Git request to GitHub. Presenting A’s placeholder on a request to B must fail.
4. **Withdraw.** With the authorization cache time to live (TTL) set to zero, OCC denies Agent 1’s next Git request after withdrawal, even on a reused connection with a valid token. With a positive TTL, the proxy may reuse a matching cached allow and credential until expiry. A previously authorized request may finish. Verified Git-only detach and independent model access let the same chat continue. If Git-only isolation cannot be verified, retire that execution. Agent 2 keeps its own grant.

[Lifecycle diagram](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd)

## Connect the two control-plane services

OpenShell’s proposed API names the gateway as the client and accepts secret material by value. This integration needs direct key enrollment at the issuer. OCE and OpenShell must agree on how OCC or its delegate authenticates and names a signer for the approved installation and scope. Keep grant scope portable for GitLab. [OpenShell issuer proposal](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#credentialrefresh-contract)

The GitHub exchange authenticates the App. Exchanging a workload’s identity for a token on an outbound request is a separate flow. OpenShell’s proposal leaves that exchange on the delivery path. Supporting it without the OpenShell supervisor would require identifying the caller, the target service and the component that performs the exchange. [Upstream scope](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#non-goals)

## Proxy deployments and caching

The OpenShell supervisor proxy is the first planned sender. For AWS Strands Box, the second target, the integration must show how protected requests reach a trusted sender and what prevents bypass without the OpenShell Sandbox Driver. Local development and CI may explicitly omit the proxy and managed credentials. A lighter proxy remains open.

Set TTL to zero for a fresh decision on each send. With caching enabled, OCC sets a fixed expiry for the authorization and credential together. During a partition the proxy may use an unexpired pair. At expiry it must reach OCC or deny the send. Pushed denials could evict an entry sooner on a connected proxy. They are optional for the MVP. [Implementation, recovery and installed acceptance](implementation-and-test.md)
