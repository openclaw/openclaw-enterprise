---
rfc: index.md
---

# Move Codex device login to TokenService

This proposed amendment moves Codex account login from the Credential Gateway and Credential Refresh Drivers to the selected TokenService and Credential Proxy. OpenClaw Control Plane (OCC) keeps the temporary login session in PostgreSQL. TokenService creates a typed OAuth CredentialSource only after the user authorizes and the issuer grants access. Dedicated Codex receives a Proxy placeholder and trusted account metadata, without an access token or refresh token.

## Login and Source ownership

OCC authorizes Source creation in the destination Namespace and selects the built-in immutable Codex issuer and public-client preset on the server. The public request cannot select another built-in issuer, client, callback, or token endpoint. The typed OAuth Source records `consent.kind: builtin_codex`, its `ownerPrincipalId`, requested and granted scopes, and the necessary account metadata. It has no `connectionTemplateId`. Plugin OAuth consent instead uses `consent.kind: connection_template`, a real approved `connectionTemplateId`, and client registration. The issuer remains fixed in code; neither branch invents Template or client IDs.

OCC asks the selected TokenService to start device authorization. It saves the challenge and opaque issuer state in the existing encrypted `authentication_states` record, with the actor, destination Namespace, selected TokenService instance, expiry, polling interval, and phase. A pending login has no Source, Source reservation, Source IAM grant, saved connection, or credential material. Cancellation and expiry close only the temporary session.

OCC checks the actor and Namespace authority before polling. TokenService performs the device exchange through its Codex issuer. A pending reply creates nothing. On a successful grant, TokenService retains the first access token, rotating refresh token, and expiry in custody. It creates the canonical typed OAuth Source with issuer-derived account metadata in its consent record and returns the Source without credential material. OCC grants the creator access and records mutation evidence. Completion returns the Source identity. Preserve the existing polling and cancellation fence; do not replay an exchange when code consumption is uncertain. A failed or lost completion must not be reported as successful login.

## Renewal and delivery

TokenService is the only refresh owner. It commits replacement access and refresh tokens and advances the credential version before notifying the selected Proxy. The Proxy updates its existing delivery resource and confirms the version on serving copies under the [update contract](token-service-instance-and-updates.md). With no delivery resource, notification creates none. Delivery failure leaves the replacement authoritative; report a sanitized failure and retain authorized manual push recovery. The Harness never receives a refresh token or becomes another issuer owner.

For dedicated Codex, the Proxy obtains the access token through the authorized TokenService resolver and returns a placeholder descriptor. The worker reads the authorized Source consent and adds the account metadata required by Codex to that binding's nonsecret projection: `accountId`, `planType`, the FedRAMP routing flag, and optional `userId` and `accountUserId` claims used by verification paths. Do not persist email. Compute and Sandbox carry the projection but cannot resolve or receive the credential. The OpenShell supervisor supplies the binding's stable placeholder on a fresh launch. The Harness uses the placeholder and context to prepare ephemeral external-mode `auth.json` and the documented JWT alias. No real token appears in that file, process environment, launch specification, or status response.

A second authorized Agent can bind the same Source. The worker reads account metadata from the canonical Source consent on every attachment, including when the Proxy reuses a delivery resource without resolving the credential. The Proxy does not persist another copy of the account metadata. Each Agent receives its own admitted binding, injection policy, and fresh placeholder. Stop or withdrawal preserves a sibling's delivery. Source deletion retires Proxy-owned delivery resources before TokenService removes custody and the Source.

Injection is allowed only for the admitted Codex executable, destination, port, method, and path. A Proxy or Sandbox that cannot enforce the required route refuses deployment. Missing account context, a wrong owner, stale delivery, absent placeholder, or failed policy readiness prevents Codex startup. Gateway ownership cannot silently substitute for Proxy delivery.

## Interface changes

### API

Keep device-login start, poll, and cancel operations. Pending responses contain the challenge or session status and no Source identity. Successful poll returns the TokenService-created Source identity. Do not add a caller-selectable issuer or built-in client catalog.

### IAM

No new actions. OCC authorizes collection creation in the destination Namespace before starting and completing login, then grants the creator access to the Source. Admission and deployment retain exact Source `operate` checks for the deployer and Agent principal.

### Database entities

Reuse `authentication_states` and the canonical typed OAuth Source catalog. Do not add a reservation or connection entity. Secret material remains in TokenService custody.

### Driver contracts

Add optional `startDeviceAuthorization` and `pollDeviceAuthorization` operations to `TokenServiceDriver`. Start accepts the admitted destination Namespace and Source enrollment context, and returns the challenge, expiry, interval, and opaque private state. Poll accepts that context and private state, and returns `pending` or `ready` with the newly created typed OAuth Source. The Codex issuer and public client are fixed in the selected implementation, not supplied as caller-controlled endpoint settings. Neither returns tokens to OCC. An unavailable operation refuses login instead of falling back to the Credential Refresh Driver.

Extend `CredentialProjection` with optional typed, nonsecret account context for its binding. `CredentialProxyDriver.configureDeployment` returns the placeholder descriptor; the worker adds the context from the canonical authorized Source consent on every attachment. The existing Sandbox `prepareStagedHarness` operation carries the completed projection to the dedicated Harness. This does not add account metadata to `ResolvedCredential` or Proxy persistence. Renewal reuses post-commit Proxy notification, versioned resolution, refresh status, and Source removal.

## Simplifications

Reuse PostgreSQL login sessions, the typed OAuth Source, the selected TokenService issuer, and the staged Proxy/Sandbox lifecycle. Remove Codex-specific Gateway/Refresh login and refresh ownership after switchover. Keep plugin OAuth consent with its Template/client owner; do not create fake consent records or a parallel Source representation.

## Acceptance criteria

- Fastify and PostgreSQL integration starts login across API instances, observes no pending Source, checks actor and Namespace denial, closes cancellation or expiry without deleting a completed Source, and completes only after an issuer grant. Verify creator access, audit, and no tokens in responses or logs.
- The supported TokenService/Source workflow proves custody, one refresh owner, replacement commit, versioned Proxy notification, delivery failure after commit, manual recovery, and deletion retirement. A simulated issuer proves controlled workflow behavior, not real provider login.
- Native Harness/Proxy integration proves dedicated Codex receives a stable placeholder and account context, writes placeholder-only auth state, shares one Source across two Agents, and refuses missing metadata, unsupported policy, or stale delivery. Controlled Gateway transport does not prove native enforcement.
- In an isolated environment with an authorized interactive Codex account and selected real OpenShell and Codex binaries, complete device login, deploy an Agent, obtain a real model response, renew through TokenService, verify Proxy delivery, and obtain another response without Harness restart. Record the tested revision, binary versions, account scope, and untested boundaries. Missing account interaction or credentials leave this proof unqualified.
