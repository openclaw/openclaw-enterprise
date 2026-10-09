# Understand the Agent detail page

Open **Agents**, then select an Agent to inspect its versions, saved settings,
and workspace. For initial setup, use
[Create and deploy Agents](../../reference/console/create-and-deploy.md).

Available actions depend on your Installation and permissions. Stored settings
do not confirm that an Agent or its Slack connection is currently healthy.

## Navigation and Agent identity

| Component                     | What it does                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OCE**                       | Product mark at the top of the console navigation.                                                                                                                                                                                                                 |
| **Agents** / **← Agents**     | Opens the Agents list in the selected Namespace.                                                                                                                                                                                                                   |
| **Namespaces**                | Lists the Namespaces you can read.                                                                                                                                                                                                                                 |
| **Observability**             | Opens the Installation's configured observability dashboard in a new tab. Shown only to Installation administrators, and only when one is configured.                                                                                                              |
| Agent name                    | Human-readable name of this Agent.                                                                                                                                                                                                                                 |
| **Namespace · name**          | Namespace containing the Agent.                                                                                                                                                                                                                                    |
| **Refresh**                   | Reloads the Agent page. It does not retry or restart deployment.                                                                                                                                                                                                   |
| **Current version**           | Version in the Agent's `activeRevisionId`. It may differ from the latest or viewed version.                                                                                                                                                                        |
| **Latest visible deployment** | Newest readable version and its recorded deployment status. **Newer version hidden** means the current version is one you cannot read; ask for read access to new versions.                                                                                        |
| **Live serving**              | Unverified by this page. **Probably down** means a newer dedicated deployment failed, and the current version was probably stopped for it, or the selected version's own deployment failed (an embedded redeploy selects its version before its gateway is ready). |
| **Deployment activity**       | Most recent visible version and its persisted deployment status.                                                                                                                                                                                                   |
| `agt_…`                       | Stable Agent identifier for API calls and support.                                                                                                                                                                                                                 |

The **Namespace** selector at the top of the page changes your scope; from Agent
detail it returns to the new Namespace's Agents list. The bottom **OpenClaw
Enterprise** menu contains **Settings** and **Logout**. Settings displays your
account; it does not offer configurable settings. Logout ends your console session.

## Follow deployment activity

**Deployment activity** follows the latest readable version, even while viewing
another version or the draft. Its milestones use the persisted record:

| Milestone               | Evidence                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| **Admitted**            | OCC saved an immutable AgentRevision and queued its work.                         |
| **Deployment work**     | `queued` awaits an initial or subsequent claim; `running` records a worker claim. |
| **Completion recorded** | `succeeded` means the original work completed activation or was already active.   |

A `failed` result shows the stored error. Select **Open vN Logs** to open that
version's [Logs tab](../topics/agent-logs.md) and bring the panel into view,
even from the draft or another version. If logs are unavailable, the panel
shows an access or availability message.
For `RUNTIME_AUTHENTICATION_FAILED`, `RUNTIME_MODEL_PROBE_FAILED`,
`RUNTIME_MODEL_PROBE_TIMEOUT` and `AGENT_GATEWAY_UNAUTHORIZED` it also states
the next step and links **Credentials** or the draft **Configuration** (for
`AGENT_GATEWAY_UNAUTHORIZED`, select **Enable gateway password access** there). A provider the runtime cannot
reach (refused connection, unknown host) usually reports
`RUNTIME_MODEL_PROBE_TIMEOUT` with OpenClaw and `RUNTIME_MODEL_PROBE_FAILED`
with Codex.
Startup evidence may identify the runtime component, failed check, code, and
check time. A failed startup model check may also show its **Cause**, such as
the provider reporting a rate limit or the check process exiting with an error
([causes](../../reference/agents/deployment.md#model-check-failure-cause)). Plugin warnings describe that attempt. An unavailable record has
unknown status. While the record is `queued` or `running`, the panel rereads it
every few seconds and stops at `succeeded`, `failed`, or a read error.
**Refresh deployment** rereads it, the selected version, and that version's
deployment record without retrying work.

Pending work shows its **Last recorded result** and **Since**, when OCC first
recorded that result; repeated identical readiness checks are not recorded again.
A running worker shows its previous result.
Next eligibility does not promise a start time; missing evidence does not mean
work never started.

**Current version** is OCC's selection, not live health. Deployment may still
be in progress; a successful historical record does not confirm a response.
Verify the runtime and a real response with
[Agent troubleshooting](../topics/agent-troubleshoot.md).

<span id="browse-revisions-or-open-the-saved-draft"></span>

## Browse versions or create a new version

An **AgentRevision** is an immutable version created by deployment. A
**Configuration** is the reusable, mutable input for the next version.

**Versions** marks the current version. **View version vN** shows creation time,
Configuration generation, deployment status, and read-only settings, including
native JSON. Activity follows the latest visible deployment. **Available versions**
jumps to readable versions; `rev_…` identifies the version for API calls and
support. Viewing neither deploys nor activates it.

**Run diagnostics for this version** requests fresh, on-demand observations of
the viewed version. Checks include a time and `succeeded`, `failed`, or
`unknown` state; unavailable requests show retryable errors. On Kubernetes
Compute the gateway checks cover only the Slack channel. A version without
Slack reports configuration `failed` with `NOT_CONFIGURED` and leaves
authentication and connectivity `unknown`; the page says this is expected. A
version deployed by an earlier controller release still shows three `unknown`
checks with `PROBE_FAILED` until you deploy a new version. If every check is
`unknown` with `UNAVAILABLE`, the runtime did not answer. Either way, a recorded deployment failure such as `RUNTIME_AUTHENTICATION_FAILED`
stays in view: diagnostics do not test model credentials, so they cannot
confirm or clear it. Diagnostics do not change deployment history, activate a
version, repeat the startup model probe, or prove message delivery. You need Agent `read` and `operate` plus
read access to that version.

**Logs** on a deployed version shows its Pods, restarts, recent warning Events
and redacted container output. It can follow new lines, filter the loaded
lines by level or text, and download the last 1000 lines. Status needs the same
grants as diagnostics; log text needs Agent `read_logs` or `administer` instead of `operate`.
When a Pod is Ready and its containers have not restarted, its warning Events
appear in muted text as earlier warnings, such as readiness probes that failed
while it started. See [Agent logs](../topics/agent-logs.md).

There is no rollback or redeploy-old-revision button. See
[Agent Revisions](../topics/agent-revisions.md) for the lifecycle.

Select **Create new version** to open the current saved settings. Edit and save
Configuration, plugin selections, channel settings, or credentials.
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

The **Configuration**, **Plugins**, **Channels**, **Repositories**, **Credentials**, and
**Workspace files** tabs change the panel below. Repositories and Credentials are available
only on the new version draft; Logs only on a version.
**Repositories** edits the draft's repository selections and access levels; see
[repository access](../../reference/console/create-and-deploy.md#create-an-agent).
Browser Back and Forward restore the selected tab. Leaving a tab clears entered
token values. The workspace remains live regardless of the viewed version.
Returning from another page rechecks completed reads, so recovered panels refresh.

### Unreadable saved settings

Unreadable settings show a warning; identity, navigation, and readable versions
remain available. Omissions are not defaults. Unreadable drafts block editing and
deployment; nothing repairs them.

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

In the draft, **Enable gateway password access** stages the generated-password
reference; authentication mode and proxy settings stay unchanged. The Compute
Driver owns the password; the Console shows only its reference.

**Edit Configuration** edits native JSON. **Save Configuration** requires an object;
**Cancel** discards edits. **Edit current Configuration** opens the current draft,
not a historical copy. Saving preserves Secret bindings and admitted revisions;
**Deploy new version** applies saved values, including for Agents sharing this
Configuration on their next deployment.

Unsaved edits, pending saves, and stale or unknown outcomes block deployment,
tab switching, and revision navigation. Save checks Configuration association and
generation, but another write can race afterward. Reload stale drafts; after an
unknown outcome, successfully reload saved state before retrying. Invalid JSON
and failed saves retain text for correction.
Backend, execution mode, and Harness authentication are Agent fields, not native
Configuration JSON. See the [Configuration reference](../../reference/configuration.md).

## Plugins tab

In **Create new version** → **Plugins**, edit the Agent's existing selections and
tool policies with **Configure plugins** or **Plugin selections JSON**. With a bound
Service Accounts token Secret, the tab preloads the first catalog page for the
picker. Search and tool lookups show loading indicators. Dedicated Codex browsing
requires exact active Agent `read`/`update` and a catalog-capable Plugin Driver. The
curated catalog needs no Secret. Hosted discovery uses the bound Service Accounts
token Secret server-side and requires caller and Agent ServicePrincipal Secret
`operate`; the browser never receives the token. Other execution modes cannot
browse this catalog. Hosted results use the draft credential, which may differ
from the running revision's; neither catalog proves installation or runtime
access. Existing
selections and **Plugin selections JSON** remain editable when browsing is
unavailable.

An open Slack approver search keeps its query and results when you return to the
browser tab and still have Agent access. Moving to another Console control closes
the results; focus the search field to open them again. Switching Agent tabs and
returning keeps a completed query.

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

The Slack card reports saved channel settings, not a live connection. [Configure Agent channels and credentials](channels-and-credentials.md#channels-tab) covers the Slack editor and Microsoft Teams limits.

## Credentials tab

**Credentials** holds the harness authentication source and, when Slack is enabled, its channel Secrets. See [the Credentials tab](channels-and-credentials.md#credentials-tab).

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

## Talk to the Agent

The console has no chat panel. To give an Agent a task:

- Message it in a channel its Configuration sets up, such as Slack. The
  [channel settings](channels-and-credentials.md#slack-editor), not OCE grants,
  decide who may mention it.
- With Agent `use` and an assigned role, use the [OpenClaw panel](#conditional-native-admin-panel)
  when the Installation enables it. It is unavailable under GitHub, Google, or
  OIDC sign-in.
- Otherwise ask someone who can edit the Agent's Configuration to let you into
  its channel. An operator with cluster access can check a real response with
  [model verification](../operate/model-verification.md).

<a id="conditional-native-admin-panel"></a>

## Conditional OpenClaw panel

When enabled by the Installation and permitted for your account, **OpenClaw**
provides **Refresh access** and **Open OpenClaw**. The latter opens
the active gateway in a new tab, even while you view a draft or older revision.

If you are an Installation administrator without OpenClaw access, the card directs
you to assign your Principal ID a role in **Share Agent** below. After saving,
select **Refresh access** to open it in the same tab.

The native UI can change the gateway outside OCE's revision tracking. Use OCE for
durable configuration. See [native admin access](../../reference/agent-native-admin.md)
for permissions and stopped, unavailable, or unsupported states. Installation
administrators can [share an Agent](agent-sharing.md) with existing people.

## Stop and resume

**Stop Agent** opens a confirmation explaining that shutdown interrupts running
work but preserves revision history, credentials, gateway state, and workspace
files. A chat that was mid-reply can keep showing the reply as in progress;
reload it after the Agent is deployed again. **Cancel** closes it without a
write. Confirming requires `operate` permission on this Agent, regardless of the
viewed revision or tab.

An accepted stop requests shutdown; it does not prove the runtime
finished. **Refresh stop status** reads the desired state and selected revision.
An uncertain result blocks another stop until a successful refresh. To resume,
open **Create new version** and select **Deploy new version**, which creates a new
revision. See [Stop and resume](../../reference/agents/deployment.md#stop-and-resume).

## Delete Agent and error recovery

**Delete Agent** opens a confirmation dialog. **Cancel** closes it without changes.
**Permanently delete Agent** irreversibly removes the Agent, version history,
and workspace data; Namespace Configurations and Secrets remain. The dialog
gives the commands that delete the Agent's Configuration and, if it has one, its
model credential Secret: both are kept even when Create Agent made them, and the
console cannot list or delete them. Exact Agent
`delete` permission is required. Accepted deletion starts asynchronous cleanup;
the page checks it every few seconds and returns to Agents once the Agent is gone.
**Refresh deletion status** checks it immediately.

An API error may show a request ID for support. **Outcome unknown** does not
prove failure: refresh before retrying any write. An expired session clears
private content and requests login. See the [Console reference](../../reference/console.md)
for access, concurrency, and recovery details.
