# Deploy native admin UI access

Enable Agent native admin UI access only for a trusted-operator pilot. The feature lets exact Agent administrators open the stock native UI through OCC on an isolated per-Agent browser host. Start with [production installation](production-installation.md) and [private Agent workspace routing](workspace-routing.md).

## Requirements

- Private workspace routing already works for the target Agents. Helm rejects `agentNativeAdmin.enabled: true` unless `gatewayRouting.enabled: true` is also set.
- A public wildcard DNS name and HTTPS certificate route traffic to the OCC API Service, not to Envoy. Use a previously unused `agentNativeAdmin.domain` for the first pilot rollout; do not reuse a domain from prior native UI experiments because OCC does not evict already registered browser service workers.
- The configured Agent domain is separate from the console domain and does not include a wildcard, scheme, port, or path.
- Each pilot Agent uses native trusted-proxy authentication with `occ-workspace-files` granted `operator.admin`, native `controlUi.enabled: true`, the derived Agent origin in `controlUi.allowedOrigins`, and trusted-proxy admin device auto-approval.
- Operators who use the console have exact Agent `administer` permission.

## Steps

Add the Helm values alongside the existing private gateway routing values:

```yaml
gatewayRouting:
  enabled: true

agentNativeAdmin:
  enabled: true
  domain: agents.example.com
```

Expose the API Service through your existing public ingress layer. The chart does not create this route. This example shows the required shape; adapt the Ingress class, certificate, and selectors to your cluster:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: occ-agent-native-admin
  namespace: openclaw-system
  annotations:
    cert-manager.io/cluster-issuer: public-wildcard
spec:
  ingressClassName: public
  tls:
    - hosts:
        - "*.agents.example.com"
      secretName: occ-agent-native-admin-wildcard-tls
  rules:
    - host: "*.agents.example.com"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: openclaw-enterprise-api
                port:
                  number: 8080
```

Allow ingress only to the API Pods selected for public browser traffic. Keep the Envoy Service private:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-native-admin-browser-ingress-to-api
  namespace: openclaw-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: openclaw-enterprise
      app.kubernetes.io/component: api
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
```

Verify Helm passes these API environment variables:

```text
OCC_AGENT_NATIVE_ADMIN_ENABLED=true
OCC_AGENT_NATIVE_ADMIN_DOMAIN=agents.example.com
```

Configure each pilot Agent after the API feature and wildcard route are enabled. Native admin availability requires the Agent's native configuration to trust the exact derived Agent origin. In an existing authenticated console browser session, open the status URL before the final compatible redeploy:

```text
https://occ.example.com/namespaces/<namespaceId>/agents/<agentId>/native-admin
```

For browser devtools, the same check is:

```js
await fetch("/namespaces/<namespaceId>/agents/<agentId>/native-admin", {
  credentials: "include",
}).then((response) => response.json());
```

A `200` response with `data.status: "unsupported"` can still include `data.host`, `data.origin`, `data.activeRevisionId`, and `data.bootstrapUrl`. Copy the returned `data.origin` into the Agent Configuration, preserving the existing model, Harness, channel, and gateway settings:

```yaml
gateway:
  auth:
    mode: trusted-proxy
    trustedProxy:
      userHeader: x-occ-identity
      allowUsers:
        - occ-workspace-files
      deviceAutoApprove:
        enabled: true
        scopes:
          - operator.admin
    identityScopes:
      occ-workspace-files:
        - operator.admin
  controlUi:
    enabled: true
    allowedOrigins:
      - https://agent-<opaque-hash>.agents.example.com
```

Do not set `gateway.auth.token`, `controlUi.dangerouslyDisableDeviceAuth`, or `controlUi.dangerouslyAllowHostHeaderOriginFallback`. Deploy the updated Agent revision, then call the status route again and expect `data.status: "available"` with the same `data.origin`. If the first status response is `data.status: "unavailable"`, fix active revision selection before saving the native configuration; OCC cannot derive the Agent origin until it can select the active revision.

Keep durable configuration changes in OCE. For compatible Kubernetes gateways,
native edits affect a Pod-local copy and are discarded when the Pod is replaced
or the Agent is redeployed; persistent workspace and gateway data remain.
See [Kubernetes managed native configuration](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#managed-native-configuration)
for the exact opt-in conditions and storage lifecycle.

## Tests

Open the console, choose a running Agent with an active revision, open **Workspace files**, and verify **Native admin UI** reports available for an administrator. Open the tab, confirm the launch on the console origin, and confirm the callback sets a host-only `__Host-occ_native_admin` cookie on the derived Agent host.

Full runtime proof still requires a real browser test that loads native assets through OCC, reconnects native WebSocket traffic, and performs a reversible native admin edit against a disposable Agent.

## Troubleshooting

| Symptom                                             | Check                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Helm render fails                                   | `agentNativeAdmin.enabled` requires `gatewayRouting.enabled` and a DNS-only `agentNativeAdmin.domain`.                                                 |
| API startup fails with `AGENT_NATIVE_ADMIN_INVALID` | `agentNativeAdmin.domain`, `OCC_AUTH_BASE_URL`, auth secret length, and PostgreSQL composition.                                                        |
| Console panel is hidden                             | Feature enablement and exact Agent `administer` permission.                                                                                            |
| Panel reports stopped                               | Deploy or restart the Agent before opening the native UI.                                                                                              |
| Panel reports unavailable                           | Active revision selection. Fix the Agent's active revision before discovering `data.origin` or redeploying compatible native configuration.            |
| Panel reports unsupported                           | Compute gateway routing, `getGatewayEndpoint` support, and native trusted-proxy/control UI configuration for the active revision.                      |
| Native tab cannot load                              | Browser wildcard DNS/TLS to API, launch/callback status, native admin cookie, native `controlUi.allowedOrigins`, and private gateway routing to Envoy. |
| Browser reports service-worker registration failure | Expected for the pilot. OCC blocks native service-worker script requests and adds `worker-src 'none'` to proxied responses.                            |

## Related

- [Agent native admin UI](../../reference/agent-native-admin.md)
- [Gateway routing with Envoy](../../reference/gateway-routing.md)
- [Workspace routing deployment](workspace-routing.md)
- [Agent native admin UI flow](../../flows/agent-native-admin.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-20 08:21: Linked Kubernetes configuration-copy details to the implementation reference after the Driver documentation refactor. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - f4e22e48)
- 2026-09-19 21:14: Replaced manual cookie copying with authenticated-browser status discovery and documented Helm, service-worker domain setup, and the explicit writable-config predicate. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 21:07: Added the status API discovery path for the derived Agent origin and troubleshooting for `unavailable`. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
- 2026-09-19 20:19: Added the operator deployment guide for native admin UI enablement, public API ingress, and remaining runtime proof. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9c)
