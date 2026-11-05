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

Move GitHub App signing and token issuance to the separate OpenShell credential issuer in the control plane. The App key stays at the issuer, outside the credential gateway. The issuer sends the signed App JWT to GitHub and receives a scoped installation token. The OpenClaw Control Plane (OCC) owns each Agent’s grant. On a cache miss, the data-plane proxy makes one OCC call to authorize the request and resolve the credential to inject.

## Follow a push to A

1. **Approve.** The operator makes repositories eligible in the Namespace. The Agent owner selects them in `repositoryBindings`. The current profile requires one permission map. This proposal gives A and B separate maps for code and issues. GitHub enforces branch and tag rules. [Current enrollment](../../../docs/guides/repository-credentials/openshell-enrollment.md)
2. **Authorize and resolve.** OCC identifies the execution from the authenticated proxy binding and checks the request’s origin, repository and operation. A static source supplies its existing credential. For a lazy source, OCC asks the issuer for a scoped token. The issuer can mint on a miss and verifies the returned scope and expiry. OCC rechecks authority after minting before returning the credential. Denied or ambiguous requests receive no credential.
3. **Send.** The proxy injects the approved credential and forwards the request. OCC binds the credential to the actual target. A’s placeholder cannot select A’s token for B.
4. **Withdraw.** With the authorization cache time to live (TTL) set to zero, OCC denies Agent 1’s next Git request after withdrawal, even on a reused connection with a valid token. With a positive TTL, the proxy may reuse a matching cached allow and credential until expiry. A previously authorized request may finish. Verified Git-only detach and independent model access let the same chat continue. If Git-only isolation cannot be verified, retire that execution. Agent 2 keeps its own grant.

[Lifecycle diagram](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd)

## Connect the two control-plane services

OpenShell’s proposed API gives the gateway a remote client role and permits passing secret material by value. Enroll the key directly at the issuer. OCE and OpenShell need to agree on how OCC or its control-plane delegate authenticates and uses a signer reference bounded to the approved installation and scope. Keep grant scope portable for GitLab. [OpenShell issuer proposal](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#credentialrefresh-contract)

## Proxy deployments and caching

Qualify the OpenShell supervisor proxy first and AWS Strands/Box second. For local development and CI, an explicit mode without a proxy or managed injection is acceptable. A lighter proxy remains open. Set TTL to zero when each send needs current approval. With caching enabled, OCC sets a fixed expiry for the authorization and credential together. During a partition the proxy may use an unexpired pair. At expiry it must reach OCC for a fresh decision or deny the send. Pushing denials could shorten that window on connected proxies and is optional for the MVP. [Implementation, recovery and installed acceptance](implementation-and-test.md)
