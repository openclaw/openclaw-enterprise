---
rfc: index.md
---

# Move Codex device login to TokenService

This proposed amendment moves Codex account login from the Credential Gateway and Credential Refresh Drivers to the selected TokenService and Credential Proxy. OpenClaw Control Plane (OCC) keeps the temporary login session in PostgreSQL. TokenService creates a typed OAuth CredentialSource only after the user authorizes and the issuer grants access. Dedicated Codex receives a Proxy placeholder and trusted account metadata, without an access token or refresh token.

## Login and Source ownership

This amendment supersedes the [OAuth registration rule](contracts.md#credential-access-and-lifecycle) only for Codex's trusted built-in preset. OCC authorizes Source creation in the destination Namespace and selects that immutable preset on the server. Public requests cannot choose an issuer, client, callback, or token endpoint. The coordinated typed Source dependency records `consent.kind: builtin_codex`, its `ownerPrincipalId`, requested and granted scopes, and necessary account metadata, without `connectionTemplateId`. Plugin OAuth continues to use `consent.kind: connection_template`, a real approved Template, and client registration. The issuer remains fixed in the selected TokenService implementation; neither path invents persisted IDs.

OCC asks the selected TokenService to start device authorization. It saves the challenge and opaque issuer state in the existing encrypted `authentication_states` record, with the actor, destination Namespace, exact saved Agent when applicable, selected TokenService instance, expiry, polling interval, and phase. A pending login has no Source, Source reservation, Source IAM grant, saved connection, or credential material. Cancellation and expiry close only the temporary session.

OCC preserves the existing Agent authority checks on start, poll, cancel, and completion: `agent:create` in the Namespace for an unsaved Agent, or `agent:read` and `agent:update` on the exact saved Agent. Start binds the session to the actor, Namespace, and saved Agent; poll, cancel, and completion check that exact identity. OCC rechecks those permissions and Namespace Source creation authority before finalization. TokenService performs the device exchange; a pending reply creates nothing. After a successful grant, TokenService retains the first access token, rotating refresh token, and expiry in custody, creates the canonical OAuth Source, and returns it without material. OCC grants the creator access, checks `operate` on the new Source, and records mutation evidence. Preserve the polling and cancellation fence; do not replay an uncertain code exchange or report lost completion as success.

## Renewal and delivery

TokenService is the only refresh owner. It commits replacement access and refresh tokens and advances the credential version before notifying the selected Proxy. The Proxy updates its existing delivery resource and confirms the version on serving copies under the [update contract](token-service-instance-and-updates.md). With no delivery resource, notification creates none. Delivery failure leaves the replacement authoritative; report a sanitized failure and retain authorized manual push recovery. The Harness never receives a refresh token or becomes another issuer owner.

For dedicated Codex, the Proxy obtains the access token through the authorized TokenService resolver and returns a placeholder descriptor. The worker adds account metadata from the authorized Source to that binding's nonsecret projection: `accountId`, `planType`, the FedRAMP routing flag, and optional `userId` and `accountUserId` claims used by verification paths. Retain other personal data only when an existing account presentation or receiving contract requires it; email is optional for Codex authentication. Compute and Sandbox carry the projection but cannot resolve or receive the credential. The OpenShell supervisor supplies a stable placeholder on launch. The Harness uses it and the context for ephemeral external-mode `auth.json` and the JWT alias. No real token appears in that file, environment, launch specification, or status.

A second authorized Agent can bind the same Source. The worker reads account metadata from the canonical Source consent on every attachment, including when the Proxy reuses a delivery resource without resolving the credential. The Proxy does not persist another copy of the account metadata. Each Agent receives its own admitted binding, injection policy, and fresh placeholder. Stop or withdrawal preserves a sibling's delivery. Source deletion retires Proxy-owned delivery resources before TokenService removes custody and the Source.

The first Codex login and Agent path preserves the refusal to delete a referenced Source. Supporting disconnect while Agents still consume the grant requires a separate withdrawal authorization decision: the grant owner cannot automatically operate every consuming Agent, and native OpenShell refuses to delete an attached Provider. Only active disconnect is deferred; it does not block this path.

One binding admits Bearer injection for the exact Codex executable and HTTPS `chatgpt.com:443` requests: `POST /backend-api/codex/responses`, `GET /backend-api/wham/accounts/check`, and `GET /backend-api/wham/config/bundle`. Codex uses the GET requests for workspace routing and managed configuration. The network grant and injection policy remain separate; both must authorize each request. Other hosts and paths, including an alternate workspace backend origin, remain refused. HTTPS is required by the target design, but the current native injection match cannot check transport scheme. As an accepted temporary exception, a matching plaintext request to port 443 could receive the Codex access token. Remove the exception when native injection can enforce HTTPS; [upstream scheme reporting](https://github.com/ai-openshell/openshell/pull/4397) alone does not establish that enforcement. A Proxy or Sandbox that cannot enforce the exact executable, host, port, method, and path matches refuses deployment. Missing account context, a wrong owner, stale delivery, absent placeholder, or failed policy readiness prevents Codex startup. Gateway ownership cannot silently substitute for Proxy delivery.

## Combine Repository execution with staged model delivery

A Repository-bound dedicated Agent must use the same TokenService model delivery as an Agent without Repository access. Add a protected execution admission version that carries the existing native Git plan and the staged model `credentialDeployment` in one revision. Preserve the plan's admitted execution ID, Repository authorization, original-launcher requirement, route identity and issuer release fence. The Git plan carries no model route or Gateway-owned Harness attachment. Require native `network-policy` Git authorization, the existing selected-repository profile, finite deadline and absence of standing approval, and an exact match between the plan's Repository snapshot and revision Repository credentials. The staged model Source and TokenService instance must match Harness authentication.

OCC admits the Repository bindings and policy under their existing Installation and Namespace limits, separately from the exact model Source grant and network and injection policy. The selected registration must own the Sandbox, the native Git proxy view and staged Credential Proxy. Compute and Sandbox reject an incomplete or mismatched owner, overlapping routes, unsupported combination or failed readiness. Before activation, verify staged model injection and the existing Repository route and launcher checks. A verified Git route can await its first material until the active revision commits; retain the issuer release fence and readiness rules. Keep the Repository issuer, Git and scoped REST rules, expiry and withdrawal unchanged. Remove the Gateway model fallback; do not invent another Git identity or copy Repository policy into model grants.

## Interface changes

### API

Keep device-login start, poll, and cancel operations. Pending responses contain the challenge or session status and no Source identity. Successful poll returns the TokenService-created Source identity. Do not add a caller-selectable issuer or built-in client catalog.

### IAM

No new actions. Preserve the unsaved and saved Agent permissions and exact session binding described above. OCC authorizes Namespace Source creation before starting and completing login, then grants the creator access. Admission and deployment retain exact Source `operate` checks for the deployer and Agent principal.

### Database entities

Reuse `authentication_states` and the canonical typed OAuth Source catalog. Do not add a reservation or connection entity. Secret material remains in TokenService custody.

### Driver contracts

Add optional `startDeviceAuthorization` and `pollDeviceAuthorization` operations to `TokenServiceDriver`. Start accepts the admitted destination Namespace and Source enrollment context, and returns the challenge, expiry, interval, and opaque private state. Poll accepts that context and private state, and returns `pending` or `ready` with the newly created typed OAuth Source. The Codex issuer and public client are fixed in the selected implementation, not supplied as caller-controlled endpoint settings. Neither returns tokens to OCC. An unavailable operation refuses login instead of falling back to the Credential Refresh Driver.

Extend `CredentialProjection` with optional typed, nonsecret account context for its binding. `CredentialProxyDriver.configureDeployment` returns the placeholder descriptor; the worker adds the context from the canonical authorized Source consent on every attachment. For a combined Repository revision, `SandboxDriver.provisionStagedHarness` also returns the trusted `proxyWiring` that ordinary `provisionHarness` supplies, beside the target identity. Compute uses that wiring to observe and enroll the exact Git installation, and retains only the Sandbox target ID for cleanup. Missing or mismatched wiring refuses enrollment. The existing Sandbox `prepareStagedHarness` operation carries the completed projection to the dedicated Harness. This does not add account metadata to `ResolvedCredential` or Proxy persistence. Renewal reuses post-commit Proxy notification, versioned resolution, refresh status, and Source removal.

## Simplifications

Reuse PostgreSQL login sessions, the typed OAuth Source, the selected TokenService issuer, and the staged Proxy/Sandbox lifecycle. Retire Codex-specific Gateway/Refresh ownership only after the hosted Plugin discovery owner migrates its current Gateway-only Source reader to TokenService; otherwise signed-in account discovery breaks. Track that caller as a coordinated dependency rather than changing Plugin OAuth consent here. Do not create fake consent records or a parallel Source representation.

## Acceptance criteria

- Fastify and PostgreSQL integration starts login across API instances, observes no pending Source, checks actor and Namespace denial, closes cancellation or expiry without deleting a completed Source, and completes only after an issuer grant. Verify creator access, audit, and no tokens in responses or logs.
- The supported TokenService/Source workflow proves custody, one refresh owner, replacement commit, versioned Proxy notification, delivery failure after commit, manual recovery, and deletion retirement. A simulated issuer proves controlled workflow behavior, not real provider login.
- Native Harness/Proxy integration proves dedicated Codex receives a stable placeholder and account context, writes placeholder-only auth state, shares one Source across two Agents, and refuses missing metadata, unsupported policy, or stale delivery. Controlled Gateway transport does not prove native enforcement.
- In an isolated environment with an authorized interactive Codex account and selected real OpenShell and Codex binaries, complete device login, deploy an Agent, obtain a real model response, renew through TokenService, verify Proxy delivery, and obtain another response without Harness restart. Record the tested revision, binary versions, account scope, and untested boundaries. Missing account interaction or credentials leave this proof unqualified.
