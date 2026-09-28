# Kubernetes networking and isolation

Configure tenant network boundaries, private Agent routes, and existing
namespace ownership for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Networking

Configure the cluster DNS namespace and Pod labels and the gateway port.
Set `network.gatewayTrustedProxyCidrs` to a
nonempty list of valid CIDRs for the actual proxy socket sources. This is trusted
Installation configuration; the Driver has no production CIDR default and rejects
all-source ranges, including IPv4-mapped equivalents. Without
private routing, also configure the namespace and Pod selectors in
`network.gatewayClients` for your authenticated proxy.

Each tenant starts with default-deny ingress and egress. Explicit policies allow
DNS, approved gateway clients, and required communication between an Agent's
gateway and dedicated Harness. Cross-tenant traffic, traffic between different
Agents, Kubernetes API access, and cloud metadata access remain denied.

For Compute-owned startup failure evidence, plugin reporting, and on-demand
deployment diagnostics, set
`network.pluginStatusProxySourceCidrs` to the precise source addresses used by the
Kubernetes API server when proxying requests to workload Pods. The policy allows
those sources only to the private status port, TCP/18791. Both worker and API
ServiceAccounts need namespace-local `get` on `pods/proxy` for their respective
reads. The ingress rule also applies when an Agent has no enabled plugins.
Prefer individual `/32` or `/128` addresses. On an
overlay network, the observed source may be the control-plane node's overlay
address rather than its node IP. Verify it across nodes with enforced policies.
An omitted list adds no API-proxy ingress rule and leaves status unavailable
where the cluster blocks that traffic. This setting does not expose the native
gateway or grant workloads Kubernetes API access.

When private Agent routing is enabled, Compute derives the only allowed peer
from `gatewayRouting`: the Envoy namespace and the Gateway's exact owning name
and namespace labels. Omit `network.gatewayClients`; startup rejects explicit
clients in routed mode. The native gateway trusts
the proxy's source range; NetworkPolicy distinguishes the authenticated proxy
from other Pods in that range. Do not retain direct API or tenant-workload
access to the native gateway port for this mode.

### Gateway authentication

Kubernetes Compute supports trusted-proxy gateway authentication only, for
embedded and dedicated Agents, with or without private routing. At deployment,
it renders `gateway.trustedProxies` from `network.gatewayTrustedProxyCidrs`,
`gateway.auth.mode: trusted-proxy`, `userHeader: x-occ-identity`, the allowed
identity `occ-workspace-files` with `operator.admin`, and
`gateway.allowRealIpFallback: true`. Agent Configuration and Console starters
can omit those fields. Unsupported gateway authentication fields or conflicting
tenant trust fields fail deployment; matching explicit CIDR lists are accepted
regardless of order. `trustedProxy.allowLoopback` must be omitted or false:
loopback access uses the separate password, not proxy identity headers. Native
required-header and device auto-approval settings retain their separate purposes.

An optional [loopback password](storage-and-credentials.md#runtime-credentials)
supports operator verification; it does not change the gateway's authentication mode.
Readiness uses a Pod-local HTTP request to
`127.0.0.1:$OPENCLAW_GATEWAY_PORT/readyz`; TLS terminates at Envoy, so native
readiness probes remain unchanged. Docker and SSH default to managed password
authentication and also support explicit trusted proxy.

Operators must verify that the configured CIDRs contain the proxy's actual
source addresses and exclude untrusted sources. CIDRs do not authenticate a
proxy: retain the exact Envoy NetworkPolicy peer, TLS verification, service-key
authentication, and identity/header sanitization. Direct embedded access still
requires a trusted proxy or the optional operator loopback password.

For repository-bearing revisions, Compute grants credential-service egress to
the embedded gateway/Harness or dedicated Codex Pod. The separate dedicated
gateway receives no repository egress rule. With `repositoryCredentials.enabled`,
Helm admits TCP/8443 ingress to the worker's credential sidecar from managed
gateway Pods carrying an Agent label, and managed dedicated Agent Pods carrying
both Agent and revision labels. Each peer also requires the tenant namespace
label. These selectors permit transport; the credential service still validates
the session and repository grant. Verify the effective policies in the installed
cluster; rendered rules alone do not prove traffic enforcement.

Compute projects repository broker policy to the actual Codex consumer: the
Agent Pod for dedicated Codex, or the gateway for embedded OpenClaw with
`plugins.driver.implementation: occ/codex-plugin`. Embedded OpenClaw using
`occ/openclaw-plugin` or no PluginDriver selection receives no Codex projection.

Selected Codex plugins receive a filesystem-only profile that grants read-only
access to the stock runtime package at `/app/node_modules/openclaw` and
published plugin skills at `/home/node/.openclaw/plugin-skills` and
`/home/node/openclaw-runtime-assets/plugin-skills`. This lets sandboxed skill
reads use the installed runtime and packaged skills without enabling proxy
networking, granting repository credential paths, granting whole-filesystem
reads, or changing project write permissions.

For Codex consumers with repository bindings, Compute also adds the exact broker
hostname from admitted session material to the tool proxy's domain allowlist and
sets stock Codex `allow_local_binding = true` and `mode = "full"`. An explicit
deny matching the broker hostname fails closed. The repository-bound filesystem
profile additionally grants read-only access to the repository client at
`/opt/oce/repository-credentials` and admitted session material at
`/run/oce/repository-credentials`. Unbound Agents receive none of those network
or repository-material changes; their existing policy remains in effect.

These settings apply to the Agent's whole tool proxy: local binding is allowed,
Codex's additional private-address guard is disabled, and every HTTP method is
allowed at otherwise allowed destinations. Domain rules match hostnames, not
ports: an allowed host is reachable on any port permitted by the lower network
layers. This is not a broker-only port or method exception. Managed requirements
that forbid local binding or require limited mode reject the conflicting
configuration. Domain allowlisting, explicit denies, Kubernetes NetworkPolicy,
TLS verification, and broker session/repository authorization remain separate
boundaries. The workspace sandbox remains enabled.

Compute supplies the broker's public CA to that consumer before Codex starts. Stock full mode
normally tunnels HTTPS, so Git verifies the broker certificate directly. If
Codex separately requires HTTPS interception, it retains platform and startup
roots upstream and supplies child tools with its managed CA bundle. Preserve
inherited `GIT_SSL_CAINFO`; TLS verification remains enabled in both paths.

Production currently permits public TCP/443 egress for model access; a
restricted model proxy is not yet available. Before readiness, each dedicated
revision receives its own authentication-only egress policy. Concurrent pending
candidates cannot replace each other's grant; stop and retirement remove the
exact revision's policy after its Harness terminates. Channels require an approved
literal-IP HTTP(S) proxy configured through `runtime.channels`; direct public
channel-provider access is denied.

## Private Agent gateway routes

See [gateway routing with Envoy](../../gateway-routing.md) for shared infrastructure,
service-key bootstrap, TLS, and network enforcement.

Runtime-enabled dedicated Harnesses require private routing and node enrollment
before Compute can prepare or activate them. Missing wiring raises a configuration
error before changing workloads; there is no Gateway-local workspace fallback.
Embedded Harnesses can still use direct access.

Installation Compute settings enable stable Agent routes:

```yaml
gatewayRouting:
  gatewayName: oce-agent-gateways
  gatewayNamespace: openclaw-system
  envoyNamespace: envoy-gateway-system
```

The Gateway name and namespace must match the Helm-managed Gateway;
`envoyNamespace` identifies its Envoy data-plane Pods. The chart always creates
the Gateway in its release namespace. These three settings are required when
routing is enabled; `hostname` is optional. `envoyHttpsTargetPort` defaults to
`10443` and must match Helm. Compute grants Harness egress only to this
installation's Envoy Pods on that port, before waiting for node enrollment.

When `hostname` is omitted or empty, Compute and Helm derive the same Service
name: `occ-gateway-` followed by the first 12 hexadecimal characters of the
SHA-256 of `<gatewayNamespace>/<gatewayName>`. The hostname is
`<serviceName>.<envoyNamespace>.svc`. It uses standard Linux Pod DNS search and
does not assume a `cluster.local` suffix. Set the same explicit `hostname` in
Compute and Helm for custom DNS or clients outside that cluster DNS context.
The default needs no existing Agent or Kubernetes lookup.
The operator installs Envoy Gateway and cert-manager and configures the
[private gateway infrastructure](../../../guides/deploy/workspace-routing.md#agent-workspace-files).
Do not put an Agent endpoint, service key, certificate, or file contents into
native Configuration or an AgentRevision.

`getGatewayEndpoint` derives
`wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>` without Kubernetes
API access. During preparation and activation, Compute reconciles an owned
`HTTPRoute` in the Gateway's physical namespace (control plane for dedicated,
data plane for embedded), attached to the configured Gateway's
`https` listener. Both rules match the configured private hostname and target
the existing same-namespace gateway Service:

- The exact Agent path rewrites to `/`, preserving workspace-file WSS access.
- A prefix rule below that Agent path rewrites the prefix to `/` and retains
  the suffix for native UI assets, deep links, and WebSocket paths.

OCC bounds proxy requests to the selected Agent base. Public native UI browser
traffic enters through OCC; Envoy and gateway Services remain private. See
[Agent native admin UI](../../agent-native-admin.md#agent-host-identity).
Namespaces receive the Gateway membership label used by `allowedRoutes`.
Runtime-enabled dedicated revisions also receive a `/node` route and a
route-specific SecurityPolicy for native device authentication. The
[routing reference](../../gateway-routing.md#native-node-endpoint) owns its
credential boundary and the remaining Harness lifecycle requirements.

The Service and route remain stable across revision cutover. Retiring an old
revision preserves a newer gateway's route; final gateway cleanup removes the
owned route. Reconciliation runs through the existing revision lifecycle; this
Driver does not add periodic route drift repair. Missing CRDs or denied worker
permissions fail reconciliation rather than disabling routing silently.

Envoy's Gateway-level SecurityPolicy authenticates the OCC service key before
forwarding. The route overwrites the native identity and real-IP headers and
removes caller forwarding and scope headers. Native `allowRealIpFallback`
accepts Envoy's direct downstream connection address when OCC and Envoy share a
Pod CIDR. That source address must be nonloopback; a loopback port-forward alone
is not a working native attribution path.

## Namespaces and isolation

Each OpenClaw Namespace has a data-plane Kubernetes namespace and a managed
Gateway runtime namespace, `oce-gateways-<hash>`, where `hash` is the first 24
hexadecimal characters of `sha256(namespaceId)`. The latter is discovered by
`openclaw.dev/gateway-namespace=<namespaceId>`; it deliberately omits the
data-plane discovery label `openclaw.dev/namespace`. Existing data-plane
namespace adoption does not adopt or reuse OCC's own namespace for Gateways.

Compute prepares restricted Pod security, quotas, defaults, default-deny and DNS
policies in both targets. Dedicated Gateway resources, private PVCs, configuration,
Services and HTTPRoutes live only in the Gateway target; Harness resources and
model credentials remain in the data target. Explicit namespace **and** Pod
selectors allow only the same Agent's selected Harness revision on app-server
and private plugin-status ports. DNS uses `agent-<hash>.<harness-namespace>.svc`.
The stable dedicated Harness Service keeps the same Namespace, Agent, revision,
and workload-role labels as the gateway egress and Harness ingress policies
while a revision is active. A prepared successor does not change that Service
selector until activation; deactivation moves the Service back to an inactive
selector. Active Gateway Services include Namespace, Agent, and gateway-role
labels, satisfying gateway policy selectors without tying the stable route to a
revision. These Service selectors support the
[AWS VPC CNI pre-DNAT policy resolution requirement](https://github.com/aws/amazon-network-policy-controller-k8s#networkpolicy-podselector-must-match-the-target-services-selector).
Current app-server transport is capability-token `ws://`, not mTLS; this change
does not implement cross-cluster transport or runtime attestation.

Stop and revision retirement inspect both targets and retain durable claims.
Agent deletion removes its owned claims; Namespace deletion deletes only the
exact managed Gateway namespace and preserves an adopted data namespace.
Neither operation may remove shared OCC infrastructure. A missing or foreign
Gateway target fails preparation rather than falling back to data-plane placement.

Identity labels under `openclaw.dev/` contain the full platform Namespace,
Agent, revision, ServiceAccount, ServicePrincipal, or Configuration ID, not a
hash. Ownership checks, discovery, Service selectors, and NetworkPolicies use
those same raw IDs. Generated Kubernetes resource names still use bounded
hashes to satisfy their naming constraints.

An Installation administrator can select an existing, exclusively dedicated
Kubernetes namespace when creating the OpenClaw Namespace:

```json
{
  "name": "customer-support",
  "existingNamespace": "customer-support-prod"
}
```

Prepare the namespace by annotating
`openclaw.dev/namespace-lifecycle=external`, applying
`pod-security.kubernetes.io/enforce=restricted`,
`pod-security.kubernetes.io/audit=restricted`, and
`pod-security.kubernetes.io/warn=restricted`, and granting tenant-local worker
and API RoleBindings. The running worker rechecks Installation administrator
authorization, rejects foreign NetworkPolicies and competing tenant claims, and
binds the generated tenant identity through one resource-version-guarded,
non-forced Kubernetes patch. No worker pause or restart is required. Missing
worker permissions keep provisioning pending; missing API permissions prevent
Configuration access. Docker and external Compute Drivers reject
existing-namespace selection with `409`.

See [tenant RoleBindings](../../../guides/deploy/production-agents.md#grant-tenant-rolebindings)
for the required worker and API grants.

Workload Pods run as nonroot, use `RuntimeDefault` seccomp by default, drop
Linux capabilities, disable privilege escalation, and use read-only root
filesystems. When `runtime.codexSeccompProfile` is configured, only the
dedicated Codex Agent container uses
`seccompProfile: { type: "Localhost", localhostProfile: <profile> }`; the Pod,
gateway container, embedded runtime, controller, and init containers keep their
default seccomp settings. The profile path must be relative to the kubelet's
localhost seccomp profile root and cannot be empty, absolute, traversing, or
unconfined. Agent identity is provided through an audience-scoped, short-lived
projected ServiceAccount token. Workloads never receive controller credentials.

The driver deletes Kubernetes namespaces it created when their corresponding
OpenClaw Namespaces are deleted. For an operator-owned existing namespace, it
removes only its exact-owned quota, limit, and three tenant NetworkPolicies;
the Kubernetes namespace, ownership markers, RoleBindings, and unrelated
resources remain intact.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Kubernetes security controls](../../security.md)
