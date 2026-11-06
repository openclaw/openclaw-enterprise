---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: one Gateway outbound proxy

- **ID:** RFC-0030
- **Created:** 2026-11-05
- **Last updated:** 2026-11-06
- **RFC and implementation PR:** [#36](https://github.com/raw-labs/openclaw-enterprise/pull/36)
- **Implementation plan:** [TASK-0051](../plans/0051-gateway-outbound-proxy.md)
- **Related:** [Installation profiles](0018-installation-profiles-design/index.md),
  [Agent egress boundaries](0017-agent-egress-0x/index.md),
  [Driver configuration](0022-driver-configuration-contributions.md),
  [Credential Proxy](0023-egress-proxy-credential-lifecycle/index.md),
  [Driver value inspection](0025-installation-driver-values.md).

## Summary

Let an Installation operator select one outbound proxy for Kubernetes-managed
OpenClaw Gateways. OCE's channel-directory client shares it by default, with an
optional separate endpoint. Use either the existing
bundled CONNECT server with a configurable host list, or an external proxy.
Do not add a Console editor or split traffic inside a Gateway across proxies.

## Problem

The existing proxy configuration belongs to channels. The bundled server permits
only Slack, and directory lookup has a separate endpoint setting. An operator
who needs Slack plus other Gateway services needs a broader destination policy
and must keep separate external endpoint inputs aligned.
Channel-free dedicated Gateways also need proxy reachability.

Enabling OC's native process routing alone is not enough. It captures the
dedicated Codex Gateway's private app-server WebSocket connection. Transport
experiments reproduced the failure and showed that an exact-URL exception can
restore that connection without exempting other destinations.

## Solution

### Operator interface

Extend the existing profile renderer, Helm chart, and Kubernetes Compute Driver:

| Interface                                | Previous configuration                                       | Proposed replacement                                                      |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Installation profile: Gateway endpoint   | `channels.runtimeProxyUrl`                                   | `proxy.url`, also the directory default                                   |
| Installation profile: directory override | `channels.directoryProxyUrl`                                 | Retained; overrides only the directory endpoint                           |
| Installation profile: bundled selection  | `channels.managedSlackProxy`                                 | `proxy.bundled`                                                           |
| Helm: bundled server                     | `slackProxy.*`                                               | `gatewayProxy.*`                                                          |
| Helm: directory endpoint                 | `api.channelDirectoryProxyUrl`                               | Retained; empty inherits the selected Gateway proxy                       |
| Kubernetes Compute                       | `runtime.channels.proxyUrl`, `runtime.channels.managedProxy` | `runtime.proxy.proxyUrl`, `runtime.proxy.managedProxy`                    |
| Bundled host policy                      | Fixed Slack host list                                        | New `proxy.allowedHosts` in profiles; `gatewayProxy.allowedHosts` in Helm |

Select the bundled proxy with `proxy.bundled: true` in a profile or
`gatewayProxy.enabled: true` in Helm. Compute uses an exact `managedProxy` peer
for the bundled Service.

The renderer writes both Helm and Compute configuration from the Gateway selection.
Compute keeps its existing configuration schema, structured validation errors,
and schema-driven value inspection. No separate configuration registry or UI is added.
Direct Helm users must provide the matching Compute endpoint. Bundled and
external Gateway selections are mutually exclusive. Replace the old
Gateway-specific proxy keys; retain the directory override.

Both clients remain: Gateways send outbound requests, and the OCE API makes
channel-directory requests. Helm still sets `OCC_CHANNEL_DIRECTORY_PROXY_URL`.
An explicit `api.channelDirectoryProxyUrl` takes precedence; otherwise Helm uses
the selected Gateway proxy endpoint. Profiles pass `channels.directoryProxyUrl`
to that Helm setting. The override also works without a Gateway proxy selection.
An empty Helm override means inherit, not disable. Without either endpoint,
directory behavior stays unchanged. Neither endpoint failure causes fallback to
the other proxy.

Sharing one proxy reduces configuration and gives both clients the same default
route. Retaining the directory override supports separate network locations or
destination policies. With an override, Helm grants API directory egress only to
that endpoint, not also to the default Gateway proxy. Gateway configuration and
permissions do not change. The operator must keep two services reachable when
the endpoints differ; sharing one endpoint instead couples their availability.

These are deployment-time operator settings, not per-Agent permissions. The
bundled default permits Slack. An explicit `allowedHosts` list replaces that
default; exact names permit one host and `*.example.com` permits subdomains,
not the apex. An empty list denies all destinations. `"*"` permits all hosts,
while retaining TCP 443 and the public-IPv4-only NetworkPolicy. Operators select
that mode or list the hosts their integrations need; enabling a plugin does not
expand the list.
Existing Agent configuration and Secret bindings still enable integrations and
supply their credentials.

### Ownership and networking

Helm runs the bundled server and routes API directory requests to the override
or, by default, the selected Gateway proxy. The server permits CONNECT only on TCP 443. Its Kubernetes policy permits
public IPv4 upstreams and excludes private and reserved ranges. TLS stays
end-to-end; the server does not inspect plaintext or inject credentials. An
external proxy owns its own destination policy.

Kubernetes Compute generates OC native proxy settings and grants Gateways access
only to the selected proxy peer and port, independently of channels. Conflicting
Agent proxy settings fail admission or preparation. With no selection, current
networking and native configuration remain unchanged.

Apply this to embedded and dedicated Gateways. Separate dedicated Harnesses and
workspace nodes do not inherit the selection. A bundled control-cluster Service
cannot serve embedded Gateways in the experimental two-cluster topology; require
a reachable external endpoint there. Keep existing channel and native-worker
support gates.

### Internal connection and failure

Compute provisions the dedicated Codex app-server URL. The OC transport registers
an exception for exactly that URL before connecting and releases it on closure
or failed construction. Another path is not exempt. Reuse Proxyline's existing
registration mechanism through a small pinned runtime-source bridge until OC
provides the owning hook. Agents cannot select bypass destinations.

A denied host fails, and an unavailable proxy does not enable a direct fallback.
Dedicated Gateways retain default-deny Internet networking. This is not
whole-workload containment: embedded model/tool permissions and arbitrary
Harness subprocesses remain separate. This proposal does not replace RFC-0017's
OpenShell or secret-mediation decisions, or RFC-0023's Credential Proxy. CONNECT
routing does not authorize individual provider requests or mediate credentials.

### Applying changes

Operators render and apply protected configuration, then roll out OCC. Gateway
endpoint changes require replacement Agent revisions. A directory-only override
change requires an API rollout, not Agent replacement. A host-list-only change rolls the
bundled proxy and may interrupt existing tunnels. These are configuration
changes, not exceptions in the image-only upgrade command.

## Alternatives

- **Keep the Slack-only setup:** leaves general Gateway access unresolved and
  retains separate endpoint settings.
- **Require an external proxy:** simpler OCE packaging, but every installation
  must operate another service. Generalizing the existing bundled server gives
  small installations an option without adding another proxy implementation.
- **Require the directory client to share the Gateway proxy:** removes an option,
  but prevents separate client routing when network access or policies differ.
  Use sharing as the default, not a requirement.
- **Split one Gateway's Slack and general traffic across two proxies:** requires
  destination routing rules. The directory override does not add those rules;
  it selects a route for a separate API client.
- **Allow direct public Gateway egress:** avoids a proxy, but loses the selected
  destination policy and weakens dedicated Gateway isolation.
- **Add a Console policy editor:** adds lifecycle and authorization work for an
  infrequent operator task. Files are sufficient for this scope.

## Delivery and verification

Draft implementation exists in PR #36; the proposal is not accepted or delivered.
The plan records passing local transport and configuration checks and the
remaining deployment/model proof. Keep its required items unchecked until proved.

Before delivery, use the regular authenticated OCE API/worker workflow to prove
embedded and dedicated deployment, allowed and denied destinations, proxy outage,
internal connectivity, and revision replacement with enforcing NetworkPolicies.
Also pass native image checks on AMD64 and ARM64.

ClawHub needs its own useful-workflow proof: search, fetch and install a selected
public skill through the supported Gateway interface, confirm workspace writes
and discovery, and check persistence after replacement. Catalogue reachability
alone does not establish this outcome or access by every installed skill.

Docker Compute is outside this delivery. Compose is supported for control-plane
development, but its current Driver rejects the Harness authentication bindings
needed to deploy new Agents. Historical model tests do not establish current
support. Fixing that contract is separate work, not evidence that Docker already
supports this proxy or ClawHub workflow.

## References

- [Operator configuration](../../docs/guides/integrations/gateway-proxy.md)
- [Gateway network contract](../../docs/reference/drivers/kubernetes-compute/gateway-proxy.md)
- [Source-backed routing flow](../../docs/flows/gateway-outbound-proxy.md)
- [Docker Compute limits](../../docs/reference/drivers/docker-compute.md)
