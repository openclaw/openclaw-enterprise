# Agent native admin UI

Agent native admin UI access lets an authorized operator open the selected Agent's native OpenClaw administration UI from the platform console. It is an explicit pilot capability for trusted operators. It exposes the stock native administrator surface for one Agent gateway; it does not create an OCE-managed configuration editor.

The feature is disabled by default. When enabled, the console shows **Native admin UI** on the Agent workspace tab only for callers with exact Agent `administer` permission. The launch flow opens a per-Agent bootstrap URL, confirms access from the console origin, redeems a one-use exchange code on the Agent origin, then serves native HTTP and WebSocket traffic through OCC.

## Requirements

- `agentNativeAdmin.enabled: true` in Helm, which sets `OCC_AGENT_NATIVE_ADMIN_ENABLED=true` on the API.
- `agentNativeAdmin.domain` set to a DNS hostname without scheme, wildcard, port, or path. Helm passes it as `OCC_AGENT_NATIVE_ADMIN_DOMAIN`. Use a previously unused DNS suffix for the first pilot rollout; the proxy blocks new service-worker registration but does not evict service workers that a prior experiment registered on the same origin.
- `gatewayRouting.enabled: true`. Helm rejects native admin enablement without private gateway routing because the API process must reach each Agent gateway through the private route.
- `OCC_AUTH_BASE_URL` set to the public OCC origin that serves the console.
- PostgreSQL-backed API composition. The enabled path requires a native-admin exchange store and a signing secret at startup.
- Private Agent gateway routing configured through [Gateway routing with Envoy](gateway-routing.md).
- The Agent must be running, have an active revision, and expose a `ComputeDriver.getGatewayEndpoint` value that can be mapped from private `wss:` to private `https:`.
- The native Agent configuration must keep the trusted-proxy `occ-workspace-files` identity with `operator.admin`, enable native `controlUi`, allow the derived Agent origin, and enable trusted-proxy admin device auto-approval. The support check rejects token auth, disabled device auth, and host-header origin fallback.

## Authorization and availability

`GET /namespaces/:namespaceId/agents/:agentId/native-admin` is the console-facing availability check. It is a protected OCC API route with exact Agent `administer` authorization. Agent `read`, Agent `operate`, native device credentials, native tokens, service keys for unrelated principals, and possession of a derived Agent host do not grant this API route.

The response reports:

| Status        | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `disabled`    | The Installation has not enabled native admin UI access.                                                       |
| `stopped`     | The Agent is not in desired running state.                                                                     |
| `unsupported` | The selected Compute Driver, active revision, or native configuration does not support native admin UI launch. |
| `unavailable` | OCC cannot resolve the active Agent revision while checking availability.                                      |
| `available`   | The caller may open the returned `bootstrapUrl` for the active revision.                                       |

If active Agent revision selection is unavailable, OCC returns `unavailable` in the success envelope so the console can show a retryable dependency state. Malformed requests, denied IAM access, missing sessions, and failures outside that availability branch use the normal protected-route error envelope.

## Agent host identity

OCC derives a stable browser host from the Installation ID, Namespace ID, Agent ID, and configured `agentNativeAdmin.domain`. The hostname is opaque and must not be reused for another Agent identity. The derived host is separate from the console origin, which gives each Agent UI its own browser origin.

The bootstrap URL uses the configured OCC public origin with the derived Agent host and this path shape:

```text
https://agent-<opaque-hash>.<agentNativeAdmin.domain>/__occ/native-admin/bootstrap?namespace=<namespaceId>&agent=<agentId>&revision=<activeRevisionId>
```

The private upstream base remains the Compute Driver's existing gateway endpoint:

```text
wss://<private-host>/namespaces/<namespaceId>/agents/<agentId>
```

For browser proxying, OCC maps that value to the same authority and Agent path over `https:`. Workspace-file access continues to use the original `wss:` endpoint. Native admin HTTP requests and WebSocket upgrades both pass through the OCC API process before reaching the private gateway. The HTTP proxy blocks native service-worker script requests and appends `worker-src 'none'` to proxied Content Security Policy so Agent content cannot register a browser service worker on the isolated Agent origin.

## Launch session

The Agent-host bootstrap page generates a browser-local `state` and verifier, then redirects to `/console/native-admin-launch` on the console origin. The console launch page asks the operator to confirm and posts `state`, verifier challenge, expected host, and expected revision to:

```text
POST /namespaces/:namespaceId/agents/:agentId/native-admin/launch
```

OCC rechecks the current session, CSRF boundary, exact Agent `administer`, desired running state, active revision, derived host, and private gateway endpoint before issuing a one-use code. Codes are stored as digest identifiers in PostgreSQL, expire within 60 seconds and no later than the parent session, and are capped per parent session.

The Agent-host callback redeems the code with the verifier and sets `__Host-occ_native_admin` as a signed, host-only, `HttpOnly`, `Secure`, `SameSite=Lax` cookie. The cookie expires at the parent session lifetime. OCC revalidates the parent session, selected IAM identity, exact Agent/revision, exact host, and exact Agent origin before accepting the cookie on proxied native UI requests.

## Native authority and drift

The native admin UI runs with the same shared native trusted-proxy identity used by workspace files: `occ-workspace-files` with `operator.admin`. OCC attributes launch and availability checks to the human session and exact Agent IAM decision. The native gateway sees the shared service identity, not a per-human native account.

Native admin changes can modify gateway-local state that is outside OCE Configurations and AgentRevisions. For Kubernetes runtime gateways whose saved configuration explicitly satisfies the native-admin support contract, the managed ConfigMap stays read-only at `/etc/openclaw-managed/openclaw.json`; an init container copies it into the pod-local emptyDir at `/home/node/.openclaw/openclaw.json`, and `OPENCLAW_CONFIG_PATH` points at that writable copy. The predicate requires trusted-proxy auth for `occ-workspace-files`, `operator.admin` identity scopes, trusted-proxy admin device auto-approval, `controlUi.enabled`, at least one `controlUi.allowedOrigins` value, and disabled dangerous control UI fallbacks. Ordinary runtime gateways, including routed gateways that do not opt into that native-admin-compatible shape, keep the read-only managed config path. Native admin configuration edits affect only the pod-local copy, then reset from the managed snapshot when the pod is recreated or the Agent is redeployed. Operators should manage durable configuration through OCE. Redeploying an Agent re-applies the managed OCE revision but does not imply a factory reset of native files, conversations, device state, plugins, or other gateway-local data.

## Failure behavior

- Helm rendering fails when `agentNativeAdmin.enabled` is true without `gatewayRouting.enabled`.
- Startup fails with `AGENT_NATIVE_ADMIN_INVALID` when enablement, domain, exchange store, public origin, or cookie-secret requirements are invalid.
- Availability returns `unavailable` when OCC cannot resolve the active Agent revision. Gateway routing, unsupported native configuration, or a selected Compute Driver without a clean endpoint returns `unsupported` after OCC has an active revision and derived Agent origin.
- The console hides the panel for disabled and denied states, shows operator-readable stopped, unsupported, or unavailable messages, and opens the returned `bootstrapUrl` in a new tab when available.
- Proxied HTTP and WebSocket requests strip browser credentials, service keys, forwarded headers, native identity/scope headers, and native `Set-Cookie` before responding through OCC. WebSocket upgrades require a non-null exact Agent `Origin`; accepted `101` connections audit `connect` and `close`, refresh authorization every 25 seconds, close when a lease check fails or takes more than 5 seconds, and are destroyed during API `preClose`.

## Related

- [Platform console](console.md#open-the-native-admin-ui)
- [Agents](agents.md#native-admin-ui)
- [Authentication](authentication.md#native-admin-launch-sessions)
- [Gateway routing with Envoy](gateway-routing.md#native-admin-ui-routing)
- [Deploy native admin UI access](../guides/deploy/native-admin.md)
- [Agent native admin UI flow](../flows/agent-native-admin.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-19 21:14: Documented gateway-routing Helm validation, service-worker domain setup, and the explicit native-admin writable-config predicate. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Documented the `unavailable` availability success state and separated it from protected-route error envelopes. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the current native admin UI reference for enablement, authorization, routing reuse, and source-confirmed launch status behavior. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
