---
created: "2026-09-19"
updated: "2026-10-01"
last_updated_session: "authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7"
---

# Agent Native Admin UI Flow

## Overview

This flow traces Agent native admin UI access. A console user opens an Agent
detail tab, OCC checks the user's exact Agent administrator grant, selects
the active gateway revision, returns a stable per-Agent URL, and the Agent host
reuses the same OCE session cookie as the console. OCC resolves the requested
host to the exact Agent, rechecks authorization, and proxies native HTTP and
WebSocket traffic through the API process. Live runtime proof remains separate.

## Entry Points

- Trigger: Console renders an Agent detail tab, calls the native admin availability API, and opens the returned Agent URL.
- Source: `apps/controller/src/console/agents/native-admin.mjs:renderNativeAdminAccess`
- Source: `apps/controller/src/http/native-admin.ts:resolveNativeAdminAvailability`
- Source: `apps/controller/src/http/native-admin.ts:handleNativeAdminUpgrade`
- Assumptions: The API has a valid controller session, `agentNativeAdmin.enabled` is true, `agentNativeAdmin.domain` and `agentNativeAdmin.sharedCookieDomain` are configured, Better Auth emits the shared session cookie at that parent domain, and private Agent gateway routing can return a `ComputeDriver.getGatewayEndpoint` value.

## Flow

```mermaid
graph TD
  A["Console opens Agent detail tab"] --> B["GET exact Agent native-admin status"]
  B --> C["Resolve OCC session and exact Agent administrator principal"]
  C --> D{"Exact Agent exists?"}
  D -->|no| E["Return protected-route error"]
  D -->|yes| F{"Installation enabled?"}
  F -->|no| G["Return disabled"]
  F -->|yes| H["Call resolveNativeAdminAvailability"]
  H --> I{"Active revision selection available?"}
  I -->|no| J{"Authorized stopped Agent without an active revision?"}
  J -->|yes| X["Return stopped without an origin"]
  J -->|no| Y["Return unavailable"]
  I -->|yes| K{"Agent desired running?"}
  K -->|no| L["Return stopped with derived origin"]
  K -->|yes| R2{"Newer revision replacing it on an exclusive Compute Driver?"}
  R2 -->|yes| Y
  R2 -->|no| M{"Native config and endpoint supported?"}
  M -->|no| N["Return unsupported with derived origin"]
  M -->|yes| O["Return available Agent URL"]
  O --> P["Browser opens derived Agent host with shared OCE session cookie"]
  P --> Q["OCC resolves host to exact Agent using platform state"]
  Q --> R{"Shared session and exact Agent administer still valid?"}
  R -->|no| S["Return protected-route error"]
  R -->|yes| T["Resolve current active revision and supported native config"]
  T --> U["OCC strips browser credentials and proxies HTTP to private gateway"]
  T -->|WebSocket with exact Origin| V["OCC proxies 101 upgrade with revision lease"]
  U -->|HTML preview with sandbox routing enabled| W["Browser loads public shell from separate preview origin"]
  W --> Z["Envoy sandbox listener routes to Agent sandbox port"]
  Z --> AA["Native UI delivers HTML into runtime-isolated iframe"]
```

## Execution Trace

### 1. Console renders native admin availability

`apps/controller/src/console/agents/native-admin.mjs:renderNativeAdminAccess`

The Agent detail page inserts the native admin panel on its tabs, including Configuration and Workspace files. The panel starts hidden while it requests `${path}/native-admin`. The UI hides disabled and denied states, reports stopped, unavailable, or unsupported states, and shows the **Open native admin UI** link only when the API returns `status: "available"` with an Agent URL. The link opens that URL in a new tab with `noopener noreferrer`; opening it makes no additional availability or launch request. A `403` is an audited denial, so the console remembers the denied status path in tab `sessionStorage` for the same session owner and hides the panel on later views of that Agent without asking again. Logout, another sign-in, or a new tab asks afresh. When deployment polling or **Refresh deployment** sees a new `activeRevisionId` or `desiredRuntimeState`, `updateCurrentAgent` calls the panel's `refresh()` once under the same guards; a refresh during a read rereads once after it.

The warning text tells operators that native admin access can change gateway state outside OCE and that durable configuration should remain in OCE.

### 2. OCC protects the availability route

`apps/controller/src/http/native-admin.ts:nativeAdminStatusOperation`

`createNativeAdminAccess` owns the host interceptor, upgrade listener and socket shutdown hook. It reads the current controller through a getter so an app created before bootstrap uses the initialized controller on later requests. Shared route admission remains in `apps/controller/src/index.ts`.

The route is `GET /namespaces/:namespaceId/agents/:agentId/native-admin`. Its operation metadata requires Agent `administer`, targets the exact Agent, and runs through the same `admit` and `resolveIdentity` middleware as other protected OCC routes. A caller with only `read` or `operate` does not reach the handler as an administrator. The disabled feature state is still behind OCC exact-Agent `administer` authorization and existence checks; `disabled` is not an unauthenticated discovery result and does not add a separate Agent `read` permission path.

### 3. Shared availability resolver checks feature and active revision state

`apps/controller/src/http/native-admin.ts:getNativeAdminStatus`
`apps/controller/src/http/native-admin.ts:resolveNativeAdminAvailability`
`packages/occ/src/index.ts:getAdministerableActiveAgentRevision`

The status handler validates the human session, preserves the OCC exact-Agent `administer` authorization and existence boundary, then delegates to `resolveNativeAdminAvailability`. The resolver returns `disabled` only after that protected boundary succeeds. When enabled, it requires a configured public origin and native admin domain, then calls `controller.getAdministerableActiveAgentRevision`. That controller method authorizes exact Agent `administer` and loads the Agent before inspecting its state. If the Agent is stopped and has no `activeRevisionId`, it raises `ResourceConflictError`; the resolver returns only `status: "stopped"`. This covers new Agents and completed stops. If active-revision selection instead raises `NoActiveAgentRevisionError`, as for a desired-running Agent awaiting activation, the resolver returns `unavailable` in a successful status envelope. Any other `DependencyUnavailableError` (an IAM or State outage) reaches the error handler as `503`. The console asks the operator to check the Agent's deployment and refresh access; private gateway routing has not been evaluated. The panel always reports the Agent's active revision, independently of the viewed snapshot. Authorization denial remains a protected-route `403` and preserves the human IAM denial audit.

After active revision selection succeeds, OCC derives the native target. If the Agent's desired runtime state is not `running`, the resolver returns `stopped` with the derived host and origin. If `nativeAdminConfigurationSupported` rejects trusted-proxy auth, admin identity scopes, admin device auto-approval, `controlUi.enabled`, exact `allowedOrigins`, or host-header fallback/device-auth settings, the resolver returns `unsupported` with the same derived target. If the selected Compute Driver cannot provide a gateway endpoint or the endpoint is not a clean private `wss:` URL, it also returns `unsupported`. Only the `available` result carries the private `gatewayBase`; `nativeAdminAvailabilityData` omits that value from the browser API response.

### 4. OCC derives the isolated Agent host

`apps/controller/src/gateway/native-admin.ts:nativeAdminTarget`

`deriveNativeAdminHost` hashes Installation ID, Namespace ID, and Agent ID into an opaque label under the configured domain. `nativeAdminTarget` replaces the hostname of `publicOrigin` with that derived Agent host and returns `/` as the browser entrypoint for that Agent.

The host hash is not reversible. Native-host admission resolves the host back to an exact Agent by checking existing Installation, Namespace, and Agent state for the derived host. Unknown hosts, wrong suffixes, deleted Agents, and non-unique matches fail closed. This flow does not add a persistent host registry.

`nativeAdminGatewayHttpBase` accepts only a `wss:` endpoint without username, password, query, or hash, then converts it to `https:` while preserving authority and the Agent base path. This keeps workspace-file WSS behavior unchanged while defining the private HTTP base needed by the native UI bridge.

### 5. Shared cookie admits the Agent host

`apps/controller/src/auth/index.ts:createControllerAuth`

When native admin is enabled, startup passes `nativeAdmin.sharedCookieDomain` to
Better Auth as `OCC_AUTH_COOKIE_DOMAIN`, and Better Auth emits the ordinary OCE
session cookie at that configured shared cookie parent domain. The controller
validates that the console host and Agent host suffix fit that parent on
DNS-label boundaries and rejects public suffixes, malformed domains, or values
outside the parent. It does not infer a broader parent domain from the console
or Agent hostname. When native admin is disabled, leftover shared-cookie-domain
configuration is ignored and the console keeps the legacy host-only
`openclaw_occ` cookie prefix and scope.

A domain-scoped session cookie cannot use a host-only `__Host-` prefix. The controller keeps one canonical cookie name and scope so the browser does not choose between duplicate host-only and domain cookies during migration.

### 6. OCC intercepts native-host HTTP requests

`apps/controller/src/http/native-admin.ts:interceptNativeAdminHttp`

The `onRequest` hook calls `interceptNativeAdminHttp` before normal OCC route
handling. For hosts beneath the configured native admin domain, that early
intercept prevents the Agent origin from exposing console or controller API
routes. For Agent hosts, OCC authenticates the shared session cookie, resolves
the selected IAM identity, resolves the requested host to the exact Agent,
revalidates exact Agent `administer`, selects the current active revision, and
validates native configuration support before proxying. Attributable IAM denials
during proxy admission preserve an IAM denial audit for the human session and
exact Agent instead of becoming unaudited dependency failures.

Admission reads Better Auth once and returns the verified session metadata with
the caller identity. The status and proxy paths reuse that result to check
expiry and attribute access, without a second session lookup. Each WebSocket
lease runs admission again against current session state.

`apps/controller/src/gateway/native-admin-proxy.ts:proxyNativeAdminHttp`

The HTTP proxy canonicalizes a bounded path suffix, rejects missing or nonmatching `Origin` on non-GET/HEAD requests, strips browser cookies, service keys, forwarding headers, native identity, native scopes, and upstream `Set-Cookie`, rejects service-worker script requests, rewrites same-upstream `Location` values to the Agent origin, appends `worker-src 'none'` to proxied Content Security Policy, and forwards to the private `https:` gateway base. A `502` from the gateway's user-photo route (`/api/users/<id>/avatar`) becomes an empty `404`: it means OpenClaw could not fetch a Gravatar fallback, which a dedicated Gateway without internet egress never can, and the UI shows initials for both. The native gateway never receives the OCE session cookie.

### 7. OCC proxies native WebSocket upgrades

`apps/controller/src/http/native-admin.ts:handleNativeAdminUpgrade`

The API process intercepts `upgrade` before Fastify routing. It accepts only derived Agent hosts, reuses the shared-session admission path, captures the current active revision at connection admission, and builds the same private proxy transport context. Active sockets are tracked so `preClose` destroys them during API shutdown.

`apps/controller/src/gateway/native-admin-proxy.ts:proxyNativeAdminWebSocket`

The WebSocket proxy requires a non-null exact Agent `Origin`, forwards a sanitized upgrade request to the private `https:` gateway base, and only connects the browser after the upstream returns `101`. `onConnect` appends `openclaw.agents.native_admin.websocket.connect`; `onClose` appends `openclaw.agents.native_admin.websocket.close`. The `websocket.connect` audit record includes `connectionId`; the matching `websocket.close` audit record reuses that `connectionId` and includes `closeReason`, whose value distinguishes lifecycle, revocation, dependency, client, upstream, and shutdown paths. A timer rechecks the shared-session admission path every 25 seconds, with each lease bounded to 5 seconds. Failed, denied, timed-out, or revision-changed lease checks close both sockets and preserve the IAM denial audit when authorization is the reason. An authorized reconnect uses the current active revision. Native chat does not renew the OCE session.

### 8. Runtime renders HTML on a separate origin

`apps/controller/src/drivers/compute/kubernetes/index.ts:gatewaySandboxConfiguration`
`apps/controller/src/drivers/compute/kubernetes/index.ts:reconcileGatewayRoute`

With operator sandbox routing configured, preparation and activation render the
Agent's stable preview origin and adjacent sandbox port in its native document.
The worker reconciles its GET/HEAD route, public-shell SecurityPolicy and
Agent-scoped backend ingress policy under the serving revision. A separate Helm listener admits only configured ingress
peers, and the backend targets the sandbox port instead of the admin port.
The preview domain is outside the shared session cookie scope. Native UI still
reads private file content through its authenticated connection, then delivers
it to the runtime's isolated iframe. The sandbox listener serves public shell
and registered renderer assets; runtime CSP and nested frame isolation remain
responsible for executing generated content. See the [routing contract](../reference/gateway-routing.md#public-preview-routing).

For opted-in Kubernetes gateways, `KubernetesComputeDriver.privateStateInitContainer`
copies the admitted configuration from `/etc/openclaw-managed/openclaw.json` to
`/runtime-state/home/.openclaw/openclaw.json` on the init container's writable
volume. The gateway mounts that same home subdirectory at `/home/node`, so native
edits remain Pod-local and the next Pod starts from the admitted configuration.
The init container cannot write through the gateway's later mount path.

## Debugging and Verification

- `AGENT_NATIVE_ADMIN_INVALID` at startup points to invalid native admin enablement, missing public origin, invalid Agent domain, invalid shared cookie parent domain, invalid Better Auth cookie scope, or insufficient auth secret material.
- `disabled` means the Installation has not enabled the feature.
- `stopped` means the exact Agent is not desired running. Its response has no origin or revision after stop reconciliation clears the active revision, or before the first deployment.
- `unavailable` means active revision selection raised `NoActiveAgentRevisionError` (a desired-running Agent without an active revision) before OCC could derive the Agent target, or a newer revision exists whose Compute Driver `requiresStoppedPredecessors` (Kubernetes dedicated). That worker stops the active revision's workload before the newer one starts, so nothing serves until the newer revision activates; if it fails, the old revision stays recorded as active with no workload.
- `unsupported` means the selected Compute Driver, gateway endpoint, or native trusted-proxy/control UI configuration cannot support the active revision.
- Wrong or unknown Agent hosts fail before gateway proxying. Check the derived host calculation, Agent lifecycle state, and `agentNativeAdmin.domain`.
- Browser requests should not contain native-admin exchange, bootstrap, callback, launch-code, state, verifier, or Agent-specific session-cookie traffic.
- The native gateway should never observe the OCE session cookie; inspect sanitized proxy inputs when testing this boundary.
- IAM denial audits should appear for attributable denied status checks, proxy admission, and WebSocket lease renewal, with the human principal and exact Agent target preserved.
- `openclaw.agents.native_admin.websocket.connect` audits should include `connectionId`; matching `openclaw.agents.native_admin.websocket.close` audits should reuse `connectionId` and include `closeReason` with one of the expected categories: lifecycle, revocation, dependency, client, upstream, or shutdown.
- Service-worker registration failure is expected: the HTTP proxy rejects `Service-Worker: script` requests and adds `worker-src 'none'` to proxied responses.
- Browser tests cover panel visibility, warning copy, available status, and opening the returned URL. Integration proof should cover shared-cookie admission, denied service API keys, unknown host denial, proxied asset loads, WebSocket reconnect, authorization lease renewal (the PostgreSQL suite shortens the 25-second interval), revision-change closure and reconnect, and a reversible native admin edit on a disposable Agent.
- The flow is source-backed only here. Live runtime proof remains separate.

## Related docs

- [Agent native admin UI](../reference/agent-native-admin.md)
- [Platform console](../reference/console.md#open-the-native-admin-ui)
- [Gateway routing with Envoy](../reference/gateway-routing.md#native-admin-ui-routing)
- [Deploy native admin UI access](../guides/deploy/native-admin.md)
- [Workspace files flow](workspace-files.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-04 07:30: Only a missing active revision reports `unavailable`; IAM and other dependency outages return `503`, and close or refuse proxied requests as `dependency_failure`. (bh11-native-status)

- 2026-10-03 12:00: Reread availability once when deployment polling observes a new active revision or runtime state.

- 2026-10-01 17:20: Move native-admin admission, availability, sockets and shutdown ownership into the HTTP module. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-10-01 21:00: Reported `unavailable` while a newer exclusive revision replaces the active workload, including after that replacement fails.
- 2026-10-01 18:20: Answered unreachable user-photo fallbacks with `404` instead of `502`.

- 2026-09-30 19:00: Remembered a denied availability read per tab and session owner so reloads do not add an audited denial per view.

- 2026-09-29 21:35: Corrected native configuration initialization to write through the init volume mount. (89a4ccd7-3974-43c6-b08a-be02269a8d01 - cc96e34f33868555d4a89cb44bc022859d76c815)

- 2026-09-28 16:20: Added the accompanying optional sandbox routing implementation and separate-origin preview flow. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 33a2528163d5bbff311bb685345e60aadb24a70a)

- 2026-09-21 21:20: Distinguished authorized stopped Agents with no active revision from unavailable running deployments. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-21 21:17: Clarified the console's active-revision dependency message and its independence from the viewed configuration snapshot. (01a0c750-0c10-7492-97eb-f4124cded820 - f3dbdd41c8f3b49573d1353a4b06ce510ee43a56)
- 2026-09-20 09:45: Reused session metadata from admission and replaced launch bookkeeping with a direct browser link; socket lifecycle state remains owned by the proxy. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - bbb864aadc709dcc4f7b95d4b42b74823c18363a)
- 2026-09-20 08:53: Replaced the native-admin exchange flow with shared OCE session cookie admission, host-to-Agent resolution, credential stripping, and current-revision reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Updated the flow for the shared availability resolver names and service-worker blocking behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Added the `DependencyUnavailableError` to `unavailable` status branch and clarified derived-origin status payloads. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the source-backed native admin UI availability, launch, cookie redemption, HTTP proxy, and WebSocket proxy flow. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
