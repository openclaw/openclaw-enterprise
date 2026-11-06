---
rfc: ../rfcs/0030-openshell-credential-service/index.md
---

# Move outbound credential lifecycles to OpenShell

- **ID:** RFC-0030
- **Delivery status:** Planned
- **Owners:** OCE control plane and OpenShell credential service maintainers
- **Source baseline:** [OCE main](https://github.com/openclaw/openclaw-enterprise/tree/d75f285fa0100ba8aa732212156d5876aa7e0e72) · [OpenShell embedded issuer](https://github.com/NVIDIA/OpenShell/blob/9321d1632a41cd7337db38ff982164bff9120d08/crates/openshell-credential-issuer/README.md) · [Remote API proposal](https://github.com/NVIDIA/OpenShell/pull/5139)

Migrate each OCE-managed outbound provider credential through its real caller, including model and Harness requests. Start with GitHub to connect the services. Prioritize OAuth connections that must renew without an attached Agent or an active user. Adopt static storage in a separate rollout step. Platform bootstrap, database and TLS credentials, and OCE sign-in have separate owners.

## Connect the control planes with one GitHub grant

Keep OCE’s Token Service registration and resolution contract. Implement the OpenShell call in the issuer adapter for the registered family. The adapter maps OCE’s source identity to the remote grant, output reference and generation. The remote service serializes scheduled and request-triggered renewal for each migrated grant. [Existing registration and resolution](https://github.com/openclaw/openclaw-enterprise/pull/4853)

Start with one approved repository, an issuer-enrolled App key and no issued output for that grant. Prove a private Git request through the installed sender and a denial before minting. If OCC loses the issuer’s reply, recover the original committed output under current authorization. If the issuer loses GitHub’s reply after a possible mint, deliver nothing and verify that the issuer sends no second mint. Qualify mixed repository permissions separately. [GitHub implementation and installed acceptance](../rfcs/0030-openshell-credential-service/github-integration.md)

## Enroll and renew a saved OAuth connection

Preserve the consent and per-Agent grants in [RFC-0027](../rfcs/0027-agent-oauth-connections/index.md). Trusted enrollment handles the browser redirect, state, PKCE verifier, or provider-specific device flow. Keep registration details, token endpoint, client authentication and provider response fields in the enrollment or issuer adapter. OCC keeps stable connection, provider, subject and consent references. Bind enrollment, status, resolution and retirement to the authenticated caller, Namespace, provider instance and grant identity. Put protocol-specific enrollment on a typed adapter. Keep the store location of refresh tokens and the renewal schedule private to the lifecycle owner. A renewal worker can renew its grant without an Agent identity or permission to read a token for delivery.

For a browser grant, bind the attempt to the initiating session, Namespace, connection and pinned client registration, including its issuer, redirect, state and PKCE verifier. One enrollment adapter claims the attempt and redeems the code. Verify the returned account identity against the provider registration and any preselected account, then transfer the first token set directly to the issuer over an authenticated control-plane channel. Record the issuer's durable acknowledgment for that grant and version before OCC marks it usable. If either reply is lost, look up the original attempt. Keep delivery closed while the exchange or import is uncertain. Require fresh consent if custody cannot be recovered. Replaying the authorization code can lose the grant.

OCE’s local OAuth issuer already stores the account and renews it with zero Agents attached. Keep OCC’s session-bound consent, client registration and stable account identity. Per-Agent attachment is a separate delivery change. [Saved-account implementation](https://github.com/openclaw/openclaw-enterprise/pull/4671) · [Agent-grant proposal](https://github.com/openclaw/openclaw-enterprise/pull/4673)

### One writer during normal renewal

Two Agents using the same account share one provider grant. The scheduler, an authorized request that needs a fresher token, and manual rotation must serialize on that grant. Persist the claim before sending the provider request. Commit the successor refresh token and access token together against the claimed generation before making the output available. A timed-out waiter or expired lock cannot establish that the provider left the old refresh token usable.

OCE already claims the private OAuth custody record with compare-and-swap across API and worker replicas. OpenShell takes a local mutex and a store guard keyed by provider ID and credential key, then records the in-flight exchange. PostgreSQL supplies an advisory lock across replicas. These mechanisms protect each owner within its own store. [OCE claim and publication](https://github.com/openclaw/openclaw-enterprise/blob/f1c0865be4c523090af0dccc29c613ad1d47d542/apps/controller/src/backends/token-service/oauth-connection.ts#L275-L391) · [OpenShell refresh guard](https://github.com/NVIDIA/OpenShell/blob/2856eef417c50de6375852e8175ab0a6dc0011b8/crates/openshell-credential-issuer/src/refresh/engine.rs#L493-L568)

### Move one existing grant during a maintenance window

1. Put the selected connection into maintenance. Close delivery and fence every old path that can rotate or replace it, including timers, request-triggered work, manual actions and restarted replicas. Drain the current attempt. After an interrupted exchange, import only if the old owner proves the request was unsent or recovers the committed successor. An unknown outcome keeps both writers fenced.
2. During the quiet window, read the last confirmed grant and verify its pinned client registration, issuer, account, resource and scopes. End the window by importing that grant through trusted enrollment. The destination may renew once it durably accepts the grant because the old writer is already fenced. Keep delivery closed until OCC verifies the destination reference and version.
3. Switch OCC’s expected owner, reference and generation together and reopen delivery. Keep the old writer fenced. After a lost reply, reconcile that operation and the committed owner before resuming. Once the new owner can rotate, recover from its record. An old backup may contain a spent token.

This proposal requires a durable old-owner fence and a trusted import path. It permits downtime and needs no lock shared between the two stores. OpenShell’s embedded adoption work does not transfer OCE accounts. If there is no safe import for that account, or a provider consumed a refresh token whose successor cannot be recovered, require fresh consent and retire the old grant separately. Ordinary refresh and a successful maintenance transfer need no reconnect. [Embedded adoption scope](https://github.com/NVIDIA/OpenShell/pull/5315)

Use an OAuth provider that invalidates each refresh token on use. Race two contenders for the same due version and verify one provider exchange and one committed successor. During cutover, restart the fenced old owner and verify it cannot exchange the token. With zero Agents attached, renew once, restart the service, and renew again with the saved successor. Attach two Agents and verify both make authorized calls with the resulting access token. Withdraw one Agent and verify the other continues. Disconnect the saved connection and verify both Agents lose use after any cached approval expires. Separately revoke consent at the provider and verify the connection requests reauthorization. Drop a response after a rotating refresh token is consumed. Commit the successor and access token together before release, conditional on the same active grant generation. A late reply after disconnect must produce no usable output. If the provider consumed the token but the successor is unknown, park that generation across restart. Recover from provider evidence or require fresh consent. After restart, attempt cutover as well as manual rotation and reconfiguration. Expect zero imports and zero further exchanges with the possibly spent token.

## Migrate the other credential families

| Family                                     | Required proof through the supported caller                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine OAuth                              | Acquire an access token with client credentials, renew before expiry, and make an authorized request after the old token expires. Reject a changed issuer or client binding.                                                                         |
| Device-authorized model or Harness account | Complete the supported device login, preserve account identity across renewal, and obtain a real model response after expiry. Keep the refresh token in issuer custody. Verify denial or cancellation leaves the connection unusable.                |
| Provider-specific strategies               | Qualify each configured strategy's issue, renew and retire operations against its provider. For service-managed personal access tokens, verify provider replacement and revocation where supported. Treat manually supplied tokens as static values. |
| Static provider values                     | Replace a managed API key in the versioned `CredentialStore`. Assert that an authorized sender uses the new version on its next OCC resolution, a stale concurrent replacement fails, and no refresh or mint runs.                                   |

Today, Gateway-managed static sources normally pick up a replacement on redeployment. For a migrated source, keep OCC’s recorded source owner, grants and authorized static-read boundary through the Secret Driver. Back its approved reads with a versioned OpenShell store reference. The service owns replacement of that value. Verify an installed model request after rebinding to the new version. [Current static update behavior](https://github.com/openclaw/openclaw-enterprise/blob/d75f285fa0100ba8aa732212156d5876aa7e0e72/docs/reference/drivers/openshell-credential-gateway.md) Bind writes to the expected version and original operation ID so a lost reply cannot create another version. For v1 resolve the authorized version on every protected send. In any future cache, end reuse at the earliest of the store’s freshness limit, the OCC authorization deadline and any credential or grant expiry. Retire the gateway copy after its last caller moves. Preserve a source Secret still used elsewhere. When replacing a key requires revocation at the provider, the operator must do that separately. Only a future policy that admits cached decisions could let a disconnected sender use the old key within that window. A sender that observes the replacement discards the old entry. On credential rejection, discard the entry and report the result. Never automatically replay a possible write with the new key. The issuer can select its physical storage backend separately. [Versioned store contract](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#credentialstore-contract)

## Retire each previous owner

RFC-0023 owns retirement of the public Credential Gateway and Credential Refresh Drivers. This plan moves each family’s material and outstanding provider operations to the issuer. Repository policy, source ownership, and authorization to attach or withdraw an Agent stay in OCE. [Driver retirement](https://github.com/openclaw/openclaw-enterprise/issues/4843)

Check every [registered source type](../../docs/reference/drivers/openshell-credential-gateway.md#source-type-catalog) and caller. Include protected inference, direct Harness key or token mounts, [ServiceAccount-issued personal access tokens](../../docs/reference/service-accounts.md), native Git and the operator’s [plugin discovery flow](../../docs/flows/credential-source-refresh.md). Transfer each credential-bearing caller to authorized resolution or explicitly disable that path before retiring its owner. Credential-free requests need no issuer call.

OpenShell leaves per-workload subject-token exchange on the request path. Keep workload authentication separate from maintenance of a reusable provider grant. A just-in-time exchange of an execution’s identity needs a trusted sender and a binding to the target service. Qualify that path on each runtime that offers it. For unprotected local or CI runs, keep provider credentials outside the Agent. [Upstream scope](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#non-goals)

Remove a worker key mount, refresh schedule or provider adapter only after its last caller moves, its old writes are fenced, and outstanding attempts and revocations settle. Update the affected references, guides and flows as each family ships. Record installed sender, service and provider results per family. GitHub acceptance closes the GitHub milestone. Completion requires the remaining active lifecycles and static store adoption to pass their own checks.

## Manual Notes

## Changelog

- 2026-11-06: Proposed paired sender-cache deferral, grant-scoped refresh locking, and an offline ownership transfer.
- 2026-11-06: Aligned the handoff with the merged Token Service and saved-account implementations and the proposed OpenShell GitHub strategy.
- 2026-11-05: Planned the migration by credential family against OCE `34783672`.
