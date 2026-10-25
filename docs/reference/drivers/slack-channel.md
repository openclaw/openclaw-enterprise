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
Secret-backed native environment references: an env SecretRef, or a token that
is exactly one `${NAME}`, with `NAME` bound to a Secret. Socket Mode app tokens
must start with `xapp-`; bot tokens must start with `xoxb-` and pass `auth.test`
with a bot identity. An explicit Enterprise Grid installation requires an enterprise ID;
other installations require a workspace ID. User and channel lookup still
require a workspace ID. HTTP mode skips the app-token check. Disabled Slack
accounts make no provider call. Validation has an eight-second request budget
and never opens a Socket Mode connection or sends a message.

Failures return sanitized `CHANNEL_CREDENTIAL_*` errors with the native field
path. A retryable `503` means Slack or its route failed. When the production API
has no proxy URL and `auth.test` gets no answer from Slack (connection, DNS, or
time budget failure), validation instead returns `409` `RESOURCE_CONFLICT`. The
message names the [proxy settings](#enable-lookup-in-production) and says to try
again if the API has another approved route to Slack, because an open route that
timed out gets the same answer. App-token prefixes do not prove validity, scopes, or app/bot pairing.
Validation checks the current values; credentials can change before runtime
startup, which remains a separate connectivity check.

## Enable lookup in production

The production API selects the Slack Driver. With default-deny egress, Slack
lookup and credential validation need a proxy. With the recommended Helm setting
`slackProxy.enabled: true`, the chart:

- creates a private `openclaw-enterprise-slack-proxy` Service;
- points `OCC_CHANNEL_DIRECTORY_PROXY_URL` at that Service DNS name;
- allows API Pod egress only to the proxy Pod selector; and
- allows the proxy public IPv4 egress on TCP 443, excluding private and
  reserved ranges.

The bundled proxy accepts HTTP `CONNECT` only for Slack hostnames on port 443.
The API accepts a DNS proxy URL only when Helm also sets the matching
`OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST`; it rejects any other DNS proxy URL.

Operators can instead set Helm `api.channelDirectoryProxyUrl` to an approved
external HTTP or HTTPS proxy, such as `http://198.51.100.25:3128` with the
example IP and port replaced. The value must contain one literal IPv4 address
other than `0.0.0.0` and an explicit port, without credentials or a path. The
chart passes it to the API as `OCC_CHANNEL_DIRECTORY_PROXY_URL` and allows API
Pod egress only to that IP and port. The proxy must permit `CONNECT slack.com:443`; restrict its other
destinations at the proxy. The chart does not grant the worker or Agent Pods this
egress.

The Driver sends Slack API requests through the selected tunnel and verifies
Slack's TLS certificate. Keep the selected bot token in the same-Namespace
Secret; Helm values need no token or other credential for the proxy.
Without a reachable Slack route, lookup returns unavailable, and credential
validation answers as described in [Credential validation](#credential-validation). Exact-ID entry does not bypass credential validation. See the
[production controller settings](../settings/production.md) for the environment
contract.

See the [ChannelDriver contract](channel.md) for OCC authorization and
[Slack Configuration](../configuration/secrets.md#native-channel-configuration)
for gateway token bindings.
