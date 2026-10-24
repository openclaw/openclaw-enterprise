# Kubernetes networking and isolation

Configure tenant network boundaries, private Agent routes, and existing
namespace ownership for the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Networking

Configure cluster DNS namespace/Pod labels and gateway port. Peer namespaces
must be DNS labels of at most 63 characters. `network.gatewayTrustedProxyCidrs`
requires nonempty proxy socket-source CIDRs; it has no production default and
rejects all-source ranges, including IPv4-mapped equivalents. Without private
routing, set `network.gatewayClients` namespace/Pod selectors for the authenticated proxy.

`podLabels` use [Kubernetes label syntax](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set), checked before provisioning.
For every peer selector, values may be empty; key names and values allow 63
characters, DNS prefixes 253.

Each tenant starts with default-deny ingress and egress. Explicit policies allow
DNS (UDP/TCP ports `53` and `5353` through `allow-dns`), approved gateway clients,
and required communication between an Agent's gateway and dedicated Harness.
Cross-tenant traffic, traffic between different Agents, Kubernetes API access,
and cloud metadata access remain denied where those addresses fall inside the
model egress exclusions below.

A provisioning Sandbox Driver may own the dedicated Harness endpoint. Configure
`network.providerHarness` with its namespace, Pod labels, Service ClusterIP in
`address`, and `port`. Compute maps the hostname to that address,
limits Gateway egress to the peer, and disables its direct Harness route.
This ClusterIP bridge supports only owned k3d profiles advertising
`*.openshell.localhost`; production cannot use it. Drivers without
the endpoint capability retain ordinary Service or private routing.

For startup, plugin and deployment diagnostics, set
`network.pluginStatusProxySourceCidrs` to the API server's Pod-proxy source
addresses as `/32` or `/128`: wider ranges warn; all-address ranges fail.
On overlays, the source can be the control-plane node's overlay address. Verify
each node's actual source address with enforced policies. This allows only private TCP/18791, including Agents without plugins.
API and worker ServiceAccounts need namespace-local `get` on `pods/proxy`.
Omission adds no ingress rule, potentially blocking diagnostics, and restarts the
Gateway once per dedicated Codex first deploy. It grants neither native Gateway
nor Kubernetes API access.

With private Agent routing, Compute derives its Gateway ingress peer
from `gatewayRouting`: the Envoy namespace and the Gateway's exact owning name
and namespace labels. Omit `network.gatewayClients`; startup rejects explicit
clients in routed mode. The native gateway trusts
the proxy's source range; NetworkPolicy distinguishes the authenticated proxy
from other Pods in that range. Remove direct API or tenant-workload access to
the native gateway port in this mode.

### Gateway authentication

Compute retains OCC's machine administration and preserves explicit native human
identities and grants. Human access requires a separate operator-managed ingress;
see [Gateway authentication](gateway-authentication.md) for trust settings,
identity validation, network requirements and withdrawal limits.

For Agent revisions with repository bindings, Compute grants credential-service egress to
the embedded gateway/Harness or dedicated Codex Pod. The separate dedicated
gateway receives no repository egress rule. With `repositoryCredentials.enabled`,
Helm admits TCP/8443 ingress to the worker's credential sidecar from managed
gateway Pods carrying an Agent label, and managed dedicated Agent Pods carrying
both Agent ID and Agent revision ID labels. Each peer also requires the tenant namespace
label. These selectors permit transport; the credential service still validates
the session and repository grant.

Compute projects repository broker policy to the actual Codex consumer: the
Agent Pod for dedicated Codex, or the gateway for embedded OpenClaw with
`plugins.driver.implementation: occ/codex-plugin`. Embedded OpenClaw using
`occ/openclaw-plugin` or no PluginDriver selection receives no Codex projection.

Selected Codex plugins get filesystem-only, read-only access to
`/app/node_modules/openclaw`, `/home/node/.openclaw/plugin-skills` and
`/home/node/openclaw-runtime-assets/plugin-skills`. This enables neither proxy
networking, repository credential paths nor whole-filesystem reads, and leaves
project write permissions unchanged.

For Codex consumers with repository bindings, Compute also adds the exact broker
hostname from admitted session material to the tool proxy's domain allowlist and
sets stock Codex `allow_local_binding = true` and `mode = "full"`. An explicit
deny matching the broker hostname fails closed. The repository-bound filesystem
profile additionally grants read-only access to the repository client at
`/opt/oce/repository-credentials` and admitted session material at
`/run/oce/repository-credentials`. Dedicated Codex with an enabled proxy also
reads `/home/node/.codex/skills/.system`, even without a binding. Embedded
Codex uses another home; a disabled proxy stays disabled.

These settings apply to the Agent's whole tool proxy: local binding is allowed,
Codex's additional private-address guard is disabled, and every HTTP method is
allowed at otherwise allowed destinations. Domain rules match hostnames, not
ports: an allowed host is reachable on any port permitted by the lower network
layers. Managed requirements
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
prepared Agent revision ID. Stop leaves it and the Agent's runtime and plugin-status
policies, selecting no Pod, until the next preparation or Agent deletion.
Channels require an approved HTTP(S) proxy in `runtime.channels`: a literal IP
endpoint, or the exact
Helm-managed proxy Service URL paired with `runtime.channels.managedProxy`.
Direct public channel-provider access is denied.

## Explicit network profiles

Ordinary DNS, model, repository-credential, authentication, channel, workspace-node,
plugin-status, sandbox-preview ingress and gateway/Harness allow policies require the reserved Pod label
`openclaw.dev/network-profile=broad-egress-v1` plus their existing
role, Agent ID, Namespace ID and Agent revision ID selectors. Gateway/Harness peer selectors require the
same profile. Missing, empty or unknown profiles receive no ordinary grant;
default-deny policies still select every Pod in each runtime target.

Compute assigns this profile to ordinary embedded and dedicated workload
templates, preserving routes and ports. Readiness requires
the expected template profile.

Harness Pods provisioned by a SandboxDriver, such as OpenShell, carry
`provider-fenced-v1` instead. The provider fences their egress, so Compute grants
them only Gateway transport and status ingress (`allow-agent-runtime` is
ingress-only for them) and the workspace-node route: no DNS, model or
authentication egress.
Provider Harness readiness and activation reject other Pod profiles.

Policy names stay stable; controller upgrades restart no Pod.
Compute preserves existing namespace policy selectors until recreation. During
Agent preparation, it adds missing DNS ports to the tenant and Gateway policies
with UID/resource-version guards, preserving peers and other rules. Running Pods
retain their templates until Compute prepares a version for their Agent:

- Preparing a version re-renders that Agent's grants and templates with the
  profile; other Agents are untouched. Preparing the selected version again (as
  repository-credential maintenance does) rolls its Pods once.
- An unprofiled embedded or dedicated Gateway keeps serving with its Gateway
  grants during the next preparation, exempt from the profile check. The stable
  Agent Service stays unchanged. Activation replaces the predecessor.

Existing OpenShell Sandboxes are not relabeled because Sandbox names use the
Agent revision ID: redeploy the Agent. For development, follow the
[development recovery procedure](../../../guides/deploy/local-operations.md#build-images-for-local-kubernetes).

The separately installed OpenShell gateway needs separate scoped DNS/API and
callback policies. Its caller, the OpenShell supervisor Pod
(`openshell.ai/boundary-role=supervisor`), carries no `openclaw.dev` labels, so
supervisor-labelled peers admit it; an Agent Gateway admits only its Sandbox's.
Platform services keep their Helm policy selectors.

Profile assignment is a trusted controller decision. The label qualifies a Pod
for network grants but supplies no workload identity or authorization to
request them. Operators must control workload creation, profile-label
mutation and NetworkPolicy writes; this Driver installs no admission controls
for them.

Kubernetes combines grants from every matching policy, so stale or additional
allow policies can bypass this. Inspect installed policies and
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

Routing requires these three settings. Gateway name/namespace must match Helm's
Gateway in its release namespace; `envoyNamespace` selects its data-plane Pods.
`envoyHttpsTargetPort` defaults to `10443` and must match Helm. Compute grants
Harness egress only to these Envoy Pods/port, including before enrollment.
`endpointPort` defaults to `443`; it changes only generated WSS URLs. When set,
configure the external load balancer to forward that port to the HTTPS listener.

When `hostname` is omitted or empty, Compute and Helm derive the same Envoy
Service hostname without a lookup; see
[endpoint and route](../../gateway-routing.md#endpoint-and-route). Set the same
explicit `hostname` in Compute and Helm for custom DNS or clients outside that
cluster DNS context. Install Envoy Gateway and cert-manager and configure
[private gateway infrastructure](../../../guides/deploy/workspace-routing.md#agent-workspace-files).
Do not put an Agent endpoint, service key, certificate, or file contents into
native Configuration or an AgentRevision.

`getGatewayEndpoint` derives `wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>`
without Kubernetes calls. Preparation/activation reconcile an owned `HTTPRoute`
in the Gateway's physical namespace (control plane: dedicated; data plane: embedded).
It attaches to the Gateway's `https` listener; both rules match its private
hostname and same-namespace Service:

- The exact Agent path rewrites to `/`, preserving workspace-file WSS access.
- A prefix rule below that Agent path rewrites the prefix to `/` and retains
  the suffix for native UI assets, deep links, and WebSocket paths.

OCC bounds proxy requests to the selected Agent base. Public native UI browser
traffic enters through OCC; Envoy and gateway Services remain private. See
[Agent native admin UI](../../agent-native-admin.md#agent-host-identity).
Namespaces receive the Gateway membership label used by `allowedRoutes`.
Runtime-enabled dedicated versions receive a `/node` route and a
route-specific SecurityPolicy for native device authentication. The
[routing reference](../../gateway-routing.md#native-node-endpoint) owns its
credential boundary and the remaining Harness lifecycle requirements.

The Service and route stay stable across version changes and are repaired only
during deployment reconciliation; see
[endpoint and route](../../gateway-routing.md#endpoint-and-route). Missing CRDs
or denied worker permissions fail reconciliation rather than disabling routing
silently.

Envoy authenticates the service key and rewrites identity headers
([native identity](../../gateway-routing.md#service-key-and-native-identity)).
`allowRealIpFallback` accepts Envoy's nonloopback downstream address when it shares
OCC's Pod CIDR. Loopback port-forwarding alone cannot supply native attribution.

## Namespaces and isolation

Single-cluster Compute shares one created or adopted tenant namespace, labeled
`openclaw.dev/namespace=<namespaceId>` and
`openclaw.dev/gateway-namespace=<namespaceId>`. Secret and Configuration Drivers
require one owned storage target; adopted targets require restricted Pod Security.
Discovery excludes OCC's namespace.

Only the experimental two-cluster profile creates `oce-gateways-<hash>` in the
control cluster, with the first 24 hexadecimal characters of `sha256(namespaceId)`.
That target has the storage-role label and omits the tenant discovery label.

Compute prepares restricted Pod security, quotas/defaults and default-deny/DNS
policies per target. Dedicated Gateway/Harness Pods, ServiceAccounts, private
PVCs and credential mounts stay separate. Harness projections exclude Gateway
password/channel credentials; OCE does not project Harness model credentials
into dedicated Gateways. Humans with native `operator.write` can separately save
personal model accounts in the Gateway's persistent profile store; those
credentials and session selections survive access withdrawal.
Namespace-wide Pod/Secret privileges, quotas and deletion affect both roles,
so workload managers are trusted for both.
Namespace **and** Pod selectors admit only the Agent's selected Harness revision
on app-server/plugin-status ports. DNS: `agent-<hash>.<harness-namespace>.svc`.
Active Harness Service labels match policy selectors: network-profile,
Namespace, Agent, Agent revision ID and workload-role. Successors change the
selector only at activation; deactivation restores an inactive selector.
Gateway Services use Namespace/Agent/gateway-role labels to match policies
independently of Agent revision ID. These selectors support the
[AWS VPC CNI pre-DNAT policy resolution requirement](https://github.com/aws/amazon-network-policy-controller-k8s#networkpolicy-podselector-must-match-the-target-services-selector).
App-server transport is capability-token `ws://`, not mTLS; cross-cluster
transport and runtime attestation are not implemented.

Stop/retirement retain durable claims. Agent deletion removes owned claims and
credentials by UID regardless of draft execution mode. Namespace deletion removes
managed tenant namespaces or only owned resources in adopted targets, preserving
adopted ownership metadata. Two-cluster deletion also removes the exact-owned
Gateway namespace. Both preserve OCC infrastructure. Missing/foreign targets fail preparation.

Identity labels under `openclaw.dev/` contain full platform IDs for ownership,
discovery and network selectors; resource names use shortened hashes to meet
Kubernetes name limits.

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
The worker rechecks
[administrator authorization and foreign ownership](../../security.md#namespace-admission-and-resource-isolation)
before binding the tenant identity; no pause or restart is required.
Missing worker permissions keep provisioning pending; missing API permissions
prevent Configuration access. Docker and external Compute Drivers reject
existing-namespace selection with `409`.

Workload Pods use the restricted
[Pod and container hardening](../../security.md#pod-and-container-hardening),
including the optional `runtime.codexSeccompProfile`, which applies only to the
dedicated Codex Agent container. Agents get identity from an
audience-scoped, short-lived projected ServiceAccount token. Workloads never
receive controller credentials.

## Related

- [Driver configuration and troubleshooting](../kubernetes-compute.md)
- [Kubernetes security controls](../../security.md)
