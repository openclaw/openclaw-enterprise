# Kubernetes networking and isolation

Configure tenant network boundaries, private Agent routes, and existing
namespace ownership for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Networking

Configure the cluster DNS namespace and Pod labels and the gateway port.
Without private routing, also configure the namespace and Pod selectors in
`network.gatewayClients` allowed to access Agent gateways.

Each tenant starts with default-deny ingress and egress. Explicit policies allow
DNS, approved gateway clients, and required communication between an Agent's
gateway and dedicated Harness. Cross-tenant traffic, traffic between different
Agents, Kubernetes API access, and cloud metadata access remain denied.

For Compute-owned startup failure evidence and plugin reporting, set
`network.pluginStatusProxySourceCidrs` to the precise source addresses used by the
Kubernetes API server when proxying requests to workload Pods. The policy allows
those sources only to the private status port, TCP/18791; worker RBAC separately
requires `get` on `pods/proxy`. Prefer individual `/32` or `/128` addresses. On an
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

When native Configuration selects `gateway.auth.mode: "trusted-proxy"`, Compute
omits automatic `OPENCLAW_GATEWAY_TOKEN` projection: native OpenClaw rejects a
simultaneous gateway token. Token mode remains the default. Readiness uses a
Pod-local HTTP request to `127.0.0.1:$OPENCLAW_GATEWAY_PORT/readyz`; TLS terminates
at Envoy, so native readiness probes remain unchanged.

Production currently permits public TCP/443 egress for model access; a
restricted model proxy is not yet available. Channels require an approved
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
`HTTPRoute` in the tenant namespace, attached to the configured Gateway's
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

Each OpenClaw Namespace maps to one Kubernetes namespace. The driver applies
tenant resource quotas, container defaults, and network isolation before
starting Agent workloads. Each Agent receives its own gateway; dedicated Agents
also receive a separate Harness and workload identity.

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
