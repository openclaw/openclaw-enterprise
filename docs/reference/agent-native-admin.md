# Agent native admin UI

Agent native admin UI access lets an authorized operator open the selected Agent's native OpenClaw administration UI from the platform console. It is an explicit pilot capability for trusted operators. It exposes the stock native administrator surface for one Agent Gateway, subject to [Gateway managed mode](#gateway-managed-mode).

The feature is disabled by default. When enabled, the console shows **Native admin UI** on the Agent detail tabs only for callers with exact Agent `administer` permission. Opening the Agent host uses the operator's ordinary OCE console session cookie, resolves the exact Agent represented by that host, then serves native HTTP and WebSocket traffic through OCC.

## Who can open it

Native admin UI is the only Agent chat surface in the console, and it is for exact Agent `administer` holders with a human session (see [Authorization and availability](#authorization-and-availability)). Other people message the Agent through a channel its Configuration sets up, such as [Slack](../guides/integrations/slack.md), or ask someone who can edit that Configuration to let them in. An operator with cluster access can check a real response with [model verification](../guides/operate/model-verification.md) or the [OpenClaw TUI](../guides/deploy/production-tui.md).

Native admin UI is unavailable under GitHub, Google, or OIDC sign-in: startup rejects enablement (`<Provider> sign-in does not support native administration.`). That profile issues a host-only `__Host-openclaw_occ.session_token` session cookie on HTTPS, which cannot carry the `Domain` attribute that lets Agent hosts read the [shared session](authentication.md#native-admin-shared-sessions).

## Requirements

- `agentNativeAdmin.enabled: true` in Helm, which sets `OCC_AGENT_NATIVE_ADMIN_ENABLED=true` on the API.
- `agentNativeAdmin.domain` set to the Agent host suffix, such as `agents.oce.example.com`, without scheme, wildcard, port, or path. Helm passes it as `OCC_AGENT_NATIVE_ADMIN_DOMAIN`. Use a previously unused DNS suffix for the first pilot rollout; the proxy blocks new service-worker registration but does not evict service workers that a prior experiment registered on the same origin.
- `agentNativeAdmin.sharedCookieDomain` set to the explicit shared OCE session cookie parent domain, such as `oce.example.com`. Helm passes it as `OCC_AUTH_COOKIE_DOMAIN` when `agentNativeAdmin.enabled` is true. The console host and Agent host suffix must both be inside this parent on DNS-label boundaries. Public suffixes, malformed domains, and DNS-label boundary violations fail closed. Helm has no public suffix list, so it renders a suffix such as `co.uk` or `github.io`; the installation profile renderer refuses it, and so does API startup (`AUTH_BASE_URL_INVALID`). The Agent suffix may equal the cookie domain; OCC excludes its configured Console hostname from native proxy routing.
- `gatewayRouting.enabled: true`. Helm rejects native admin enablement without private gateway routing because the API process must reach each Agent gateway through the private route.
- `OCC_AUTH_BASE_URL` set to the public OCC origin that serves the console, for example `https://console.oce.example.com`.
- Better Auth cookie configuration using the shared cookie parent domain while preserving `Secure`, `HttpOnly`, appropriate `SameSite`, CSRF, and trusted-origin protections. A domain-scoped cookie cannot use a host-only `__Host-` prefix. The shared-domain session uses the `openclaw_occ_shared` cookie prefix and clears prior host-only `openclaw_occ` and `openclaw_occ_shared` session-cookie names during sign-in/sign-out migration. When native admin is disabled, OCC ignores leftover shared-cookie-domain configuration and keeps the legacy host-only `openclaw_occ` session cookie scope.
- Private Agent gateway routing configured through [Gateway routing with Envoy](gateway-routing.md).
- The Agent must be running with a selected version owned by the selected Compute Driver: both Driver ID and implementation must match the version. Its `ComputeDriver.getGatewayEndpoint` value must map from private `wss:` to private `https:`.
- The native Agent configuration must keep the trusted-proxy `occ-workspace-files` identity with `operator.admin`, enable native `controlUi`, allow the derived Agent origin, and enable trusted-proxy device auto-approval. The machine identity grant supplies admin authority; device auto-approval can stay limited to read/write. The support check rejects token auth, disabled device auth, and host-header origin fallback.

The local Compose-control-plane profile enables this capability only when both
Kubernetes Compute and OpenShell are selected. Its development proxy terminates
HTTPS on host loopback for the installation's console and wildcard Agent hosts;
the private Envoy route in k3d still carries OCC-to-gateway traffic. The
first-Agent helper's `--control-ui` option supplies the exact per-Agent native
configuration. Other Compose profiles do not expose this browser endpoint.

## Authorization and availability

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` is the console-facing availability check. It is a protected OCC API route with a human session, exact Agent `administer` authorization, and exact Agent existence. OCC verifies that authorization boundary before returning any feature status, including `disabled`; Agent `read`, Agent `operate`, native device credentials, native tokens, service keys for unrelated principals, and possession of a derived Agent host do not grant this API route.

The response reports:

| Status        | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `disabled`    | The Installation has not enabled native admin UI access.                                                        |
| `stopped`     | The Agent is not in desired running state.                                                                      |
| `unsupported` | The selected Compute Driver, selected version, or native configuration does not support native admin UI access. |
| `unavailable` | No version is serving yet: the Agent has no selected version, or a newer version is replacing it.               |
| `available`   | The caller may open the returned `url` for the selected version.                                                |

A stopped Agent with no selected version returns only `status: "stopped"`, including before its first deployment and after stop reconciliation clears its selected version. A stopped Agent with a version that OCC can select still includes its target fields. If a desired-running Agent has no selected version, OCC returns `unavailable` in the success envelope so the console can show a retryable state. A dependency outage, the IAM Driver included, returns `503 DEPENDENCY_UNAVAILABLE`. Malformed requests, denied IAM access and missing sessions also use the normal protected-route error envelope.

Changing the selected Compute Driver does not migrate existing versions. After
lifecycle and native-configuration checks, OCC compares the selected Driver's ID
and implementation with the selected version's recorded owner. A mismatch returns
`503 DEPENDENCY_UNAVAILABLE` from the availability API before endpoint resolution,
private gateway-key lookup or transport. Agent-host HTTP retains its existing
`403` refusal. WebSocket admission destroys the client socket without an HTTP
response, before gateway-key lookup or connection; a mismatch during a WebSocket
lease closes the connection through the existing failed-lease path. Matching ownership retains
normal access. Earlier stopped, replacing and unsupported-configuration outcomes
keep their precedence.

The mismatch is not transient, so refreshing does not clear it. Each API process
logs one `native_admin.compute_owner_mismatch` warning per version and selected
Driver, naming both Driver IDs and implementations. To restore access, select the
version's Compute Driver again, with the same ID and implementation.

When someone opens the Agent root `/` or a copied `/chat/main` link without a valid session, OCC sends a temporary `302` redirect to the configured console. This also works for links ending in a 32-character lowercase hexadecimal session segment. The redirect carries only the opaque key from the Agent host, in a URL fragment. It drops the chat session segment and query, sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and does not check whether the Agent exists.

The console checks the browser session and offers sign-in if needed. Its authenticated `GET /native-admin/return/<key>` operation then checks exact Agent `administer` access and returns the Namespace and Agent IDs even if the Agent is stopped. Unknown and unauthorized keys receive the same `404`. Recovery ends at Agent detail; opening native chat is a separate action. Only a user-activated, top-level HTML navigation qualifies for the redirect. Link previews, API requests, and WebSocket upgrades keep their ordinary refusal behavior. A signed-in authorization denial does not redirect and does not start sign-in.

When that signed-in person cannot administer the Agent, a user-activated top-level HTML navigation to `/` or `/chat/main` stays HTTP 403. The page does not name the Agent. Its only link is **Go to your Agents**, which points at `/console/agents` on the configured public console origin. The response sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. A JSON `Accept` header still receives the JSON `403`. WebSocket upgrades still close without that page.

In an already-open Gateway tab, the Control UI offers **Reconnect in browser** if a reconnect fails and its same-origin health request receives `401` or `403`. Following the link opens `/` on the current Agent host. The UI does not navigate automatically or carry forward the chat path or query. The response is a reason to check access, not proof that a session expired. OCC decides whether that navigation reaches sign-in or is refused.

## Agent host identity

OCC derives a stable browser host from the Installation ID, Namespace ID, Agent ID, and configured `agentNativeAdmin.domain`. The hostname is opaque and must not be reused for another Agent identity. The derived host is separate from the console origin, which gives each Agent UI its own browser origin.

An Agent URL uses the derived host directly:

```text
https://agent-<opaque-hash>.<agentNativeAdmin.domain>/
```

The host hash is not reversible, so native-host admission resolves the host to the exact Agent using existing platform state. Unknown hosts, wrong suffixes, deleted Agents, and hosts that do not map to exactly one Agent fail closed. This lookup does not require a persistent registry or cache.

The private upstream base remains the Compute Driver's existing gateway endpoint:

```text
wss://<private-host>/namespaces/<namespaceId>/agents/<agentId>
```

For browser proxying, OCC maps that value to the same authority and Agent path over `https:`. Workspace-file access continues to use the original `wss:` endpoint. Native admin HTTP requests and WebSocket upgrades both pass through the OCC API process before reaching the private gateway. The HTTP proxy blocks native service-worker script requests and appends `worker-src 'none'` to proxied Content Security Policy so Agent content cannot register a browser service worker on the isolated Agent origin.

## Shared session boundary

The console and Agent hosts share the ordinary OCE session cookie through the configured cookie parent domain. That expands the cookie trust boundary: every host under the console and Agent subdomains that can receive the cookie must be a trusted OCE ingress endpoint. Public Agent hosts route to OCC, not Envoy or tenant gateway Services. OCC strips browser cookies, `Authorization`, API keys, forwarded identity, scope headers, and native `Set-Cookie` before forwarding upstream, so the native gateway never receives the OCE session cookie.

Native chat or other activity in the Agent tab does not renew the console session. Session expiry, logout, session revocation, permission removal, pilot disablement, Agent unavailability, or a version change closes active WebSockets during the authorization lease. Reconnecting uses the same stable Agent host and the selected version when the shared OCE session, exact Agent permission, and native configuration remain valid.

## Gateway managed mode

Managed mode defaults on where the Compute Driver supports it. It prevents Gateway administrators from editing native
configuration, opening Gateway-local terminals, and running Gateway-hosted command
jobs. An Installation administrator can change the setting in OCE for the next
deployment. See [Gateway managed mode](agents/gateway-managed-mode.md) for runtime
requirements and behavior when managed mode is off.

## Native authority and drift

The native admin UI runs with the same shared native trusted-proxy identity used by workspace files: `occ-workspace-files` with `operator.admin`. OCC attributes availability, proxy admission, and socket closure checks to the human session and exact Agent IAM decision. The native gateway sees the shared service identity, not a per-human native account.

When Gateway managed mode is off, native admin changes affect gateway-local state
outside OCE Configurations and Agent revisions. To keep a setting across Pod
recreation or redeployment, save it in the OCE Configuration. In the Kubernetes pilot, native configuration edits
affect a Pod-local copy that resets from the managed snapshot when the Pod is
recreated or the Agent is redeployed.
See [Kubernetes managed native configuration](drivers/kubernetes-compute/storage-and-credentials.md#managed-native-configuration)
for mount selection and the copy lifecycle.

Do not change `gateway.bind`, `gateway.customBindHost`, or
`gateway.tailscale.mode` in that copy. OCE checks these listener settings in the
managed Configuration at deployment, not after a native edit. The edit
survives same-Pod restarts. With `loopback`, the Gateway stays Ready, because its
readiness check uses loopback, but refuses traffic to the Pod IP: the native
admin UI goes dark and cannot undo the edit. With Tailscale `serve` or `funnel`
and the rendered `lan` bind, native startup fails and the container restarts in
a loop. To
recover, delete the Pod or redeploy the Agent.

Redeployment does not imply a factory reset of native files, conversations,
device state, plugins, or other persistent gateway data.

## Failure behavior

- Helm rendering fails when `agentNativeAdmin.enabled` is true without `gatewayRouting.enabled`, or with an `auth.baseUrl` that is not HTTPS or whose host is outside `agentNativeAdmin.sharedCookieDomain`.
- Better Auth setup runs before the native admin checks below and reports its own codes instead: `AUTH_BASE_URL_INVALID` for a malformed or public-suffix shared cookie domain, one that does not contain the public origin's host, or a non-HTTPS public origin with that cookie domain set, and `AUTH_SECRET_INVALID` for an auth secret under 32 characters. A missing `OCC_GATEWAY_API_KEY_PATH` reports `GATEWAY_API_KEY_UNAVAILABLE`.
- Startup fails with `AGENT_NATIVE_ADMIN_INVALID` when enablement, Agent domain, shared cookie domain, public origin, Better Auth cookie scope, or cookie-secret requirements are invalid.
- Availability returns `stopped` for a stopped Agent with no selected version; `unavailable` means a desired-running Agent has no selected version yet or a newer version is replacing it. Dependency outages return `503`. Gateway routing, unsupported native configuration, or a selected Compute Driver without a clean endpoint returns `unsupported` after OCC has a selected version and derived Agent origin.
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

- 2026-10-14 01:20: Documented the Compute-owner mismatch warning and how to restore access. (fix-1287)

- 2026-10-14 00:10: Distinguished HTTP refusal from WebSocket socket closure without a response. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-13 23:57: Documented native-admin refusal when selected Compute ownership differs from the selected version. (01a13783-3cb5-7f53-8668-b2e3affa2b12 - e64d04f12cb80eb438a4c442180e56c2a2adae38)

- 2026-10-10 09:20: Documented that native listener edits are not re-checked and how to recover. (docs-1014)

- 2026-10-06 12:00: Documented the Compose/OpenShell development endpoint and first-Agent Control UI option.

- 2026-09-21 21:20: Documented status-only stopped results before deployment and after stop reconciliation. (01a0c750-0c10-7492-97eb-f4124cded820 - 156dd67b7bd280a380d96b5c34a64e402fe3b96b)
- 2026-09-20 08:21: Linked Kubernetes configuration-copy details to the implementation reference after the Driver documentation refactor. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - f4e22e48)
- 2026-09-20 08:53: Replaced the temporary exchange launch description with the shared OCE session cookie model, cookie-domain trust boundary, host-to-Agent admission, and current-version reconnect behavior. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)
- 2026-09-19 22:27: Documented exact-Agent disabled-status gating, IAM denial audit preservation, and WebSocket `connectionId`/`closeReason` audit fields. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 9621ce4e)
- 2026-09-19 21:14: Documented gateway-routing Helm validation, service-worker domain setup, and the explicit native-admin writable-config predicate. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Documented the `unavailable` availability success state and separated it from protected-route error envelopes. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the current native admin UI reference for enablement, authorization, routing reuse, and source-confirmed launch status behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
