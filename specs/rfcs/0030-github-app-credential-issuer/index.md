---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Issue GitHub App tokens through OpenShell

- **ID:** RFC-0030
- **Created:** 2026-11-05

## Decision for review

A team gives its Agent read/write access to repository A and read access to B. It needs to withdraw Git later while the same Agent continues its chat. Move GitHub App JWT signing and installation-token issuance from the OCE worker to the credential issuer embedded in the OpenShell gateway. The OpenClaw Control Plane (OCC) still authorizes each protected send. The trusted sender holds the bearer. GitHub enforces repository permissions and branch and tag rules. [Current OCE flow](../../../docs/reference/repository-credentials/protected-openshell-git.md)

Start with built-in Git. Keep provider instance, repository identity and access tier in the OCE grant. A GitLab adapter can map them to its own credentials. Static model keys follow the separate Gateway cleanup. [OCE Credential Proxy](../0023-egress-proxy-credential-lifecycle/index.md)

## Where the minter runs

Add GitHub App issuance to OpenShell’s in-process Rust `TokenMinter` registry. The embedded issuer already owns storage and refresh, with four built-in strategies. GitHub needs a new strategy and gateway validation. The review question is whether the App key may reside in the gateway process. If the key must stay outside the gateway, provision it directly at an independently trusted issuer or signer. [Embedded storage](https://github.com/NVIDIA/OpenShell/pull/5266) · [Embedded refresh](https://github.com/NVIDIA/OpenShell/pull/5283)

Mrunal’s proposed gRPC API separates refresh grant creation (`CredentialRefresh.CreateGrant`), resolution of the current value and version (`CredentialStore.ResolveSecrets`) and provider minting (`TokenMinter.Mint`). The draft passes secret material by value through `CreateGrant` and `Mint`. A remote minter alone cannot provide separate key custody. The first strategy uses the landed Rust interface. [OpenShell RFC 0023](https://github.com/NVIDIA/OpenShell/pull/5139) · [Proposed API](https://github.com/mrunalp/OpenShell/blob/7240ef9486fad85c4a1adb80c1574b64358221f6/rfc/0023-credential-issuer-service/README.md#credentialrefresh-contract)

## Follow A’s credential

1. **Approve.** The operator makes A and B eligible in the Namespace. The Agent owner selects them in `repositoryBindings`. Today those bindings share one permission map. Admit separate grants for the same execution so A can have read/write and B read for code and issues. [Enrollment](../../../docs/guides/repository-credentials/openshell-enrollment.md) · [Binding check](../../../apps/controller/src/drivers/repo/github/credentials/registry.ts)
2. **Prepare.** OCE records the approved signer, GitHub installation, grant generation and scope. In the background, the issuer signs the JWT and requests A’s numeric repository ID, explicit `contents` and `issues` permissions, and `metadata: read`. Reject missing scope before GitHub can inherit installation access. Verify returned repositories, permissions and expiry before publication. Renewal cannot extend OCE approval. [GitHub issuance API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
3. **Send.** The Agent gets a placeholder. The gateway delivers the workload credential only to the sender bound to the execution. It matches the HTTPS origin and repository to one credential and checks OCC before injection. Deny client-supplied bearers, ambiguous targets, cold material and unavailable decisions. Fence direct egress, redirects and credential-producing API calls. Existing `git-write` keeps its exact-ref checks.
4. **Withdraw.** OCC withdraws Agent 1’s Git access. Its next request fails even on an open connection with valid material. A previously authorized send may finish. Verify Git-only detach for the original sandbox and material generation. Independent model access and verified detach allow the chat to continue. If Git-only isolation cannot be verified, deny Git and retire the execution under the existing route policy. Agent 2 retains its own grant.

[Lifecycle diagram](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd) · [First PR, recovery and installed test](implementation-and-test.md)
