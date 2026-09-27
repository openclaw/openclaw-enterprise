# Understand the Agent detail page

Open **Agents**, then select an Agent to inspect its versions, saved settings,
and workspace. For initial setup, use
[Create and deploy Agents](../../reference/console/create-and-deploy.md).

Available actions depend on your Installation and permissions. Stored settings
do not confirm that an Agent or its Slack connection is currently healthy.

## Navigation and Agent identity

| Component                     | What it does                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| **Control Plane**             | Identifies the OpenClaw Control Plane (OCC) console.                                        |
| **Agents** / **← Agents**     | Opens the Agents list in the selected Namespace.                                            |
| **Namespaces**                | Lists the Namespaces you can read.                                                          |
| Agent name                    | Human-readable name of this Agent.                                                          |
| **Namespace · name**          | Namespace containing the Agent.                                                             |
| **Refresh**                   | Reloads the Agent page. It does not retry or restart deployment.                            |
| **Current version**           | Version in the Agent's `activeRevisionId`. It may differ from the latest or viewed version. |
| **Latest visible deployment** | Newest readable version and its recorded deployment status.                                 |
| **Live serving**              | Remains unverified by this page and its limited diagnostics.                                |
| **Deployment activity**       | Most recent visible version and its persisted deployment status.                            |
| `agt_…`                       | Stable Agent identifier for API calls and support.                                          |

The bottom **OpenClaw Enterprise** menu contains **Namespace**, **Settings**,
and **Logout**. Namespace selection changes your scope; from Agent detail it
returns to the new Namespace's Agents list. Settings displays your account;
it does not offer configurable settings. Logout ends your console session.

## Follow deployment activity

**Deployment activity** follows the latest readable version, even while viewing
another version or the draft. Its milestones use the persisted record:

| Milestone               | Evidence                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Admitted**            | OCC saved an immutable AgentRevision and queued its work.                       |
| **Deployment work**     | `queued` awaits a claim; `running` records a worker claim.                      |
| **Completion recorded** | `succeeded` means the original work completed activation or was already active. |

A `failed` result shows the stored error. Startup evidence may identify the
runtime component, failed check, code, and check time. Plugin warnings describe
that attempt. An unavailable record has unknown status. **Refresh deployment**
rereads it and the selected version without retrying work.

**Current version** is OCC's selection, not live health. Deployment may still
be in progress; a successful historical record does not confirm a response.
Verify the runtime and a real response with
[Agent troubleshooting](../topics/agent-troubleshoot.md).

<span id="browse-revisions-or-open-the-saved-draft"></span>

## Browse versions or create a new version

An **AgentRevision** is an immutable version created by deployment. A
**Configuration** is the reusable, mutable input for the next version.

The **Versions** list marks the current version. **View version vN** opens
read-only details: creation time, source Configuration generation, recorded
deployment status, and captured settings. The activity panel still follows the
latest visible deployment. **Available versions** jumps to readable versions;
Configuration and Channels show further details, including admitted native JSON.
The `rev_…` ID identifies an exact version for API calls and support. Viewing
does not deploy or activate it.

**Run diagnostics for this version** requests fresh, on-demand observations of
the viewed version. Checks include a time and `succeeded`, `failed`, or
`unknown` state; unavailable requests show retryable errors. Diagnostics do
not change deployment history, activate a version, repeat the startup model
probe, or prove message delivery. You need Agent `read` and `operate` plus
read access to that version.

There is no rollback or redeploy-old-revision button. See
[Agent Revisions](../topics/agent-revisions.md) for the lifecycle.

Select **Create new version** to open the current saved settings. Edit and save
Configuration, plugin selections, channel settings, or credentials as needed.
**Deploy new version** submits those saved settings for a new revision; it does
not redeploy a version you were viewing. It
checks freshness and required model and channel credentials; missing prerequisites
or a changed draft require correction or refresh. Select **Set up credentials**
beside the disabled button when a model or channel credential needs your input.
When Kubernetes Compute requires them, OCC generates missing connection
credentials during the first deployment.
If they are missing after a revision exists, ask an operator to investigate;
OCC cannot regenerate them through initial provisioning. A successful request
opens the new revision's Workspace files view. Bound channel Secrets do not
prove successful authentication or a working channel.

The **Configuration**, **Plugins**, **Channels**, **Credentials**, and **Workspace files** tabs
change the panel below. Credentials is available only on the new version draft.
Browser Back and Forward restore the selected tab. Leaving a tab clears entered
token values. The workspace remains live regardless of the viewed version.

## Configuration tab

| Field                                  | Meaning                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Model**                              | Primary model configured for the Agent.                                                                          |
| **Execution mode**                     | Embedded runs the harness within the gateway; Dedicated runs it separately.                                      |
| **Backend (experimental)**             | Installation-configured Backend associated with this Agent; model credentials come from Harness authentication.  |
| **Harness authentication**             | Saved authentication binding, such as a ChatGPT service account ID. It is not a credential value or login check. |
| **Created**                            | Creation time of the displayed Configuration or revision.                                                        |
| **Harness**                            | Revision's harness identifier and integration version. This is not the installed Codex CLI version.              |
| **Compute**                            | Revision's Compute Driver identifier and implementation.                                                         |
| **View admitted native configuration** | Expands the revision's formatted native JSON. The draft uses **View native Configuration**.                      |

In **Create new version**, select **Edit Configuration** to edit the native JSON,
including model and gateway settings. **Save Configuration** requires a JSON
object and updates the saved draft; **Cancel** discards unsaved edits. On an
admitted snapshot, **Edit current Configuration** opens the current draft, not
a copy of the historical snapshot.

Save does not deploy or change existing AgentRevisions. Select **Deploy new
version** after saving to apply the new values. Deployment, tab switching, and revision navigation are blocked while edits are unsaved, a save is
pending, or a stale or unknown result requires reload. Other Agents sharing this
Configuration also use the updated values on their next deployment.

The editor preserves existing Secret bindings and checks for a changed
Configuration or Agent association before saving. A stale draft requires reload;
this preflight cannot prevent another write racing with the save. If the outcome
is unknown, inspect the saved Configuration through a successful reload before
saving again. Invalid JSON and failed saves retain the text for correction.
Backend, execution mode, and Harness authentication are Agent fields, not native
Configuration JSON. See the [Configuration reference](../../reference/configuration.md).

## Plugins tab

Open **Create new version** → **Plugins** to change this Agent's plugin selections and
tool policies. Existing selections load from the Agent. **Configure plugins**
opens the same policy editor used when creating an Agent; **Plugin selections
JSON** also shows the complete selection map. Dedicated Codex browsing requires
exact active Agent `read`/`update` and a catalog-capable Plugin Driver. The
curated catalog needs no Secret. Hosted discovery uses the bound Service Accounts
token Secret server-side and requires caller and Agent ServicePrincipal Secret
`operate`; the browser never receives the token. Other execution modes cannot
browse this catalog. Hosted results use the draft credential, which may differ
from the running revision's; neither catalog proves installation or runtime
access. Existing
selections and **Plugin selections JSON** remain editable when browsing is
unavailable.

Select **Save plugin selections** to update the Agent's desired plugin map, then
**Deploy new version** to apply it. Saving does not alter an admitted revision
or the reusable Configuration. An empty map removes all Agent-owned plugin
selections on the next deployment. The selected Plugin Driver validates policy
at save and deployment; installation and app access are checked later during
startup. A rejected save leaves the running revision unchanged. For policy
limits and errors, see [Agent plugins](../../reference/agent-plugins.md).

When viewing an admitted revision, the **Plugins** tab shows that revision's
immutable selection. Return to **Create new version** to make another edit.
Native `values.plugins` in **Edit Configuration** controls the runtime's native
plugin allowlist and is separate from these Agent-owned selections.

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

## Workspace files tab

**Workspace access is unavailable** leaves
the editor and Save disabled. The empty box does not mean the file is empty.
Check gateway access, then use Reload.

These are live files belonging to the Agent, even when you browse an older
revision. They are not historical copies or Configuration fields.

| File          | Typical role                                      |
| ------------- | ------------------------------------------------- |
| `AGENTS.md`   | Workspace instructions and operating conventions. |
| `SOUL.md`     | Behavior, tone, and boundaries.                   |
| `IDENTITY.md` | Agent identity and presentation.                  |
| `USER.md`     | Context about the person the Agent assists.       |

Each editor loads independently. Its status reports loading, success, or failure.
**Reload** replaces unsaved edits with current contents. **Save** immediately
creates or replaces that one file; it does not deploy a revision. Save is disabled
until appropriate loaded, changed state is available.

Each file allows up to 16 KiB of valid UTF-8 text. Concurrent saves use the last
writer's contents. Reading requires Agent `read`, saving requires `operate`, and
access needs an active revision with a reachable gateway. An uncertain save
requires a successful Reload before retrying. See
[Workspace Files](../topics/workspace-files.md).

## Conditional native admin panel

When enabled by the Installation and permitted for your account, **Native admin
UI** provides **Refresh access** and **Open native admin UI**. The latter opens
the active gateway in a new tab, even while you view a draft or older revision.

The native UI can change the gateway outside OCE's revision tracking. Use OCE for
durable configuration. See [native admin access](../../reference/agent-native-admin.md)
for permissions and stopped, unavailable, or unsupported states.

## Stop and resume

**Stop Agent** opens a confirmation explaining that shutdown interrupts running
work but preserves revision history, credentials, gateway state, and workspace
files. **Cancel** closes it without a write. Confirming requires `operate`
permission on this Agent, regardless of the revision or tab you are viewing.

An accepted stop requests shutdown; it does not prove that the runtime has
finished. **Refresh stop status** reads the desired state and selected revision.
An uncertain result blocks another stop until a successful refresh. To resume,
open **Create new version** and select **Deploy new version**, which creates a new
revision. See [Stop and resume](../../reference/agents/deployment.md#stop-and-resume).

## Delete Agent and error recovery

**Delete Agent** opens a confirmation dialog. **Cancel** closes it without changes.
**Permanently delete Agent** irreversibly removes the Agent, revision history,
and workspace data; Namespace Configurations and Secrets remain. Exact Agent
`delete` permission is required. Accepted deletion starts asynchronous cleanup;
**Refresh deletion status** checks it, and confirmed removal returns to Agents.

An API error may show a request ID for support. **Outcome unknown** does not
prove failure: refresh before retrying any write. An expired session clears
private content and requests login. See the [Console reference](../../reference/console.md)
for access, concurrency, and recovery details.
