---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Move provider credential lifecycles to OpenShell

- **ID:** RFC-0030
- **Created:** 2026-11-05

## Decision for review

A user connects an OAuth account in a Namespace before deploying an Agent. The account must renew while it has zero Agents. Later, two Agents use the account. The user can withdraw one Agent’s access while the other keeps working under the original consent.

Give the separate **OpenShell credential service** custody of OCE-managed outbound provider credentials. It stores static keys and owns issuance, scheduled renewal, rotation and recovery for active credentials. It retires grants and revokes them at the provider where supported. The **OpenClaw Control Plane (OCC)** owns enrollment, consent, source selection and each Agent’s access. A trusted sender injects the credential into an authorized request. The Agent sees a placeholder. GitHub App tokens are the first integration. Saved OAuth accounts establish whether the design supports proactive renewal.

## What happens to each credential?

| Credential                    | What the control-plane service does                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved OAuth account           | Accepts the reusable grant from trusted enrollment. Renews before access-token expiry, even with zero Agents. Saves the successor refresh token before publishing the new access token. If a reply is lost, it recovers the original attempt or signals that the user must reconnect. |
| GitHub App installation token | Holds the App key, signs an App JWT and exchanges it with GitHub on an authorized cache miss when no suitable token exists. Only the service can use the signer. OCC supplies the approved repository and permission scope.                                                           |
| Static provider key           | Stores the operator-supplied value in the versioned `CredentialStore`. Replacement writes a new version. An authorized read resolves the current value without creating a refresh grant or invoking a minter.                                                                         |

OCC records which issuer owns the source, its opaque grant or secret reference, and its generation. Disconnect and status requests go to that owner even with zero Agents. OCC’s enrollment adapter handles browser consent and device login. This changes the renewal owner proposed in [RFC-0027](../0027-agent-oauth-connections/index.md) and preserves its independent Agent grants. The [saved-account implementation proposal](https://github.com/openclaw/openclaw-enterprise/pull/4671) can use a local owner until its grants can transfer safely.

## What happens on a protected request?

On a cache miss the sender calls OCC once. OCC authenticates the execution, authorizes the actual destination and operation, resolves the approved credential through the issuer, and rechecks access before returning it. The sender injects it and sends. With a zero authorization TTL, withdrawal denies the next send. A positive TTL permits reuse of the same approval and credential for a matching request until their fixed deadline, even during a partition. The sender denies the request at expiry if it cannot reach OCC.

[Proposed renewal and request flow](request-lifecycle.svg) · [Editable diagram](request-lifecycle.mmd)

## What must both teams agree on?

OpenShell’s embedded [store](https://github.com/NVIDIA/OpenShell/pull/5266) and [refresh engine](https://github.com/NVIDIA/OpenShell/pull/5283) have landed. Its [remote API proposal](https://github.com/NVIDIA/OpenShell/pull/5139) names the gateway as the client. OCE needs authenticated control-plane enrollment and resolution callers, direct provisioning of signing keys and reusable grants, and recovery by original operation ID after a lost reply. The credential gateway must have no access to signing keys or refresh tokens.

[Migration plan and OAuth acceptance](../../plans/0030-openshell-credential-service.md) · [First GitHub integration and withdrawal test](github-integration.md)
