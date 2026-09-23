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
- Choose a dedicated Agent on Kubernetes and configure its
  [model authentication](../../reference/agents.md#harness-authentication).
  Embedded execution cannot isolate channel credentials from the Harness.
- To provision generated credentials, you need `read` and `operate` on the Agent.
  Selecting Secrets requires [readable Secret metadata](../../reference/drivers/secret.md#iam)
  and caller `operate` on each selected Secret. Saving token bindings requires Configuration update and
  [Namespace IAM administration](../../reference/authorization.md#manage-namespace-policy)
  to grant the Agent access to each exact Secret. Creating a token Secret also
  requires Secret creation permission in the Namespace.

## Connect and verify

1. Open the Agent's new revision in the console and open **Channels**. Enable
   Slack, enter the channel IDs, and leave **Require mention** enabled for this
   setup. For each token menu, select a Namespace Secret or **Create new Secret...**.
   The modal prefills the token key and accepts its value in a password field.
   **Create Secret** stores it immediately; **Save configuration** saves the
   selected bindings. Cancelling the drawer discards selections but keeps any
   newly created Secrets. If multiple Agents use this Configuration, the edit
   also affects their future deployments.
2. Open **Credentials** and select **Provision generated runtime credentials**
   before the first deployment. If tokens are still missing, fill them and select
   **Save channel Secrets**. OCC stores them as Namespace Secrets, grants the
   Agent access, and saves Configuration bindings for gateway delivery. Stored
   credentials confirm storage only; they do not prove Slack accepted them.
   Bound tokens show a synthetic password mask. To replace one token, edit that
   field and leave the other unchanged; its stored value is preserved.
3. Select **Deploy new revision** to apply the saved bindings. After a channel
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
references; non-Socket settings and mixed per-channel mention settings may
need an API edit.

## Enable direct messages (optional)

Channel mentions do not deliver direct messages, even if the user mentions the
bot. To enable one-to-one messages:

1. In Slack, subscribe to the bot event
   [`message.im`](https://docs.slack.dev/reference/events/message.im/) and grant
   the bot token [`im:history`](https://docs.slack.dev/reference/scopes/im.history/).
   Reinstall the Slack app if the scope is new. In
   [App Home settings](https://docs.slack.dev/tools/python-slack-sdk/socket-mode/#using-socket-mode),
   enable sending messages from the **Messages** tab.
2. In the OCC console, add the intended Slack user IDs under **Allowed user
   IDs**, save the channel draft, and redeploy.
3. From an allowed user account, send the app a direct message with a new
   phrase and confirm a reply. A channel reply does not verify direct messages.

## Troubleshoot

- **Credentials show Stored but the Agent does not reply:** first confirm that
  the gateway connected to Slack, the bot has joined the configured channel,
  and the channel ID is correct. Then send an explicit mention. Ask the
  operator to check gateway network access if it cannot connect.
- **Channel messages work but direct messages do not:** check the
  `message.im` subscription, the installed bot token's `im:history` scope,
  and whether the sender's Slack user ID is in **Allowed user IDs**.
- **Credential save failed or the response was lost:** select **Refresh status**
  before retrying. Inspect saved Secrets, IAM bindings, and Configuration after a
  partial save; those writes are separate and are not automatically rolled back.
- **Slack replies with a model error:** check the Agent's model authentication
  and active revision independently. Slack connection alone does not establish
  model access.

## Related

- [Console channel editing](../../reference/console.md#inspect-detail-revisions-and-channel-drafts)
- [Initial Agent credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
- [Agent deployment](../../reference/agents/deployment.md)
