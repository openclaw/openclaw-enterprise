# Bundled Slack Channel Driver

The bundled `SlackChannelDriver` reads people and channels for the Console's
name picker. It uses the Agent's selected same-Namespace `SLACK_BOT_TOKEN`
Secret; the controller does not configure or store another token.

The Driver calls Slack [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)
to require a bot identity and identify its workspace, then [`users.list`](https://docs.slack.dev/reference/methods/users.list/)
or [`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/).
The bot needs `users:read` for people, `channels:read` for public channels, and
`groups:read` for private channels. Slack returns only resources visible to the
bot. The Driver scans up to three provider pages for a nonempty search query and
one page without a query. It returns a cursor when more pages remain. The
Console displays the workspace and saves selected IDs, never names.

For exact-ID searches and saved IDs, the Driver calls [`users.info`](https://docs.slack.dev/reference/methods/users.info/)
or [`conversations.info`](https://docs.slack.dev/reference/methods/conversations.info/)
directly. The Console shows selected names as removable chips, with exact IDs
available on hover. IDs the bot cannot see remain visible without a name.
Search in the field and choose a result, or paste exact IDs and press Enter.
The Console waits 300 ms after typing and shows up to five results per page.
Enter searches immediately. Next and Previous reuse fetched matches before
requesting another provider page.
Unselected search text is never saved. Channel access explicitly selects
**Specific people** or **Everyone in these channels**; removing the last person
does not switch to everyone.

An invalid token, missing scope, rate limit, invalid response, or unavailable
Slack service produces a safe error without returning the token or upstream
payload. Non-success HTTP responses release their unused response body before
returning the error. Retry after fixing the token or scopes. Exact IDs can be entered when
directory browsing is unavailable.

## Credential validation

Before API provisioning or deployment, enabled Slack accounts require
Secret-backed native environment references. Socket Mode app tokens must start
with `xapp-`; bot tokens must start with `xoxb-` and pass `auth.test` with a bot
identity. An explicit Enterprise Grid installation requires an enterprise ID;
other installations require a workspace ID. User and channel lookup still
require a workspace ID. HTTP mode skips the app-token check. Disabled Slack
accounts make no provider call. Validation has an eight-second request budget
and never opens a Socket Mode connection or sends a message.

Failures return sanitized `CHANNEL_CREDENTIAL_*` errors with the native field
path. App-token prefixes do not prove validity, scopes, or app/bot pairing.
Validation checks the current values; credentials can change before runtime
startup, which remains a separate connectivity check.

## Network requirements

The trusted Slack Driver declares two separate requirements:

- `controlPlaneNetworkRequirements()` permits the exact `slack.com` host for
  credential validation and directory requests.
- `gatewayNetworkRequirements(configuration)` permits `slack.com`,
  `slack-edge.com`, and `slack-msgs.com`, including subdomains, when at least one
  native Slack account is enabled. Disabled accounts add no requirement.

OCC combines the Gateway requirements with the Agent's
[Gateway outbound selection](../gateway-outbound.md) during deployment. Enabling
Slack supplies these destinations automatically; operators do not maintain a
second Slack host list. Gateway networking remains available only for supported
dedicated execution, and channel enablement does not grant general public HTTPS.

## Enable lookup in production

Production composition selects the Slack Driver. With default-deny egress,
lookup and credential validation need an approved route. Configure Helm
`outboundProxy.enabled: true` and supply `outboundProxy.denyCidrs` with the actual
Installation infrastructure addresses, including public addresses. The chart:

- creates the private `openclaw-enterprise-outbound-proxy` Service;
- sets `OCC_CONTROL_PLANE_OUTBOUND_PROXY_URL` and the exact matching
  `OCC_CONTROL_PLANE_OUTBOUND_PROXY_MANAGED_HOST` on the API;
- admits only the release's API Pods and grants them egress to that proxy;
- grants the proxy public IPv4 TCP 443 egress, excluding private, reserved,
  and configured infrastructure ranges.

The control-plane entrypoint derives permitted destinations from the trusted
bundled ChannelDriver. It uses the same generic CONNECT implementation as Gateway
proxies, with a separate restricted policy. For Slack management it permits
`CONNECT slack.com:443`, without a subdomain grant. It needs no Agent deployment
and receives no Slack token. Gateway Pods use their own revision-owned proxies
and cannot reach this API-only service.

Operators can instead set Helm `api.controlPlaneOutboundProxyUrl` to an approved
external HTTP or HTTPS proxy, such as `http://198.51.100.25:3128` with the example
IP and port replaced. Use one literal IPv4 address other than `0.0.0.0` and an
explicit port, without credentials or a path. Helm grants the API egress to that
exact IP and port. The external proxy must enforce the Driver's management
requirements and infrastructure restrictions.

The Driver verifies Slack's TLS certificate inside the tunnel. Keep the selected
bot token in its same-Namespace Secret; no proxy credential is needed in Helm
values. Without a reachable route, lookup and credential validation return
unavailable. Exact-ID entry does not bypass credential validation. See
[production controller settings](../settings/production.md#control-plane-outbound-proxy)
for proxy process settings.

See the [ChannelDriver contract](channel.md) for OCC authorization and
[Slack Configuration](../configuration/secrets.md#native-channel-configuration)
for gateway token bindings.
