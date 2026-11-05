---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Move provider credential lifecycles to OpenShell

- **ID:** RFC-0030
- **Created:** 2026-11-05

## Decision for review

A user connects an OAuth account before deploying an Agent. Its access token must keep renewing. Later, two Agents share that consent. The user withdraws one Agent’s access while the other keeps working.

Give the separate **OpenShell credential service** custody of OCE-managed outbound provider credentials. It stores static keys. For active credentials, `CredentialRefresh` schedules renewal, calls the provider’s `TokenMinter`, and owns rotation, recovery and retirement, including provider revocation where supported. The **OpenClaw Control Plane (OCC)** owns enrollment, consent, source selection and each Agent’s access. GitHub App tokens are the first integration.

## What happens to each credential?

| Credential                    | What the control-plane service does                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved OAuth account           | Renews the enrolled grant with zero Agents attached. Saves the successor refresh token before publishing the new access token. After a lost reply, recovers the original attempt or requests fresh consent. |
| GitHub App installation token | Holds the App key. If OCC approves the request and no matching token exists, exchanges a signed App JWT with GitHub for the approved repository and permissions.                                            |
| Static provider key           | Stores each operator replacement as a new version in `CredentialStore`. An authorized read returns the current value without a refresh grant or mint.                                                       |

OCC keeps the issuer, opaque grant or secret reference, and source generation. It routes status and disconnect to that owner even with zero Agents. Disconnecting the account withdraws all attachments and asks the issuer to retire the grant. OCC keeps browser and device enrollment and the independent Agent grants from RFC-0027. The proposed local OAuth owner can deliver those flows while the remote service is built. [OAuth connection RFC](../0027-agent-oauth-connections/index.md) · [Saved-account proposal](https://github.com/openclaw/openclaw-enterprise/pull/4671)

## What happens on a protected request?

The Agent sees a placeholder. On a cache miss its trusted sender calls OCC once. OCC authenticates the execution, authorizes the actual destination and operation, resolves the approved credential through the issuer, and rechecks access before returning it. The sender injects it and sends. On a redirect, it strips the credential and obtains approval for the new request. With zero authorization TTL, withdrawal denies the next send. A positive TTL permits matching sends until the cached approval and credential expire, even during a partition. At expiry, reach OCC or deny.

[Proposed renewal and request flow](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd)

## What must both teams agree on?

OpenShell has landed the embedded store and refresh engine. Its remote API proposal binds stored references to the authenticated gateway. [Embedded store](https://github.com/NVIDIA/OpenShell/pull/5266) · [Embedded refresh](https://github.com/NVIDIA/OpenShell/pull/5283) · [Proposed remote API](https://github.com/NVIDIA/OpenShell/pull/5139)

1. How can OCC enroll keys and grants directly, then resolve only their outputs? The gateway and OCC’s ordinary resolver must be unable to read an App key or refresh token, even with its reference.
2. If the issuer accepts a write and OCC loses the reply, how does OCC recover the committed reference and version using the original operation ID?

[Migration plan and OAuth acceptance](../../plans/0030-openshell-credential-service.md) · [First GitHub integration and withdrawal test](github-integration.md)
