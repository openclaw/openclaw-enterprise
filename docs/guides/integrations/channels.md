# Channels

Connect an existing Agent to Slack from the Console, then mention it in a channel
and receive a reply.

## Before you start

- Use a **dedicated Codex** Agent on Kubernetes with working model
  authentication. [Deploy your first Agent](../deploy/deploy-first-agent.md)
  if you do not have one. Embedded OpenClaw Harnesses cannot use external
  channels; keep Slack disabled on the Standard OpenClaw preset.
- Ask your Installation operator to confirm that
  [managed channel egress](../deploy/channel-egress.md) is ready. Private
  workspace routing alone does not provide Slack access.
- Prepare one Slack app for this Agent. Follow the
  [Slack app and permission requirements](slack.md#before-you-start) for Socket
  Mode, token scopes, event subscriptions, and Console permissions. Keep its app
  and bot tokens available for Secret creation. Do not run another Agent or
  local process with the same app's Socket Mode token.
- In Slack, invite the app to the channel where you will test it. Use a channel
  and sender that you are authorized to connect to this Agent.

## Add Slack in the Console

1. Open **Agents**, select your Agent, and select **Create new version**.
   Open **Channels**, then **Configure Slack**. For an existing Slack setup,
   select **Edit Slack**.
2. Under **Slack credentials**, select the bot token Secret first. To create
   one, choose **Create new Secret...**, enter a name and the bot token in
   **Value**, keep the prefilled key, and select **Create Secret**. Repeat for
   the app token. You can also select existing Namespace Secrets that you have
   permission to use.

   **Create Secret** stores the Secret immediately. Cancelling the Slack drawer
   does not delete it. Both token bindings are required to save enabled Slack.

3. Enable Slack. Under **Channels**, search for and select the channel you
   invited the app to. The bot token enables channel and people lookup.
4. Under **Who can use the agent in these channels?**, keep **Specific people**
   and select the people who may use it, including your test sender. Choose
   **Everyone in these channels** only if all members of those channels should
   have access.
5. Leave **Require a mention** enabled. Under **Direct-message policy**, select
   **Disabled — no direct messages** for this channel-only setup. The new-setup
   default is **Allowlist — selected users only**; direct-message access is
   separate from channel access.
6. Select **Save configuration**. If other Agents use the same Configuration,
   the saved changes also apply to their future deployments.
7. Select **Deploy new version**. Wait for the Agent's Gateway and Harness to
   become Ready. Saving configuration or creating Secrets does not update the
   running version; deploy again after changing a channel or its token value.

## Verify a reply

In the selected Slack channel, use an allowed user account to mention the app
explicitly. For example, send `@YourAgent Reply with: channels check 7319`, using
a new phrase for your run. Open the message thread and confirm that the Agent
replies with that phrase. New Slack setups use threaded channel replies.

A saved Secret or Ready deployment does not prove message delivery. If no reply
arrives, check the app invitation, selected channel and sender, mention, and
deployment. Then use the [Slack integration guide](slack.md) to check app scopes,
Socket Mode, and managed egress. Keep mention filtering enabled unless you
intend to [allow channel messages without mentions](slack.md#enable-channel-messages-without-mentions-optional).
