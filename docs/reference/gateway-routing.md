# Gateway routing with Envoy

The OpenClaw Control Plane (OCC) uses Envoy Gateway to read and write Agent
workspace files on Kubernetes. A private HTTPS listener routes each Agent URL
to that Agent's native OpenClaw gateway:

```text
OCC API -- WSS + service key --> Envoy -- WebSocket --> Agent gateway Service
```

For installation commands, use [Configure private Agent workspace routing](../guides/deploy/workspace-routing.md#configure-private-routing).
For caller permissions and file operations, see the
[workspace-files API](agents.md#workspace-files).

## Resources and ownership

| Owner                     | Resources or responsibility                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation operator     | Envoy Gateway and cert-manager controllers, Gateway API CRDs, an existing GatewayClass, enforced NetworkPolicies, and the service-key Secret.                   |
| Helm chart                | Shared Gateway, ClusterIP EnvoyProxy, SecurityPolicy, certificates and optional CA issuers, API/worker credential mounts, and controller/Envoy NetworkPolicies. |
| Kubernetes Compute Driver | Tenant attachment labels, Agent HTTPRoutes and node-route SecurityPolicies, gateway Services, and tenant NetworkPolicies through worker reconciliation.         |
| OCC API                   | Caller authorization, endpoint derivation through Compute, and native file RPCs using the mounted service key.                                                  |
| OCC worker                | Native node enrollment through Compute, using the mounted service key and revision-owned enrollment Secrets.                                                    |

The proxy Pods inherit `controlPlane.nodeSelector` from Helm values, keeping
credential verification on the trusted OCC pool. Install the separately managed
Envoy Gateway and cert-manager controllers on trusted nodes as well.

The shared Gateway and certificate resources are in the Helm release namespace.
Envoy's proxy Service and Pods are in `envoyNamespace`. Each Agent's HTTPRoute
and gateway Service are in its tenant namespace, or for a dedicated Agent in the
two-cluster profile, its `oce-gateways-<hash>` namespace in the control cluster.
The installer needs
permission to create the shared resources, including the NetworkPolicy in the
Envoy namespace. The worker needs tenant HTTPRoute and SecurityPolicy permissions; the API does
not need to write routes or execute commands in gateway Pods.

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

`getGatewayEndpoint(revision)` computes the URL without a Kubernetes lookup;
it does not check whether the gateway is ready. When preparing and activating a
revision, Compute creates or updates an HTTPRoute attached to the shared
Gateway's `https` listener. The route matches the exact hostname and forwards
to the Agent Service in the same namespace. The exact Agent path rewrites to
`/`; a bounded prefix rule preserves suffixes for native UI traffic. See the
[Kubernetes route rules](drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes).
TLS ends at Envoy. From there, plaintext HTTP and WebSocket traffic to the
gateway is restricted by NetworkPolicy.

The route and Service stay stable when a revision is activated or a gateway Pod
is replaced. Retiring an older revision preserves the newer gateway's route;
final gateway cleanup removes it. Compute repairs the route while reconciling
a revision. There is no separate periodic repair.

### Native node endpoint

Runtime-enabled dedicated revisions also receive an exact `/node` route and an
exact `/node/__openclaw__/worker` route under the same Agent URL, hostname and
`https` listener, plus `/node/__openclaw__/worker-bundle/v1/` and
`/node/__openclaw__/worker-transfer/v1/` prefix routes. All use the same backend
Service; the worker routes rewrite to OpenClaw's `/__openclaw__/` ingress paths.
The route removes `x-occ-identity`, `x-api-key`, `authorization`, `cookie`,
forwarded identity and scope headers, and Tailscale identity headers while
setting `x-real-ip` from Envoy's downstream socket. This preserves trusted
proxy attribution without granting the OCC administrative identity. The bundle
and transfer routes keep `authorization`, because those worker requests carry
their own one-time bearer tokens.

Compute attaches a tenant-local SecurityPolicy with no authentication fields
to this node HTTPRoute. Envoy Gateway v1.6.7 replaces the entire inherited
Gateway policy at this more specific scope, so the node route does not require
the OCC service key. Native OpenClaw verifies the signed device identity and
node-only bootstrap or device token. Invalid credentials and attempts to use
node credentials as an operator fail at the native Gateway. Worker callbacks
authenticate their first WebSocket frame with the Gateway-minted, session-bound
worker admission credential; the Harness never receives the OCC service key.

Dedicated Codex also receives a POST-only
`/node/__openclaw__/native-hook/` prefix, rewritten to
`/__openclaw__/native-hook/`. It preserves the Authorization header while
removing the administrative identity headers listed above. OpenClaw authenticates
each callback with its per-relay capability and generation; this route does not
grant node or operator access. Compute derives the callback URL from this Agent's
private endpoint and refuses a caller-selected override.

The Gateway delivers each hook capability through its authenticated Codex
app-server connection. The Harness stores it under `/home/node/.oce-native-hooks`
with a private directory mode, outside the workspace and file-transfer roots.
This directory is ephemeral Pod state. It is not an isolation boundary against
compromised Harness code running as the same user. Gateway checks bind each
capability to this Agent's live provider/relay and exact generation; it grants
neither another Agent's callbacks nor node or operator access. Native hooks use the installation's public CA bundle
with normal HTTPS certificate verification.

Preparation creates or repairs these resources under the serving Gateway's
revision. Preparing a replacement preserves that ownership until activation
replaces the Deployment.
Stop and retirement remove the exact revision's node route before
its policy, checking ownership and deletion UIDs; newer revisions remain.
The Compute enrollment path also admits Harness egress to this installation's
Envoy Pods on the configured HTTPS target port. File, Memory and Skills access
use the enrolled node. Dedicated Gateway does not mount the Harness workspace
or generated-image directories; sessions stay in Gateway private storage.
Native runtime and Envoy integration verification remain incomplete. See the
[enrollment trace](../flows/workspace-files.md#6-compute-resolves-a-route-and-occ-loads-the-current-key).
Real Envoy node-authentication verification is described in
[routing tests](../testing/gateway-routing.md).

## Service key and native identity

The Installation operator must create the service key, even when the certificate
authority (CA) is created automatically. Generate 32 random bytes encoded as
hex without a trailing newline and store the result in a dedicated Opaque
Secret under the key `occ`. Set `gatewayRouting.apiKeySecretName` to its name.
The Secret belongs in the Helm release namespace; see the [setup commands](../guides/deploy/workspace-routing.md#configure-private-routing).

Helm mounts that Secret into the OCC API and worker at
`/etc/openclaw/gateway-api-key/key` and sets `OCC_GATEWAY_API_KEY_PATH`.
The Gateway-level SecurityPolicy references the same Secret. OCC reads the key
for each operation and sends it as `x-api-key`. Envoy validates and strips that
header before forwarding.

The tenant-worker role grants Secret get/create/update/delete for admitted Gateway
credential delivery and Compute-owned node enrollment. Operators bind this role
only in approved tenant runtime namespaces; the chart creates no
cluster-wide binding for it. The worker
is part of the trusted control plane. Harnesses receive a node-only setup code
and public CA bundle, never this administrative service key.

The HTTPRoute sets `x-occ-identity: occ-workspace-files` and sets `x-real-ip`
from Envoy's direct downstream connection. It removes `authorization`, `cookie`,
`x-forwarded-for`, `forwarded`, and `x-openclaw-scopes`. Kubernetes Compute renders native
trusted-proxy auth from the operator's `network.gatewayTrustedProxyCidrs`, enables
`allowRealIpFallback`, and grants the fixed identity `operator.admin`. Agent
Configuration cannot override that trust boundary. A direct loopback connection
can still use the Driver-managed gateway password if the native Configuration
explicitly selects its [environment SecretRef](drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials).
This password is separate from the Envoy service key. See the complete
[operator proxy trust setup](../guides/deploy/workspace-routing.md#configure-native-gateway-authentication).

This key grants native administrative access across the Installation's routed
gateways. OCC separately checks the caller's exact Agent permission. Keep the
key separate from Better Auth, provider, and native Agent credentials. The trusted
OCC API and worker receive it; Agent Gateway and Harness Pods do not.

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
`caSecretName` and `caSecretKey` together if OCC needs an additional public
CA bundle; otherwise it uses Node's existing trust store. Explicit CA trust
requires an explicit issuer. Keep root, listener, service-key, and other
credential Secrets distinct.

OCC rereads the service-key file for new operations, allowing projected Secret
updates without an API restart after Envoy also observes the update. Rotation
is not coordinated atomically between those consumers. Node loads additional
CA trust at process startup: changing the trust bundle requires restarting both
the API and worker. Workspace nodes receive a public CA snapshot at launch;
their Harness workloads also need replacement when that trust changes.
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
optional. `endpointPort` defaults to `443`. Set it only when the external load
balancer exposes the Gateway listener on another port; Helm does not configure
that external mapping. `envoyHttpsTargetPort` defaults to `10443` and must match Helm's value,
so the Harness egress rule permits the listener's actual Pod port.
Match the Helm values and use the release namespace for
`gatewayNamespace`. Helm does not rewrite the Installation Secret. Remove
`network.gatewayClients` when enabling routing: Compute derives the Envoy peer
and rejects explicit clients in this mode. Restart API and worker after changing
their Installation startup configuration. Adding an Agent requires no endpoint
map or controller restart.

## Network enforcement and failures

Envoy ingress permits the selected OCC API/worker Pods and Harness Pods in
attached tenant namespaces. It also permits OpenShell supervisor Pods from those
namespaces because the supervisor opens policy-enforced Harness connections.
The namespace attachment label limits both sources to this Gateway. Envoy egress
permits tenant gateway traffic, configured DNS, and the Envoy Gateway
control-plane connection. Tenant gateway ingress permits the selected Envoy
Pods. The Gateway accepts HTTPRoutes only from namespaces bearing its attachment
label.

These restrictions require a Kubernetes network plugin that enforces
NetworkPolicy. Only trusted actors can be allowed to change routes, policies,
attachment labels, or native Configuration. For proxied connections, the
native real-IP fallback requires OCC to connect from a nonloopback address;
a loopback port-forward alone cannot supply the caller's address.

| Symptom                                            | Check                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Helm render fails                                  | Required GatewayClass/service-key settings and distinct Secret names.                                   |
| API Pod waits or startup fails                     | Service-key/root-CA Secret availability and valid key-file contents.                                    |
| Agent reconciliation fails                         | Routing/native-auth configuration, installed CRDs, and worker RBAC.                                     |
| Workspace API returns `503 DEPENDENCY_UNAVAILABLE` | Endpoint support, active gateway, DNS, TLS trust, key agreement, route attachment, and NetworkPolicies. |
| A write returns `503 UNKNOWN_OUTCOME`              | Read the file before deciding whether to resubmit; OCC does not replay uncertain writes.                |

The Kubernetes Driver implements the optional `ComputeDriver.getGatewayEndpoint`
method. It returns no endpoint when routing is not configured. The Docker Driver
does not implement this method; exposing its gateway port on localhost does
not enable workspace-file access through OCC.

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

## Public preview routing

Optional `gatewayRouting.sandbox` in Kubernetes Compute adds a stable per-Agent
HTTPS origin for dedicated execution under the operator's preview domain.
Embedded OpenClaw retains its native preview configuration. Compute owns the native
`sandboxOrigin` and `sandboxPort` values and rejects conflicting Agent settings.
The sandbox backend port is `network.gatewayPort + 1`, so the main port must be
below 65535. The selected runtime must support the dedicated sandbox listener.

The Agent's `-sandbox` HTTPRoute attaches only to the shared Gateway's separate
`sandbox` listener. It accepts GET and HEAD and forwards to the sandbox port,
never the administrative Gateway port. Cookies, authorization, API keys and
native identity headers are removed. A route-specific SecurityPolicy permits
public shell and renderer assets without granting the OCC administrative identity.
The runtime owns shell CSP, resource allowlisting and iframe isolation; private
HTML content still arrives through the authenticated native UI.

Sandbox routes and policies follow serving revision ownership. Replacing a Pod
keeps the origin stable; stopping or deleting its serving revision removes the
route before its policy. Retiring an older revision preserves newer resources.
An Agent-owned ingress policy and the Envoy egress policy admit the additional
backend port only when configured. Agent deployment reconciles preview ingress
even when the tenant namespace already exists. Helm requires explicit ingress peers on the separate listener,
a wildcard certificate, and a domain outside the shared session cookie scope.
See [HTML preview setup](../guides/deploy/native-admin.md#enable-html-previews).

## Source and verification

- [Helm values](../../deploy/helm/openclaw-enterprise/values.yaml),
  [routing resources](../../deploy/helm/openclaw-enterprise/templates/gateway-routing.yaml),
  [naming and validation](../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl),
  and [API mounts](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml).
- [Kubernetes route contract](drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
  and [workspace-file execution flow](../flows/workspace-files.md).
- [Private-routing testing](../testing/kubernetes.md#kubernetes-model-turns-and-secrets).
