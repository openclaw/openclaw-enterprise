# Dedicated Gateway outbound HTTPS

Use the Agent's **Network** tab to approve additional HTTPS destinations for trusted
native OpenClaw plugins. Kubernetes Compute creates an isolated proxy for each
admitted dedicated revision that needs external access. Enabled supported channels
add their required destinations automatically.

The bundled Slack Driver supplies automatic requirements. Other native integrations,
including Teams without a contributing Channel Driver, need an explicit restricted
or public HTTPS selection; `channelsOnly` does not infer their destinations.

## Agent selection and permissions

`gatewayOutbound` belongs to the OCE Agent, outside native Configuration values.
New Agents default to `channelsOnly`. Change it through the Network tab or
`PATCH /namespaces/{namespaceId}/agents/{agentId}` with the existing
`configurationId` and one of these selections:

| Selection                                                     | Additional authority                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `{ "mode": "channelsOnly" }`                                  | None; trusted enabled-channel requirements still apply.         |
| `{ "mode": "restricted", "hosts": ["backend.composio.dev"] }` | Exact named hosts on TCP/443, in addition to required channels. |
| `{ "mode": "publicHttps" }`                                   | General public TCP/443 for the whole trusted Gateway.           |

Restricted hosts must be 1–64 unique lowercase ASCII DNS names, each at most
253 characters. Schemes, paths, wildcards, IP literals and single-label names
are rejected. A destination name cannot override address exclusions.

Changing this field requires both `update` and `administer` on the exact Agent,
plus the existing Configuration and credential grants required by Agent updates.
An ordinary Configuration editor cannot approve extra connectivity. The
capability endpoint under `gateway-outbound/capabilities` requires Agent `read`;
it reports effective Installation options and whether the caller has both grants.
It includes required channel destinations only when the caller can read the
saved Configuration.

Saving updates the draft. Deployment freezes the selection, channel requirements,
and admitted Installation exclusions into the immutable revision. An existing
version keeps its selection when the draft or channel settings change. Deploy
a new version to apply those changes. Admission rechecks the current Installation
ceiling. Additional modes require dedicated execution; embedded execution is
unchanged.

## Installation setup

Enable the facility in the selected Kubernetes Compute Driver's Installation
configuration:

```json
{
  "runtime": {
    "gatewayOutbound": {
      "enabled": true,
      "allowPublicHttps": false,
      "image": "registry.example.com/controller@sha256:<approved-digest>",
      "denyCidrs": ["10.42.0.0/16", "10.43.0.0/16", "192.0.2.20/32"]
    }
  }
}
```

Replace the image placeholder with an approved immutable controller image that
contains the generic proxy. Provide the actual Pod, Service, API-server, database,
node and other infrastructure ranges; the example ranges are illustrative.
Enabled outbound requires explicit exclusions. `allowPublicHttps` defaults false.
Optional `resources` sets proxy requests and limits. Defaults are requests
25m CPU/64Mi memory and limits 250m CPU/256Mi memory.

The profile renderer accepts `gatewayOutbound.enabled`, `allowPublicHttps`, and
`denyCidrs`. It supplies `controlPlane.controllerImage` as the proxy image and
adds configured database/cluster endpoints to exclusions. Operators do not list
future Agents or manually provision their proxies.

Tightened exclusions are combined with each version's admitted exclusions;
loosening cannot broaden that version. Compute maintenance, normally scheduled
every 30 seconds, removes or replaces affected proxy Pods and closes old tunnels.
Disabling outbound or withdrawing public HTTPS removes the corresponding route.
The interval is not a total revocation deadline: queue delay and Pod shutdown
also count. A new policy is applied only after old proxy Pods stop.

## Enforcement and compatibility

The Gateway can reach its exact revision's proxy. Other Agents and its Harness
receive no grant to that proxy. Each proxy has its own Deployment, Service,
immutable policy ConfigMap and NetworkPolicies. It receives no provider/model
Secret, projected Kubernetes API token, shared workspace or persistent state.
Harness and Sandbox networking retain their existing contracts. This facility
provides transport for trusted Gateway integrations. Harness egress and Credential
Proxy credential mediation remain separate; composition with protected Harness or
Credential Proxy configurations is unqualified.

The **Policy denials** tab manages [Sandbox network policies](sandbox-policies.md).
Its grants and this **Network** tab's Gateway selection are separate settings with
separate permissions. A revision can retain both snapshots. Saving or applying a
Sandbox grant does not approve additional Gateway access.

CONNECT admits only port 443. The proxy validates the hostname, resolves it once,
rejects any forbidden DNS answer, and connects to a vetted IPv4 literal. Private,
loopback, link-local, metadata, CGNAT, reserved and configured infrastructure
addresses are refused. IPv6-only targets and IP-literal requests fail closed.
TLS remains end-to-end; there is no certificate replacement or credential injection.

The stock native Gateway uses the generated `HTTP_PROXY`, `HTTPS_PROXY`,
`NODE_USE_ENV_PROXY` and exact internal `NO_PROXY` settings. This requires Node
24.5 or newer; managed-proxy Gateway startup refuses older versions. Native
plugins using ordinary global fetch can use the approved route. Libraries with
their own transports must honor these settings or use an explicit proxy agent.
Approved loopback/internal transports retain their existing access. Other direct
external connections remain blocked; proxy configuration alone is not proof of
compatibility with every plugin or provider.

Public mode trusts all Gateway-hosted plugin code with public TCP/443 access.
It does not isolate plugins from each other or enforce HTTP paths, methods,
actions, or which credentials they can read inside the process. Plugins still
need their native credentials and action authorization. Model credentials remain
in the dedicated Harness; native integration credentials remain in the Gateway.

The OCC API uses a separate restricted instance for trusted Driver management
requests made before a Gateway exists. Its destinations are not the union of
Agent permissions. See [Slack setup](../guides/integrations/slack.md) for that
Driver's management and Gateway consumers.

If terminal active-version maintenance loses deployer, credential or backend
authority, permanently loses Sandbox authorization, or current configuration
refuses admitted access, OCC persists
revision-access withdrawal before effects. Pure Compute status marks configuration
refusal as `withdrawn`; restoring it to `current` cannot cancel pending removal.
Kubernetes
closes its Gateway proxy and independently removes any admitted public GitHub
reader policy and terminates that reader's exact Harness. Reader withdrawal applies
even when the configured peer is unchanged. Both closures must complete before the
terminal result is recorded; failures stay pending across retries and restarts.
A refused Installation ceiling uses the same withdrawal path, so an admitted
reader's Harness can stop even if its reader peer is unchanged.
Restored authority cannot repair that version's access: deploy a new authorized
version. An ordinary Harness without admitted reader access retains its existing
behavior. Channels and Gateway integrations lose their route when the proxy stops.

Retired Agent-wide channel grants are removed before a Gateway starts or access
withdrawal completes. Cleanup keeps the old grant until the affected Gateway Pods
terminate, closing established connections as well as the policy route. Failed
deletion remains pending; cleanup cannot delete a newer Gateway.

## Verification and troubleshooting

Inspect the admitted version's network snapshot and deployment result. A saved
Agent setting is not deployment readiness. Missing proxy configuration, an
unsupported topology, or a withdrawn Installation ceiling refuses admission.
Proxy preparation must become ready before the Gateway starts.

A proxy denial means the hostname or resolved address failed policy; it does not
prove missing provider credentials. Check required channel declarations, the
additional host list and infrastructure exclusions. A direct-socket failure with
an allowed hostname can mean the plugin transport does not honor the proxy.

[Runtime flow](../flows/gateway-outbound.md) explains resource ordering.
[Testing](../testing/gateway-outbound.md) records selected proof and limits.
[RFC-0021](../../specs/rfcs/0023-gateway-outbound.md) records the architectural proposal.
