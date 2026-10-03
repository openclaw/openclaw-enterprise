# Configure Agent channels and credentials

These are the **Channels** and **Credentials** tabs of the [Agent detail page](agent-details.md). Changes on both tabs apply only after **Deploy new version**.

## Channels tab

The Slack card shows **Not configured**, **Disabled**, or
**Configured (enabled)** based on saved settings: Socket Mode, selected channels, and allowed users. This is not a
live connection indicator.

Version cards are read-only. On the new version draft, **Configure** or **Edit** opens
a drawer; **Disable** saves a disabled channel setting. These changes affect
future deployments, including other Agents sharing that Configuration. They do
not stop a running channel or modify an existing revision. Channels require
Dedicated execution; unsupported native settings can make the simple editor
unavailable.

### Slack editor

| Control                                                   | Purpose                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Enable Slack**                                          | Enables Slack in the draft when saved.                                                                            |
| **Slack channel IDs**                                     | Comma-separated channel IDs, not channel names. Existing properties of retained channels are preserved.           |
| **Allowed channel user IDs**                              | Comma-separated Slack user IDs allowed to mention the Agent in the selected channels.                             |
| **Allow everyone in these channels to mention the agent** | Allows any Slack user in the selected channels to mention the Agent. Direct-message access is unchanged.          |
| **Require a mention**                                     | Applies the mention requirement to the listed channels.                                                           |
| **Slack app token** / **Slack bot token**                 | Search readable Secrets by name or ID, then select with arrow keys and Enter, or choose **Create new Secret...**. |
| **Create new Secret...**                                  | Opens a modal with an editable Agent-prefixed Name, the fixed binding key, and a masked Value.                    |
| **Open Agent Credentials**                                | Opens Credentials in a new tab, keeping unsaved drawer inputs. Save channel edits before changing credentials.    |
| **Save configuration**                                    | Saves channel settings and selected Secret bindings to the shared draft.                                          |
| **Cancel** / **Close**                                    | Discards the drawer's unsaved inputs.                                                                             |

Saving preserves existing direct-message and group policies. Channel user IDs do
not edit `allowFrom`, and **No selected channels** describes the saved channel
list; it does not by itself determine whether DMs work.
See [Slack setup](../integrations/slack.md) for credentials and policy details.

In any Secret picker, typing a Secret's exact name selects it when you press
Enter or leave the field, as choosing its suggestion does; other text restores
the bound Secret.

**Create Secret** stores the value immediately. Cancelling the channel drawer
discards token selections but does not delete that Namespace Secret. The modal
never reads an existing value. If the name already exists in this Namespace,
correct the Name and retry; both fields remain filled and the existing Secret is unchanged.
See the [Console reference](../../reference/console.md#inspect-detail-revisions-and-channel-drafts)
for binding permissions and save behavior. Apply the saved draft with
**Deploy new version** before expecting the running Agent to use it.

Microsoft Teams has no console editor. Existing Teams settings remain visible
in native Configuration JSON, but a Teams-enabled draft cannot deploy through
the console. Use the operator workflow for those Agents.

## Credentials tab

### Harness authentication

**Authentication source** determines how the harness gets model credentials:

| Choice                           | Required input and effect                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| **None**                         | No binding; deployment remains blocked.                                                          |
| **API key**                      | Select a Namespace Secret containing the API key, or create one through the picker.              |
| **Service Accounts**             | Select a Namespace Secret containing a service account token; available for Dedicated execution. |
| **Operator-managed credentials** | Credentials configured on the runtime host; OCC does not validate them.                          |
| **ChatGPT service account**      | Select an already issued account in this Namespace. This selector does not create an account.    |

**Save authentication source** saves the Agent binding for a future deployment.
For API keys and Service Accounts tokens, it also grants the Agent access to
that exact Secret through your authorized Namespace IAM operations. If the
binding saves but the grant fails, ask a Namespace administrator to confirm
`secret:operate` for this Agent on that Secret, then use **Retry credential
access**. The retry checks the saved binding and does not resave it. If the
binding changed, or the save outcome is unknown, use **Reload authentication source** first.
Deployment authorization failures remain visible beside **Deploy new version**;
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
| **Slack app token** / **Slack bot token** pickers | Select a readable Namespace Secret or **Create new Secret...**. Missing tokens need a selected binding.          |
| **Save channel Secrets**                          | Saves Configuration Secret bindings, grants the Agent access, and requires an explicit deployment to apply them. |

First-deployment credential generation requires Agent `read` and `operate` when
generated credentials are missing; deployment also requires `deploy`.
Saving channel Secrets additionally requires Secret,
Configuration, and Namespace IAM permissions. These are multiple writes, so a
failure can leave partial progress. **Outcome unknown** means refresh and inspect
saved state before retrying. Save requires at least one changed selection and a
bound Secret for each token. Changing the picker switches the referenced Secret;
it does not overwrite an existing shared Secret value. Existing values are never
fetched or displayed.
