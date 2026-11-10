# Agent native admin UI

Native browser access is disabled by default. It exposes an Agent Gateway’s chat or administration surface according to the caller’s Agent permission, subject to [Gateway managed mode](#gateway-managed-mode). OCC resolves the Agent host and proxies native HTTP and WebSocket traffic using the human’s OCE session.

## Host-only session exchange

For guarded OIDC sign-in, select `agentNativeAdmin.sessionMode: host-only-exchange`
(`OCC_AGENT_NATIVE_ADMIN_SESSION_MODE=host-only-exchange`) and omit
`agentNativeAdmin.sharedCookieDomain` and `OCC_AUTH_COOKIE_DOMAIN`. Console and Agent
origins must use same-site HTTPS and route to OCC. Launch creates no account or grant.

Opening the Agent creates a 60-second, window-bound challenge, confirmed through
the same Console session. One-use redemption sets a Secure, HttpOnly,
SameSite=Strict host-only cookie, expiring with its parent session (at most eight
hours). HTTP, WebSocket admission and renewal recheck the session, Principal,
Agent, Namespace, revision and authorization. Neither cookie reaches the Gateway.

Repeating **Open Agent UI** reuses a valid handle with the same authority and
expiry, preserving existing WebSockets. Otherwise, redemption issues a new handle.

## Who can open it

The console’s Agent browser surface requires a human session and exact Agent
`operate` or `administer` permission. `operate` grants chat access;
`administer` retains administration access and takes precedence when both are
granted. Agent `read` alone and service API keys grant neither mode.

Password and OIDC sign-in support native browser access with shared cookies.
OIDC also supports the [host-only session exchange](#host-only-session-exchange).
Google sign-in does not support native browser access.

## Enable during creation

In **Create Agent**, select **Enable browser chat**. Unchecked by default, it
requires Installation native access enablement and compatible gateway support.
Ordinary Agent owners can use this option without Installation administration.

API callers set `nativeAdmin: true` on `POST /namespaces/:namespaceId/agents`
and supply `expectedConfigurationGeneration`. In addition to ordinary Agent
creation permissions, this requires `update` on the selected Configuration,
which must not be referenced by any Agent. OCC checks the generation, prepares
the Configuration, and creates the Agent in one transaction. Deploy the Agent
through the normal workflow after creation.

Supported guided provisioning accepts `nativeAdmin: true` on
`POST /namespaces/:namespaceId/agents/provision` and prepares the initial
Configuration before queueing its deployment. Its existing provisioning
permissions still apply.

Both paths save `controlUi.enabled`, the exact derived HTTPS origin (including
its port), `gateway.publicOrigin`, and trusted-proxy admin device approval in the
initial Configuration. It preserves existing allowed origins, Secret bindings,
and unrelated settings. Conflicting authentication modes, unsupported auth fields,
disabled device authentication, and host-header origin fallback are refused.
Guided-provisioning retries retain the Agent identity and prepared Configuration.
Browser preparation does not change the creator's Agent permissions.

## Requirements

- `agentNativeAdmin.enabled: true` in Helm, which sets `OCC_AGENT_NATIVE_ADMIN_ENABLED=true` on the API.
- `agentNativeAdmin.domain` set to the Agent host suffix, such as `agents.oce.example.com`, without scheme, wildcard, port, or path. Helm passes it as `OCC_AGENT_NATIVE_ADMIN_DOMAIN`. Use a previously unused DNS suffix for the first pilot rollout; the proxy blocks new service-worker registration but does not evict service workers that a prior experiment registered on the same origin.
- HTTPS Console and Agent DNS hosts that share a non-public suffix. In shared-cookie mode OCC derives the cookie domain automatically; see [shared sessions](authentication.md#native-admin-shared-sessions). The Agent suffix is required even when browser access is disabled.
- Private gateway routing (enabled by default). [Prepare its prerequisites](../guides/deploy/workspace-routing.md#requirements) and [Envoy routing](gateway-routing.md) before installation. Helm rejects native admin when routing is disabled; the API needs each Agent's private route.
- `OCC_AUTH_BASE_URL` set to the public OCC origin that serves the console, for example `https://console.oce.example.com`.
- The Agent must be running with a selected version owned by the selected Compute Driver: both Driver ID and implementation must match the version. The [mode-specific endpoint](#agent-host-identity) must map from private `wss:` to private `https:`.
- The native Agent configuration must keep the trusted-proxy `occ-workspace-files` identity with `operator.admin`, enable native `controlUi`, allow the derived Agent origin, and enable trusted-proxy device auto-approval. The machine identity grant supplies admin authority; device auto-approval can stay limited to read/write. The support check rejects token auth, disabled device auth, and host-header origin fallback.
- Chat additionally requires `gateway.auth.trustedProxy.requiredHeaders` to include `x-openclaw-scopes` in the saved Configuration and a runtime that enforces the [chat authority ceiling](#native-authority-and-drift). Preserve other required headers when adding it.

Local development uses the existing loopback HTTPS proxy for Console sessions in
Compose and Kubernetes-only profiles. Compose with Kubernetes Compute and
OpenShell also enables native Agent routing. The first-Agent helper’s
`--control-ui` option supplies the Agent’s native configuration.

## Authorization and availability

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` requires a human
session, exact Agent existence, and either `operate` or `administer`. OCC checks
this boundary before returning any feature status, including `disabled`.
Successful access selects `mode: "chat"` or `mode: "admin"`; unsupported narrow
runtime authority fails closed instead of granting administration.

The response reports:

| Status        | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `disabled`    | The Installation has not enabled native admin UI access.                                                        |
| `stopped`     | The Agent is not in desired running state.                                                                      |
| `unsupported` | The selected Compute Driver, selected version, or native configuration does not support native admin UI access. |
| `unavailable` | No version is serving yet: the Agent has no selected version, or a newer version is replacing it.               |
| `available`   | The caller may open the returned `url` for the selected version.                                                |

A stopped Agent without a selected version returns only `status: "stopped"`, including before first deployment and after completed stop reconciliation. Otherwise, stopped results include target fields. A desired-running Agent without a selected version returns `unavailable` in the success envelope. Dependency outages, including IAM, return `503 DEPENDENCY_UNAVAILABLE`. Malformed requests, IAM denials and missing sessions use the protected-route error envelope.

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

Without a valid session, opening `/` or `/chat/main` redirects to the Console with `302`. Trailing slashes and 32-character lowercase hexadecimal session segments are accepted. Only the opaque host key survives in the fragment; session segments and queries are dropped. Responses set `Cache-Control: no-store` and `Referrer-Policy: no-referrer` without checking Agent existence.

Only a user-activated (`Sec-Fetch-User: ?1`) top-level HTML navigation is redirected. The same page load without that header, including every Safari navigation, stays HTTP `403` with one **Sign in** link to that console URL. Link previews, API requests, and WebSocket upgrades send no navigation Fetch Metadata and keep their ordinary refusal.

The console offers sign-in if needed. Its authenticated `GET /native-admin/return/<key>` operation checks exact Agent `operate` or `administer` access and returns the Namespace and Agent IDs even if the Agent is stopped. Unknown and unauthorized keys receive the same `404`. Recovery ends at Agent detail; opening native chat is a separate action.

A signed-in person who has neither chat nor administration access to the Agent is never redirected. Their top-level HTML navigation stays HTTP 403 on a page that does not name the Agent; its only link, **Go to your Agents**, points at `/console/agents`. JSON requests still receive the JSON `403`; WebSocket upgrades still close.

In an already-open Gateway tab, the Control UI offers **Reconnect in browser** if a reconnect fails and its same-origin health request receives `401` or `403`. Following the link opens `/` on the current Agent host. The UI does not navigate automatically or carry forward the chat path or query. The response is a reason to check access, not proof that a session expired. OCC decides whether that navigation reaches sign-in or is refused.

## Agent host identity

OCC derives a stable browser host from the Installation ID, Namespace ID, Agent ID, and configured `agentNativeAdmin.domain`. The hostname is opaque and must not be reused for another Agent identity. The derived host is separate from the console origin, which gives each Agent UI its own browser origin.

An Agent URL uses the derived host directly:

```text
https://agent-<opaque-hash>.<agentNativeAdmin.domain>/
```

Admission resolves the irreversible host hash through platform state without a separate registry or cache. Unknown hosts, wrong suffixes, deleted Agents and ambiguous matches fail closed.

Administration and workspace-file access use the Compute Driver's
`getGatewayEndpoint`, typically:

```text
wss://<private-host>/namespaces/<namespaceId>/agents/<agentId>
```

Chat uses the optional [`getGatewayChatEndpoint`](drivers/compute.md#method-get-gateway-chat-endpoint),
which must enforce the chat authority ceiling. Missing support returns
`unsupported`; OCC never falls back to the administrative endpoint. Kubernetes
uses a separate `/native-chat/` route on the existing managed HTTPRoute.

For browser proxying, OCC maps the selected endpoint to the same authority and path over `https:`. Workspace-file access continues to use the original `wss:` endpoint. Native HTTP requests and WebSocket upgrades both pass through the OCC API process before reaching the private gateway. The HTTP proxy blocks native service-worker script requests and appends `worker-src 'none'` to proxied Content Security Policy so Agent content cannot register a browser service worker on the isolated Agent origin.

## Shared session boundary

Shared-cookie mode uses the automatically derived domain. Every host receiving that cookie must be a trusted OCE ingress endpoint. Agent hosts route to OCC, not Envoy or tenant Services. OCC strips cookies, `Authorization`, API keys, forwarded identity/scope headers and native `Set-Cookie`; the Gateway never receives the OCE cookie.

Native chat or other activity in the Agent tab does not renew the console session. Session expiry, logout, session revocation, permission removal or a change between chat and administration authority, pilot disablement, Agent unavailability, or a version change closes active WebSockets during the authorization lease. A socket remains bound to the session that opened it; replacing a browser cookie does not replace that socket’s session. Reconnecting uses the same stable Agent host and the selected version when the shared OCE session, exact Agent permission, and native configuration remain valid.

## Gateway managed mode

Managed mode defaults on where the Compute Driver supports it. It prevents Gateway administrators from editing native
configuration, opening Gateway-local terminals, and running Gateway-hosted command
jobs. An Installation administrator can change the setting in OCE for the next
deployment. See [Gateway managed mode](agents/gateway-managed-mode.md) for runtime
requirements and behavior when managed mode is off.

## Native authority and drift

OCC selects native authority on the server for each human session. Both modes
use the existing `occ-workspace-files` identity. The chat route overwrites
`x-openclaw-scopes` with `operator.sessions.write`; the runtime intersects this
ceiling with identity and device grants. It permits conversation operations
and implies `operator.sessions.read`. The administrative route retains its
existing authority. Browser headers cannot widen that ceiling. OCC records the
human IAM principal, exact Agent and selected mode in audit evidence.

Chat access does not grant native configuration writes, device or pairing
administration, approval management, or elevated gateway commands. A runtime
that cannot enforce the selected narrow scopes is unsupported for chat mode.

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

- Helm requires HTTPS and an Agent DNS suffix even when native access is disabled. Native access also requires private gateway routing.
- Auth setup rejects missing or incompatible Console and Agent DNS hosts, public-suffix cookie scope, and short auth secrets. The removed `sharedCookieDomain` and `OCC_AUTH_COOKIE_DOMAIN` inputs are rejected, including empty values.
- Native access setup rejects invalid enablement, origins, or transport prerequisites. A missing `OCC_GATEWAY_API_KEY_PATH` reports `GATEWAY_API_KEY_UNAVAILABLE`.
- Host-only exchange requires guarded OIDC sign-in, same-site HTTPS Console and Agent origins, and disabled sandbox preview.
- See [availability statuses](#authorization-and-availability). With a selected version and derived origin, unsupported native configuration, gateway routing or an unclean Compute endpoint returns `unsupported`.
- The console hides native access for disabled and denied states and explains stopped, unsupported, or unavailable states. When available, **Open chat** or **Open Agent UI** opens a new tab directly in shared-cookie mode or completes the host-only exchange.
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

- 2026-11-03: Documented the unactivated sign-in page.
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
