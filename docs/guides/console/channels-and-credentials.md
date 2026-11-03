# Configure Agent channels and credentials

These are the **Channels** and **Credentials** tabs of the [Agent detail page](agent-details.md). Changes on both tabs apply only after **Deploy new version**.

## Channels tab

The Slack card shows **Not configured**, **Disabled**, or
**Configured (enabled)** based on saved settings: Socket Mode, selected channels, and allowed users. This is not a
live connection indicator.

Version cards are read-only. On the new version draft, **Configure Slack** or **Edit Slack**
opens a drawer; **Disable Slack** saves a disabled channel setting. These changes affect
future deployments, including other Agents sharing that Configuration. They do
not stop a running channel or modify an existing version. Channels require
Dedicated execution; unsupported native settings can make the simple editor
unavailable.

### Slack editor

| Control                                                                 | Purpose                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enable Slack**                                                        | Enables Slack in the draft when saved.                                                                                                                                                                                                                                                        |
| **Slack bot token** / **Slack app token**                               | Search readable Secrets by name or ID, then select with arrow keys and Enter, or choose **Create new Secret...**. The bot token Secret also enables name search below. Both are required while Slack is enabled. A Secret you may read but not `operate` is listed disabled, with the reason. |
| **Create new Secret...**                                                | Opens a modal with an editable Name (the Agent name and token by default), the fixed binding key, and a masked Value. Without Secret `create` in the Namespace, it is disabled and says why.                                                                                                  |
| **View bot token Secret metadata** / **View app token Secret metadata** | Opens the selected Secret on the **Secrets** page in a new tab, keeping unsaved drawer inputs. Shown only for a Secret you can read.                                                                                                                                                          |
| **Channels**                                                            | Search channels by name with the bot token Secret, or paste exact channel IDs. Existing properties of retained channels are preserved.                                                                                                                                                        |
| **Who can use the agent in these channels?**                            | **Specific people** limits mentions to **Allowed people in these channels**; **Everyone in these channels** allows any Slack user there. Direct-message access is separate.                                                                                                                   |
| **Allowed people in these channels**                                    | Slack users, by name search or exact user ID, who may mention the Agent in the selected channels.                                                                                                                                                                                             |
| **Require a mention**                                                   | Applies the mention requirement to the listed channels.                                                                                                                                                                                                                                       |
| **Direct-message policy**                                               | **Pairing** (approve new senders), **Allowlist** (selected users only, the default for a new setup), **Open** (anyone) or **Disabled**. An existing setup without a policy shows **Runtime default (pairing)**.                                                                               |
| **Allowed people in direct messages**                                   | Users allowed to send direct messages under Allowlist, or preapproved under Pairing. Allowlist needs at least one.                                                                                                                                                                            |
| **Save configuration**                                                  | Saves channel settings and selected Secret bindings to the shared draft. It stays disabled until you change a setting or a Secret binding.                                                                                                                                                    |
| **Cancel** / **Close**                                                  | Discards the drawer's unsaved inputs.                                                                                                                                                                                                                                                         |

Name search needs a reachable Slack directory; when it is unavailable, the drawer says so and
exact IDs still work. Channel access and direct-message access are independent:
channel people edit the selected channels' `users`. Switching to **Open** writes
`allowFrom: ["*"]`, Pairing or Allowlist write the listed people to `allowFrom`, and Disabled
keeps the saved list. Save channel edits before changing
credentials on the Credentials tab. A save keeps each Secret binding it does not change, so it
needs Secret `operate` on that Secret, as described in [Channel Secrets](#channel-secrets).

A Configuration save refuses an enabled channel whose token reference has no
Secret binding. The refusal names the setting and the binding, for example
`channels.slack.botToken` and `SLACK_BOT_TOKEN`, once, under the Configuration JSON
when you edit it there or on Create Agent. Select the token Secrets in the Slack
editor or on the Credentials tab, or remove the reference. A token must be
exactly one `${NAME}`: `$NAME`, a fallback, or other text, spaces or references
with `${NAME}` are refused, and the message names the form. The Slack editor opens tokens saved as `${SLACK_APP_TOKEN}` and
`${SLACK_BOT_TOKEN}` and keeps that form.
See [Slack setup](../integrations/slack.md) for credentials and policy details.

In any Secret picker, typing a Secret's exact name selects it when you press
Enter or leave the field, as choosing its suggestion does; other text restores
the bound Secret.
Choose **Refresh Secret list** to find a Secret created in another tab or retry a
failed list read. It preserves your search, focus, and staged choices without saving.
The highlighted Secret stays highlighted by identity; if removed, choose again before
pressing Enter. Refresh is unavailable while a read is pending; repeated activation is not queued.
Existing access restrictions still apply.

**Create Secret** stores the value immediately. Cancelling the channel drawer
discards token selections but does not delete that Namespace Secret. The modal
never reads an existing value. If the name already exists in this Namespace,
correct the Name and retry; both fields remain filled and the existing Secret is unchanged.
See the [Console reference](../../reference/console/versions-and-channel-drafts.md)
for binding permissions and save behavior. Apply the saved draft with
**Deploy new version** before expecting the running Agent to use it.

Microsoft Teams has no console editor. Existing Teams settings remain visible
in native Configuration JSON, but a Teams-enabled draft cannot deploy through
the console. Use the operator workflow for those Agents.

## Credentials tab

### Harness authentication

**Authentication source** determines how the harness gets model credentials:

| Choice                           | Required input and effect                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **None**                         | No binding; deployment remains blocked.                                                                           |
| **API key**                      | Select a Namespace Secret containing the API key, or create one through the picker.                               |
| **Service Accounts**             | Select a Namespace Secret containing a service account token; available for the Codex Harness.                    |
| **ChatGPT OAuth (Experimental)** | Codex Harness only: sign in through a device code; see [credential lifecycle](../deploy/credential-lifecycle.md). |
| **Operator-managed credentials** | Credentials configured on the runtime host; OCC does not validate them.                                           |
| **ChatGPT service account**      | Select an already issued account in this Namespace. This selector does not create an account.                     |

**Save authentication source** saves the Agent binding for a future deployment.
It needs Agent `update`, Configuration `read`, `operate` on each Secret and credential source
that the Agent and its Configuration bind, and `read` on a ChatGPT service account it uses;
without them, the source is read-only and a note names what is missing.
For API keys and Service Accounts tokens, it also grants the Agent access to
that exact Secret. Granting needs Installation `administer`. When a member saves
the source, the binding saves, but the member's session sends no grant. The form
stays editable and says that deploying checks the Agent's access: if the Agent
cannot use the Secret, ask an Installation administrator to give the Agent
`operate` on it, for example by opening the Agent's Credentials and selecting
**Save authentication source**. **Deploy new version** stays available. When an administrator opens Credentials, the tab reads Namespace IAM, says
when that grant is missing and holds **Deploy new version** until it is granted.
When your access no longer includes updating this Agent, the warning asks an
Installation administrator to grant it.
If the grant was already in place, **Reload authentication source** clears the
warning. If a grant request is refused or its outcome is lost, the console says
so and offers **Retry credential access**.
The retry checks the saved binding and does not resave it. If the
binding changed, or the save outcome is unknown, use **Reload authentication source** first.
Deploying needs Secret `operate` on each Secret the draft binds. When your access
does not include it, **Deploy new version** is disabled and names those Secrets.
A bound Secret you cannot read is not named: the button is disabled and asks for
Secret `read` and `operate` on it. The Secret field says its name is unavailable.
Other deployment authorization failures remain visible beside **Deploy new version**;
check both your deployment permission and the Agent's credential access.
Changing between **API key** and **Service Accounts** clears the selected Secret
so a token is not silently reused for another authentication method. The account
availability message describes discovery, not model readiness.
See [harness authentication](../../reference/harness-execution.md#harness-authentication).

### Channel Secrets

This section appears when Slack is enabled in the saved Configuration.

| Component                                         | Purpose                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Slack app token / bot token: Bound/Missing**    | Reports saved Secret references, not whether Slack accepts the tokens.                                           |
| **Bound · Agent access not confirmed**            | The Secret is saved, but the Agent may not use it yet: its grant was refused, missing or not verified.           |
| **Retry Secret access**                           | Retries only the Agent's access grants for the saved bound Secrets; it saves no Configuration.                   |
| **Slack app token** / **Slack bot token** pickers | Select a readable Namespace Secret or **Create new Secret...**. Missing tokens need a selected binding.          |
| **Save channel Secrets**                          | Saves Configuration Secret bindings, grants the Agent access, and requires an explicit deployment to apply them. |

The pickers bind only `SLACK_APP_TOKEN` for the app token and `SLACK_BOT_TOKEN` for the bot token,
and only the keys the Slack tokens read. HTTP mode without an `appToken` reference reads no app
token, so it shows only the **Slack bot token** picker; HTTP mode that keeps
`appToken: "${SLACK_APP_TOKEN}"` shows both pickers. When the tokens read other keys, for example named
accounts, other `${NAME}` references or each other's key, the section lists each key as **Bound** or
**Missing** without pickers. It also lists the other keys the Slack settings read, such as a signing
secret's, below the pickers. Bind them through the Configuration API; **Deploy new version** waits
until each is bound and the Agent can use its Secret. Deployment checks the Agent's access to every
bound Secret, so a bound key no Slack setting reads, such as `SLACK_APP_TOKEN` left from Socket
Mode, shows as **Bound · not read by the Slack settings** and needs that access too. **Disable
Slack** keeps the bindings, so with Slack off the section still lists each bound Secret whose
access is not confirmed. While an
Installation administrator's console reads that access, **Deploy new version** waits, and the save
message names deployment as the next step only after the Agent's access is confirmed. Until then,
**Deploy new version** names the token or key whose Secret waits and says to select **Retry Secret
access** in Credentials. **Retry Secret access** stays available for all of them. When your access no longer includes editing this
Configuration, the panel offers no Retry and the warning asks an Installation administrator to
grant or confirm the access. If the API refuses a save for a channel setting, the panel
shows the API's message, which names the setting. Fix that setting in the Configuration JSON on the
Configuration tab. If the message asks for a Secret binding of another name, bind that name through
the Configuration API.

First-deployment credential generation requires Agent `read` and `operate` when
generated credentials are missing; deployment also requires `deploy`.
Saving channel Secrets additionally requires Secret,
Configuration, and Namespace IAM permissions. Every Configuration save needs Secret `operate`
on each Secret it keeps bound, and **Save channel Secrets** keeps every binding it does not change.
When the Secret you cannot operate is a Slack token, the panel names it: choose another Secret for
it, or the console refuses the save before sending it. **Disable Slack** stays disabled until you
do. Once that save succeeds, the plugin, repository and authentication source controls become
editable without a reload. When it is bound under another key, the
pickers are read-only and name that key. These are multiple writes, so a
failure can leave partial progress. Granting the Agent a Secret needs Installation
`administer`: when a member saves a token, the Configuration saves, but the member's session
sends no grant, so it does not verify the Agent's access. The console asks an Installation
administrator to open the Agent's Credentials and select **Retry Secret access**, and offers
no retry itself. **Deploy new version** stays available, and **Reload draft** clears the
warning: the member's console cannot read the grant, so the API refuses a deployment it does
not cover. **Outcome unknown** means refresh and inspect
saved state before retrying. Save requires at least one changed selection and a
bound Secret for each token. Changing the picker switches the referenced Secret;
it does not overwrite an existing shared Secret value. Existing values are never
fetched or displayed.
