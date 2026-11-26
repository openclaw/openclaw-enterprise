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

| Control                                      | Purpose                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enable Slack**                             | Enables Slack in the draft when saved.                                                                                                                                                                          |
| **Slack bot token** / **Slack app token**    | Select a ready static Credential Source or choose **Add new credential…**. Both tokens are required while Slack is enabled. Saving checks exact Source `operate` and owner support.                             |
| **Channels**                                 | Search channels by name with the bot token Credential Source, or paste exact channel IDs. Existing properties of retained channels are preserved.                                                               |
| **Who can use the agent in these channels?** | **Specific people** limits mentions to **Allowed people in these channels**; **Everyone in these channels** allows any Slack user there. Direct-message access is separate.                                     |
| **Allowed people in these channels**         | Slack users, by name search or exact user ID, who may mention the Agent in the selected channels.                                                                                                               |
| **Require a mention**                        | Applies the mention requirement to the listed channels.                                                                                                                                                         |
| **Direct-message policy**                    | **Pairing** (approve new senders), **Allowlist** (selected users only, the default for a new setup), **Open** (anyone) or **Disabled**. An existing setup without a policy shows **Runtime default (pairing)**. |
| **Allowed people in direct messages**        | Users allowed to send direct messages under Allowlist, or preapproved under Pairing. Allowlist needs at least one.                                                                                              |
| **Save configuration**                       | Saves channel settings and selected Credential Source bindings to the shared draft. It stays disabled until you change a setting or binding.                                                                    |
| **Cancel** / **Close**                       | Discards the drawer's unsaved inputs.                                                                                                                                                                           |

Name search needs a reachable Slack directory; when it is unavailable, the drawer says so and
exact IDs still work. Channel access and direct-message access are independent:
channel people edit the selected channels' `users`. Switching to **Open** writes
`allowFrom: ["*"]`, Pairing or Allowlist write the listed people to `allowFrom`, and Disabled
keeps the saved list. Save channel edits before changing
credentials on the Credentials tab. A save keeps bindings it does not change and requires exact
`operate` on each bound credential, as described in [Channel credentials](#channel-credentials).

A Configuration save refuses an enabled channel whose token reference has no
credential binding. The refusal names the setting and the binding, for example
`channels.slack.botToken` and `SLACK_BOT_TOKEN`, once, under the Configuration JSON
when you edit it there or on Create Agent. Select the token Sources in the Slack
editor or on the Credentials tab, or remove the reference. A token must be
exactly one `${NAME}`: `$NAME`, a fallback, or other text, spaces or references
with `${NAME}` are refused, and the message names the form. The Slack editor opens tokens saved as `${SLACK_APP_TOKEN}` and
`${SLACK_BOT_TOKEN}` and keeps that form.
See [Slack setup](../integrations/slack.md) for credentials and policy details.

For **Add new credential…**, enter a Source name and the masked token, then choose **Create credential**. Source creation requires `credential_source:create` in the Namespace; saving the resulting Source binding also requires exact `operate`. If creation cannot be confirmed, check **Credentials** before trying again. You can still create Sources there and refresh the list. Former Secret-backed settings require newly created Sources. Selection stays staged until the channel changes are saved.

For native Slack settings, Create Agent and the Configuration JSON editor show Source selectors for references in unsaved settings. Select the Source before saving the reference. The Agent **Credentials** tab can replace a Source for each saved app token, bot token, signing secret, user token, or relay authentication token, including named accounts. Directory search and approver lookup use the selected bot Source and require exact Source `operate` plus permission to edit the target. The Console never retrieves stored credential values. Deploy the saved draft before expecting the running Agent to use it.

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
| **Credential Source**            | Select a compatible, readable, ready model Source for Dedicated execution. Built-in ChatGPT OAuth requires Codex. |
| **ChatGPT OAuth (Experimental)** | Codex Harness only: sign in through a device code; see [credential lifecycle](../deploy/credential-lifecycle.md). |
| **Operator-managed credentials** | Credentials configured on the runtime host; OCC does not validate them.                                           |
| **ChatGPT service account**      | Select an already issued account in this Namespace. This selector does not create an account.                     |

In any Secret picker, typing a Secret's exact name selects it when you press
Enter or leave the field, as choosing its suggestion does; other text restores
the bound Secret.
Choose **Refresh Secret list** to find a Secret created in another tab or retry a
failed list read. It preserves your search, focus, and staged choices without saving.
The highlighted Secret stays highlighted by identity; if removed, choose again before
pressing Enter. Refresh is unavailable while a read is pending; repeated activation is not queued.
Existing access restrictions still apply.

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

<a id="channel-secrets" class="anchor-alias"></a>

### Channel credentials

When Slack is enabled, the Agent **Credentials** tab lists every credential name the saved Slack settings reference. The status reports whether a ready static Credential Source is bound; it does not prove Slack accepts the value.

Choose an existing Source for each missing or changed credential, then select **Save channel credentials**. The panel supports app and bot tokens, signing secrets, user tokens, relay authentication tokens, and named accounts. Source selection changes the Configuration binding; it does not replace the Source value. Former Namespace Secret-backed settings require newly created Sources.

Saving requires Configuration `update` and exact `credential_source:operate` on each Source the saved Configuration binds. If you cannot operate a currently bound Source, choose a replacement you can operate before saving. The simple Slack drawer permits replacement of its standard app and bot bindings; use the Credentials panel for other referenced names. **Disable Slack** keeps existing bindings and is unavailable when that write would keep a binding you cannot operate.

Deploy the saved draft to apply the change. OCC admission checks the caller's exact Source authority and delegates the corresponding use grant to the Agent's service principal. The Console does not issue a separate Source grant. A refusal names the missing permission or unsupported Source owner when the API can report it. **Outcome unknown** requires refreshing saved state before retrying. Credential values are never fetched or displayed.
