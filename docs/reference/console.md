# Platform console

Open `/console/` on your OCC address to manage Agents and supported Slack settings,
workspace files, and credentials. Authorized operators can also open an Agent's
[native admin UI](#open-the-native-admin-ui). The console has no rollback, live
runtime health, or browser chat through OCE.

Start with [Create and deploy Agents](console/create-and-deploy.md) or
[Understand Agent detail](../guides/console/agent-details.md). Operator setup and
runtime checks belong to the [deployment guide](../guides/deploy.md).

## Start and sign in

At your administrator-provided address, enter your provisioned account email as
**Username**, then its password, and select **Login**. Public
signup, single sign-on, and self-service password recovery are unavailable; ask
your administrator for an account or a password reset. To set up your own
Installation, see the
[quickstart](../guides/quickstart.md#open-the-platform-console) or
[deployment guide](../guides/deploy.md#open-the-platform-console).

The console uses the [email/password session contract](authentication.md) with
same-origin cookies. It does not store tokens or accept service keys. A
missing or expired session clears private content and asks you to sign in again.

## Identify the control-plane build

With `debug=true`, the sidebar shows **OCE** followed by the first eight
characters of the running OCC image's source commit, or **dev** for builds
without metadata; hover for the full revision. Published images bake the checked
release revision into the console HTML.

## Browse and select a Namespace

The sidebar opens **Agents** or **Namespaces**; **Refresh** repeats the read.
Set up models during Agent creation; the [experimental Backends](backends.md)
tab is hidden. Namespace rows are read-only.

| Page          | Scope and permission                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Agents        | Selected Namespace; Namespace `read`, then exact Agent `read` filtering.                                             |
| Namespaces    | Installation-wide collection filtered by exact Namespace `read`.                                                     |
| Observability | External [`observability.url`](configuration.md#installation-startup-configuration) link; Installation `administer`. |

The console uses a light appearance and OCC-served fonts. Full-page client
navigation focuses the destination heading when the previous control disappears.
On mobile, **Open navigation** opens a drawer; widening to desktop closes it
and releases page controls.

When available, a retained view stays mounted and inert while a full-page return
is revalidated: matching data reactivates it, changed data rebuilds it, and
Refresh always rebuilds. Agent-detail refocus revalidates access without
rebuilding, preserving editors, form input, open Slack searches, and the enabled
header selector. Retained views are scoped to account, session, route, and
Namespace; sign-out, session changes, exit, or Backend denial clear them.

The header's **Namespace** selector switches readable scopes on desktop and
mobile; the Namespaces page omits it. **OpenClaw Enterprise** at the bottom offers
**Settings**, which shows the signed-in account without configurable settings,
and **Logout**.

Selection persists in `?namespace=<id>` across navigation, reload, and Back.
An unreadable ID shows **Namespace unavailable**. On Namespaces, **Choose a valid
namespace** updates the URL and removes the warning without leaving the page.
Page load, Refresh, and admission-starting navigation disable the selector and
hide its choices during session and Namespace checks; retained-view reads do not.
Without readable alternatives, Agents and Namespaces show provisioning and access guidance;
global pages remain available.

Switching Namespace from Agent detail or creation returns to Agents in the new
scope; global pages stay open. The selector cannot broaden API authorization.

## Inspect build and runtime images

Append `debug=true` to the console URL, for example
`/console/agents?debug=true` (or `&debug=true` after an existing query).
The sidebar shows the full OCE source commit and per-container image
observations for readable Agents in the selected Namespace. Navigation preserves
the flag; remove it to hide diagnostics and stop these reads. **Refresh**
retries unavailable metadata and updates the snapshot.
[Debug sidebar fields](console/debug-fields.md) defines every field, Docker and
Kubernetes differences, inspection scope, and unavailable states.

## Agent creation and deployment

Supported Dedicated provisioning deploys the first revision during creation. Otherwise, creation
saves a draft: provide model and channel credentials when prompted, then select
**Deploy new version**. If the Compute Driver requires them, OCC generates
missing connection credentials during that first deployment.
See [Create and deploy Agents](console/create-and-deploy.md) for the full
workflow, channel constraints, and partial-write recovery.
Plugin selections follow the API's Agent create/update contract: an omitted map
is preserved, `{}` clears it, and deployment startup reports unsupported catalog
or policy choices.

## Inspect detail, revisions, and channel drafts

Agent tabs change only their panel; Back/Forward restores the selected tab.
The selected tab stays visible in the horizontal strip at narrow widths.
Unsaved JSON, plugin policies, workspace text, authentication, Slack drawers,
Preset variables, and Agent search survive in-document navigation as drafts
scoped to user, Namespace, and Agent. Passwords clear; reload and sign-out
clear drafts.

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
**Access and credential setup** expands the Driver guidance and help links;
the compact reminder stays visible. Search and pagination remain reachable
while the catalog list and plugin details scroll within the picker.
**Save plugin selections** updates the Agent; deployment snapshots them.
**Operator-managed credentials** saves `{ "method": "runtime" }` for SSH embedded
OpenClaw; OCC neither validates host credentials nor generates metadata for that
binding, but API permissions and topology checks still apply. **Current version**
displays `activeRevisionId`, which can differ from the viewed snapshot and does
not prove live serving.
**Deployment activity** shows the latest visible version's persisted result;
the viewed version shows its own recorded outcome.
For a failed deployment, **Open vN Logs** opens that exact version and brings
its Logs panel into view, including when starting from the draft or another
version. The panel shows runtime output or the applicable access or availability
message; see [Agent logs](../guides/topics/agent-logs.md).

**Run diagnostics for this version** fills **Current observations** with a
bodyless POST that checks the exact viewed version. It requires Agent
`read`/`operate` and exact AgentRevision `read`. Kubernetes checks cover only
Slack (`NOT_CONFIGURED`: no Slack channel), never model credentials. Each check
is timestamped `succeeded`, `failed`, or `unknown`; recorded failures stay shown,
and unavailable requests show an error. Results do not change deployment
history, repeat the startup model probe, or prove message delivery.

**Save authentication source** stores the binding and confirms exact
`secret:operate` access for the Agent principal on an API-key or Service Accounts
Secret. Grant changes require Namespace IAM authority; issued ChatGPT accounts
and operator-managed authentication skip the grant. A failed grant reports
partial success and offers **Retry credential access** without repeating the
Agent update. Partial saves survive navigation. Grants do not prove runtime or
provider readiness.

Configuration and Slack summaries show bound Secret names and IDs for the viewed
draft or revision. Names require exact same-Namespace Secret `read`; denied,
missing, or failed reads show the ID with **Metadata unavailable**. **No Secret
bound** means no binding. Values are never read, and metadata does not prove
credential validity.

AgentRevision snapshots cannot be edited, rolled back, or redeployed. **Create
new version** and **Edit current Configuration** open the saved draft without
changing the viewed snapshot; **Deploy new version** admits it as another
immutable revision. Admission, recorded activation, and `activeRevisionId` are
separate facts, and startup evidence does not establish live gateway health; see the
[deployment guide](../guides/deploy/production-agents.md#configure-the-agent-runtime)
and [deployment reference](agents/deployment.md#revisions-and-deployment).

Channels edits the saved Slack draft. Teams credentials and Bot Framework ingress
require operator setup; Teams has no editor, its settings remain in Configuration
JSON, and it blocks Console deployment. Saving Slack patches `values` and
includes `secretBindings` only for changed tokens. Existing plugin allowlists are
extended; omitted ones stay omitted. Channel allowlists remain native
Configuration changes, and shared Configurations can affect other Agents' future
deployments.

Before saving, Agent and Configuration reads verify association and generation;
concurrent changes can still race the PATCH. Refresh after a conflict. An
unconfirmed PATCH may have succeeded and is never replayed automatically: it shows **Outcome unknown** and disables
channel writes until Refresh loads saved state. **Disable Slack** changes only
the draft, not access, execution, or admitted revisions.

Slack requires dedicated execution and Kubernetes runtime projection. Socket Mode
uses unresolved `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` references.
New configurations use allowlist policies. **Allowed people in these channels**
replaces selected channels' `users` lists while preserving unrelated settings.
**Everyone in these channels** writes `users: ["*"]`; it and specific people are
mutually exclusive. **Require a mention** is independent of sender access.
Channel edits preserve group policies. Change DM access with
**Direct-message policy** and **Allowed people in direct messages** in the same drawer; see
[Slack policies](configuration/secrets.md#native-channel-configuration).

Model, Harness, and Slack credentials share one searchable Secret picker; the
[Slack editor](../guides/console/channels-and-credentials.md#slack-editor) lists
its controls. Escape restores the binding, and **Create new Secret...** stays
available without matches, with **Name** defaulting to the Agent name and
purpose. A name conflict keeps both inputs and overwrites no Secret. Namespace
readiness errors require refresh.

Creation stores the Secret immediately, under existing
[Secret IAM checks](drivers/secret.md#iam); cancelling the surrounding editor
does not delete it, and values are never read back. An uncertain creation blocks
resubmission: the Secret may exist, so refresh and inspect metadata first.

Selections stay staged until **Save configuration**; Cancel discards them.
Saving patches Configuration, then grants Agent access through Namespace IAM;
both require caller permission. A failed grant leaves Configuration saved and
requires access recovery. Neither creation nor saving deploys a Secret.

Secret metadata links open new tabs, preserving edits. Save channel changes
before editing credentials on the Credentials tab.

The simple editor may reject native channel documents it cannot round-trip,
including non-Socket Slack settings, non-standard credential references, mixed
per-channel mention settings or sender lists, `*` channel maps, or unsupported
plugin shapes. Inspect those settings in the native Configuration view; edit them
through the API or operator workflow.

## Stop and resume an Agent

Open the Agent, select **Stop Agent**, review the effect on running work, and
confirm. Stop requires exact Agent `operate`. It requests shutdown while
retaining revision history, credentials, gateway state, and workspace files.

An accepted request means shutdown was queued. **Refresh stop status** rereads
the Agent's desired state and selected revision without probing the runtime.
Refresh before retrying an uncertain result. Permission denials remain visible,
and the console never repeats a stop request automatically.

To resume, open **Create new version** and select **Deploy new version**, which
creates a new revision. See [Stop and resume](agents/deployment.md#stop-and-resume) for the
worker lifecycle and preservation guarantees.

## Delete an Agent

Select **Delete Agent** below the Agent detail tabs, then **Permanently delete
Agent** in the confirmation dialog. This requires exact
Agent `delete`; `read` or `operate` is not enough. Deletion permanently removes
the Agent, its version history, and its workspace data; Namespace-owned
Configurations and Secrets remain; see
[Agent deletion](agents.md#deletion).

An accepted request starts asynchronous cleanup, and the detail page shows the
Agent as deleting; **Refresh deletion status** checks progress. Once the API
confirms the Agent is gone, the console returns to Agents in the same Namespace.
An access denial stays on the detail page and says deletion requires permission.
An unconfirmed outcome may have succeeded; refresh before retrying. The console
never resends a delete request automatically.

## Failures and logout

An authorized empty list differs from a failed read. Access denials, unavailable
dependencies, missing resources, and network failures clear affected rows and
offer recovery. Backend error text is not rendered; include any displayed request
ID when reporting an API failure. A current protected `401` clears private
content and closes open channel editors and harness authentication controls.
Backend discovery shows only configured IDs and types; see its
[limits](backends.md#read-configured-backends).

Logout immediately hides private content and stops pending reads. The console
returns to login once sign-out succeeds or a session check confirms no session.
If it cannot confirm logout, it shows a blocking error with Retry; the server
session may not be revoked.

## Set initial workspace contents

The create form's **Workspace files** section contains editable OpenClaw defaults
for `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`, as complete rendered
templates: keep or replace each, or clear a field for an empty file.
Textareas submit LF newlines. The form submits all four fields, including unchanged values,
for application before the first deployment runs.

Creation stages these inputs privately; the live workspace editor becomes
available after deployment. Staged inputs on an undeployed Agent have no editor;
to correct them, delete the Agent ([Delete Agent](#delete-an-agent) or the API)
and create it again. If creation reports that defaults changed, reload the form
and review them before resubmitting. See [initial contents](agents.md#initial-contents-at-creation)
for the release binding, limits, and deployment failure behavior.

## Edit workspace files

Open **Workspace files** on an Agent to load the same four files. This view reads the live Agent workspace, not the
Configuration draft or browsed AgentRevision, and requires an active revision
and reachable gateway; selection alone does not prove access. Files are never
copied into a Configuration or revision.

Each file has its own **Save** and **Reload**. A save creates or replaces only
that file through the [workspace file API](agents.md#workspace-files); the editor
enforces the API's 16 KiB UTF-8 and Unicode limits. Loading requires Agent `read`; saving
requires `operate`. Writes have no version check: the last writer wins. Reload
replaces unsaved edits with the current file. The editor uses LF line endings:
loading a CRLF file does not enable Save or rewrite it, and saving an edit writes LF.

A failed write preserves the editor contents. An unknown outcome disables that
file's Save until Reload confirms current contents or file absence; review the
contents, or enter new content if it is missing, before saving again. Read denials
and unavailable resources keep Save disabled; no write is replayed automatically. Files load and
save independently, so one file's result says nothing about another's. For
unavailable gateways, follow the
[workspace access setup](../guides/deploy/workspace-routing.md#agent-workspace-files).

## Open the native admin UI

When [Agent native admin UI access](agent-native-admin.md) is enabled, all Agent
detail tabs, including Configuration and Workspace files, show a **Native admin
UI** panel to callers with exact Agent `administer`.
It is hidden otherwise, when the Installation disables the feature, and until
the next sign-in or new tab after a denial. The panel reports a stopped Agent
(including before first deployment) as needing to be started, asks you to check
deployment and refresh access when a desired-running Agent has no active
revision, and reports when native admin is unsupported. Installation
administrators can [share an Agent](console/agent-sharing.md) with an existing
person.

**Open native admin UI** opens the Agent's active revision in a new tab, even
from a draft or older revision. Its visible warning is part of the operator
contract: native UI changes to the gateway bypass OCE and are not recorded in
AgentRevisions. Use OCE for durable configuration. The tab shares
the console's OCE session cookie through the configured shared cookie parent
domain; native chat or other Agent-host activity does not extend that session.

## Routes

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/backends`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.
See the [request flow](../flows/platform-console.md) and
[local testing](../testing/local.md) for implementation and verification.
