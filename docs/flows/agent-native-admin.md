---
created: "2026-09-19"
updated: "2026-10-15"
last_updated_session: "authoring-run/f64d2a52-ee3c-4e67-9d22-30f2e4d89aa3"
---

# Agent Native Admin UI Flow

## Overview

OCC checks a Console user's exact Agent `use` grant and runtime assignment,
then returns the active Gateway's stable per-Agent URL. That host authenticates
the shared OCE session cookie, resolves the exact Agent, rechecks authorization,
and proxies native HTTP and WebSocket traffic.

## Entry Points

- Trigger: Console opens an Agent URL, or `scripts/first-agent.mjs --control-ui` creates a compatible local Compose/OpenShell Agent.
- Source: `scripts/first-agent.mjs:nativeConfiguration`
- Source: `apps/controller/src/console/agents/runtime-access.mjs:renderRuntimeAccess`
- Source: `apps/controller/src/http/native-admin.ts:resolveNativeAdminAvailability`
- Assumptions: The API has a valid controller session, `agentNativeAdmin.enabled` is true, `agentNativeAdmin.domain` and `agentNativeAdmin.sharedCookieDomain` are configured, Better Auth emits the shared session cookie at that parent domain, and private Agent gateway routing can return a `ComputeDriver.getAgentRuntimeAccess` value.

## Flow

```mermaid
graph TD
  L["Local first-Agent selects Control UI"] --> L2["Create Agent, derive exact origin,<br/>and save Configuration generation 2"]
  L2 --> A
  A["Console opens Agent detail tab"] --> B["GET exact Agent native-admin status"]
  B --> C["Resolve OCC session and human principal"]
  C --> F{"Installation enabled?"}
  F -->|no| D["Require exact Agent administer and existence"]
  D --> G["Return disabled"]
  F -->|yes| H["Require exact Agent use and runtime assignment"]
  H --> I{"Active revision selection available?"}
  I -->|no| J{"Authorized stopped Agent without an active revision?"}
  J -->|yes| X["Return stopped without an origin"]
  J -->|no| Y["Return unavailable"]
  I -->|yes| K{"Agent desired running?"}
  K -->|no| L["Return stopped with derived origin"]
  K -->|yes| R2{"Newer revision replacing it on an exclusive Compute Driver?"}
  R2 -->|yes| Y
  R2 -->|no| M{"Native config supported?"}
  M -->|no| N["Return unsupported with derived origin"]
  M -->|yes| CO{"Compute ID and implementation match active revision?"}
  CO -->|no| CF["Return 503 dependency error"]
  CO -->|yes| EP{"Private gateway endpoint supported?"}
  EP -->|no| N
  EP -->|yes| O["Return available Agent URL"]
  O --> P["Browser opens derived Agent host with shared OCE session cookie"]
  P -->|HTTP| Q["OCC resolves host to exact Agent using platform state"]
  P -->|WebSocket| V["OCC guards client socket during admission"]
  V --> Q
  Q --> R{"Shared session and exact Agent use and assigned role still valid?"}
  R -->|no| S["Reject request; audit exact-Agent authorization denial"]
  R -->|yes| T["Resolve current revision, native config and Compute owner"]
  T -->|owner mismatch| RF["Refuse before key lookup or gateway connection"]
  T -->|matching owner| U["OCC strips browser credentials and proxies HTTP to private gateway"]
  T -->|WebSocket client reset| VB["Stop before gateway connection"]
  T -->|WebSocket client connected with matching owner and exact Origin| VC["Proxy 101 upgrade with revision lease"]
  VC --> AD{"Gateway has configured roles?"}
  AD -->|yes| AB["Native Gateway verifies assignment and commits profile role"]
  AD -->|no, explicit administrator| AC
  AB --> AC["Native policy authorizes subsequent commands"]
  U -->|HTML preview with sandbox routing enabled| W["Browser loads public shell from separate preview origin"]
  W --> Z["Envoy sandbox listener routes to Agent sandbox port"]
  Z --> AA["Native UI delivers HTML into runtime-isolated iframe"]
```

## Execution Trace

### 0. Local first-Agent opts into native admin

`scripts/first-agent.mjs:loadLocalInstallation`
`scripts/first-agent.mjs:nativeConfiguration`
`scripts/first-agent.mjs:ensureManagedConfiguration`

The option requires launcher-owned Compose/OpenShell browser state. Because OCC
assigns the Agent ID, the helper saves disabled Configuration generation 1,
creates the Agent, derives its origin, and patches generation 2 before
deployment. Generation 2 enables `controlUi`, pins its origins, and grants the
`occ-workspace-files` trusted-proxy identity `operator.admin` with device
auto-approval. An existing helper-owned name cannot change this selection.

### 1. Console renders native admin availability

`apps/controller/src/console/agents/runtime-access.mjs:renderRuntimeAccess`

Agent detail requests `${path}/native-admin`. Disabled responses and ordinary-user denials hide the panel. Denied Installation administrators see self-assignment guidance and **Refresh access**. Other states show feedback; only `available` exposes **Open OpenClaw**, opening with `noopener noreferrer`.

Tab `sessionStorage` caches audited `403` paths per session owner. **Refresh access** forgets this path and retries; logout, sign-in or a new tab asks afresh. The [page cache](platform-console.md#2-resolve-the-session-before-private-reads) owns Back revalidation. Polling or **Refresh deployment** refreshes changed `activeRevisionId` or `desiredRuntimeState`; a pending read queues one retry. Native edits do not update OCE Configuration.

### 2. OCC protects the availability route

`apps/controller/src/http/native-admin.ts:nativeAdminStatusOperation`

`createNativeAdminAccess` owns the host interceptor, upgrade listener and socket shutdown hook. It reads the current controller through a getter so an app created before bootstrap uses the initialized controller on later requests. Shared route admission remains in `apps/controller/src/index.ts`.

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` admits a human session through the ordinary `admit` and `resolveIdentity` middleware. When enabled, it requires exact Agent `use` and a runtime assignment; `read` or `operate` alone cannot admit the caller. When disabled, it requires exact Agent `administer` and existence before returning `disabled`, without requiring a runtime assignment.

### 3. Shared availability resolver checks feature and active revision state

`apps/controller/src/http/native-admin.ts:getNativeAdminStatus`
`apps/controller/src/http/native-admin.ts:resolveNativeAdminAvailability`
`packages/occ/src/index.ts:getUsableActiveAgentRevision`

Enabled access requires a public origin and native domain.
`getUsableActiveAgentRevision` selects the active revision and successor. A
stopped Agent without an active revision raises `ResourceStateConflictError`
and returns `stopped`, including before first deployment.
`NoActiveAgentRevisionError` returns `unavailable` while a desired-running Agent
awaits activation. Other dependency failures return `503`; authorization denial
returns `403` with human IAM audit evidence. The panel reports the active revision.

A newer successor on a Compute Driver requiring stopped predecessors also produces `unavailable`: the worker removes the old workload before starting its replacement. A failed replacement leaves the old revision recorded as active without a serving workload. Both status and proxy admission check this boundary.

OCC derives the target from the active revision; desired state other than
`running` returns `stopped`. Compute qualifies trusted-proxy identity, role
headers and device approval covering the selected role.
`nativeAdminConfigurationSupported` checks `controlUi.enabled`, exact
`allowedOrigins` and host-header/device-auth settings. Rejection returns
`unsupported` with the target and a reason: UI configuration, missing role,
insufficient device approval or unsupported transport. Missing endpoints and
unclean private `wss:` URLs also return `unsupported`. Only `available` carries
private `gatewayBase`, omitted from browser responses.
Then the selected Compute Driver ID and implementation must match `revision.compute`. A mismatch returns `503 DEPENDENCY_UNAVAILABLE` before endpoint, key or transport lookup. Selection changes do not migrate existing revisions.

### 4. OCC derives the isolated Agent host

`apps/controller/src/gateway/native-admin.ts:nativeAdminTarget`
`apps/controller/src/gateway/native-admin-host.mjs:deriveNativeAdminHost`

`deriveNativeAdminHost` hashes Installation, Namespace and Agent IDs under the configured domain. `nativeAdminTarget` substitutes that host in `publicOrigin` and returns `/`. The first-Agent script imports the Node-only helper without workspace dependencies.

Host admission checks existing platform state without a registry. Unknown hosts, wrong suffixes, deleted Agents and non-unique matches deny access. `nativeAdminGatewayHttpBase` converts a clean `wss:` endpoint to `https:` preserving authority and base path; userinfo, query and hash are refused. Workspace WSS routing is unchanged.

### 5. Shared cookie admits the Agent host

`apps/controller/src/auth/index.ts:createControllerAuth`

Startup passes `nativeAdmin.sharedCookieDomain` to Better Auth as `OCC_AUTH_COOKIE_DOMAIN`. The session cookie uses that explicit parent; startup rejects public suffixes, malformed domains and hosts outside its DNS-label boundary. Disabled native access keeps the host-only `openclaw_occ` cookie and ignores leftover shared-domain configuration.

Shared-domain cookies cannot use a `__Host-` prefix. One canonical cookie name and scope avoids ambiguous session selection.

### 6. OCC intercepts native-host HTTP requests

`apps/controller/src/http/native-admin.ts:interceptNativeAdminHttp`

`onRequest` intercepts native Agent hosts before OCC routing, preventing those origins from exposing console/API routes. OCC authenticates the shared session, resolves the exact Agent and IAM principal, revalidates `use` and the assignment, then checks the active revision and native configuration. Denials retain attributable human IAM audit evidence.

Admission returns the verified identity and session once for expiry checks and attribution. Each WebSocket lease repeats admission and Compute-owner checks. A mismatch returns Agent-host HTTP `403`, destroys new WebSockets before key lookup or connection, and closes existing sockets through failed-lease handling. Earlier lifecycle and unsupported-configuration outcomes retain precedence.

`apps/controller/src/gateway/native-admin-proxy.ts:proxyNativeAdminHttp`

The proxy bounds paths to the Agent base, checks exact `Origin` for writes, strips browser credentials, forwarding/native authority headers and upstream `Set-Cookie`, and forwards to private HTTPS. It rewrites same-upstream redirects, refuses service-worker scripts and adds CSP `worker-src 'none'`. A user-photo `/api/users/<id>/avatar` upstream `502` becomes an empty `404`: the offline Gateway cannot fetch Gravatar, so the UI shows initials. The native Gateway never receives the OCE cookie.

### 7. OCC proxies native WebSocket upgrades

`apps/controller/src/http/native-admin.ts:handleNativeAdminUpgrade`

The API intercepts `upgrade` before Fastify routing, accepts only derived Agent
hosts and tracks sockets for `preClose` shutdown. It handles socket errors before
awaiting admission, preventing uncaught TCP-reset errors. Authorization denial
still audits after a reset. Allowed admission checks for client destruction
before and after resolving private transport, preventing upstream connections
for disconnected clients. Connected clients use the selected active revision.

`apps/controller/src/gateway/native-admin-proxy.ts:proxyNativeAdminWebSocket`

The proxy requires an exact, non-null Agent `Origin`, sanitizes the request and connects the browser only after upstream `101`. `onConnect` and `onClose` audit `websocket.connect` and `websocket.close` with a shared `connectionId`. Close reasons distinguish lifecycle, revocation, dependency, client, upstream and shutdown. Admission repeats every 25 seconds with a 5-second deadline. Denials retain human IAM audit evidence; failed, timed-out or changed-revision leases close both sockets. Authorized reconnects use the current revision. Native chat does not renew the OCE session.

### 8. Runtime commits the verified role before admission

`apps/controller/src/drivers/compute/kubernetes/runtime-access.ts:humanRuntimeAccess`
`deploy/runtime/openclaw-trusted-proxy-role.patch`

Kubernetes offers `platform-administrator` alongside configured roles. The migration converts effective human Agent `administer` grants into exact `use` assignments with Namespace entry Roles. Removal never restores old grants. Without configured roles, only explicit administrator assignments use the shared service profile; malformed roles deny access.

Configured roles use `/people/namespaces/<namespaceId>/agents/<agentId>`, `oce:<Principal ID>` and a policy digest. Preparation retains serving-revision route ownership through failed candidate retirement; a role-free replacement leaves it for predecessor retirement. Service traffic uses disjoint `/namespaces`. OCC replaces browser authority headers.

The Gateway verifies trusted-proxy authentication, managed identity scope and policy digest, refusing profiles with multiple managed identities. It commits the selected role before admission. HTTP retires prior authority with `401`; new requests use the committed role without OCC replay. OpenClaw enforces permissions; backend connections retain `oce-service`, and independently authenticated local owners retain access.

Operator WebSockets intersect requested scopes with the proxy ceiling using native semantics; non-operator connections retain exact matching. The lease closes changed assignments or descriptors within 30 seconds. New HTTP requests/upgrades resolve current policy; profiles update at reconnect.

### 9. Runtime renders HTML on a separate origin

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

- `AGENT_NATIVE_ADMIN_INVALID` at startup points to native admin enablement, the Agent domain, or a missing shared cookie domain. A bad shared cookie domain or public origin reports `AUTH_BASE_URL_INVALID`, short auth secret material `AUTH_SECRET_INVALID`, and a missing gateway API key path `GATEWAY_API_KEY_UNAVAILABLE`.
- `disabled` means the Installation has not enabled the feature.
- `stopped` means the exact Agent is not desired running. Its response has no origin or revision after stop reconciliation clears the active revision, or before the first deployment.
- `unavailable`: no active revision or an exclusive replacement is in progress. Check Deployment activity, including failed replacements, then refresh. Other dependency outages return `503`.
- `unsupported` means the selected Compute Driver, gateway endpoint, or native trusted-proxy/control UI configuration cannot support the active revision.
- Wrong/unknown hosts fail before proxying; check host derivation, lifecycle and `agentNativeAdmin.domain`.
- IAM denial audits should appear for attributable denied status checks, proxy admission, and WebSocket lease renewal, with the human principal and exact Agent target preserved.
- A TCP reset during WebSocket admission leaves the API running and preserves a later authorization-denial audit without opening an upstream connection.
- `openclaw.agents.native_admin.websocket.connect` audits should include `connectionId`; matching `openclaw.agents.native_admin.websocket.close` audits should reuse `connectionId` and include `closeReason` with one of the expected categories: lifecycle, revocation, dependency, client, upstream, or shutdown.
- Service-worker registration failure is expected: the HTTP proxy rejects `Service-Worker: script` requests and adds `worker-src 'none'` to proxied responses.
- Browser tests cover panel states and launch. Integration covers shared cookies, service-key/host denials, assets, WebSocket leases/reconnects and reversible native edits.

## Related docs

- [Agent native admin UI](../reference/agent-native-admin.md)
- [Platform console](../reference/console.md#open-the-native-admin-ui)
- [Gateway routing with Envoy](../reference/gateway-routing.md#native-admin-ui-routing)
- [Deploy native admin UI access](../guides/deploy/native-admin.md)
- [Workspace files flow](workspace-files.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-15 13:36: Preserve Compute ownership checks and shared hostname derivation with per-person runtime admission. (authoring-run/f64d2a52-ee3c-4e67-9d22-30f2e4d89aa3 - b0fdd771426669636fc97b59c651a383b5d64984)

- 2026-10-14 11:53: Extracted shared hostname derivation so the first-Agent script starts without installed workspace dependencies. (authoring-run/fba0a85c-ba37-4764-871e-9fdf80ee1083 - 5511d28d1)

- 2026-10-14 00:10: Distinguished HTTP refusal from WebSocket socket closure without a response. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-13 23:57: Documented the active revision Compute-owner comparison and status/proxy refusal before gateway effects. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)
- 2026-10-08 14:03: Return disabled status without a runtime assignment; keep administrator assignment guidance visible and retry remembered denial on explicit Refresh. (authoring-run/3bee1cb2-aeb2-4700-8ff4-3da9ac7f098c - 346b1fe14)

- 2026-10-08 03:40: Documented client reset handling during native-admin WebSocket admission and the denial-audit and upstream-connection ordering at inspected revision `002d0f796`. (authoring-run/1e4aaf85-2e38-434d-99c0-75881fe9991c - 002d0f79639a9c814eb1fa2799530516a6c90cde)
- 2026-10-05 17:34: Trace Namespace-scoped entry Roles and consistent human-route selection for runtime assignments. (authoring-run/593fb00e-b94d-46a0-a339-f3a8973764cb - aecffb24a16b5252c55ddf47bed2c66e622f1813)

- 2026-10-05: Preserve explicit administrator entry during upgrade explain access configuration failures, and retain serving-route ownership during preparation. (authoring-run/fabe27b6-d360-4a29-8a8c-17547858f84a - 379dc56084c92d7847849f2b3f96ddc0eccc17d8)

- 2026-10-06 12:00: Traced the optional first-Agent Configuration generation that derives and allows the exact local native-admin origin before deployment. (authoring-run/0e6b1c8a-1723-4b20-ae51-08fa9457204a - 99641a7ab)

- 2026-10-04 07:30: Only a missing active revision reports `unavailable`; IAM and other dependency outages return `503`, and close or refuse proxied requests as `dependency_failure`. (bh11-native-status)

- 2026-10-03 08:54: Preserve access refresh, visible read failures, service-key feedback and cached pages after optional access denial. (authoring-run/59d7541c-66d2-414c-8139-174fca84fe33 - b6f9185159f14399905bf495b3cdef3ce2d14e30)

- 2026-10-02 14:32: Trace per-person roles, configured managed identities, disjoint routing, verified admission, scope intersection and revocation. (authoring-run/32e6f4fe-d1a7-4d1a-96f4-282e75750412 - 3b2369155e55b0e9bed49de9e46d68a958dc5278)
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
