# Feature Spec: OCC Gateway Administration and Command Proxy: request routing and policy

[Spec overview](../15-occ-gateway-access.md). Original record; decisions and status are preserved.

### HTTP request and native result

The canonical route is `POST /namespaces/:namespaceId/agents/:agentId/gateway/`, including the trailing slash, with no query parameters. Do not add a global `/gateway/` route or infer an Agent from caller-supplied URLs.

```json
{ "method": "agents.files.get", "params": { "agentId": "main", "name": "AGENTS.md" } }
```

The outer object permits only a nonempty `method` string and optional JSON `params`; the native gateway validates method parameters. `params.agentId` is a native Agent selector inside the already selected gateway, not an OCC target. The caller cannot select a gateway address, namespace, revision, transport token, native identity, scope, timeout, or request ID. Native credentials and connection options are always server-owned.

Successful dispatch returns HTTP 200 using the existing OCC envelope:

```json
{
  "data": { "ok": true, "payload": { "example": "native payload" } },
  "meta": { "requestId": "occ-generated-id" }
}
```

A native RPC rejection also uses HTTP 200, with `data: {ok:false,error:{code,message,details?,retryable?,retryAfterMs?}}`, preserving the SDK's native error semantics. OCC admission, routing, and transport failures use the existing HTTP error envelope, not a fabricated native RPC result. Preserve native payloads semantically, not byte-for-byte wire frames. Native results are privileged administrator data; never put parameters, results, credentials, or native error details in audit or request logs.

For `config.get`, omit the internal `sourceConfigBeforeMigrations` snapshot. The pinned native runtime exposes this field without redaction; its supported public config fields remain native-redacted. This credential-isolation exception does not change configuration ownership or permit writes.

Use the SDK's first-response behavior (`expectFinal: false`), with a fixed 30-second total connection/request deadline after admission. An `accepted` payload acknowledges work and does not claim completion; callers may use an allowed history/status command later. Do not hold HTTP open for native events. On timeout, disconnect, or caller cancellation, stop the local wait without claiming the gateway cancelled the work; a request already sent may have taken effect. Never automatically replay it. Close the per-request client after the response; no connection pool is required for this slice.

Reuse OCC's configured request-body limit (64 KiB by default). Reject proxy responses over 1 MiB of serialized JSON with an OCC dependency failure; they may follow an already executed command. The SDK's investigated inbound frame bound is 25 MiB, so the response cap is not a pre-allocation bound. Keep explicit deadlines and the SDK frame limit; do not invent a streaming parser. Source contracts are the existing [controller HTTP conventions](../../apps/controller/src/index.ts), [API primitives](../../packages/contracts/src/api/common.ts), and native [request handling](https://github.com/openclaw/openclaw/blob/b9d01e71270e15208d191e4ea4afdef31fbf51ac/packages/gateway-client/src/pending-request.ts).

### Authorization, routing, and command policy

Admit only existing human sessions or non-Agent service API keys. Require exact `Agent`/`administer` authorization for the path's Namespace and Agent through the selected IAM Driver, before discovering credentials or opening a gateway connection. Do not treat `read`, `operate`, native Agent selectors, or Agent ServicePrincipal credentials as equivalent authorization. Add `administer` to the native bootstrap administrator's Agent permissions; other roles need an explicit grant, with no fallback for existing `operate` grants. Reuse the existing [IAM action and exact matching](../../packages/iam/src/index.ts) and [request admission](../../apps/controller/src/auth/index.ts).

Cookie-authenticated proxy POSTs require an `Origin` matching the configured OCC public origin, and reject conflicting cross-site Fetch Metadata; missing/malformed origin is denied. Compare against trusted server configuration, not the incoming Host header. Apply this check to the application route: Better Auth's own trusted-origin protection does not protect arbitrary OCC POST handlers. Valid service API keys remain usable without browser headers; invalid keys never fall back to cookies. Keep existing development host/origin protections.

Expose a controller-private gateway adapter from Installation composition only when its selected Compute implementation supports this contract. The bundled Kubernetes implementation resolves the current running Agent, verifies Namespace/Agent ownership and selected revision on the gateway Service, EndpointSlice, Deployment, and ready Pod, then uses authenticated Kubernetes API `pods/proxy` WebSocket upgrade to the owned Pod. The private controller-side upgrade bridge uses existing Kubernetes TLS/auth configuration and exposes only an ephemeral loopback WebSocket URL to the native SDK. The API server reaches the owned Pod IP, preserving native remote-client pairing semantics; port-forward would trigger the native local-backend bypass without creating a durable paired device. The admitted native Configuration must narrowly pin the actual API-server-to-Pod source addresses in `gateway.trustedProxies`; Kubernetes-generated forwarded client attribution must be non-loopback. Do not infer a broad Pod/Service CIDR or silently inject proxy trust. Missing or mismatched trust fails native admission. Native readiness is checked over Pod loopback so kubelet probes need no forwarded-identity exception. It does not dial the Service directly or add a new gateway Service network exception. Return unsupported/unavailable for unimplemented Drivers, stopped/unready Agents, missing credentials, or mismatched ownership; no alternate gateway, caller-selected target, or impersonation fallback. Configure the required API/worker RBAC and controller-namespace credential access. A revision change or transport loss during dispatch is an uncertain outcome; do not retarget/retry a mutation.

The approved initial allowlist is exact and code-owned:

| Native methods                                                                             | Intended use                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `health`, `status`, `config.get`, `config.schema.lookup`, `agents.list`, `channels.status` | Inspect the selected gateway and its effective configuration.                |
| `agents.files.list`, `agents.files.get`, `agents.files.set`                                | Native workspace authoring; file semantics and validation remain native.     |
| `chat.send`, `chat.history`, `chat.abort`                                                  | Submit, inspect, or abort a native chat run; first-response semantics apply. |

Reject all other methods before forwarding. In particular, `config.set`, `config.patch`, `config.apply`, `update.run`, native Agent configuration mutations, and device-pairing/token administration are unavailable through this route. The allowlist bounds caller access despite OCC's native admin authority. Extending it requires reviewing each method's effect on OCC ownership; do not automatically include new upstream methods.

Configuration remains OCC-owned: the current [Kubernetes projection](../../apps/controller/src/drivers/compute/kubernetes/index.ts) mounts `OPENCLAW_CONFIG_PATH` read-only. Admin pairing does not make live native configuration writes deployable. Configuration changes continue through OCC Configuration admission and AgentRevision deployment; direct native writes need a separate writable-projection and adoption contract. Mutable workspace bytes remain outside revisions. The native gateway enforces native file/path rules; this admin proxy does not replace a narrower user-facing workspace-file API.

Audit the admitted actor, Namespace, Agent, native method, OCC request ID, and dispatch/outcome category through existing audit facilities. Record an authorized dispatch before forwarding; record native success/rejection or an uncertain transport outcome afterward. Audit admission/denial failures without parameters; if required audit storage fails before dispatch, do not send. A failed outcome write after dispatch cannot undo or safely replay the command. Never report uncertain execution as confirmed failure without this qualification.

