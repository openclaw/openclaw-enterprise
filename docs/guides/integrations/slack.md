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
- Require the operator to [configure and verify both Slack proxies](#configure-both-slack-proxies)
  before enabling Slack: gateway messaging and Console directory lookup use
  separate settings and egress rules.
- Choose a dedicated Agent on Kubernetes and configure its
  [model authentication](../../reference/agents.md#harness-authentication).
  Embedded execution cannot isolate channel credentials from the Harness.
- First deployment generates required connection credentials. It requires Agent
  `deploy`, plus Agent `read` and `operate` when generation is needed.
  Selecting Secrets requires [readable Secret metadata](../../reference/drivers/secret.md#iam)
  and caller `operate` on each selected Secret. Saving token bindings requires Configuration update and
  [Namespace IAM administration](../../reference/authorization.md#manage-namespace-policy)
  to grant the Agent access to each exact Secret. Creating a token Secret also
  requires Secret creation permission in the Namespace.

## Configure both Slack proxies

For Slack-enabled k3d and EKS installations, configure both paths before
creating a Slack-enabled Agent. A working Socket Mode connection does not
establish that Console user or channel search works.

| Path                            | Required setting                                                                   | Consumer          |
| ------------------------------- | ---------------------------------------------------------------------------------- | ----------------- |
| Slack messaging and Socket Mode | Installation `drivers.compute.configuration.runtime.channels.proxyUrl`             | Dedicated gateway |
| Console user and channel lookup | Helm `api.channelDirectoryProxyUrl`, rendered as `OCC_CHANNEL_DIRECTORY_PROXY_URL` | OCC API           |

Provision a reviewed HTTP CONNECT proxy reachable from each consumer. Use a
literal IPv4 address and explicit port, with no URL credentials or path. The
same endpoint can serve both paths when its access policy admits both sources;
setting one URL does not configure the other path. Keep the listener private,
restrict callers to the intended API and gateway traffic, and deny unrelated
destinations and private upstream addresses.

The directory path needs `CONNECT slack.com:443`. The gateway path also needs
the Slack Socket Mode endpoints returned for the app; review the required
`slack.com`, `slack-edge.com`, and `slack-msgs.com` domains and their subdomains.
Retain TLS certificate verification. See the [directory proxy contract](../../reference/drivers/slack-channel.md#enable-lookup-in-production)
and [gateway network boundary](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).

Merge these fragments into the protected Installation and Helm inputs. Replace
the documentation-only IP with the reviewed endpoint; preserve other settings.

```yaml
# installation.yaml
drivers:
  compute:
    configuration:
      runtime:
        channels:
          proxyUrl: http://198.51.100.25:3128
```

```yaml
# Helm values
api:
  channelDirectoryProxyUrl: http://198.51.100.25:3128
```

Apply both inputs through the installation procedure and roll out the affected
control-plane processes so they load the new configuration. The Helm chart
grants API egress to its configured proxy IP and port; Kubernetes Compute grants
gateway egress to its channel proxy. Provision the proxy's own listener access
and upstream connectivity separately. Keep Slack tokens in Namespace Secrets;
do not place them in these inputs or the proxy configuration.

For an existing installation, once OCC reloads the gateway proxy setting, deploy
a new revision for every affected running Slack Agent. Its gateway environment
and channel NetworkPolicy are rendered during revision preparation; restarting
OCC alone does not update existing gateways. Preserve stopped Agents' state.
Changing only the API directory proxy does not require an Agent redeployment.

Before handing off the Slack setup, verify both paths:

1. In the Console, select the Slack bot Secret and search for a known user and
   channel visible to that bot. Require successful results. The bot needs
   `users:read`, `channels:read`, and `groups:read` for private channels.
2. After deploying, require the current gateway and Harness to be Ready and
   confirm Slack Socket Mode is connected. Use the authorized message proof
   below to establish delivery separately.
3. Confirm the proxy denies an unrelated public destination and a private
   upstream destination from the same permitted caller path.

A directory response of `501` means the API path is not configured; a missing
scope response requires updating the bot's Slack scopes. Missing gateway proxy
configuration prevents Slack-enabled workload preparation. Resolve each path
independently; entering exact IDs does not verify directory lookup.

## Connect and verify

1. Open the Agent's **Create new version** draft in the console, then open
   **Channels** and **Configure Slack** (or **Edit Slack** for an existing setup).
   Start with **Slack credentials** at the top: select a Namespace Secret or
   **Create new Secret...** for each token. The bot token enables channel and
   people name lookup; the app token is used for Socket Mode. Both are required
   before deployment. Exact-ID entry remains available without name lookup.
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
2. Open **Credentials**. If tokens are still missing, select their Secrets and
   **Save channel Secrets**. OCC stores them as Namespace Secrets, grants the
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
   policy** and enter **Allowed DM user IDs**. Save and redeploy. Choose
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
  and active revision independently. Slack connection alone does not establish
  model access.

## Related

- [Console channel editing](../../reference/console.md#inspect-detail-revisions-and-channel-drafts)
- [Initial Agent credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
- [Agent deployment](../../reference/agents/deployment.md)
