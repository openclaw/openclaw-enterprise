# Connect an Agent to Slack

Connect a dedicated Codex Agent to a Slack workspace using Socket Mode. A
Kubernetes installation and an existing Slack app are required. Slack credentials
go to the Agent's gateway; model credentials are configured separately.

## Before you start

- Enable Slack Socket Mode and create an app-level token (`xapp-`) with
  [`connections:write`](https://docs.slack.dev/reference/scopes/connections.write/).
  Subscribe to the bot event [`app_mention`](https://docs.slack.dev/reference/events/app_mention/).
  Grant the bot token (`xoxb-`) [`app_mentions:read`](https://docs.slack.dev/reference/scopes/app_mentions.read/)
  to receive channel mentions and [`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)
  to send replies. [Reinstall the Slack app](https://docs.slack.dev/app-management/distribution/#when-is-a-reinstall-required)
  if you add bot scopes to an existing installation.
- Invite the app's bot to the channel. Your Installation operator must allow
  the gateway's Slack network traffic and provide a runtime image that includes
  the native Slack plugin.
- Require the operator to [configure and verify the Slack route](#configure-the-slack-route)
  before enabling Slack: gateway messaging and Console directory lookup use
  a shared proxy by default, with an optional directory-only override and
  separate client egress rules.
- Choose a dedicated Codex Agent on Kubernetes and configure its
  [model authentication](../../reference/agents.md#harness-authentication).
  Embedded OpenClaw execution cannot isolate channel credentials from the
  Harness, and Kubernetes Compute rejects embedded versions with external
  channels enabled. The Standard OpenClaw preset must leave channels disabled.
- First deployment generates required connection credentials. It requires Agent
  `deploy`, plus Agent `read` and `operate` when generation is needed.
  Selecting Secrets requires [readable Secret metadata](../../reference/drivers/secret.md#iam)
  and caller `operate` on each selected Secret. Saving token bindings requires Configuration update and
  [Namespace IAM administration](../../reference/authorization.md#manage-namespace-policy)
  to grant the Agent access to each exact Secret. Creating a token Secret also
  requires Secret creation permission in the Namespace.

<a id="configure-both-slack-proxies"></a>

## Configure the Slack route

Ask your operator to [configure the Gateway proxy](gateway-proxy.md). The bundled
proxy permits Slack by default; an external proxy must permit `slack.com`,
`slack-edge.com`, `slack-msgs.com`, and their subdomains on TCP 443. By default,
one endpoint serves Gateway messaging and API directory requests. The operator
can [override the directory endpoint](gateway-proxy.md#directory-proxy-override-optional)
when the API needs a different route. Tokens remain in Agent-owned
Secrets, not operator proxy configuration.

Apply the protected Installation and Helm configuration through the installation
procedure, then roll out OCC and replace affected Agent revisions. The Compute
Driver grants Gateway access to its selected endpoint independently of
channel enablement. Existing channel placement restrictions still apply.

Verify directory lookup and Slack messaging separately. Directory requests need
`CONNECT slack.com:443`; Socket Mode also uses Slack's returned WSS endpoints.
Keep TLS verification enabled, and never put tokens or signed WSS URLs in proxy
configuration. A successful lookup does not prove Socket Mode or model access.
See the [directory proxy contract](../../reference/drivers/slack-channel.md#enable-lookup-in-production).

## Connect and verify

1. Open the Agent's **Create new version** draft in the console, then open
   **Channels** and **Configure Slack** (or **Edit Slack** for an existing setup).
   Start with **Slack credentials** at the top: select a Namespace Secret or
   **Create new Secret...** for each token. The bot token enables channel and
   people name lookup; the app token is used for Socket Mode. An enabled Slack
   setup saves only with both. Exact-ID entry remains available without name lookup.
   Enable Slack and choose **Channels**, then select **Specific people** or
   **Everyone in these channels** under channel access. Leave **Require a mention**
   enabled for this setup. New Slack setups use
   [threaded channel replies](../../reference/configuration/secrets.md#native-channel-configuration).
   Choose **Disabled** under **Direct-message policy** for channel-only access,
   or keep **Allowlist** and select **Allowed people in direct messages**.
   When creating a Secret, the modal prefills the token key and accepts its value
   in a password field.
   **Create Secret** stores it immediately; **Save configuration** saves the
   selected bindings. Cancelling the drawer discards selections but keeps any
   newly created Secrets. If multiple Agents use this Configuration, the edit
   also affects their future deployments.
2. Open **Credentials**. If tokens are still missing (a Configuration saved
   before this check), select their Secrets and **Save channel Secrets**. OCC stores them as Namespace Secrets, grants the
   Agent access, and saves Configuration bindings for gateway delivery. Stored
   Secret bindings confirm storage only; they do not prove Slack accepted the tokens.
   Bound tokens show a synthetic password mask. To replace one token, edit that
   field and leave the other unchanged; its stored value is preserved.
3. Select **Deploy new version** to apply the saved bindings. OCC generates
   missing connection credentials during the first deployment when the Compute
   Driver requires them. After a channel
   draft or Secret value change, explicitly redeploy each consumer. Follow
   [Secret updates](../../reference/drivers/kubernetes-secret.md#update-and-redeploy)
   when replacing an existing token.
4. From a real Slack user account, send an explicit `@mention` to the Agent
   in an allowed channel. Ask it to repeat a short unique phrase. A reply
   containing that phrase confirms that the message reached the Agent and
   a response returned to Slack. An accepted deployment or `Stored`
   credentials alone do not prove that path.

If you manage Configuration through the API, use the
[native Slack Socket Mode example](../../reference/configuration/secrets.md#native-channel-configuration).
The console supports the default Socket Mode account and gateway environment
references; non-Socket settings, wildcard channel maps, mixed per-channel
mention settings, mixed per-channel sender lists, and sender IDs that cannot be
represented in a comma-separated field may need an API edit.

## Enable direct messages (optional)

Channel mentions do not deliver direct messages, even if the user mentions the
bot. To enable one-to-one messages:

1. In Slack, subscribe to the bot event
   [`message.im`](https://docs.slack.dev/reference/events/message.im/) and grant
   the bot token [`im:history`](https://docs.slack.dev/reference/scopes/im.history/).
   Reinstall the Slack app if the scope is new. In
   [App Home settings](https://docs.slack.dev/tools/python-slack-sdk/socket-mode/#using-socket-mode),
   enable sending messages from the **Messages** tab.
2. In **Channels → Edit Slack**, select **Allowlist** under **Direct-message
   policy** and choose **Allowed people in direct messages**. Save and redeploy. Choose
   **Disabled** to block DMs (recommended for organization-wide installs), or
   use [Pairing or Open](../../reference/configuration/secrets.md#native-channel-configuration).
   Channel user IDs do not grant DM access. If native `dm.enabled` is `false`,
   enable it in native Configuration JSON before testing DMs.
3. From an allowed user account, send the app a direct message with a new
   phrase and confirm a reply. A channel reply does not verify direct messages.

## Troubleshoot

- **Credentials show Bound but the Agent does not reply:** first confirm that
  the gateway connected to Slack, the bot has joined the configured channel,
  and the channel ID is correct. Then send an explicit mention. Ask the
  operator to check gateway network access if it cannot connect.
- **Channel messages work but direct messages do not:** check the
  `message.im` subscription, the installed bot token's `im:history` scope,
  and whether the sender's Slack user ID is allowed by the native `allowFrom`
  setting and direct-message policy.
- **Credential save failed or the response was lost:** reload the Agent and
  inspect saved Secrets, IAM bindings, and Configuration before retrying after a
  partial save; those writes are separate and are not automatically rolled back.
- **Slack replies with a model error:** check the Agent's model authentication
  and selected version independently. Slack connection alone does not establish
  model access.

## Related

- [Console channel editing](../../reference/console/versions-and-channel-drafts.md)
- [Initial Agent credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
- [Agent deployment](../../reference/agents/deployment.md)
