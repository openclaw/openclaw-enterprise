# Kubernetes networking and isolation

Configure tenant network boundaries, private Agent routes, and existing
namespace ownership for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Networking

Configure the cluster DNS namespace and Pod labels and the gateway port.
Every peer namespace must be a Kubernetes namespace name, a DNS label of at most
63 characters; startup refuses others.
Set `network.gatewayTrustedProxyCidrs` to nonempty, valid CIDRs for the proxy
socket sources. This trusted Installation setting has no production default and
rejects all-source ranges, including IPv4-mapped equivalents. Without private
routing, also configure the namespace and Pod selectors in
`network.gatewayClients` for your authenticated proxy.

`podLabels` use [Kubernetes label syntax](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set), checked before provisioning.
Values may be empty; key names and values allow 63 characters, DNS prefixes 253. This covers
DNS, gateway clients, repository credentials, Provider Harness, and managed channel
proxy peers.

Each tenant starts with default-deny ingress and egress. Explicit policies allow
DNS (UDP/TCP ports `53` and `5353` through `allow-dns`), approved gateway clients,
and required communication between an Agent's gateway and dedicated Harness.
Cross-tenant traffic, traffic between different Agents, Kubernetes API access,
and cloud metadata access remain denied where those addresses fall inside the
model egress exclusions below.

A provisioning Sandbox Driver may own the dedicated Harness endpoint. Configure
`network.providerHarness` with its namespace, Pod labels, Service ClusterIP in
`address`, and `port`. Compute maps the advertised hostname to that address,
limits Gateway egress to the peer, and leaves its direct Harness route inactive.
This ClusterIP bridge is only for owned k3d profiles advertising
`*.openshell.localhost`; it is not production configuration. Drivers without
the endpoint capability retain ordinary Service or private routing.

For Compute-owned startup failure evidence, plugin reporting, and on-demand
deployment diagnostics, set `network.pluginStatusProxySourceCidrs` to the
Kubernetes API server's source addresses for Pod proxy requests, preferably
individual `/32` or `/128` addresses. On overlay networks, the source may be the
control-plane node's overlay address rather than its node IP; verify it across
nodes with enforced policies. The policy allows those sources only to the private
status port, TCP/18791, even when an Agent has no enabled plugins. Worker and API
ServiceAccounts each need namespace-local `get` on `pods/proxy`. An omitted list
adds no API-proxy ingress rule and leaves status unavailable where the cluster
blocks that traffic. It also restarts the Gateway once on each
dedicated Codex first deploy. This setting does not expose the native
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
regardless of order. Deployment and Agent provisioning check the same fields
when they admit a request and answer `409 RESOURCE_CONFLICT` naming the refused
setting and what is accepted, for example `Configuration setting gateway.auth.mode must be
trusted-proxy: …`, never its value. `trustedProxy.allowUsers` is checked later:
provisioning answers the fixed `409` text, with the reason in the API log, and a
deployment is admitted and then fails with `DEPENDENCY_UNAVAILABLE`, with the
reason in the worker's `worker.compute-prepare-failed` line. `trustedProxy.allowLoopback` must be omitted or false:
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
authentication, and identity/header sanitization.
Direct access still requires a trusted proxy or the operator loopback password.

For repository-bearing revisions, Compute grants credential-service egress to
the embedded gateway/Harness or dedicated Codex Pod. The separate dedicated
gateway receives no repository egress rule. With `repositoryCredentials.enabled`,
Helm admits TCP/8443 ingress to the worker's credential sidecar from managed
gateway Pods carrying an Agent label, and managed dedicated Agent Pods carrying
both Agent and revision labels. Each peer also requires the tenant namespace
label. These selectors permit transport; the credential service still validates
the session and repository grant.

Compute projects repository broker policy to the actual Codex consumer: the
Agent Pod for dedicated Codex, or the gateway for embedded OpenClaw with
`plugins.driver.implementation: occ/codex-plugin`. Embedded OpenClaw using
`occ/openclaw-plugin` or no PluginDriver selection receives no Codex projection.

Selected Codex plugins receive a filesystem-only profile that grants read-only
access to the stock runtime package at `/app/node_modules/openclaw` and
published plugin skills at `/home/node/.openclaw/plugin-skills` and
`/home/node/openclaw-runtime-assets/plugin-skills`. It does not enable proxy
networking, grant repository credential paths or whole-filesystem reads, or
change project write permissions.

For Codex consumers with repository bindings, Compute also adds the exact broker
hostname from admitted session material to the tool proxy's domain allowlist and
sets stock Codex `allow_local_binding = true` and `mode = "full"`. An explicit
deny matching the broker hostname fails closed. The repository-bound filesystem
profile additionally grants read-only access to the repository client at
`/opt/oce/repository-credentials` and admitted session material at
`/run/oce/repository-credentials`. Unbound Agents keep their existing policy
without those changes.

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

Model access uses TCP/443 egress to any address outside `10.0.0.0/8`,
`100.64.0.0/10`, `172.16.0.0/12`, `192.168.0.0/16` and `169.254.0.0/16`; a
restricted model proxy is not yet available. Confirm that your API server
endpoint, Pod and Service CIDRs, and metadata endpoint fall inside them. A
dedicated Agent has one authentication-only egress policy, pinned to its latest
prepared revision. Stop leaves it and the Agent's runtime and plugin-status
policies, selecting no Pod, until the next preparation or Agent deletion.
Channels require an approved HTTP(S) proxy in `runtime.channels`: a literal IP
endpoint, or the exact
Helm-managed proxy Service URL paired with `runtime.channels.managedProxy`.
Direct public channel-provider access is denied.

## Explicit network profiles

Ordinary DNS, model, repository-credential, authentication, channel, workspace-node,
plugin-status, sandbox-preview ingress and gateway/Harness allow policies require the reserved Pod label
`openclaw.dev/network-profile=broad-egress-v1` plus their existing
role, Agent, namespace and revision selectors. Gateway/Harness peer selectors require the
same profile. Missing, empty or unknown profiles receive no ordinary grant;
default-deny policies still select every Pod in each runtime target.

Compute assigns this profile to ordinary embedded and dedicated workload
templates without changing their routes or ports. Deployment readiness requires
the expected template profile.

Harness Pods provisioned by a SandboxDriver, such as OpenShell, carry
`provider-fenced-v1` instead. The provider fences their egress, so Compute grants
them only Gateway transport and plugin-status ingress (`allow-agent-runtime` is
ingress-only for them): no DNS, workspace-node, model or authentication egress.
Provider Harness readiness and activation reject a Pod with any other profile.

Existing policy names remain stable; upgrading the controller restarts no Pod.
Compute preserves existing namespace policy selectors until recreation. During
Agent preparation, it adds missing DNS ports to the tenant and Gateway policies
with UID/resource-version guards, preserving peers and other rules. Running Pods
retain their templates until Compute prepares their Agent's revision:

- Preparing a revision re-renders that Agent's grants and templates with the
  profile; other Agents are untouched. Re-preparing an active revision (as
  repository-credential maintenance does) rolls its Pods once.
- An unprofiled embedded or dedicated Gateway keeps serving, with its Gateway
  grants, during the next preparation, which exempts that predecessor from the
  profile check and leaves the stable Agent Service alone. Activation replaces it.

Existing OpenShell Sandboxes are not relabeled because Sandbox names are per
revision: redeploy the Agent revision. For development, follow the
[development recovery procedure](../../../guides/deploy/local-operations.md#build-images-for-local-kubernetes).

The separately installed OpenShell gateway needs its own scoped DNS/API and
callback policies. Its caller is the OpenShell supervisor Pod
(`openshell.ai/managed-by=openshell`, `openshell.ai/boundary-role=supervisor`),
which carries no `openclaw.dev` labels; supervisor-labelled peers admit it, not
the ordinary profile. Platform services retain their existing Helm policy selectors.

Profile assignment is a trusted controller decision. The label qualifies a Pod
for network grants but does not supply workload identity or authorization to
request those grants. Operators must control workload creation, profile-label
mutation and NetworkPolicy writes; this Driver installs no admission controls
for them.

Kubernetes combines grants from every matching policy, so stale or additional
allow policies can bypass this restriction. Inspect installed policies and
[check allowed and denied connections](../../../guides/operate/network-isolation.md)
with NetworkPolicy enforcement.

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

These three settings are required when routing is enabled; `hostname` is
optional. The Gateway name and namespace must match the Helm-managed Gateway,
which the chart always creates in its release namespace; `envoyNamespace`
identifies its Envoy data-plane Pods. `envoyHttpsTargetPort` defaults to
`10443` and must match Helm. Compute grants Harness egress only to this
installation's Envoy Pods on that port, before waiting for node enrollment.
`endpointPort` defaults to `443` and changes only the port in generated WSS URLs.
When set, the external load balancer must forward that port to the HTTPS listener.

When `hostname` is omitted or empty, Compute and Helm derive the same Envoy
Service hostname without a lookup; see
[endpoint and route](../../gateway-routing.md#endpoint-and-route). Set the same
explicit `hostname` in Compute and Helm for custom DNS or clients outside that
cluster DNS context. The operator installs Envoy Gateway and cert-manager and configures the
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

The Service and route stay stable across revision cutover and are repaired only
during revision reconciliation; see
[endpoint and route](../../gateway-routing.md#endpoint-and-route). Missing CRDs
or denied worker permissions fail reconciliation rather than disabling routing
silently.

Envoy authenticates the OCC service key and the route rewrites identity headers
([service key and native identity](../../gateway-routing.md#service-key-and-native-identity)).
Native `allowRealIpFallback` accepts Envoy's direct downstream address when OCC
and Envoy share a Pod CIDR. That address must be nonloopback; a loopback
port-forward alone is not a working native attribution path.

## Namespaces and isolation

Single-cluster Compute shares one created or adopted tenant namespace, labeled
`openclaw.dev/namespace=<namespaceId>` and
`openclaw.dev/gateway-namespace=<namespaceId>`. Secret and Configuration Drivers
require one owned storage target; adopted targets require restricted Pod Security.
Discovery excludes OCC's namespace.

Only the experimental two-cluster profile creates `oce-gateways-<hash>` in the
control cluster, with the first 24 hexadecimal characters of `sha256(namespaceId)`.
That target has the storage-role label and omits the tenant discovery label.

Compute prepares restricted Pod security, quotas, defaults, default-deny and DNS
policies in each target. Dedicated Gateway and Harness Pods, ServiceAccounts,
private PVCs and credential mounts remain separate. Gateway password and channel
credentials never enter the Harness projection; model credentials never enter a
dedicated Gateway. Namespace workload managers are trusted for both roles:
namespace-wide Pod/Secret privileges, quotas and deletion affect both.
Explicit namespace **and** Pod
selectors allow only the same Agent's selected Harness revision on app-server
and private plugin-status ports. DNS uses `agent-<hash>.<harness-namespace>.svc`.
The stable dedicated Harness Service keeps the same network-profile, Namespace,
Agent, revision, and workload-role labels as the gateway egress and Harness ingress policies
while a revision is active. A prepared successor does not change that Service
selector until activation; deactivation moves the Service back to an inactive
selector. Active Gateway Services include Namespace, Agent, and gateway-role
labels, satisfying gateway policy selectors without tying the stable route to a
revision. These Service selectors support the
[AWS VPC CNI pre-DNAT policy resolution requirement](https://github.com/aws/amazon-network-policy-controller-k8s#networkpolicy-podselector-must-match-the-target-services-selector).
App-server transport is capability-token `ws://`, not mTLS; cross-cluster
transport and runtime attestation are not implemented.

Stop and retirement retain durable
claims. Agent deletion removes its owned claims and credentials by UID, independent
of the draft execution mode. Namespace deletion removes the managed tenant
namespace, or only owned resources in an adopted namespace, preserving its ownership metadata. The
two-cluster profile also deletes its exact-owned Gateway namespace. Both preserve
OCC infrastructure. Missing or foreign targets fail preparation.

Identity labels under `openclaw.dev/` contain full platform IDs for ownership,
discovery and network selectors; generated resource names use bounded hashes.

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
`pod-security.kubernetes.io/warn=restricted`, and granting the tenant-local
[worker and API RoleBindings](../../../guides/deploy/production-agents.md#grant-tenant-rolebindings).
The running worker rechecks
[administrator authorization and foreign ownership](../../security.md#namespace-admission-and-resource-isolation)
before binding the tenant identity; no worker pause or restart is required.
Missing worker permissions keep provisioning pending; missing API permissions
prevent Configuration access. Docker and external Compute Drivers reject
existing-namespace selection with `409`.

Workload Pods use the restricted
[Pod and container hardening](../../security.md#pod-and-container-hardening),
including the optional `runtime.codexSeccompProfile`, which applies only to the
dedicated Codex Agent container. Agent identity is provided through an
audience-scoped, short-lived projected ServiceAccount token. Workloads never
receive controller credentials.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Kubernetes security controls](../../security.md)
