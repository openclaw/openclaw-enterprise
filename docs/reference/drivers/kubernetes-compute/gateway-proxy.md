# Gateway outbound proxy

`runtime.proxy.proxyUrl` selects one credential-free HTTP(S) IP endpoint with an
explicit port. For the bundled Service, also set `runtime.proxy.managedProxy`
with its exact namespace-qualified Service hostname, namespace, Pod labels, and
port. Compute validates the pair and permits only that peer and port from the
Agent's Gateway, whether channels are enabled or not. Embedded Gateways receive
the same setting; dedicated Harness processes do not.

Compute reuses the Agent's existing proxy NetworkPolicy when the endpoint
changes. Reconciliation replaces its egress grant rather than adding a second
policy. Removing the selected proxy clears the existing grant; Agent retirement
deletes the owned policy.

The bundled proxy's `gatewayProxy.allowedHosts` accepts exact DNS names,
`*.example.com` for subdomains, or `"*"` for all hosts. The default permits Slack;
an empty list denies all hosts. `"*"` removes hostname filtering only. CONNECT
remains restricted to TCP 443, and the chart's NetworkPolicy still limits upstream
traffic to public IPv4 addresses, excluding private and reserved ranges.

The bundled Service is cluster-local. Embedded Gateways in the experimental
two-cluster topology run in the execution cluster and require an external proxy
reachable there; admission rejects a managed control-cluster proxy for that topology.
Dedicated Gateways remain in the control cluster and can use the bundled Service.

Compute renders native `proxy.enabled: true`, the selected `proxy.proxyUrl`, and
`proxy.loopbackMode: gateway-only`. Contradictory Agent proxy settings fail
admission/preparation. With no selected endpoint, Compute leaves native proxy
settings and networking unchanged. Existing topology/channel support gates remain.

The runtime bridge exempts only the exact Driver-provisioned dedicated Codex
app-server URL while its transport is open. It removes the exception on closure
or failed construction; another path is not exempt. Native workspace nodes and
dedicated OpenClaw workers keep their separate, unproxied Gateway connection.
This is not a private-network allowlist. Proxy failures do not enable direct
Internet egress from dedicated Gateways. Existing embedded model/tool egress
permissions remain distinct; this setting does not claim whole-workload containment.

Use the [operator guide](../../../guides/integrations/gateway-proxy.md) to select
bundled or external service and configure destinations. Runtime-image and model
qualification are separate from chart rendering and Driver conformance.
