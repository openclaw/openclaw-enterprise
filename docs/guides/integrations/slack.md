# Connect an Agent to Slack

Connect a dedicated Codex Agent to a Slack workspace using Socket Mode. A
Kubernetes installation and an existing Slack app are required. Slack credentials
go to the Agent's gateway; model credentials are configured separately.

## Before you start

- Create and install a Slack app in your workspace. Enable
  [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) and
  create an app-level token (`xapp-`) with
  [`connections:write`](https://docs.slack.dev/reference/scopes/connections.write/).
  Subscribe to the bot event [`app_mention`](https://docs.slack.dev/reference/events/app_mention/).
  Grant the bot token (`xoxb-`) [`app_mentions:read`](https://docs.slack.dev/reference/scopes/app_mentions.read/)
  to receive channel mentions and [`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)
  to send replies. [Reinstall the Slack app](https://docs.slack.dev/app-management/distribution/#when-is-a-reinstall-required)
  if you add bot scopes to an existing installation.
- For Console name lookup, grant the bot `users:read` and `channels:read`, plus
  `groups:read` if you use private channels. See the
  [Slack directory reference](../../reference/drivers/slack-channel.md) for
  visibility and lookup limits.
- Use one Slack app, with its own app-level and bot tokens, for each Agent.
  Slack can deliver an event to any active Socket Mode connection for that app.
  If Agents share an app, the intended Agent can miss the event.
- Invite the app's bot to the channel. Your Installation operator must allow
  the gateway's Slack network traffic and provide a runtime image that includes
  the native Slack plugin.
- Require the operator to [configure managed channel egress](#configure-managed-channel-egress)
  before enabling Slack: gateway messaging and Console directory lookup use
  separate Envoy listeners and network grants.
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

## Configure managed channel egress

Ask the Installation operator to enable the
[dedicated Envoy egress fleet](../../reference/drivers/kubernetes-compute/channel-egress.md)
and provide the actual Pod, Service and node address exclusions. The
installation profile accepts `channels.managedEgress: true` with
`channels.excludedCidrs` and writes matching Helm and Compute settings.
Follow [dependency setup](../deploy/channel-egress.md) before installing the
channel resources. Enabled Helm defaults do not install Envoy dependencies;
the Kubernetes and EKS quickstart templates explicitly disable channels until
you configure them.
Envoy Gateway must enable EnvoyPatchPolicy support. The egress fleet uses its
qualified image separately from private workspace ingress.

Each enabled Agent receives its own actual listener port. OCC uses a separate
listener for credential validation and directory lookup. The Harness receives
neither grant. No Slack token belongs in Helm values or Envoy configuration.
Customer upstream proxies are not supported.

Verify both consumers before handing off the setup:

1. In the Console, select the bot Secret and search for a known user and channel.
2. Deploy the Agent. Require its Gateway and Harness to be Ready and confirm
   that Slack Socket Mode connected. Complete the message proof below.
3. Verify that the same Gateway cannot reach another Agent's listener, an
   unlisted destination or a private upstream address. Direct internet fallback
   must remain denied.

A directory `503` can mean the OCC listener or Slack is unavailable. An absent
managed route makes credential validation return a configuration conflict.
Repair the fleet and retry; entering exact IDs does not verify directory access.
A missing-scope error requires updating the Slack app's scopes. No new
channel-enabled Gateway starts until its own listener and network grants are installed.

## Connect and verify

Follow [Channels](channels.md#add-slack-in-the-console) to create or select the
Secrets in the Slack drawer, restrict access, save, deploy, and verify a threaded
reply. Stored bindings confirm storage only; they do not prove that Slack
accepted the tokens or delivered a message.

For an older Configuration with missing token bindings, open **Credentials**,
select the token Secrets, and choose **Save channel Secrets**. Bound tokens show
a password mask. To replace one token, edit that field and leave the other
unchanged. Follow [Secret updates](../../reference/drivers/kubernetes-secret.md#update-and-redeploy)
and explicitly redeploy each consumer after a token value or channel change.

If you manage Configuration through the API, use the
[native Slack Socket Mode example](../../reference/configuration/secrets.md#native-channel-configuration).
The console supports the default Socket Mode account and gateway environment
references; non-Socket settings, wildcard channel maps, mixed per-channel
mention settings, mixed per-channel sender lists, and sender IDs that cannot be
represented in a comma-separated field may need an API edit.

## Enable channel messages without mentions (optional)

Consider model token costs before disabling **Require a mention**. Slack event
subscriptions control delivery; the channel's mention setting controls admission
to model turns. With this setting enabled, ordinary channel text without a
mention is rejected before model dispatch. Replies in threads where the bot
participates can count as implicit mentions. Disabling the setting lets other
messages trigger model turns, increasing input tokens for messages and context
and output tokens for generated responses. This can increase costs substantially
in busy channels. Receiving a Slack event alone does not consume model tokens;
calling the model does.

Disabling **Require a mention** changes the Agent's message filter. It does not
change the Slack app's event subscriptions. The bot token's scopes and the app's
bot event subscriptions must both permit channel messages:

1. Open [Your Slack Apps](https://api.slack.com/apps), select the Agent's app,
   then open **Features → Event Subscriptions → Subscribe to bot events**.
   Select **Add Bot User Event** and add the event for each channel type you use:

   | Channel type | Bot event                                                                       | Required bot token scope |
   | ------------ | ------------------------------------------------------------------------------- | ------------------------ |
   | Public       | [`message.channels`](https://docs.slack.dev/reference/events/message.channels/) | `channels:history`       |
   | Private      | [`message.groups`](https://docs.slack.dev/reference/events/message.groups/)     | `groups:history`         |

   Keep `app_mention` and select **Save Changes**.

2. Under **OAuth & Permissions → Bot Token Scopes**, confirm the required scopes.
   Add any missing scopes, then select **Install App → Reinstall to Workspace**
   if you added scopes.
3. In the Console, open **Channels → Edit Slack**, clear **Require a mention**,
   save, and deploy a new version. If the running Agent already has this setting
   disabled, changing the Slack event subscriptions does not require another
   Agent deployment.
4. From an allowed user account, send a new top-level message without an
   `@mention` in a configured channel where the bot is a member. Ask the Agent
   to repeat a short unique phrase and confirm that its reply contains that
   phrase. Do not use an existing thread where the bot has participated; its
   implicit mention handling can admit the message even when mentions are required.

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
- **Some messages never reach the Agent:** check whether another Agent connects
  to the same Slack app. Give each Agent its own app and use that app's tokens.
- **The Agent replies only to mentions after Require a mention is disabled:**
  check the app's bot event subscriptions as well as its bot token scopes. Follow
  [Enable channel messages without mentions](#enable-channel-messages-without-mentions-optional).
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
