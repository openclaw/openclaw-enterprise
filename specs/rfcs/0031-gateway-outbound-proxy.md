---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: one Gateway outbound proxy

- **ID:** RFC-0031
- **Status:** Proposed
- **Author:** miguelbranco80
- **Created:** 2026-11-05
- **Last updated:** 2026-11-06
- **Implementation plan:** TASK-0051
- **Related:** RFC-0018 Installation profiles; RFC-0017 Agent egress boundaries; RFC-0023 Credential Proxy.

## Summary

Provide one **optional, Installation-wide outbound proxy setting** for embedded and dedicated Gateways. Leave it unset by default and preserve existing networking when unset.

Operators select either an external proxy or the existing bundled Slack proxy, extended with a configurable destination list. Use OpenClaw’s native proxy routing so the selection applies to Gateway clients independently of channel enablement, rather than relying only on channel-specific `HTTPS_PROXY` wiring.

The API’s channel-directory client uses the selected Gateway proxy by default, with an optional separate endpoint. Preserve internal Gateway connections and leave separate Harness networking unchanged.

Configure this through Installation profiles and Helm. Do not add a Console editor or per-Agent proxy selection. Docker Compute and Compose networking are outside this proposal.

## Problem

Current Gateway networking has different behavior by execution mode:

- **Embedded Gateways** have direct public HTTPS access for model and tool requests.
- **Dedicated Gateways** do not have general direct Internet access. When channels are enabled, OCE grants access to their configured channel proxy.

The proxy configuration belongs to channels, and the bundled server permits only Slack. This prevents a dedicated Gateway from using that server for Slack together with other external services, or from selecting a proxy without enabling channels.

OCE also configures the API’s channel-directory proxy separately. Operators must supply two endpoints even when Gateway messaging and API directory lookups should use the same server. Separate endpoints remain useful when those clients need different network access or policies.

OpenClaw already provides native process-level proxy routing. However, enabling it also captures the Gateway’s private connection to a dedicated Codex app-server. That internal connection must remain direct.

## Proposed design

### 1. Select an optional Gateway proxy

Use the existing Installation-profile renderer, Helm chart and Kubernetes Compute Driver.

The operator has three choices:

- **No proxy:** omit the profile’s `proxy` section. Preserve existing Gateway networking.
- **Bundled proxy:** set `proxy.bundled: true`, with an optional destination list.
- **External proxy:** set `proxy.url`. Do not deploy the bundled server.

Bundled and external selections are mutually exclusive. The selection applies to embedded and dedicated Gateways using this Compute configuration; Agents do not choose their own endpoint.

Change the configuration interfaces as follows:

| Interface | Previous configuration | Proposed configuration |
|---|---|---|
| Profile: Gateway endpoint | `channels.runtimeProxyUrl` | `proxy.url` |
| Profile: bundled selection | `channels.managedSlackProxy` | `proxy.bundled` |
| Profile: directory override | `channels.directoryProxyUrl` | Retained |
| Helm: bundled server | `slackProxy.*` | `gatewayProxy.*` |
| Helm: directory override | `api.channelDirectoryProxyUrl` | Retained; empty inherits the Gateway proxy |
| Kubernetes Compute | `runtime.channels.proxyUrl`, `runtime.channels.managedProxy` | `runtime.proxy.proxyUrl`, `runtime.proxy.managedProxy` |
| Bundled destination policy | Fixed Slack host list | Profile `proxy.allowedHosts`; Helm `gatewayProxy.allowedHosts` |

The profile renderer generates matching Helm and Compute configuration. Direct Helm users must also configure the matching Compute endpoint.

For the bundled Service, `runtime.proxy.managedProxy` identifies its exact namespace-qualified hostname, namespace, Pod labels and port. Profile and Helm external endpoints must be credential-free HTTP(S) URLs with a literal IPv4 address and an explicit port.

### 2. Use OpenClaw’s native Gateway routing

When a Gateway proxy is selected, Kubernetes Compute generates:

```yaml
proxy:
  enabled: true
  proxyUrl: <selected endpoint>
  loopbackMode: gateway-only
```

This activates OpenClaw’s existing proxy routing for supported Gateway clients, including HTTP and WebSocket clients. OCE also retains `HTTPS_PROXY` for clients that use that environment variable.

Compute grants access to the selected proxy peer and port independently of channel enablement. Contradictory Agent proxy settings fail admission or preparation.

Without a selected endpoint, Compute leaves native Gateway proxy settings and networking unchanged.

This is Gateway routing, not whole-workload containment. It does not route arbitrary tool subprocesses, replace embedded model/tool permissions, authorize provider requests, or mediate credentials.

### 3. Generalize the bundled Slack proxy

Reuse the existing CONNECT server and deploy it as a private Helm Service. Do not add a second proxy implementation.

The default destination list remains Slack-only. Operators replace it with `proxy.allowedHosts`:

| Entry | Meaning |
|---|---|
| `api.example.com` | Permit that exact hostname |
| `*.example.com` | Permit subdomains, but not `example.com` itself |
| `"*"` | Permit all hostnames |
| Empty list | Deny all destinations |

For example, this profile fragment permits Slack and other public HTTPS destinations:

```json
{
  "proxy": {
    "bundled": true,
    "allowedHosts": ["*"]
  }
}
```

Direct Helm users set `gatewayProxy.enabled: true` and `gatewayProxy.allowedHosts: ["*"]`, together with the matching Compute configuration.

The bundled server accepts CONNECT only to TCP 443. Its Kubernetes NetworkPolicy permits public IPv4 upstreams and excludes private and reserved ranges. `"*"` removes hostname filtering; it does not remove those port or address restrictions.

TLS remains end-to-end. The proxy does not decrypt traffic or inject credentials. An external proxy manages its own destination policy.

Users continue to enable integrations and supply credentials through Agent configuration and Secret bindings. Enabling Teams, ClawHub or another integration does not add destinations to the proxy policy, install a plugin, or supply credentials.

### 4. Preserve internal Gateway connections

Separate dedicated Harnesses and workspace nodes do not inherit the Gateway proxy. Their outbound routing and permissions remain unchanged.

For dedicated Codex, Compute provisions the private app-server URL. Before connecting, the Gateway’s Codex transport registers an exact-URL exception with OpenClaw’s process proxy owner, using Proxyline’s existing mechanism.

Release that exception when the transport closes or construction fails. Another path on the same host is not exempt. Agents cannot choose exception destinations.

Native OpenClaw workers and workspace nodes retain their separate, unproxied connections to the Gateway. Existing native-worker restrictions remain unchanged.

Denied external requests and proxy outages must fail without direct fallback. Dedicated Gateways retain default-deny Internet networking.

### 5. Share the endpoint with API directory requests

The API’s channel-directory client performs lookups separately from Gateway messaging. Select its endpoint in this order:

1. Use a nonempty directory override.
2. Otherwise, use the selected Gateway proxy.
3. With neither endpoint, preserve existing directory behavior.

Keep profile `channels.directoryProxyUrl` and Helm `api.channelDirectoryProxyUrl` as directory-only overrides. An empty Helm override means **inherit**, not disable. An override can also be used without a Gateway proxy.

Helm writes the selected API endpoint to `OCC_CHANNEL_DIRECTORY_PROXY_URL` and grants directory proxy egress only to that endpoint. When an override is selected, do not also grant access to the default Gateway proxy.

The override does not change Gateway configuration or permissions. Neither client switches to the other endpoint when its selected proxy fails.

Sharing the default reduces configuration but couples the clients’ availability. The override preserves separate routing when needed, at the cost of managing two endpoints. It does not split one Gateway’s traffic across proxies.

## Defaults and backward compatibility

### No Gateway proxy selected

Preserve the existing difference between modes:

| Mode | Behavior before and after this proposal |
|---|---|
| Embedded | Retain direct public HTTPS access for model and tool requests |
| Dedicated | Retain restricted Gateway networking, without general direct Internet access |

Operators do **not** need `allowedHosts: ["*"]` to preserve embedded’s existing direct access. They leave the Gateway proxy unset.

No proxy is automatically selected or deployed.

### Gateway proxy selected

Apply the selected proxy in both modes, even without channels.

For dedicated Gateways, this removes the previous dependency between enabling channels and receiving a proxy route.

For embedded Gateways, this is an explicit change from direct access to proxy routing. Selecting the bundled server with its default list limits routed requests to Slack destinations. Selecting `"*"` permits broader public HTTPS access, but does not reproduce the direct route:

- Routed requests fail if the proxy is unavailable.
- External services see the proxy’s outbound address.
- The bundled proxy’s port and address restrictions still apply.

Do not choose `"*"` automatically for embedded mode or a different host list automatically for dedicated mode.

### Slack and Teams enabled

Preserve the existing channel requirements:

- Channels require dedicated mode.
- Dedicated Gateways with enabled channels require a configured Gateway proxy.
- Reject enabled channels in embedded mode or without a Gateway proxy.
- Enabling a channel does not deploy or select a proxy.
- An API directory-only proxy does not satisfy the Gateway requirement.

With the bundled server’s default policy, Slack remains permitted. Other integrations require an appropriate host list or an external proxy that permits their destinations.

### Existing configuration files

The renamed Gateway configuration keys are breaking changes. Reject retired keys with a message identifying the replacement; do not silently ignore or automatically convert them.

Directory overrides remain supported. Their default changes: an unset or empty override inherits the selected Gateway proxy. With no Gateway proxy and no directory override, directory behavior remains unchanged.

### Two-cluster deployments

For embedded Gateways in the experimental two-cluster topology:

- No proxy remains allowed.
- If a proxy is selected, it must be an external endpoint reachable from the execution cluster.
- Reject the bundled control-cluster Service because it is not routable from that placement.

Dedicated Gateways remain in the control cluster and can use the bundled Service.

## Applying configuration changes

Operators render and apply protected configuration, then roll out the control plane.

- **Gateway endpoint change:** replace Agent revisions to apply the new Gateway settings.
- **Directory-only endpoint change:** roll out the API; Agent replacement is not required.
- **Bundled host-list change:** roll out the proxy; existing tunnels can be interrupted.

Endpoint changes replace the previous owned proxy grant rather than adding another grant. Removing the selection revokes that proxy grant; Agent retirement deletes the owned policy. Existing non-proxy permissions remain separate.

These configuration changes are outside the image-only upgrade command.

## Alternatives

- **Keep the Slack-only setup:** avoids configuration changes but does not provide general Gateway access through the bundled server or proxy access without channels.
- **Require an external proxy:** reduces OCE packaging, but requires operators to supply a separate service. Reusing the bundled server provides an option for small installations.
- **Require one endpoint for Gateway and directory traffic:** removes an override but prevents independent API routing. Sharing by default retains the simpler setup without removing that option.
- **Permit direct public egress from dedicated Gateways:** avoids a proxy but loses its destination policy and weakens dedicated Gateway isolation. Existing embedded direct access remains available when no proxy is selected.

## Required validation

Validate the regular OCE API/worker deployment workflow, not only rendered configuration:

- With no proxy selected, embedded Gateways retain direct public HTTPS access and dedicated Gateways retain restricted networking.
- Both Gateway modes use the selected proxy without requiring channels. Dedicated Gateways also use it with channels enabled.
- Unsupported channel combinations and conflicting Agent proxy settings are rejected.
- Allowed destinations work. Denied destinations and proxy outages do not cause direct fallback.
- Directory requests inherit the default or use the explicit override. Their proxy egress grant excludes an unused default endpoint.
- Internal Codex connectivity works. Closing the transport removes its exact-URL exception without exempting other paths.
- Changing, removing and retiring the proxy selection replaces or revokes the previous grant. Agent revision replacement applies the new settings.
- Separate Harness routing and permissions remain unchanged.
- A Gateway can search ClawHub, fetch and install a public skill, discover it, and retain it after Agent revision replacement.
