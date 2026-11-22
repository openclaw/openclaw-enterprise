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
Console displays the workspace and saves selected IDs, never names. An empty,
null, or absent provider cursor marks the final page, as defined by
[Slack pagination](https://docs.slack.dev/apis/web-api/pagination/).

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
path. An unavailable configured route remains retryable. If no managed OCC
listener is configured, credential validation reports a configuration conflict
before provider I/O. The Driver never falls back to direct access.

## Enable lookup in production

Configure [managed channel egress](kubernetes-compute/channel-egress.md).
Composition derives the reserved OCC listener from the validated installation
settings and permits only that exact Service host. The API and Gateway use
separate listeners. Envoy receives no provider credentials.

`enableRouting()` declares the apex and subdomains of `slack.com`,
`slack-edge.com` and `slack-msgs.com` on TCP 443. Compute owns address checks,
per-Agent rules and revocation. Provider TLS stays end-to-end and its
certificates remain verified. Directory lookup cannot select an Agent's listener.

Keep the bot token in its same-Namespace Secret. Lookup returns unavailable when
the managed route cannot be used. Exact-ID entry does not bypass credential
validation. See the [ChannelDriver contract](channel.md) for authorization and
[Slack Configuration](../configuration/secrets.md#native-channel-configuration)
for Gateway token bindings.
