# Bundled Slack Channel Driver

The bundled `SlackChannelDriver` reads people and channels for the Console's
name picker. It uses the Agent's selected same-Namespace `SLACK_BOT_TOKEN`
Secret; the controller does not configure or store another token.

The Driver calls Slack [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/)
to require a bot identity and identify its workspace, then [`users.list`](https://docs.slack.dev/reference/methods/users.list/)
or [`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/).
The bot needs `users:read` for people, `channels:read` for public channels, and
`groups:read` for private channels. Slack returns only resources visible to the
bot. The Driver scans a bounded number of pages per query and returns a cursor
when more pages remain. The Console displays the workspace and saves selected
IDs, never names.

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
payload. Retry after fixing the token or scopes. Exact IDs can be entered when
directory browsing is unavailable.

## Enable lookup in production

The production API leaves directory lookup unavailable unless the operator sets
Helm `api.channelDirectoryProxyUrl` to an approved HTTP or HTTPS proxy endpoint,
for example `http://198.51.100.25:3128` after replacing the example IP and port.
The value must contain one literal IPv4 address and an explicit port, without
credentials or a path. The chart passes it to the API as
`OCC_CHANNEL_DIRECTORY_PROXY_URL` and allows API Pod egress only to that IP and
port. It does not grant the worker or Agent Pods this egress.

The proxy must permit HTTP `CONNECT` to `slack.com:443`. The Driver sends its
Slack API requests through that tunnel and verifies Slack's TLS certificate.
Restrict the proxy to that destination. Keep the selected bot token in the
same-Namespace Secret; the proxy endpoint needs no token or other credential in
the Helm value. When the value is empty, authorized lookups return an unavailable
response and the Console offers exact-ID entry. See the
[production controller settings](../settings/production.md) for the environment
contract.

See the [ChannelDriver contract](channel.md) for OCC authorization and
[Slack Configuration](../configuration/secrets.md#native-channel-configuration)
for gateway token bindings.
