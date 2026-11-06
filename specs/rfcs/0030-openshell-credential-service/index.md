---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Move provider credential lifecycles to OpenShell

- **ID:** RFC-0030
- **Created:** 2026-11-05

## Decision for review

Give an Agent write access to repository A and read access to B. The OpenClaw Control Plane (OCC) decides what this Agent may do. The separate OpenShell credential service holds the GitHub App key and mints a token for the approved scope. A trusted sender injects it. The Agent sees a placeholder.

GitHub is the first integration. Use OpenShell as the issuer behind OCE’s existing Token Service for managed, renewable provider credentials. OCC keeps consent, source registration and per-Agent grants. The issuer mints and renews tokens, retires grants, and recovers exchanges whose outcome is unknown. A migrated static key uses the issuer’s versioned store. [OCE lifecycle contract](https://github.com/openclaw/openclaw-enterprise/blob/18130677062c69c16b68fefc97e1a75bbdfe1c4f/specs/rfcs/0023-egress-proxy-credential-lifecycle/contracts.md#credential-access-and-lifecycle)

## What moves to OpenShell?

| Credential          | What the issuer must do                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App          | Exchange a signed App JWT for the approved repository IDs and permissions. Verify the returned scope before releasing the token. If GitHub may have minted one, reconcile the original attempt before another mint. |
| Saved OAuth account | Renew with zero Agents attached. Commit the successor refresh token and access token together. Retire the grant when OCC disconnects the account.                                                                   |
| Static provider key | Store operator replacements as new versions in `CredentialStore`. Resolve the approved value without a refresh grant or mint.                                                                                       |

OCE already registers GitHub grants and saved OAuth accounts with its Token Service. OCC handles browser consent and code exchange. The local issuer can renew a saved account before it has any Agents. Detaching one Agent leaves the account available to another authorized Agent. [Token Service](https://github.com/openclaw/openclaw-enterprise/pull/4853) · [Saved accounts](https://github.com/openclaw/openclaw-enterprise/pull/4671) · [Per-Agent delivery proposal](https://github.com/openclaw/openclaw-enterprise/pull/4673)

## What happens on a protected request?

For v1, defer both sender caches. On every protected send the trusted sender asks OCC to authorize the captured request and resolve the credential. The issuer may return an already minted token for that grant. OCC rechecks access before release. Withdrawal denies the next fresh send. A redirect requires its own approval. [Request flow](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd) · [What a future cached read would have to match](github-integration.md#authorization-across-senders)

## Proposed issuer contract

Deploy the issuer alongside OpenShell or separately, with its own process and service identity. Give the enrollment client authority to provision signing keys and refresh grants. Give the OCC resolver access only to the approved grant’s named output. The gateway can use neither the signer nor the refresh token.

For a cold Git request, extend `EnsureFresh` to start or join issuance for an authorized delivery. Read the committed version through `ResolveSecrets`. If OCC loses a mutation reply, replay the same operation ID to recover its recorded result. An uncertain provider exchange stays with the issuer. [Upstream API proposal](https://github.com/NVIDIA/OpenShell/pull/5139)

OpenShell has merged the embedded refresh engine. Remote delivery authorization and recovery still need implementation. During OAuth cutover, pause the selected grant, drain the old owner, and transfer its last confirmed version before enabling renewal at the new owner. [Embedded engine](https://github.com/NVIDIA/OpenShell/pull/5283) · [Proposed embedded versioning](https://github.com/NVIDIA/OpenShell/pull/5315)

[Migration plan and OAuth acceptance](../../plans/0030-openshell-credential-service.md) · [First GitHub integration and installed test](github-integration.md)
