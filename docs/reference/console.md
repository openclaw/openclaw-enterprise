# Platform console

Open `/console/` on your OCC address to manage Agents, Namespace Secrets, and supported Slack settings,
workspace files, and credentials. Authorized operators can also open an Agent's
[native admin UI](#open-the-native-admin-ui). The console has no rollback, live
runtime health, or browser chat through OCE.

See [Create and deploy Agents](console/create-and-deploy.md) or
[Understand Agent detail](../guides/console/agent-details.md). Operator setup and
runtime checks belong to the [deployment guide](../guides/deploy.md).

## Start and sign in

Enter your provisioned account email and password, then select **Sign in**. Public
signup, single sign-on, and self-service password recovery are unavailable; ask
your administrator for an account or password reset. A wrong email or password
always gets the same message. Other sign-in failures say what to do: wait the
time shown after too many attempts, try again shortly when sign-in is unavailable,
or open the console from its configured address when the API refuses the
browser origin. For your own
Installation, see the
[quickstart](../guides/quickstart.md#open-the-platform-console) or
[deployment guide](../guides/deploy.md#open-the-platform-console).

The console uses [session cookies](authentication.md); it never stores tokens or
accepts service keys. Expiry clears private content and drafts. Sign in again to
return to the validated page after access checks.
See [sign-in destinations](authentication/external-sign-in.md#console-sign-in-destinations).

## Customize deployment branding

Operators can replace the displayed product name, logo, browser icons, and semantic
colors with a mounted [theme bundle](console/theming.md). See
[Apply a console theme](../guides/deploy/console-theme.md) for deployment steps.

## Identify the control-plane build

With `debug=true`, the sidebar wordmark shows the first eight characters of the
running OCC image's source commit, or **dev** for builds without metadata; hover
for the full commit. Published images bake their source commit into the console
HTML.

## Browse and select a Namespace

The sidebar opens **Agents**, **Secrets**, or **Namespaces**; **Refresh** repeats the read.
Configure models during creation. [Experimental Backends](backends.md) stay
hidden. Namespace rows open their Agents.

| Page          | Scope and permission                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Agents        | Selected Namespace; Namespace `read`, then exact Agent `read` filtering.                                             |
| Secrets       | Selected Namespace; Namespace `read`, then exact Secret `read` filtering.                                            |
| Namespaces    | Installation-wide collection filtered by exact Namespace `read`.                                                     |
| Observability | External [`observability.url`](configuration.md#installation-startup-configuration) link; Installation `administer`. |

[Create a Namespace](../guides/console/create-namespace.md) explains creation and recovery.

The Console uses light appearance and OCC-served fonts. Navigation focuses the
destination heading; **Open navigation** opens the mobile drawer.

Click an Agent name or an open area of its row to open its details. Version links
and Stop or Delete buttons keep their separate actions. Keyboard users can Tab to
the Agent name and press Enter.

Opening an Agent shows its details page immediately. While it loads, **Back to
Agents** returns to your place. A slow return to a retained page says **Still
checking…** after one second. Refresh rebuilds; refocusing an unchanged page preserves edits,
Slack searches, focus, and the Namespace selector; at phone width, focus in the open drawer moves to
**Open navigation**. Views belong to one account, session, route,
and Namespace. Sign-out, session changes, exit, or Backend denial clear them.

**Namespace** switches readable scopes; Namespaces omits this selector. The account menu offers
**Settings** (the signed-in account, with **Sign out**) and **Sign out**.

The URL keeps `?namespace=<id>` across navigation, reload, and Back. An unreadable
ID shows **Namespace unavailable**; on Namespaces, **Choose a valid namespace**
updates the URL in place.

During session and Namespace checks, the selector is disabled and hides its choices.
Once the list is known, it names the destination's Namespace. On returns to the same page,
later page reads do not block it. Without a readable Namespace, Agents and Namespaces explain how to
get access; global pages remain available.

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

## Manage Namespace Secrets

The **Secrets** page lists metadata, creates Secrets, replaces values, inspects
consumers, and deletes unreferenced Secrets through the existing Secret API.
Creation needs collection `secret:create`; replacement and deletion need exact
`secret:update` and `secret:delete`. Read access does not grant mutation or use.
The API authorizes each operation; a refusal disables the submitted action.
Names are fixed, values remain unreadable, and entered material is never saved
in browser storage. Consumer counts retain read-permission and truncation limits.

Follow [Manage Secrets in the console](../guides/console/secrets.md) for procedures,
replacement delivery, deletion effects, and uncertain-write recovery.

## Agent creation and deployment

Dedicated provisioning waits for first activation; failure links the original
request’s existing Agent and version. Otherwise, creation
saves a draft: provide model and channel credentials when prompted, then select
**Deploy new version**. If the Compute Driver requires them, OCC generates
missing connection credentials during that first deployment.
See [Create and deploy Agents](console/create-and-deploy.md) for the full
workflow, [Namespace status](namespaces.md#lifecycle) rules, channel constraints, and partial-write recovery.
Plugin selections follow the API's Agent create/update contract: an omitted map
is preserved, `{}` clears it, and deployment startup reports unsupported catalog
or policy choices.

<a id="inspect-detail-revisions-and-channel-drafts" class="anchor-alias"></a>

## Inspect detail, versions, and channel drafts

Agent detail tabs, drafts, deployment details, diagnostics, authentication,
versions, and the Slack channel editor are described in
[Inspect Agent detail, versions, and channel drafts](console/versions-and-channel-drafts.md).

## Stop and resume an Agent

Select **Stop Agent** or the Agent's list-row Stop icon, review its effect, and
confirm. Stop requires exact Agent `operate`. It requests shutdown while
retaining version history, credentials, gateway state, and workspace files.

An accepted request means shutdown was queued; the list row shows **Stop
requested**. **Refresh stop status** rereads the Agent's desired state and
selected version without probing the runtime. After Stop, **Request Stop
again** confirms a new stop intent, even without a selected version, but not
when you can read no version, as before a first deploy (the list then shows no
Stop icon). That does not prove cleanup finished.

To resume, open **Create new version** and select **Deploy new version**. See
[Stop and resume](agents/deployment.md#stop-and-resume) for worker lifecycle and
preservation.

## Delete an Agent

Select **Delete Agent** or the Agent's list-row Delete icon, then **Permanently
delete Agent**. Exact Agent `delete` is required; `read` or `operate` is
insufficient. Deletion removes the Agent, its versions, and its workspace data.
Namespace Configurations and Secrets remain; see
[Agent deletion](agents.md#deletion).

**Refresh deletion status** follows asynchronous cleanup. When the API confirms
the Agent is gone, the console returns to that Namespace; meanwhile its row shows
**Deleting**. A deleting Agent keeps **Request deletion again** behind
confirmation. Failed cleanup can be replenished; queued or running cleanup is
unchanged. A refused repeat explains the API's retry ownership.

Missing access disables a row icon with a reason. Denials remain visible; the
console never resends either write. After an uncertain result, the action stays
blocked until a status read succeeds or, in the list, until **Refresh**.

## Failures and logout

An authorized empty list differs from a failed read. Access denials, unavailable
dependencies, missing resources, and network failures clear affected rows and
offer recovery. A denied Namespace list or draft Configuration read, and a control
disabled for lack of access, names the grant the API checks, such as Agent operate
to stop an Agent or AgentRevision read on each new version. Other denials of your own
permission show the API's sentence naming the missing grant; denials send you to an
Installation administrator, who grants access. A version link the page cannot list says the
version does not exist or your access does not include it, because a reader granted read per
version cannot tell the two apart.
A rejected model credential tells a person without Agent update which grants fix it: Agent
update to choose another credential, or, for a Secret-backed credential, Secret update on that
Secret to replace its value. It also says who gives them.
A refusal the API explains, such as an invalid field, a name already in use or a
lifecycle change, shows the API's sentence; a rate limit says how long to wait.
Other backend error text is not rendered; include any displayed request
ID when reporting an API failure. A current protected `401` clears private
content and closes open channel editors and harness authentication controls.
Interrupted response bodies and request deadlines keep the interrupted-read
recovery path. View cancellation does not show a new failure, and a failed
response never automatically retries a mutation.
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

Open **Workspace files** on an Agent to load the same four files from the live
workspace, not the Configuration draft or a browsed AgentRevision. Loading needs
a selected version and a reachable gateway; selection does not prove access.
Files are not copied into a Configuration or version.

Each file has **Save** and **Reload**. Save creates or replaces that file through
the [workspace file API](agents.md#workspace-files), within its 16 KiB UTF-8 and Unicode limit.
Loading requires Agent `read`; saving requires `operate`. The last writer wins.
Reload replaces unsaved edits. The editor uses LF: loading a CRLF file does not
enable Save or rewrite it, and saving an edit writes LF.

A failed write keeps the editor contents. An unknown outcome disables Save until
Reload confirms the file or its absence. Review what loaded, or enter new content
when the file is missing, before saving again. A denial or unavailable read leaves
Save disabled. The editor never replays a write. Each file saves independently.
For an unavailable gateway, follow the
[workspace access setup](../guides/deploy/workspace-routing.md#agent-workspace-files).

## Open the native admin UI

When [Agent native admin UI access](agent-native-admin.md) is enabled, all Agent
detail tabs, including Configuration and Workspace files, show a **Native admin
UI** panel to callers with exact Agent `administer`.
It is hidden otherwise, when the Installation disables the feature, and until
the next sign-in or new tab after a denial. The panel reports a stopped Agent
(including before first deployment) as needing to be started, asks you to check
deployment and refresh access when a desired-running Agent has no selected version, and reports when native admin is unsupported. Installation
administrators can [share an Agent](console/agent-sharing.md) with an existing
person.

**Open admin console** opens the Agent's selected version in a new tab, even
from a draft or older version. Its visible warning is part of the operator
contract: native UI changes to the gateway bypass OCE and are not recorded in
AgentRevisions. Use OCE for durable configuration. The tab shares
the console's OCE session cookie through the configured shared cookie parent
domain; native chat or other Agent-host activity does not extend that session.

## Routes

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/backends`,
`/console/namespaces`, `/console/secrets`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.
See the [request flow](../flows/platform-console.md) and
[local testing](../testing/local.md) for implementation and verification.
