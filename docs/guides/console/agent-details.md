# Understand the Agent detail page

Open **Agents**, then click an Agent name or an open area of its row. For setup, see
[Create and deploy Agents](../../reference/console/create-and-deploy.md).
Saved settings don’t establish Agent or Slack connection health.

The Console explains why Deploy is unavailable and leaves out Stop or Delete without access. Reload after access changes.
The API checks every request. Opening a version draft needs no Agent update
permission; saving and deploying have separate access checks.

## Navigation and Agent identity

| Component                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenClaw Enterprise**       | Product mark atop the console navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Agents** / **← Agents**     | Opens the Agents list in the selected Namespace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Namespaces**                | Lists the Namespaces you can read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Observability**             | Opens the Installation's configured observability dashboard in a new tab. Shown only to Installation administrators, and only when one is configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Agent name                    | Human-readable name of this Agent. Each deployment also shows it as the assistant name in the [native admin UI](../../reference/agents/deployment.md#versions-and-deployment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Namespace**                 | Namespace containing the Agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Refresh**                   | Reloads the Agent page. It does not retry or restart deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Selected for service**      | Version in the Agent's `activeRevisionId`. It may differ from the latest or viewed version. **A version you cannot read** means your access does not include it; **A newer version you cannot read** adds that it is newer than every version you can read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Latest visible deployment** | Newest readable version and its recorded deployment status. **Newer version hidden** means the current version is one you cannot read; ask for read access to new versions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Live serving**              | Unverified by this page. **Not running** means no version is selected for service, for example after a failed first deployment. **May be offline** means a newer dedicated deployment failed, and the current version was probably stopped for it, or the selected version's own deployment failed (an embedded redeploy selects its version before its gateway is ready). For a running Agent whose selected version has a dedicated Harness, the line under it shows that version's Sandbox: running, starting, Harness restarting, or unknown when it cannot be read. The page reads it when it opens; **Refresh** reads it again. **Sandbox lost** means that the Sandbox stopped or is gone and OCC does not restart it; deploy a new version. |
| **Deployment activity**       | Most recent visible version and its persisted deployment status. Hidden until a version exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `agt_…`                       | Stable Agent identifier for API calls and support (**Copy Agent ID**).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The **Namespace** selector at the top of the page changes your scope; from Agent
detail it returns to the new Namespace's Agents list. The account menu contains
**Settings** and **Sign out**. Settings displays your account. Installation
administrators can expand **Installation Driver configuration** to inspect
[accepted startup values](../../reference/drivers/selection.md#configuration-definitions-and-discovery).
**Fields** shows labeled values and nested groups. **JSON** shows the same values
as a document. Hidden values remain redacted in both views.
Changes require operator-managed startup configuration and a control-plane restart.
Sign out ends your console session.

## Follow deployment activity

In **Deployment**, **Deployment activity** follows the latest readable version while viewing
another version or the draft. Routine completions and failures fold, a failure
under its leading card; pending work, warnings and cleanup stay open. On a slow
connection the page can show before the first record arrives; that record then stays
folded and **Latest visible deployment** shows its outcome. Open **Deployment details**
to read it.
Milestones show the saved record:

| Milestone               | Evidence                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **Admitted**            | OCC saved an AgentRevision and queued its work.                                                  |
| **Deployment work**     | `queued` awaits the first claim; `running` means work started, including waits between attempts. |
| **Completion recorded** | `succeeded` means the original work completed activation or was already active.                  |

Work ended by a newer version (`REVISION_SUPERSEDED` or
`REPOSITORY_REVISION_SUPERSEDED`) or a Stop (`REVISION_STOPPED`) shows as a
neutral `superseded` or `stopped` result, not a failure; after a Stop, deploy a
new version to run the Agent again. A `failed` result shows the stored error. **Open vN Logs** opens the
failed version’s [Logs tab](../topics/agent-logs.md), showing output or the
applicable access or availability message, even from the draft or another version.
For most codes the error states the next step, as in `occ`. For `RUNTIME_AUTHENTICATION_FAILED`, `RUNTIME_MODEL_PROBE_FAILED`,
`RUNTIME_MODEL_PROBE_TIMEOUT` and `AGENT_GATEWAY_UNAUTHORIZED` the panel also links **Credentials** or the draft **Configuration**.
Startup evidence may identify the runtime component, failed check, code, and
check time. A failed startup model check may also show its **Cause**, such as
the provider reporting a rate limit or the check process exiting with an error
([causes](../../reference/agents/deployment.md#model-check-failure-cause)). Plugin warnings describe that attempt. An unavailable record has
unknown status. While the record is `queued` or `running`, the panel rereads it
every few seconds, through outages, until `succeeded`, `failed`, a denial, or a missing record.
**Refresh deployment** rereads it, the selected version, and its
deployment record without retrying work.

Pending work shows its **Last recorded result** and **Since**, when OCC first
recorded that result; repeated identical readiness checks are not recorded again.
A running worker shows its previous result.
Next eligibility does not promise a start time; missing evidence does not mean
work never started.

**Selected for service** is OCC's selection, not live health. Deployment may still
be in progress; a successful historical record does not confirm a response.
A newer version still deploying is labelled **Deploying version**.
Verify the runtime and a real response with
[Agent troubleshooting](../topics/agent-troubleshoot.md).

<span id="browse-revisions-or-open-the-saved-draft"></span>

## Browse versions or create a new version

An **Agent revision** (`AgentRevision`) stores one version's settings, which
cannot change. A **Configuration** supplies reusable settings for the next version.

**Viewing version** opens the saved draft or a read-only version snapshot. The
picker initially holds the newest 50 versions; **Load older versions** appends
the next page. It marks the version **Selected for service** and deployment
outcomes. **Version details** expands the version ID, creation time, and
Configuration generation. Browsing does not deploy or activate a version.

Open **Deployment** for the latest visible deployment activity, the viewed
version's own record, and diagnostics. Pending work, startup warnings, and
incomplete cleanup also show a message above the tabs. A failed refresh of the
current version or history keeps a notice there with a link to Deployment.
Failed deployments keep
their recovery message above the summary. These records do not prove live health.

**Run diagnostics for this version** requests fresh, on-demand observations of
the viewed version. A failed version that is not current has no runtime to check,
so the page does not offer diagnostics for it. Checks include a time and `succeeded`, `failed`, or
`unknown` state; unavailable requests show retryable errors. On Kubernetes
Compute the gateway checks cover only the Slack channel. A version without
Slack reports configuration `failed` with `NOT_CONFIGURED` and leaves
authentication and connectivity `unknown`; the page shows these as `not set up`
and `not checked` and says this is expected. A
version deployed by an earlier controller release still shows three `unknown`
checks with `PROBE_FAILED` until you deploy a new version. If every check is
`unknown` with `UNAVAILABLE`, the runtime did not answer. Either way, a recorded deployment failure such as `RUNTIME_AUTHENTICATION_FAILED`
stays in view: diagnostics do not test model credentials, so they cannot
confirm or clear it. Diagnostics do not change deployment history, activate a
version, repeat the startup model probe, or prove message delivery. You need Agent `read` and `operate` plus
read access to that Agent revision.

**Logs** on a deployed version shows its Pods, restarts, recent warning Events
and redacted container output. It can follow new lines, filter the loaded
lines by level or text, and download the last 1000 lines. Status needs the same
grants as diagnostics; log text needs Agent `read_logs` or `administer` instead of `operate`.
When a Pod is Ready and its containers have not restarted, its warning Events
appear in muted text as earlier warnings, such as readiness probes that failed
while it started. See [Agent logs](../topics/agent-logs.md).

The Console cannot roll back or deploy an old version again. See
[Agent revisions](../topics/agent-revisions.md) for the lifecycle.

Select **Open draft** to open the current saved settings. Edit and save
Configuration, plugin selections, channel settings, or credentials.
**Prepare this version**, above the tabs, checks off saved settings and
credentials and holds **Deploy new version** with its status. A model credential
the last deployment rejected keeps the credentials step open: deploying again
does not fix it.
**Deploy new version** submits those saved settings for a new version; it does
not redeploy a version you were viewing. It
checks freshness and required model and channel credentials; missing prerequisites
or a changed draft require correction or refresh. Select **Set up credentials**
beside the disabled button when a model or channel credential needs your input.
When Kubernetes Compute requires them, OCC generates missing connection
credentials during the first deployment.
If they are missing after a version exists, ask an operator to investigate;
OCC cannot regenerate them through initial provisioning. A successful request
opens the new version's Workspace files view. Bound channel Secrets do not
prove successful authentication or a working channel.

The **Configuration**, **Plugins**, **Channels**, **Repositories**, **Credentials**,
**Workspace files**, **Policy denials**, **Logs**, and **Access** tabs change the panel below.
Repositories and Credentials are available only on the new version draft; Logs only on a
version; Access only to Installation administrators. A link to a tab that you cannot use
shows Configuration and a note that names the tab and the reason. When a tab finds that your
access changed, the next tab change reloads the page, as **Refresh** does. **Refresh** also
reads refused logs again, so a restored grant shows them.
**Repositories** edits the draft's repository selections and access levels; without the grants
an Agent save needs, it lists them read-only. See
[repository access](../../reference/console/repository-access.md).
Browser Back and Forward restore the selected tab. Leaving a tab clears entered
token values. The workspace remains live regardless of the viewed version.

### Unreadable saved settings

Unreadable settings show a warning; identity, navigation, and readable versions
remain available. Omissions are not defaults. Unreadable drafts block editing and
deployment; nothing repairs them.

## Configuration tab

**Configuration** shows the model, execution mode, Harness, and native JSON, and
edits the draft's native Configuration. See
[the Configuration tab](configuration-plugins-and-files.md#configuration-tab).

## Plugins tab

**Plugins** shows and edits the Agent-owned plugin selections. See
[the Plugins tab](configuration-plugins-and-files.md#plugins-tab).

## Channels tab

The Slack card reports saved channel settings, not a live connection. [Configure Agent channels and credentials](channels-and-credentials.md#channels-tab) covers the Slack editor and Microsoft Teams limits.

## Credentials tab

**Credentials** holds the harness authentication source and, when Slack is enabled, its channel Secrets. See [the Credentials tab](channels-and-credentials.md#credentials-tab).

## Workspace files tab

**Workspace files** edits the Agent's live `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
and `USER.md`. See
[the Workspace files tab](configuration-plugins-and-files.md#workspace-files-tab).

## Talk to the Agent

The console has no chat panel. To give an Agent a task:

- Message it in a channel its Configuration sets up, such as Slack. The
  [channel settings](channels-and-credentials.md#slack-editor), not OCE grants,
  decide who may mention it.
- With Agent `administer`, use the [native admin panel](#conditional-native-admin-panel)
  when the Installation enables it. It is unavailable under GitHub, Google, or
  OIDC sign-in.
- Otherwise ask someone who can edit the Agent's Configuration to let you into
  its channel. An operator with cluster access can check a real response with
  [model verification](../operate/model-verification.md).

<span id="conditional-native-admin-panel"></span>

## Open the Agent UI

When enabled by the Installation and permitted for your account, **Open Agent UI**
in the header opens the Agent interface directly in a new tab. Its description
names the version selected for service, even while you view a draft or historical
version. **Refresh access** checks availability again. Unavailable access leaves
the launch disabled and explains the next step; denied access hides it.

Gateway managed mode restricts administrative changes by default. OCE deployments
can overwrite changes made while managed mode is off. Use OCE for durable configuration. See [native admin access](../../reference/agent-native-admin.md)
for permissions and stopped, unavailable, or unsupported states. Installation
administrators [share Agents](agent-sharing.md) from the **Access** tab.

## Stop and resume

**Stop Agent**, in the **Danger zone** card at the end of the page, opens a confirmation explaining that shutdown interrupts running
work but preserves version history, credentials, gateway state, and workspace
files. A chat that was mid-reply can keep showing the reply as in progress;
reload it after the Agent is deployed again. **Cancel** closes it without a
write. Confirming requires `operate` permission on this Agent, regardless of the
viewed version or tab.

An accepted stop shows **Runtime: Stop requested** in the overview; it does not
prove the runtime finished. **Refresh stop status** reads desired state and
selected version. If another operator has started deletion, the page shows deletion recovery.
An uncertain result blocks another stop until a refresh.
With no selected version, there is no Stop row before a first deploy or after a
failed first deployment. While a first deployment is queued or in progress,
**Stop Agent** cancels it. If you cannot read the deploying version, Stop stays
and its confirmation says it cancels the deployment or stops a started version. To resume,
open **Open draft** and select **Deploy new version**, which creates a new
version. See [Stop and resume](../../reference/agents/deployment.md#stop-and-resume).

## Delete Agent and error recovery

**Delete Agent**, in the same card, opens a confirmation dialog. **Cancel** closes it without changes.
**Permanently delete Agent** irreversibly removes the Agent, version history,
and workspace data; Namespace Configurations and Secrets remain. The dialog
gives the commands that delete the Agent's Configuration and, if it has one, its
model credential Secret: both are kept even when Create Agent made them.
Secrets can also be inspected and deleted from the [Secrets page](secrets.md)
once their references are cleared; Configuration cleanup uses the CLI. Exact Agent
`delete` permission is required. Accepted deletion starts asynchronous cleanup;
the page checks it every few seconds and returns to Agents once the Agent is gone.
**Refresh deletion status** checks it immediately. **Request deletion again**
opens a new confirmation for an already deleting Agent. Use it after fixing a
cleanup failure that exhausted its retries; cleanup still queued or running
continues unchanged. Another uncertain request stays blocked until a successful
status refresh confirms that the Agent is deleting. The browser never repeats
DELETE automatically. Existing delete permissions and retry ownership apply.

An API error may show a request ID for support. **Outcome unknown** does not
prove failure: refresh before retrying any write. An expired session clears
private content and requests login. See the [Console reference](../../reference/console.md)
for access, concurrency, and recovery details.
