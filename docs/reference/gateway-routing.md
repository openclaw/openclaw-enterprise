# Gateway routing with Envoy

OCC uses Envoy Gateway to read and write an Agent's workspace files through a
private WebSocket connection. One shared HTTPS listener routes each Agent URL
to that Agent's native OpenClaw gateway:

```text
OCC API -- WSS + service key --> Envoy -- WebSocket --> Agent gateway Service
```

This reference describes the current Kubernetes implementation. For installation
commands, use [workspace-file setup](../guides/deploy/workspace-routing.md#agent-workspace-files).
For caller permissions and file operations, use the
[workspace-files API](agents.md#workspace-files).

## Resources and ownership

| Owner                     | Resources or responsibility                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation operator     | Envoy Gateway and cert-manager controllers, Gateway API CRDs, an existing GatewayClass, enforced NetworkPolicies, and the service-key Secret.     |
| Helm chart                | Shared Gateway, ClusterIP EnvoyProxy, SecurityPolicy, certificates and optional CA issuers, API credential mounts, and API/Envoy NetworkPolicies. |
| Kubernetes Compute Driver | Tenant namespace attachment labels, Agent HTTPRoutes, gateway Services, and tenant NetworkPolicies through worker reconciliation.                 |
| OCC API                   | Caller authorization, endpoint derivation through Compute, and native file RPCs using the mounted service key.                                    |

The shared Gateway and certificate resources live in the Helm release namespace.
Envoy's data-plane Service and Pods live in `envoyNamespace`. Each Agent's
HTTPRoute and gateway Service live in its tenant Kubernetes namespace.
The installer needs permission to create the shared resources, including the
NetworkPolicy in the Envoy namespace. The worker needs tenant HTTPRoute
permissions; the API needs no route-write or gateway Pod/exec permissions.

## Endpoint and route

The private endpoint is:

```text
wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>
```

With no explicit hostname, Helm and Compute independently derive:

```text
serviceName = occ-gateway-<first 12 hex characters of SHA-256(gatewayNamespace/gatewayName)>
hostname    = <serviceName>.<envoyNamespace>.svc
```

The chart sets Envoy's Service name to this value. Standard Linux Pod DNS search
resolves it without a separate DNS record or a fixed `cluster.local` suffix.
An explicit hostname must match in Helm and Compute and resolve to the Envoy
Service. The listener certificate uses that same hostname.

`getGatewayEndpoint(revision)` computes the URL without a Kubernetes lookup; a
returned URL does not establish gateway readiness. Preparation and activation
reconcile an HTTPRoute attached to the shared Gateway's `https` listener. It
matches the exact hostname and forwards to the Agent's same-namespace Service.
The exact Agent path rewrites to `/`; a bounded prefix rule preserves suffixes
for native UI traffic. See the [Kubernetes route rules](drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes).
TLS terminates at Envoy; the backend plaintext HTTP/WebSocket hop is restricted by NetworkPolicy.

The route and Service stay stable across revision cutover and gateway Pod
replacement. Retiring an older revision preserves a newer gateway's route;
final gateway cleanup removes the owned route. Repair runs during revision
reconciliation, without a separate periodic route-repair loop.

## Service key and native identity

The service key is **operator-created**, including when CA setup is automatic.
Generate 32 random bytes encoded as hex without a trailing newline and store
them in a dedicated Opaque Secret under the key `occ`. Set
`gatewayRouting.apiKeySecretName` to its name. The Secret belongs in the Helm
release namespace; the [setup procedure](../guides/deploy/workspace-routing.md#agent-workspace-files)
provides the commands.

Helm mounts that Secret only into the OCC API at
`/etc/openclaw/gateway-api-key/key` and sets `OCC_GATEWAY_API_KEY_PATH`.
The Gateway-level SecurityPolicy references the same Secret. OCC reads the key
for each operation and sends it as `x-api-key`. Envoy validates and strips that
header before forwarding.

The HTTPRoute sets `x-occ-identity: occ-workspace-files` and sets `x-real-ip`
from Envoy's direct downstream connection. It removes `x-forwarded-for`,
`forwarded`, and `x-openclaw-scopes`. Each Agent's native Configuration must
select trusted-proxy auth, trust the actual proxy source CIDRs, enable
`allowRealIpFallback`, accept the fixed identity header and user, and grant
that identity `operator.admin`. Compute validates those settings and omits
gateway-token projection in this mode. See the complete
[native configuration fragment](../guides/deploy/workspace-routing.md#agent-workspace-files).

This key grants native administrative access across the Installation's routed
gateways. OCC separately checks the caller's exact Agent permission. Keep the
key separate from Better Auth, provider, and native Agent credentials; workers
and Agent workloads do not receive it.

## TLS and certificate lifecycle

When `issuerRef.name` is empty, Helm creates a namespaced SelfSigned Issuer,
a root CA Certificate, and a CA Issuer for the listener certificate.
cert-manager generates and stores the key material.

| Certificate | Requested lifetime | Renew before expiry | Additional settings                                     |
| ----------- | ------------------ | ------------------- | ------------------------------------------------------- |
| Root CA     | 87,600 hours       | 720 hours           | ECDSA P-256; `isCA: true`; key rotation policy `Never`. |
| Listener    | 2,160 hours        | 720 hours           | DNS name equals the routing hostname.                   |

The API Pod receives only the root Secret's public `tls.crt`, mounted as
`ca.crt`, and loads it through `NODE_EXTRA_CA_CERTS`. It waits for the Secret
before starting. The CA signing key is never mounted into OCC. Normal CA and
hostname verification remain enabled; OCC does not pin the listener leaf.

To use an existing issuer, set `issuerRef.name` and its kind/group. Set
`caSecretName` and `caSecretKey` together if the API needs an additional public
CA bundle; otherwise it uses Node's existing trust store. Explicit CA trust
requires an explicit issuer. Keep root, listener, service-key, and other
credential Secrets distinct.

OCC rereads the service-key file for new operations, allowing projected Secret
updates without an API restart after Envoy also observes the update. Rotation
is not coordinated atomically between those consumers. Node loads additional
CA trust at process startup: changing the trust bundle requires an API restart.
Listener renewal under the existing CA does not require changing OCC trust.

## Routing configuration

Helm's `gatewayRouting` settings configure shared infrastructure:

| Setting                        | Default or requirement                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `enabled`                      | `false`; enable to render routing resources and API mounts.                    |
| `gatewayClassName`             | Required existing Envoy GatewayClass.                                          |
| `gatewayName`                  | `<release>-agent-gateways`.                                                    |
| `envoyNamespace`               | `envoy-gateway-system`.                                                        |
| `hostname`                     | Empty derives the Service DNS hostname.                                        |
| `apiKeySecretName`             | Required operator-created Secret with entry `occ`.                             |
| `issuerRef.name`               | Empty creates the private CA and issuers.                                      |
| `issuerRef.kind` / `group`     | `ClusterIssuer` / `cert-manager.io` for an explicit issuer.                    |
| `caSecretName` / `caSecretKey` | Empty; optional public trust bundle with an explicit issuer.                   |
| `tlsSecretName`                | `<gatewayName>-tls`, truncated to 63 characters with trailing hyphens removed. |
| `tenantGatewayPort`            | `8080`; must equal Compute's `network.gatewayPort`.                            |
| `envoyHttpsTargetPort`         | `10443`; NetworkPolicy port for the Envoy listener Pod.                        |
| `envoyGatewayPodLabels`        | Chart defaults select the Envoy Gateway controller for control-plane egress.   |

The Installation's `drivers.compute.configuration.gatewayRouting` separately
requires `gatewayName`, `gatewayNamespace`, and `envoyNamespace`; `hostname` is
optional. Match the Helm values and use the release namespace for
`gatewayNamespace`. Helm does not rewrite the Installation Secret. Remove
`network.gatewayClients` when enabling routing: Compute derives the Envoy peer
and rejects explicit clients in this mode. Restart API and worker after changing
their Installation startup configuration. Adding an Agent requires no endpoint
map or controller restart.

## Network enforcement and failures

Envoy ingress is restricted to the selected OCC API Pods. Its egress permits
tenant gateway traffic, configured DNS, and the Envoy Gateway control-plane
connection. Tenant gateway ingress permits the selected Envoy Pods. The Gateway
accepts HTTPRoutes only from namespaces bearing its attachment label.

These restrictions require an enforcing Kubernetes network plugin and trusted
writes to routes, policies, attachment labels, and native Configuration. The
native real-IP fallback requires a nonloopback OCC connection address; a
loopback port-forward alone does not provide working attribution.

| Symptom                                            | Check                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Helm render fails                                  | Required GatewayClass/service-key settings and distinct Secret names.                                   |
| API Pod waits or startup fails                     | Service-key/root-CA Secret availability and valid key-file contents.                                    |
| Agent reconciliation fails                         | Routing/native-auth configuration, installed CRDs, and worker RBAC.                                     |
| Workspace API returns `503 DEPENDENCY_UNAVAILABLE` | Endpoint support, active gateway, DNS, TLS trust, key agreement, route attachment, and NetworkPolicies. |
| A write returns `503 UNKNOWN_OUTCOME`              | Read the file before deciding whether to resubmit; OCC does not replay uncertain writes.                |

The Kubernetes Driver implements optional `ComputeDriver.getGatewayEndpoint`;
it returns no endpoint when routing is unconfigured. The Docker Driver does
not implement this method. Its localhost gateway port publication does not
enable workspace-file access through the standard OCC composition.

## Native admin UI routing

Agent native admin UI access reuses the same private Envoy routing primitive as
workspace files. The public browser hosts are operator-owned wildcard names
served by the OCC API process, using `agentNativeAdmin.domain`; Envoy and Agent
gateway Services remain private ClusterIP resources. The Agent hosts share the
ordinary OCE session cookie through the configured `agentNativeAdmin.sharedCookieDomain`,
so every matching console and Agent subdomain must be a trusted OCE ingress
endpoint. OCC authenticates and authorizes the human session before proxying,
then strips browser cookies and credentials before forwarding to Envoy.

The private Compute endpoint remains:

```text
wss://<private-host>/namespaces/<namespaceId>/agents/<agentId>
```

OCC converts that endpoint to `https:` for native UI HTTP traffic while keeping
the same private authority and exact Agent base path. Workspace-file traffic
continues to use the original WSS endpoint. Native-host requests are
intercepted before the normal API not-found path, resolved to the exact Agent
represented by the host, and checked against the current active revision before
the API proxies HTTP or WebSocket traffic through the private route.

## Source and verification

- [Helm values](../../deploy/helm/openclaw-enterprise/values.yaml),
  [routing resources](../../deploy/helm/openclaw-enterprise/templates/gateway-routing.yaml),
  [naming and validation](../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl),
  and [API mounts](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml).
- [Kubernetes route contract](drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
  and [workspace-file execution flow](../flows/workspace-files.md).
- [Private-routing testing](../testing/kubernetes.md#kubernetes-model-turns-and-secrets).
