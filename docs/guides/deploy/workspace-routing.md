# Configure private Agent workspace routing

Enable private Kubernetes routing so operators can read and replace Agent
workspace files through OCC. Start with the [production installation](production-installation.md)
and keep its protected Helm values, Installation YAML, and Kubernetes context.

## Agent workspace files

The [Envoy routing reference](../../reference/gateway-routing.md) describes endpoints,
resource ownership, service keys, TLS, and failure behavior.

Enable private Agent routing to read and replace `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md` through OCC. Compute creates each Agent's HTTPRoute
when it provisions the gateway. One shared private hostname serves URLs of the
form `wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>`; there is no
per-Agent endpoint map or API restart after provisioning.

### Requirements

This integration requires Kubernetes with enforced NetworkPolicies,
[Envoy Gateway v1.9](https://gateway.envoyproxy.io/docs/tasks/quickstart/),
Gateway API CRDs, and [cert-manager](https://cert-manager.io/docs/installation/).
Install and operate those controllers separately from this chart and provide
an existing Envoy GatewayClass. By default, the chart creates a namespaced
SelfSigned Issuer, a root CA Certificate, and a CA Issuer; cert-manager generates
the CA and Envoy's listener certificate. It also creates the shared Gateway,
ClusterIP EnvoyProxy, and API-key SecurityPolicy. No public listener is created.
The operator installing the chart needs permission for these infrastructure
resources; the OCC API does not.

The chart gives Envoy a stable Service name and derives its `.svc` hostname.
Normal Linux Pod DNS search resolves that name without a separate DNS record
or a fixed cluster DNS suffix. The certificate and Compute routes use the same
hostname. TLS verification remains enabled.

### Configure private routing

Create a dedicated high-entropy service key with no trailing newline, then
create its Secret in the controller namespace. Keep key files outside Git:

```sh
umask 077
python3 -c 'import secrets; print(secrets.token_hex(32), end="")' > /secure/operator/gateway-api-key
kubectl -n openclaw-system create secret generic occ-private-gateway-key \
  --from-file=occ=/secure/operator/gateway-api-key
```

Add the following to the existing Helm values. This example uses release
`oce` in `openclaw-system`; no hostname, issuer, or CA Secret is required:

```yaml
gatewayRouting:
  enabled: true
  gatewayClassName: eg
  apiKeySecretName: occ-private-gateway-key
```

The default Gateway name is `<release>-agent-gateways`, in the Helm release
namespace. Add matching routing settings to `drivers.compute.configuration`
in the Installation startup YAML:

```yaml
gatewayRouting:
  gatewayName: oce-agent-gateways
  gatewayNamespace: openclaw-system
  envoyNamespace: envoy-gateway-system
network:
  gatewayPort: 8080
  # Preserve the existing DNS namespace and Pod labels here.
```

Helm and Compute derive the hostname independently from these same settings;
Helm does not rewrite the Installation Secret. The
[Compute reference](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
defines the naming rule. It does not require an existing Agent gateway.

To use an existing issuer instead of creating a CA, set
`gatewayRouting.issuerRef.name`, with `kind` (default `ClusterIssuer`) and
`group` (default `cert-manager.io`). If OCC needs additional trust for that
issuer, create a Secret containing only the public CA bundle and set both
`gatewayRouting.caSecretName` and `caSecretKey`. Leave both empty when Node
already trusts the issuing CA. Explicit CA trust requires an explicit issuer;
it cannot replace the chart's generated CA bundle in automatic mode.
Root and leaf certificate outputs must use different Secrets, separate from
Installation, database, auth, provider, and service-key Secrets. An external
CA trust bundle must also remain separate from those credentials and the leaf
TLS Secret.

For custom DNS, set the same `gatewayRouting.hostname` in Helm and Compute and
make it resolve to the Envoy Service. The selected issuer must be able to issue
for that name. A custom hostname can use either the automatic CA or an existing
issuer; it does not change CA ownership.

The chart's `tenantGatewayPort` must match Compute's `network.gatewayPort`.
Remove `network.gatewayClients` when enabling routing. Compute derives the
Envoy peer from `gatewayRouting` and rejects explicit gateway clients in this mode.
Retain the Installation's other Compute settings. Restart the API and worker
when changing their Installation startup configuration. New Agent creation
thereafter needs no configuration update. The worker requires tenant-local
HTTPRoute permissions from the chart's worker role; the API needs no route
writes or gateway Pod/exec access.

### Configure native gateway authentication

Each Agent's native Configuration must explicitly select trusted-proxy auth.
This fragment shows only the relevant native fields; preserve the model,
Harness, and other existing configuration:

```yaml
gateway:
  trustedProxies:
    - <actual-proxy-source-cidr>
  allowRealIpFallback: true
  auth:
    mode: trusted-proxy
    trustedProxy:
      userHeader: x-occ-identity
      allowUsers:
        - occ-workspace-files
    identityScopes:
      occ-workspace-files:
        - operator.admin
```

Compute validates the fixed identity header, allowed identity, administrative
grant, real-IP fallback, and configured proxy sources before preparing a routed
revision. Omit `gateway.auth.token`; native OpenClaw rejects a simultaneous token
in this mode, and Compute omits automatic gateway-token projection. Do not require an
`x-forwarded-for` header in native `requiredHeaders`: the route removes it.
Envoy authenticates the service key, strips it, overwrites the fixed native
identity, and supplies `X-Real-IP` from its direct OCC connection. This supported
fallback works when OCC and Envoy share a Pod CIDR. Never fabricate an address
or admit direct workload access to compensate for native attribution failures.

NetworkPolicy must restrict native gateway ingress to those Envoy Pods. The
chart restricts proxy ingress to the OCC API and permits its required routing
and control-plane traffic. A trusted source CIDR by itself is not sufficient
isolation. Restrict Kubernetes writes to the Gateway, attached HTTPRoutes,
SecurityPolicy, native configuration, and namespace attachment labels to trusted
operators and the scoped worker. Untrusted tenants must not be able to replace
route authentication or attach their own routes.

The chart mounts the service key only into the API and sets
`OCC_GATEWAY_API_KEY_PATH`. Automatic CA mode projects only the root Secret's
public `tls.crt` as `ca.crt` and sets `NODE_EXTRA_CA_CERTS`; the signing key is
never mounted into OCC. The Pod waits for that Secret before starting. With an
explicit issuer, the API uses the optional configured CA bundle instead.
No credential or endpoint map is mounted into the worker,
Agent, or gateway. The key is an Installation-wide native administrative
credential; do not reuse a Better Auth signing key or model-provider token.
OCC still checks the human caller's exact Agent `read` or `operate` permission.

### Verify routing and file access

After applying the Helm and Installation changes, verify the actual resources:

```sh
kubectl -n openclaw-system get gateway oce-agent-gateways -o yaml
kubectl -n openclaw-system get issuer,certificate,securitypolicy
kubectl -n "$TENANT_NAMESPACE" get httproute
```

Require accepted/programmed routing, a ready certificate, and accepted security
policy before testing native access. Verify missing/invalid service keys and
spoofed identity headers cannot reach native administration. Then use OCC's
four-file GET/PUT routes and a fresh native session to prove consumption; a
ready proxy alone is insufficient.

### Rotate the service key and certificates

For service-key rotation, first add the new key under another client ID in the
Envoy Secret while keeping `occ` unchanged. After Envoy accepts it, move the new
key to `occ` while retaining the previous value under a different client ID.
Wait for the API's mounted Secret to update and verify a new request, then
remove the previous key and verify rejection. OCC reads the file for each
operation; it does not require a restart for key rotation.

The generated root has a ten-year lifetime and reuses its private key on
renewal. The leaf has a 90-day lifetime; cert-manager renews both certificates
30 days before expiry. Automatic setup does not coordinate CA rollover:
preserve the CA Secret, plan backups, and control trust changes. For a CA key
replacement, distribute an overlapping old/new public trust bundle before
switching Envoy's certificate, restart the API to load that bundle, and remove
the old root only after no serving certificate depends on it.

cert-manager renews the server leaf certificate automatically. New WSS
connections continue using normal CA and hostname verification without an OCC
restart while the issuing CA remains trusted. Replacing a private root bundle
requires restarting the API because Node reads `NODE_EXTRA_CA_CERTS` at process
startup. This integration uses API-key authentication over WSS; the pinned
native client does not expose mTLS client-certificate options.

### Troubleshooting

Without routing/key configuration, with an unsupported Driver, or when the
proxy/native gateway is unavailable, file requests return
`503 DEPENDENCY_UNAVAILABLE`. Docker does not implement this automatic routing
path. The [Agents reference](../../reference/agents.md#workspace-files) owns file
limits and authorization behavior; [testing](../../testing/README.md) distinguishes live
integration evidence from rendering and conformance checks.
