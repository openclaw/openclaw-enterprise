# Configure Gateway outbound access

Choose one proxy for Gateway HTTPS and WebSocket clients. OCE's channel-directory
requests share it by default. Use the bundled proxy or supply an existing external proxy. This is
operator configuration; there is no new Console editor or per-Agent selector.

## Bundled proxy

Add this to your installation-profile input before rendering:

```json
{
  "proxy": {
    "bundled": true,
    "allowedHosts": [
      "slack.com",
      "*.slack.com",
      "slack-edge.com",
      "*.slack-edge.com",
      "slack-msgs.com",
      "*.slack-msgs.com",
      "api.example.com"
    ]
  }
}
```

Replace `api.example.com` with the services your integrations need. Exact names
permit only that hostname; `*.example.com` permits subdomains, not the apex.
The default list permits Slack only. An empty list denies every destination.
The bundled proxy accepts CONNECT on TCP 443 and retains public-IPv4-only
upstream networking. It does not inspect decrypted TLS or authorize plugins.

To permit every public HTTPS destination, use:

```json
{ "proxy": { "bundled": true, "allowedHosts": ["*"] } }
```

`"*"` removes hostname filtering, not the TCP 443 or public-IPv4 restrictions.
Private and reserved ranges remain blocked by the bundled proxy's Kubernetes
NetworkPolicy. Direct Helm users set `gatewayProxy.allowedHosts: ["*"]`.

[Render and apply the profile](../deploy/installation-profiles.md). Rendering
sets Helm `gatewayProxy.enabled`, its `allowedHosts`, the API directory route,
and Compute `runtime.proxy` together. A directory-only override is optional.
Direct Helm users must also set the matching Compute `runtime.proxy` Service
endpoint and selector in their protected Installation configuration.

Configure integrations and Secret bindings separately using the existing Agent
Configuration. Adding a destination does not install a plugin or supply credentials;
enabling an integration does not expand the proxy allowlist. Check the selected
runtime's supported plugins and integration prerequisites. General proxy routing
does not remove the existing embedded-channel or dedicated-native support gates.

For native ClawHub registry requests, include `clawhub.ai` in the list. Other
artifact sources and services used by installed skills need their own hosts;
this is not permission for every destination a skill might use. The
[ClawHub proof boundary](../../testing/docker.md#clawhub-qualification-boundary)
distinguishes the passing packaged-Gateway smoke check from pending OCE
deployment and revision-persistence qualification.

## External proxy

Instead of `bundled`, set one credential-free HTTP(S) literal IPv4 endpoint with
an explicit port:

```json
{ "proxy": { "url": "http://198.51.100.25:3128" } }
```

Replace the example address. By default, the same endpoint feeds Gateway and directory
clients. The external operator owns its destination policy; OCE does not deploy
the bundled server in this mode. `url` and `bundled: true` are mutually exclusive.
For direct Helm use, set `gatewayProxy.url` and the same Compute
`runtime.proxy.proxyUrl` in the Installation.
Use an external endpoint reachable from both clusters for embedded execution in
the experimental two-cluster topology; the bundled control-cluster Service is not routable there.

## Directory proxy override (optional)

Use a separate endpoint only when the API directory client needs different
network access or destination policy. Keep the shared default otherwise.

```json
{
  "proxy": { "url": "http://198.51.100.25:3128" },
  "channels": { "directoryProxyUrl": "https://203.0.113.20:8443" }
}
```

Replace both example addresses. `channels.directoryProxyUrl` accepts the same
endpoint format as the external Gateway proxy. It sets Helm
`api.channelDirectoryProxyUrl` and changes only the API's directory route and
proxy egress grant. Gateways keep their selected endpoint. The override also
works with a bundled Gateway proxy or without any Gateway proxy.

Direct Helm users set `api.channelDirectoryProxyUrl`. Leave it empty to inherit
the selected Gateway proxy; empty does not disable directory requests. With no
override and no Gateway proxy, directory behavior remains unchanged. A failed
selected endpoint does not cause fallback to the other proxy. Both clients need
CONNECT access to the services they use; directory lookup requires `slack.com:443`.

## Apply and verify

Reload the protected Installation configuration and roll out the control-plane
processes. Deploy replacement Agent revisions to apply Gateway configuration;
restarting OCC alone does not update running Gateways. A host-list-only change
rolls out the bundled proxy and may reconnect existing tunnels.
A directory-only override change needs an API rollout, not Agent replacement.

Verify a permitted HTTPS request, internal Harness connectivity, and no direct
fallback while the proxy is unavailable. With a host allowlist, also verify an
unlisted destination denial; with `"*"`, verify private-network denial instead.
For Slack, also verify directory lookup and Socket Mode separately, following
the [Slack guide](slack.md). With an override, verify lookup through its endpoint
and Gateway traffic through the Gateway endpoint. Keep TLS verification enabled.

With no proxy selected, existing networking behavior is unchanged. This setting
covers native Gateway routing, not arbitrary Harness subprocesses or all
control-plane traffic. See the [networking reference](../../reference/drivers/kubernetes-compute/gateway-proxy.md)
for boundaries and the [testing guide](../../testing/kubernetes.md) for real-runtime proof.
