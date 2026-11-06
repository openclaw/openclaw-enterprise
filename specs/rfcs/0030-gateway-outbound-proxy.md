---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: one Gateway outbound proxy

- **ID:** RFC-0030
- **Created:** 2026-11-05
- **Last updated:** 2026-11-06
- **Implementation plan:** [TASK-0051](../plans/0051-gateway-outbound-proxy.md)
- **Related:** [Installation profiles](0018-installation-profiles-design/index.md),
  [Agent egress boundaries](0017-agent-egress-0x/index.md),
  [Credential Proxy](0023-egress-proxy-credential-lifecycle/index.md).

## Summary

Give OpenClaw Enterprise (OCE) operators one Gateway outbound proxy setting.
Operators can use the bundled proxy with a configurable destination list or
supply an external proxy. The API's channel-directory client shares the Gateway
proxy by default and retains an optional endpoint override.

Apply this to embedded and dedicated Gateways through deployment configuration.
Do not add a Console editor or per-Agent proxy selection.

## Problem

Gateway proxy settings currently belong to channels, and the bundled proxy
permits only Slack. An Agent that needs Slack and other external services needs
a broader destination policy. A Gateway without channels also needs a way to
reach external services through a proxy.

Gateway messaging and API directory lookups run in separate processes. Their
external proxy endpoints must currently be configured separately, even when both
clients should use the same server. Separate endpoints remain useful when the
API and Gateway have different network access or destination policies.

Native OpenClaw proxy routing also captures the Gateway's private connection to
a dedicated Codex app-server. That connection must remain direct when the
outbound proxy cannot reach the internal Harness.

## Solution

### Operator interface

Use the existing installation-profile renderer, Helm chart and Kubernetes
Compute Driver. Change their settings as follows:

| Interface                                | Previous configuration                                       | Proposed replacement                                                      |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Installation profile: Gateway endpoint   | `channels.runtimeProxyUrl`                                   | `proxy.url`, also the directory default                                   |
| Installation profile: directory override | `channels.directoryProxyUrl`                                 | Retained; overrides only the directory endpoint                           |
| Installation profile: bundled selection  | `channels.managedSlackProxy`                                 | `proxy.bundled`                                                           |
| Helm: bundled server                     | `slackProxy.*`                                               | `gatewayProxy.*`                                                          |
| Helm: directory endpoint                 | `api.channelDirectoryProxyUrl`                               | Retained; empty inherits the selected Gateway proxy                       |
| Kubernetes Compute                       | `runtime.channels.proxyUrl`, `runtime.channels.managedProxy` | `runtime.proxy.proxyUrl`, `runtime.proxy.managedProxy`                    |
| Bundled host policy                      | Fixed Slack host list                                        | New `proxy.allowedHosts` in profiles; `gatewayProxy.allowedHosts` in Helm |

In a profile, select `proxy.bundled: true` or supply `proxy.url`. These selections
are mutually exclusive. Profile and Helm external endpoints must be
credential-free HTTP(S) URLs with a literal IPv4 address and an explicit port.

The renderer derives Helm `gatewayProxy` and Compute `runtime.proxy` from that
selection. Direct Helm users must also configure the matching Compute endpoint.
For the bundled Service, Compute receives its exact hostname, namespace, Pod
labels and port in `runtime.proxy.managedProxy`. The removed Gateway-specific
keys fail validation; they are not automatically converted.

These settings select network routes, not integrations. Users continue to enable
integrations and supply credentials through Agent configuration and Secret
bindings.

### Directory routing

Keep `channels.directoryProxyUrl` in profiles and `api.channelDirectoryProxyUrl`
in Helm. A nonempty override selects the API directory endpoint; otherwise the
client inherits the Gateway proxy. An empty Helm override means inherit, not
disable. A directory override can also be used without a Gateway proxy. With
neither endpoint, existing directory behavior stays unchanged.

Helm writes the selected API endpoint to `OCC_CHANNEL_DIRECTORY_PROXY_URL` and
grants directory proxy egress to that endpoint. With an override, it does not
also grant the default proxy route. The override does not change Gateway
configuration or permissions. Endpoint failure does not switch a client to the
other proxy.

Sharing one proxy reduces configuration but couples the clients' availability.
The optional override preserves separate routing when needed, at the cost of
managing two endpoints. It does not split one Gateway's traffic across proxies.

### Bundled and external proxies

Generalize the existing bundled CONNECT server instead of adding another proxy
implementation. Helm deploys it as a private Service. The default destination
list permits Slack. `proxy.allowedHosts` replaces that list:

- An exact DNS name permits that host.
- `*.example.com` permits subdomains, not the apex.
- An empty list denies all destinations.
- `"*"` permits all hosts.

The bundled server accepts CONNECT only to TCP 443. Its Kubernetes NetworkPolicy
permits public IPv4 upstreams and excludes private and reserved ranges, including
when `"*"` is selected. TLS remains end-to-end; the proxy does not decrypt traffic
or inject credentials. An external proxy controls its own destination policy.
Enabling an integration does not expand either proxy's allowed destinations.

### Gateway networking and internal connections

Kubernetes Compute generates native OpenClaw proxy configuration and grants
proxy egress to the selected peer and port, independently of channel enablement.
Conflicting Agent proxy settings fail admission or preparation. Without a
Gateway proxy selection, native Gateway configuration and networking stay
unchanged.

Apply the selection to embedded and dedicated Gateways. Separate dedicated
Harnesses and workspace nodes do not inherit it. Embedded Gateways in the
experimental two-cluster topology need an external endpoint reachable from the
execution cluster; the bundled control-cluster Service is not routable there.
Existing channel and native-worker restrictions remain unchanged.

For dedicated Codex, Compute provisions the app-server URL. Its OpenClaw
transport must register an exact-URL exception with the process proxy owner
before connecting, using Proxyline's existing mechanism. Release the exception
when the transport closes or construction fails. Other paths remain proxied,
and Agents cannot choose exception destinations.

Denied destinations and proxy outages must fail without direct Internet
fallback. Dedicated Gateways retain default-deny Internet networking. This
setting does not route arbitrary Harness subprocesses or replace embedded
model/tool permissions. CONNECT routing does not authorize provider requests or
mediate credentials; those remain separate from this proposal.

### Applying changes

Operators render and apply protected configuration, then roll out the control
plane. Gateway endpoint changes require replacement Agent revisions. A
directory-only endpoint change requires an API rollout, not Agent replacement.
A host-list-only change rolls the bundled proxy and can interrupt existing
tunnels. These changes remain outside the image-only upgrade command.

## Alternatives

- **Keep the Slack-only setup:** retains the current configuration but does not
  support general Gateway access through the bundled server.
- **Require an external proxy:** reduces OCE packaging, but requires operators
  to supply a separate service. Reusing the bundled server provides a simpler
  option for small installations.
- **Require one shared endpoint:** removes a setting but prevents independent
  API routing. Sharing by default keeps normal configuration simple without
  removing the directory override.
- **Allow direct public Gateway egress:** avoids a proxy but loses its
  destination policy and weakens dedicated Gateway isolation.

## Required outcomes

Validation must cover the regular OCE API/worker deployment workflow:

- Embedded and dedicated Gateways use the selected proxy, with or without
  enabled channels, subject to existing channel restrictions.
- Allowed destinations work; denied destinations and proxy outages do not
  cause direct fallback.
- Directory requests share the default or use the explicit override. Their
  proxy egress grant does not include an unused default endpoint.
- Internal Codex connectivity works, and closing its transport removes the
  exact-URL exception without exempting other paths.
- Endpoint changes replace the previous proxy grant; removal and Agent
  retirement revoke it. Revision replacement applies the new Gateway settings.
- A Gateway can search ClawHub, fetch and install a public skill, discover it,
  and retain it after Agent revision replacement.

Docker Compute and Compose networking are outside this proposal.
