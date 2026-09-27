# Platform console

Open `/console/` on your OCC address to manage Agents and supported Slack settings,
workspace files, and credentials. Authorized operators can also open an Agent's
[native admin UI](#open-the-native-admin-ui). The console has no rollback, live
runtime health, or browser chat through OCE.

Start with [Create and deploy Agents](console/create-and-deploy.md) or
[Understand Agent detail](../guides/console/agent-details.md). Operator setup and
runtime checks belong to the [deployment guide](../guides/deploy.md).

## Start and sign in

Open `/console/` at your administrator-provided address. **Username** is
your provisioned account email. Enter its password and select **Login**. Ask your
administrator for access if you do not have an account or have forgotten your
password; public signup, single sign-on, and self-service password recovery are
unavailable. If you are setting up your own Installation, start with the
[quickstart](../guides/quickstart.md#open-the-platform-console) or
[deployment guide](../guides/deploy.md#open-the-platform-console).

The console uses the [email/password session contract](authentication.md) with
same-origin cookies. It does not store tokens or accept service keys. A
missing or expired session clears private content and asks you to sign in again.

## Identify the control-plane build

With `debug=true`, the sidebar shows **OCE** followed by the first eight
characters of the running OCC image's source commit. Hover for the full revision
or use the [build and runtime image panel](#inspect-build-and-runtime-images).
Published images bake the checked release revision into the console HTML.
Builds without metadata show **dev** beside OCE.

## Browse and select a Namespace

The sidebar opens **Agents** or **Namespaces**; **Refresh** repeats the read.
Set up models during Agent creation; the [experimental Backends](backends.md)
tab is hidden. Namespace rows are read-only.

| Page       | Scope and permission                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Agents     | Selected Namespace; Namespace `read`, then exact Agent `read` filtering. |
| Namespaces | Installation-wide collection filtered by exact Namespace `read`.         |

The console uses a light appearance and OCC-served fonts; no external font
service is required.

Returning pages retain content during access checks; controls await authorization.
Unchanged pages and Agent tabs keep their loaded controls and expanded panels.
Agent detail keeps its mounted editor on refocus while access remains available.
Changed data rebuilds the view. Refresh explicitly reloads; first visits still load.
Document-local views
are scoped to account, session, route, and Namespace; sign-out, session changes,
and exit clear them. Failed reads show recovery. Installation-wide Backend
denial clears all previews.

Use the **Namespace** selector in the page header to switch scope on desktop or
mobile. It lists readable Namespaces and shows the current selection. The
Installation-wide Namespaces page omits the selector. The bottom
**OpenClaw Enterprise** menu contains **Settings** and **Logout**. Settings shows
the signed-in account and no configurable settings.

The selected Namespace stays in `?namespace=<id>` across pages, reload, and Back.
An unreadable explicit ID shows **Namespace unavailable** and requires another
selection. With no readable Namespaces, Agents explains that provisioning or
access is needed; global pages remain available.

Switching Namespace from Agent detail or creation returns to the Agents list in
the new scope. Other global pages stay open. The API makes all authorization decisions; the selector does
not broaden access.

## Inspect build and runtime images

Append `debug=true` to the console URL, for example
`/console/agents?debug=true` (or `&debug=true` after an existing query).
The sidebar shows the full OCE source commit and expandable entries for readable
Agents in the selected Namespace. Each container lists its configured Docker
image, observed image ID or digest, and source commit when available.
Navigation preserves the flag; remove it to hide diagnostics and stop these reads.

See [Debug sidebar fields](console/debug-fields.md) for every field, Docker and
Kubernetes differences, inspection scope, and unavailable states.
Use **Refresh** to retry unavailable metadata or update the snapshot.

## Agent creation and deployment

The console creates an Agent with reusable Configuration, optional plugins and
harness authentication, and staged workspace files. Supported Dedicated
provisioning deploys the first revision during creation. Otherwise, creation
saves a draft: provide model and channel credentials when prompted, then select
**Deploy new version**. When the selected Compute Driver requires them, OCC
generates missing connection credentials during that first deployment. Follow
[Create and deploy Agents](console/create-and-deploy.md) for the complete
workflow, channel constraints, and recovery after partial or uncertain writes.
Plugin selections use the same Agent create/update contract as the API: omitted
updates preserve the map, `{}` clears it, and deployment startup reports
unsupported catalog or policy choices.

## Inspect detail, revisions, and channel drafts

Agent tabs change only their panel; Back/Forward restores the selected tab.
Unsaved JSON, plugin policies, workspace text, authentication, Slack drawers,
Preset variables, and Agent search survive navigation within the document.
Drafts are scoped to user, Namespace, and Agent. Passwords clear; reload and
sign-out clear drafts.

**Cancel**, **Start over**, and **Reload** discard edits; **Refresh** retains them.
Saving clears drafts. Concurrent changes require reload; unsaved edits block
deployment. Pending or uncertain saves require readback, never automatic retries.
Backdrop clicks or Escape close the topmost channel, Secret, or plugin editor:
discard channel edits, clear Secret inputs, retain plugin selections.
Pending channel saves and Secret creation block dismissal.

**Create new version** edits Configuration JSON and channels; **Plugins** and
**Credentials** edit Agent selections and authentication. Plugin browsing
requires exact Agent `read`/`update` and a catalog-capable Driver. The curated
catalog needs no Secret. Hosted browsing reads bound `codex_pat` server-side and
requires caller and Agent ServicePrincipal Secret `operate`.
**Save plugin selections** updates the Agent; deployment snapshots them.
Admitted versions are read-only. **Operator-managed credentials** saves
`{ "method": "runtime" }` for SSH embedded OpenClaw; OCC does not validate host
credentials or generate metadata for that binding. API permissions and topology
checks still apply. **Current version** displays `activeRevisionId`, which
can differ from the viewed snapshot without proving live serving.
**Deployment activity** shows the latest visible version's persisted result;
the viewed version shows its own recorded outcome.

**Current observations** runs only when **Run diagnostics for this version** is
selected. The bodyless POST checks the exact viewed version and returns an
observation time and bounded checks marked `succeeded`, `failed`, or `unknown`.
Agent `read` and `operate` plus exact AgentRevision `read` are required.
An unavailable request shows an error. Results do not change deployment history,
repeat the startup model probe, or prove message delivery.

**Save authentication source** stores the binding and confirms exact
`secret:operate` access for the Agent principal on an API-key or Service Accounts
Secret. Grant changes require Namespace IAM authority. Issued ChatGPT accounts
and operator-managed authentication skip the grant. A failed grant reports
partial success and offers **Retry credential access** without repeating the
Agent update. Partial saves survive navigation. Grants do not prove runtime or
provider readiness.

Configuration and Slack summaries show bound Secret names and IDs for the viewed
draft or revision. Names require exact same-Namespace Secret `read`. Denied,
missing, or failed reads retain IDs with **Metadata unavailable**; **No Secret
bound** means no binding. Values are never read, and metadata does not prove
credential validity.

AgentRevision snapshots are read-only: they cannot be edited, rolled back, or
redeployed. **Create new version** opens the saved draft; **Deploy new version**
admits it as another immutable revision. **Edit current Configuration** opens
the draft without changing the viewed snapshot. Admission, recorded activation,
and `activeRevisionId` are separate facts. Startup evidence does not establish
live gateway health; see the
[deployment guide](../guides/deploy/production-agents.md#configure-the-agent-runtime)
and [deployment reference](agents/deployment.md#revisions-and-deployment).

Channels edits the saved Slack draft. Teams credentials and Bot Framework ingress
require operator setup; Teams has no editor and blocks Console deployment.
Its settings remain in Configuration JSON.
Saving Slack patches `values` and includes `secretBindings` only
for changed tokens. Existing plugin allowlists are extended; omitted ones stay omitted. Shared Configurations can
affect other Agents' future deployments. Channel allowlists remain native
Configuration changes.

Before saving, Agent and Configuration reads verify association and generation;
concurrent changes can still race the PATCH. Refresh after a
conflict or uncertain save. An unconfirmed PATCH shows **Outcome unknown** and
disables channel writes until Refresh loads saved state. It may have succeeded;
there is no automatic replay. **Disable Slack** changes only the draft, not
access, execution, or admitted revisions.

Slack requires dedicated execution and Kubernetes runtime projection. Socket Mode
uses unresolved `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` references.
New configurations use allowlist policies. **Allowed channel user IDs** replaces
selected channels' `users` lists while preserving unrelated settings.
**Allow everyone in these channels to mention the agent** writes `users: ["*"]`.
Entering IDs disables that checkbox; clearing IDs enables it, and unchecking it
restores ID entry. **Require a mention** is independent of sender access.
Channel edits preserve DM and group policies. Change DM access separately with
**Direct-message policy** and **Allowed DM user IDs**; see
[Slack policies](configuration/secrets.md#native-channel-configuration).

Model, Harness, and Slack credentials share a searchable Secret picker.
Filter readable same-Namespace names or IDs; arrows and Enter select, Escape
restores the binding. **Create new Secret...** remains available without
matches. **Name** defaults to Agent name and purpose; **Value** stays masked.
Slack shows its fixed `SLACK_APP_TOKEN` or `SLACK_BOT_TOKEN` key. Conflicts
retain both inputs without overwriting Secrets. Namespace readiness errors
require refresh.

Creation stores the Secret immediately; cancelling the surrounding editor does
not delete it. Values are never read back. Existing
[Secret IAM checks](drivers/secret.md#iam) apply. An uncertain creation blocks
resubmission: refresh and inspect metadata first, because the Secret may exist.

Selections remain staged until **Save configuration**; Cancel discards them.
Saving patches Configuration, then grants Agent access through Namespace IAM.
Both require caller permission. Failed grants leave Configuration saved and
require access recovery. Neither creation nor saving deploys a Secret.

Metadata and **Open Agent Credentials** links open new tabs, preserving edits.
Save channel changes before editing credentials elsewhere, then refresh the
original page.

The simple editor may reject native channel documents it cannot round-trip,
including non-Socket Slack settings, non-standard credential references, mixed
per-channel mention settings, mixed per-channel sender lists, `*` channel maps,
or unsupported plugin shapes. Inspect unsupported settings in the native
Configuration view and edit them through the API or operator workflow.

## Stop and resume an Agent

Open the Agent, select **Stop Agent**, and confirm after reviewing the effect on
running work. Stop requires `operate` permission on that exact Agent. It requests
shutdown while retaining revision history, credentials, gateway state, and
workspace files.

An accepted request means shutdown was queued. **Refresh stop status** rereads
the Agent's desired state and selected revision; it does not probe the runtime.
If the result is uncertain, refresh before retrying. Permission denials remain
visible, and the console never automatically repeats a stop request.

To resume, open **Create new version** and select **Deploy new version**. This creates a
new revision. See [Stop and resume](agents/deployment.md#stop-and-resume) for the
worker lifecycle and preservation guarantees.

## Delete an Agent

Open the Agent and find **Delete Agent** below the detail tabs. In the
confirmation dialog, select **Permanently delete Agent**. This requires `delete`
permission on that Agent; being able to read or operate it does not grant
deletion. Deletion is permanent: it removes the Agent, its revision history, and its workspace data.
Namespace-owned Configurations and Secrets remain. See the [Agent deletion
reference](agents.md#deletion) for the complete cleanup behavior.

An accepted request starts asynchronous cleanup. The detail page shows the Agent
as deleting; select **Refresh deletion status** to check progress. When the API
confirms that the Agent is gone, the console returns to the Agents list in the
same Namespace. An access-denied response stays on the detail page and tells you
that deletion requires permission. If the console cannot confirm the outcome,
the request may have succeeded; refresh to read the Agent's current state before
retrying. The console does not automatically send another delete request.

## Failures and logout

An authorized empty list is different from a failed read. Access denied,
unavailable dependencies, missing resources, and network failures clear affected
rows and offer the relevant recovery action. Include a displayed request ID when
reporting an API failure. Backend error text is not rendered. A current protected
`401` clears private content and closes an open channel editor and harness authentication controls. Backend
discovery shows configured IDs and types only; see
[Backends](backends.md#read-configured-backends) for its limits.

Logout immediately hides private content and stops pending reads. The console
returns to login after sign-out succeeds or a session check confirms the session
is absent. If it cannot confirm logout, it stays on a blocking error with
Retry. Do not treat that error as confirmation that the server session was revoked.

## Set initial workspace contents

The create form's **Workspace files** section contains editable OpenClaw defaults
for `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`. These are complete rendered
templates, so you can keep them, replace them, or clear a field to create an empty
file. Browser textareas submit LF newlines. The form submits all four fields,
including unchanged values, for application before the first deployment runs.

Creating the Agent stages these inputs privately. The live workspace editor
becomes available after deployment. There is no editor for staged inputs on an
undeployed Agent; to correct them, delete and recreate the Agent through the API.
If creation reports that defaults changed, reload the form and review the new
defaults before resubmitting. See [initial contents](agents.md#initial-contents-at-creation)
for the release binding, limits, and deployment failure behavior.

## Edit workspace files

Open **Workspace files** on an Agent to load `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md`. This view reads the live Agent workspace, not the
Configuration draft or browsed AgentRevision. It requires an active revision and
reachable gateway; selection alone does not prove access. Files remain in the
Agent workspace and are never copied into a Configuration or revision.

Each file has its own **Save** and **Reload** action. A save creates or replaces
only that file through the [workspace file API](agents.md#workspace-files).
The editor enforces the API's 16 KiB UTF-8 and Unicode limits. Agent `read`
permits loading, while `operate` is required to save. Workspace writes have no
version check; the last writer wins. Reload replaces unsaved edits with the
current file.

A failed write preserves the editor contents. An unknown outcome disables that
file's Save action until a successful reload, so an uncertain write is never
replayed automatically. Review loaded contents before writing again. Files load
and save independently; success for one file says nothing about another file's
result. For unavailable gateways, follow the
[workspace access setup](../guides/deploy/workspace-routing.md#agent-workspace-files).

## Open the native admin UI

When [Agent native admin UI access](agent-native-admin.md) is enabled, the
Agent detail tabs, including Configuration and Workspace files, include a
**Native admin UI** panel for callers with exact Agent `administer` permission.
The panel is hidden when the Installation disables the feature or when the
caller lacks that grant. An Agent that is stopped reports that it must be started,
including before its first deployment or after stopping clears its active
revision. If a desired-running Agent has no active revision yet, the panel asks
you to check the Agent's deployment and refresh access. It also reports when
native admin is unsupported.

**Open native admin UI** opens the Agent's active revision in a new tab, even
when you are viewing a draft or an older revision. The visible warning is part
of the operator contract: the native UI can change the gateway outside OCE, and
those changes are not recorded in AgentRevisions. Use OCE for durable
configuration. The Agent tab uses the same OCE session cookie as the console
through the configured shared cookie parent domain; native chat or other
Agent-host activity does not extend that console session.

## Routes

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/backends`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.
See the [request flow](../flows/platform-console.md) and
[local testing](../testing/local.md) for implementation and verification.
