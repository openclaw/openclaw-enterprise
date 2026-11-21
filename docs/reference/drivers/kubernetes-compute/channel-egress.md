# Managed channel egress

Enable `channelEgress` in Helm and `runtime.channelEgress` in the Kubernetes
Compute configuration before deploying a channel-enabled Agent. The settings
must identify the same dedicated Envoy Gateway, Service and ports. Managed profiles
and Helm default channel egress on; an explicit false remains off. Independently
supplied Installation files must include the matching runtime settings.
OCC starts without the fleet; affected channel operations fail
instead of using a direct internet connection.

This route supports dedicated Gateways. It does not give the Harness channel
access or combine the egress fleet with private workspace ingress.

## Configuration

Envoy Gateway v1.6.7 must have `extensionApis.enableEnvoyPatchPolicy: true`.
The chart selects the qualified Envoy v1.39.4 digest for the egress fleet only.
Other images are rejected. Keep the private ingress fleet's image and
administrative credentials separate.

```yaml
# Installation: drivers.compute.configuration.runtime
channelEgress:
  gatewayName: openclaw-channel-egress
  gatewayNamespace: openclaw-system
  envoyNamespace: envoy-gateway-system
  serviceName: openclaw-channel-egress
  listenerPortStart: 10001
  listenerPortEnd: 10062
  occListenerPort: 10000
  inspectionPort: 19004
  excludedCidrs:
    - 10.42.0.0/16
    - 10.43.0.0/16
    - 192.0.2.10/32
```

Replace the example exclusions with the installation's actual Pod, Service and
node ranges, including public node addresses. Operators own this inventory;
Compute does not receive cluster-wide node discovery permission. An enabled
configuration requires a nonempty list. A provider rule cannot override these
exclusions or the built-in nonpublic IPv4 exclusions.

Set Helm `channelEgress.enabled: true` and its matching fields. Helm uses the
release namespace as `gatewayNamespace`; `gatewayClassName` selects the installed
Envoy Gateway class. The installation profile renderer accepts
`channels.excludedCidrs` and writes both inputs. `channels.managedEgress` defaults
to true; false writes an explicit Helm opt-out and omits runtime channel settings.
Use [dependency setup](../../../guides/deploy/channel-egress.md)
to provision or check the pinned controller before installing channel resources.
OCC derives its provider listener from the validated installation configuration;
it has no separate caller-selected proxy endpoint.

Agent ports, the OCC port and the inspection port must be distinct integers
from 1024 through 65535. Agent ports must form a continuous range of at most 62
ports. Ports 19000, 19001 and 19003 are reserved by Envoy. The 62-slot limit
includes candidate revisions and incomplete cleanup. The packaged fleet has
64 configured listeners, including OCC and inspection. Capacity exhaustion
rejects activation; it does not combine destination sets or add another fleet.

## Upstream proxy configuration

Single-cluster Kubernetes Compute can admit an [Agent Gateway channel proxy](../../agents/network-proxy.md).
Set the same `upstreamProxies` and optional `proxyTrust` inputs in Helm
`channelEgress` and Compute `runtime.channelEgress`:

```yaml
upstreamProxies:
  - url: https://proxy.example.internal:8443
    addresses: [10.20.30.40/32]
proxyTrust:
  caSecretName: channel-proxy-ca
  caKey: ca.pem
```

Use actual endpoint addresses from the Installation network inventory. Each of
at most 32 endpoints has 1–16 unique IPv4 `/32` addresses. Metadata, special-use,
and Installation Pod, Service, and node exclusions remain denied. DNS must
resolve only inside the endpoint's configured address set. Compute saves the
resolved addresses and Gateway identity in private revision admission. A changed
answer or Installation selection requires a new deployment.

For HTTPS, Envoy verifies the proxy hostname and certificate. Without
`proxyTrust`, it uses its public root bundle. With `proxyTrust`, the named
Secret in the Envoy namespace supplies the complete public/private CA bundle;
EnvoyProxy mounts it read-only. It contains public certificates only. Provider
TLS remains inside CONNECT.

When endpoints are configured, Helm precreates blank credential Secret, filter,
and deny-only route slots for the existing listener ports. The worker can
`get` and `update` only those exact Secret names and read the exact routes and
filters. Helm manifests contain no credential data. Envoy Gateway is a trusted
reader of the staged credential. Inspection permits only exact listener,
cluster, and names-only SDS queries; full Secret dumps and credential-derived
delta versions are unavailable.

## Enforcement

Trusted composition maps each enabled provider to one
[Channel Driver](../channel.md). Missing or ambiguous mappings reject activation.
The worker derives requirements from the saved Agent revision and current
Drivers on every attempt. It holds that result through preparation. A retry
after a Driver upgrade can use different rules; no separate destination-policy
snapshot is saved in PostgreSQL.

Each binding has its own actual Envoy listener port. Gateway `HTTPS_PROXY`
points directly to that listener. Source egress and Envoy ingress NetworkPolicies
select the exact Kubernetes namespace, platform Namespace, Agent, Agent revision,
Gateway role, ordinary network profile and server-owned binding label. Other
Agents and Harnesses receive no grant. Compute checks the complete policy sets
for broader additive grants before and after installing its rules.

Envoy accepts only matching CONNECT targets and ports. It resolves destinations
through strict-DNS subclusters and checks each selected upstream address before
connecting. It excludes loopback, link-local, metadata, private, reserved and
configured installation ranges. Provider TLS stays inside the tunnel. Ordinary
HTTP proxying and caller-supplied identity headers do not grant access.

IPv4 DNS, explicit IP and CIDR rules are supported. IPv6 rule forms fail
explicitly and IPv6 upstream connections are denied. A destination grant permits
a service endpoint, not a particular provider workspace, account or API method.

## Readiness and cleanup

Compute reserves a stable per-port `EnvoyPatchPolicy` using Kubernetes
`resourceVersion` compare-and-swap before publishing an allow policy. The record
contains the namespace, Agent, Agent revision, binding ID, policy hash and state.
Unknown ownership fails closed. A different policy generation gets a separate
binding, so it cannot widen a serving Gateway's access.

Before starting the Gateway, Compute checks the active generation on every ready
egress Pod and verifies the network grants. A worker-only inspection listener
exposes read-only configuration and drain-counter inspection. Gateway `Programmed` status alone
does not establish that the requested policy is installed.

Stopping or retiring a channel revision installs a new deny filter chain. Compute
waits for the new generation, no old draining listener, and a zero
`listener_manager.total_filter_chains_draining` gauge on every serving Pod.
Envoy does not include in-place filter-chain drains in `config_dump`. The gauge
confirms removal on all Envoy workers; another Agent's concurrent drain can delay
cleanup. The fleet uses a five-second filter-chain drain. Compute then removes
the grants. It releases the slot only after the old Gateway Pods are gone and
no Deployment or ReplicaSet can recreate them. NetworkPolicy readback does not
confirm that the CNI has revoked access. Empty per-port policies remain as concurrency
records: a delayed worker cannot recreate an old allow rule after port reuse.
Unavailable inspection or uncertain ownership retains the reservation and fails
cleanup for retry. Cleanup for one revision cannot release another binding.

OCC provider requests use the reserved listener and an API-only network grant.
The generated Helm policy consumes the bundled Drivers' routing declarations.
Slack tokens stay with their authorized consumers; Envoy receives none.

## Verification and troubleshooting

- For failed activation, check the selected Gateway, qualified image, patch
  policy status, exact listener generation and NetworkPolicies. Keep OCC available
  while repairing the fleet.
- For exhausted capacity, finish failed cleanup or retire an unneeded channel
  revision. Do not delete allocation records or reuse ports manually.
- For denied directory requests, check the OCC listener and Secret permissions.
  A working Gateway listener does not prove that the OCC listener works.
- For a denied public endpoint, check its DNS answers and exclusions. Direct
  channel destinations remain public-only. Configure a private proxy through
  its exact Installation endpoint entry; never remove global exclusions.

Use the [Kubernetes tests](../../../testing/kubernetes.md) and
[Slack proof](../../../testing/slack.md) for real enforcement and model execution.
Per-Agent ports are temporary until verified Gateway workload identity supports
authenticated shared listeners. Customer upstream proxies and Microsoft Teams
are not implemented by this change.

See the [source-backed flow](../../../flows/channel-egress.md) for reconciliation.
