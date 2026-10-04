# Agent native admin UI

Agent OpenClaw access lets an explicitly assigned person open a deployed Gateway with their own native profile. OCE decides who may enter and which configured OpenClaw role they receive. OpenClaw defines and enforces that role's permissions; each Agent's files, plugins and provider accounts remain shared.

The feature is disabled by default. When enabled, the console shows **OpenClaw** on the Agent detail tabs only for callers with exact Agent `use` permission and a direct person/Agent `runtimeRole` assignment. Opening the Agent host uses the operator's ordinary OCE console session cookie, resolves the exact Agent represented by that host, then serves native HTTP and WebSocket traffic through OCC.

## Who can open it

Native admin UI is the only Agent chat surface in the console, and it is for exact Agent `administer` holders with a human session (see [Authorization and availability](#authorization-and-availability)). Other people message the Agent through a channel its Configuration sets up, such as [Slack](../guides/integrations/slack.md), or ask someone who can edit that Configuration to let them in. An operator with cluster access can check a real response with [model verification](../guides/operate/model-verification.md) or the [OpenClaw TUI](../guides/deploy/production-tui.md).

Native admin UI is unavailable under GitHub, Google, or OIDC sign-in: startup rejects enablement (`<Provider> sign-in does not support native administration.`). That profile issues a host-only `__Host-openclaw_occ.session_token` session cookie on HTTPS, which cannot carry the `Domain` attribute that lets Agent hosts read the [shared session](authentication.md#native-admin-shared-sessions).

## Requirements

- `agentNativeAdmin.enabled: true` in Helm, which sets `OCC_AGENT_NATIVE_ADMIN_ENABLED=true` on the API.
- `agentNativeAdmin.domain` set to the Agent host suffix, such as `agents.oce.example.com`, without scheme, wildcard, port, or path. Helm passes it as `OCC_AGENT_NATIVE_ADMIN_DOMAIN`. Use a previously unused DNS suffix for the first pilot rollout; the proxy blocks new service-worker registration but does not evict service workers that a prior experiment registered on the same origin.
- `agentNativeAdmin.sharedCookieDomain` set to the explicit shared OCE session cookie parent domain, such as `oce.example.com`. Helm passes it as `OCC_AUTH_COOKIE_DOMAIN` when `agentNativeAdmin.enabled` is true. The console host and Agent host suffix must both be inside this parent on DNS-label boundaries. Public suffixes, malformed domains, and DNS-label boundary violations fail closed. The Agent suffix may equal the cookie domain; OCC excludes its configured Console hostname from native proxy routing.
- `gatewayRouting.enabled: true`. Helm rejects native admin enablement without private gateway routing because the API process must reach each Agent gateway through the private route.
- `OCC_AUTH_BASE_URL` set to the public OCC origin that serves the console, for example `https://console.oce.example.com`.
- Better Auth cookie configuration using the shared cookie parent domain while preserving `Secure`, `HttpOnly`, appropriate `SameSite`, CSRF, and trusted-origin protections. A domain-scoped cookie cannot use a host-only `__Host-` prefix. The shared-domain session uses the `openclaw_occ_shared` cookie prefix and clears prior host-only `openclaw_occ` and `openclaw_occ_shared` session-cookie names during sign-in/sign-out migration. When native admin is disabled, OCC ignores leftover shared-cookie-domain configuration and keeps the legacy host-only `openclaw_occ` session cookie scope.
- Private Agent gateway routing configured through [Gateway routing with Envoy](gateway-routing.md).
- The Agent must be running, have an active revision, and provide the Compute Driver's human-access descriptor for the selected role and active revision.
- The runtime must include the verified proxy-role admission bridge from the [runtime recipe](../../deploy/runtime/README.md). An unpatched runtime rejects its configuration. Configure `gateway.roles` with a default and named definitions, and deploy them before assigning access. Role definitions must use canonical native agent IDs and de-duplicated scope/agent arrays; any normalization mismatch fails admission through the policy digest check.
- The native Agent configuration must keep the trusted-proxy `occ-workspace-files` identity with `operator.admin`, enable native `controlUi`, allow the derived Agent origin, and enable trusted-proxy device auto-approval with every scope used by the selected role. The support check rejects token auth, disabled device auth, and host-header origin fallback.

## Authorization and availability

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` is the console-facing availability check. It is a protected OCC API route with a human session, exact Agent `use` authorization with one explicit runtime assignment, and exact Agent existence. OCC verifies that authorization boundary before returning any feature status, including `disabled`; Agent `read`, Agent `operate`, native device credentials, native tokens, service keys for unrelated principals, and possession of a derived Agent host do not grant this API route.

The response reports:

| Status        | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `disabled`    | The Installation has not enabled native admin UI access.                                                       |
| `stopped`     | The Agent is not in desired running state.                                                                     |
| `unsupported` | The selected Compute Driver, active revision, or native configuration does not support native admin UI access. |
| `unavailable` | No revision is serving yet: the Agent has no active revision, or a newer revision is replacing it.             |
| `available`   | The caller may open the returned `url` for the current active revision.                                        |

A stopped Agent with no active revision returns only `status: "stopped"`, including before its first deployment and after stop reconciliation clears its active revision. A stopped Agent with a selectable active revision still includes its target fields. If a desired-running Agent has no active revision, OCC returns `unavailable` in the success envelope so the console can show a retryable state. A dependency outage, the IAM Driver included, returns `503 DEPENDENCY_UNAVAILABLE`. Malformed requests, denied IAM access and missing sessions also use the normal protected-route error envelope.

## Agent host identity

OCC derives a stable browser host from the Installation ID, Namespace ID, Agent ID, and configured `agentNativeAdmin.domain`. The hostname is opaque and must not be reused for another Agent identity. The derived host is separate from the console origin, which gives each Agent UI its own browser origin.

An Agent URL uses the derived host directly:

```text
https://agent-<opaque-hash>.<agentNativeAdmin.domain>/
```

The host hash is not reversible, so native-host admission resolves the host to the exact Agent using existing platform state. Unknown hosts, wrong suffixes, deleted Agents, and hosts that do not map to exactly one Agent fail closed. This lookup does not require a persistent registry or cache.

The Kubernetes human route uses a separate `/people` path:

```text
wss://<private-host>/people/namespaces/<namespaceId>/agents/<agentId>
```

For browser proxying, OCC maps that value to the same authority and Agent path over `https:`. Workspace-file access continues to use the original `wss:` endpoint. Native admin HTTP requests and WebSocket upgrades both pass through the OCC API process before reaching the private gateway. The HTTP proxy blocks native service-worker script requests and appends `worker-src 'none'` to proxied Content Security Policy so Agent content cannot register a browser service worker on the isolated Agent origin.

## Shared session boundary

The console and Agent hosts share the ordinary OCE session cookie through the configured cookie parent domain. That expands the cookie trust boundary: every host under the console and Agent subdomains that can receive the cookie must be a trusted OCE ingress endpoint. Public Agent hosts route to OCC, not Envoy or tenant gateway Services. OCC strips browser cookies, `Authorization`, API keys, forwarded identity, scope headers, and native `Set-Cookie` before forwarding upstream, so the native gateway never receives the OCE session cookie.

Native chat or other activity in the Agent tab does not renew the console session. Session expiry, logout, session revocation, permission removal, role changes, pilot disablement, Agent unavailability, or a revision change closes active WebSockets during the authorization lease. Reconnecting uses the same stable Agent host and the current active revision when the shared OCE session, exact Agent permission, and native configuration remain valid.

## Native authority and drift

The native Gateway sees `oce:<Principal ID>`, a stable account identifier verified against the OCE session, and the server-selected role. It finds or creates that native profile and commits the named role before admitting its connection. The proxy also supplies a SHA-256 digest of the role definition; missing roles or changed native definitions reject admission. Browser-supplied identity, role, policy-digest and scope headers are discarded.

For native authenticated HTTP, creating a profile or changing its role retires the authority captured before acquisition. That request returns `401` before the handler runs; a separate request uses the committed role. OCC never automatically replays an HTTP write. WebSocket admission acquires authority after role publication.

Role definitions live in the admitted `gateway.roles` Configuration. The person-to-role mapping lives in the exact Agent's OCE AccessBinding `runtimeRole` field. A native role edit does not change that assignment; the next proxied admission reapplies the OCE role. Profiles linked to different OCE people cannot admit them as one person. `GET /namespaces/:namespaceId/agents/:agentId/runtime-roles` lists assignable names and permission summaries from the active revision. An Installation administrator changes an assignment with `PATCH /namespaces/:namespaceId/iam/access-bindings/:bindingId/runtime-role`; deleting that binding revokes entry. There is at most one assignment per person/Agent. Groups, service identities, broad bindings and Installation administration do not select a native role.

The Kubernetes Driver configures `gateway.auth.trustedProxy.managedIdentityPrefixes: ["oce:"]` and `managedIdentities: ["occ-workspace-files"]`. The runtime bridge accepts role assignments only for identities in this declared scope and rejects profiles linked to more than one managed identity. Selectors must be nonempty, trimmed lowercase values; at least one prefix or exact identity is required when role headers are enabled. The Driver rejects conflicting selectors.

Kubernetes retains the separate `occ-workspace-files` identity with the reserved `oce-service` role for server operations. The role catalog excludes that reserved role. OCE core consumes opaque role names and Compute descriptors; native profile details stay in the runtime and Driver.

The bridge computes its policy digest as SHA-256 of the UTF-8 JSON role definition. It recursively sorts object keys with English locale comparison and preserves array order. The Driver and runtime use the same rules; the digest checks agreement with native policy, while verified proxy authentication establishes authority.

Native admin changes affect gateway-local state outside OCE Configurations and
immutable AgentRevisions. Manage durable configuration through OCE. In the
Kubernetes pilot, native configuration edits affect a Pod-local copy that resets
from the managed snapshot when the Pod is recreated or the Agent is redeployed.
See [Kubernetes managed native configuration](drivers/kubernetes-compute/storage-and-credentials.md#managed-native-configuration)
for the opt-in predicate, mounts, and copy lifecycle.

Redeployment does not imply a factory reset of native files, conversations,
device state, plugins, or other persistent gateway data.

## Failure behavior

- Helm rendering fails when `agentNativeAdmin.enabled` is true without `gatewayRouting.enabled`.
- Startup fails with `AGENT_NATIVE_ADMIN_INVALID` when enablement, Agent domain, shared cookie domain, public origin, Better Auth cookie scope, or cookie-secret requirements are invalid.
- Availability returns `stopped` for a stopped Agent with no active revision; `unavailable` means a desired-running Agent has no active revision yet or a newer revision is replacing it. Dependency outages return `503`. Gateway routing, unsupported native configuration, or a selected Compute Driver without a qualified human-access descriptor or clean endpoint returns `unsupported` after OCC has an active revision and derived Agent origin.
- The console hides the panel for disabled and denied states, shows operator-readable stopped, unsupported, or unavailable messages, and opens the returned `url` in a new tab when available.
- Attributable IAM denials remain audit events for status checks, native-host proxy admission, and recurring WebSocket lease renewal. Those denial paths preserve the human IAM principal and exact Agent target instead of collapsing into unaudited dependency failures.
- Proxied HTTP and WebSocket requests strip browser credentials, service keys, forwarded headers, native identity/scope headers, and native `Set-Cookie` before responding through OCC. WebSocket upgrades require a non-null exact Agent `Origin`; accepted `101` connections audit `websocket.connect` with `connectionId` and `websocket.close` with the same `connectionId` plus `closeReason`, refresh authorization every 25 seconds, close when a lease check fails or takes more than 5 seconds, set `closeReason` to distinguish lifecycle, revocation, dependency, client, upstream, and shutdown paths, and are destroyed during API `preClose`.

## Related

- [Platform console](console.md#open-the-native-admin-ui)
- [Agents](agents.md#native-admin-ui)
- [Authentication](authentication.md#native-admin-shared-sessions)
- [Gateway routing with Envoy](gateway-routing.md#native-admin-ui-routing)
- [Deploy native admin UI access](../guides/deploy/native-admin.md)
- [Agent native admin UI flow](../flows/agent-native-admin.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-21 21:20: Documented status-only stopped results before deployment and after stop reconciliation. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-20 08:21: Linked Kubernetes configuration-copy details to the implementation reference after the Driver documentation refactor. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - f4e22e48)
- 2026-09-20 08:53: Replaced the temporary exchange launch description with the shared OCE session cookie model, cookie-domain trust boundary, host-to-Agent admission, and current-revision reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Documented gateway-routing Helm validation, service-worker domain setup, and the explicit native-admin writable-config predicate. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Documented the `unavailable` availability success state and separated it from protected-route error envelopes. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the current native admin UI reference for enablement, authorization, routing reuse, and source-confirmed launch status behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
