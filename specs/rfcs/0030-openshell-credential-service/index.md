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

For v1, check every send online, including credential-cache hits. In one call the trusted sender asks OCC to authorize the captured request and resolve its credential. OCC checks the execution, destination and operation before resolution and rechecks access before release. Withdrawal denies the next fresh send. A redirect needs its own approval. A separately admitted positive authorization TTL could permit matching sends until a fixed deadline, even during a partition. [Request flow](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd)

## What must both teams agree on?

OpenShell’s store and refresh engine run inside its gateway today. Versioned embedded grants are under review. The proposed remote gRPC service would let OCE deploy issuer and gateway together under separate identities, keeping signing keys and refresh tokens outside the gateway’s reach. [Embedded engine](https://github.com/NVIDIA/OpenShell/pull/5283) · [Versioned grants](https://github.com/NVIDIA/OpenShell/pull/5315) · [Remote API](https://github.com/NVIDIA/OpenShell/pull/5139)

1. How does OCC enroll reusable material directly at the issuer and give its resolver access only to approved outputs, including when a Git token must be minted?
2. How does OCC recover the committed grant or version after a lost reply? Can an imported OAuth grant stay paused until OCC switches owners?

[Migration plan and OAuth acceptance](../../plans/0030-openshell-credential-service.md) · [First GitHub integration and installed test](github-integration.md)
