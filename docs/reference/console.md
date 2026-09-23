# Platform console

Use the browser console at `/console/` on your OCC address to sign in, choose a
Namespace, create, deploy, and delete Agents, and edit supported Slack
draft settings. You can also set initial workspace contents and runtime credentials,
read or replace supported live workspace files, and list the Agents, Providers, and Namespaces
you can access. When the pilot is enabled, trusted operators can open an Agent's
[native admin UI](#open-the-native-admin-ui). The console does not offer rollback,
live runtime health, or browser chat through OCE.

For a component-by-component tour, see
[Understand the Agent detail page](../guides/console/agent-details.md).

For browser deployment instructions, follow [Create and deploy Agents](console/create-and-deploy.md).
See the [deployment guide](../guides/deploy.md) for operator procedures and
runtime checks, and the [API reference](api.md) for management operations.

## Start and sign in

Open `/console/` at the address your administrator gave you. **Username** is
your provisioned account email. Enter its password and select **Login**. Ask your
administrator for access if you do not have an account or have forgotten your
password; public signup, single sign-on, and self-service password recovery are
unavailable. If you are setting up your own Installation, start with the
[quickstart](../guides/quickstart.md#open-the-platform-console) or
[deployment guide](../guides/deploy.md#open-the-platform-console).

The console uses the existing [email/password session contract](authentication.md)
with same-origin cookies. It does not store tokens or accept service keys. A
missing or expired session clears private content and asks you to sign in again.

## Browse and select a Namespace

The sidebar opens **Agents**, **Providers**, or **Namespaces**. **Refresh**
repeats the current read. Provider and Namespace rows remain read-only collection
entries.

| Page       | Scope and permission                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Agents     | Selected Namespace; Namespace `read`, then exact Agent `read` filtering. |
| Namespaces | Installation-wide collection filtered by exact Namespace `read`.         |
| Providers  | Installation-wide configured inventory; Installation `administer`.       |

Use the bottom **OpenClaw Enterprise** menu for **Namespace**, **Settings**, or
**Logout**. Settings shows the signed-in account and no configurable settings.

The selected Namespace stays in `?namespace=<id>` across pages, reload, and Back.
An unreadable explicit ID shows **Namespace unavailable** and requires another
selection. With no readable Namespaces, Agents explains that provisioning or
access is needed; global pages remain available.

Switching Namespace from Agent detail or creation returns to the Agents list in
the new scope. Global pages stay open because Providers and Namespaces remain
Installation-wide. The API makes all authorization decisions; the selector does
not broaden access.

## Agent creation and deployment

The console creates an Agent and reusable Configuration, records optional
Agent-owned plugin selections and a harness authentication binding, stages initial
workspace contents, and provisions transport/channel credentials. Creation leaves
the Agent stopped and undeployed; **Deploy new revision** creates and starts a revision from the current Configuration. Follow
[Create and deploy Agents](console/create-and-deploy.md) for the complete
workflow, channel constraints, and recovery after partial or uncertain writes.
Plugin selections use the same Agent create/update contract as the API: omitted
updates preserve the map, `{}` clears it, and deployment startup reports
unsupported catalog or policy choices.

## Inspect detail, revisions, and channel drafts

Switching between **Configuration**, **Channels**, **Credentials**, and **Workspace
files** updates only the tab content. The surrounding Agent panels stay in place,
and browser Back/Forward restores the selected tab. Password fields are cleared
when leaving a tab. Use **Refresh** to reload the Agent and its Configuration.

An Agent detail page has a **New revision** view and immutable AgentRevisions. The new revision view
reads the current Configuration and supports native JSON editing through **Edit Configuration**,
plus the channel editor and harness authentication controls. Choose **Operator-managed
credentials** for SSH embedded OpenClaw: “Configured on the runtime host; not
validated by OCC.” This saves `{ "method": "runtime" }` without a Secret ID or
account. Its deployment action does not wait for OCC-managed credential metadata;
the API still enforces permissions and driver/topology support. Gateway readiness
does not establish model access. **Selected revision** displays `activeRevisionId`; neither the
newest admitted revision nor the viewed snapshot must match it.

Read-only AgentRevision snapshots cannot be edited, rolled back, redeployed, or
used as a live-health check. **Edit current Configuration** opens the current
draft; saving it leaves the viewed snapshot unchanged. Activation means the revision was admitted and
selected by OCC. The console displays persisted deployment and startup evidence,
not live gateway health. Follow the
[deployment guide](../guides/deploy/production-agents.md#configure-the-agent-runtime) and
[Agent deployment reference](agents/deployment.md#revisions-and-deployment) for the
installed runtime.

The Channels tab edits Slack settings on the saved Configuration draft.
Microsoft Teams has no console editor: its credentials and Bot Framework ingress
require operator setup, and the console cannot deploy a Teams-enabled draft.
Existing Teams settings remain visible in the native Configuration JSON.
Saving Slack settings patches only `values`, so
the backend retains existing `secretBindings`. An existing plugin allowlist is
extended; an omitted allowlist stays omitted. Because a Configuration can be
shared by multiple Agents, channel edits can affect future deployments of other
Agents that reference the same Configuration.
These channel allowlist edits are native Configuration changes and are separate
from Agent-owned plugin selections.

Before saving, the browser rereads the Agent and Configuration and checks that
the Agent still references the same Configuration and its generation is unchanged.
These are separate reads; a later concurrent change can still race the PATCH.
Refresh before retrying a conflict or uncertain save. An unconfirmed PATCH shows
**Outcome unknown**, closes the editor, and disables channel writes until
Refresh loads current saved state. The write may have succeeded; there is no
automatic replay. **Disable Slack** edits only the draft. It does not disable
access, stop execution, or change an admitted revision.

Slack editing preserves existing direct-message and channel policies, including
pairing, open, disabled, and omitted policies. It also preserves per-channel user
restrictions. New Slack configurations use allowlist policies. **Allowed user
IDs** edits `allowFrom`; the existing policy determines how those entries affect
access. The editor does not change the policy when saving channel settings. Slack Socket Mode uses fixed
unresolved references to `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`.
Slack requires dedicated execution and Kubernetes runtime projection.

The simple editor may reject native channel documents it cannot round-trip,
including non-Socket Slack settings, non-standard credential references, mixed
per-channel mention settings, or unsupported plugin shapes. Inspect unsupported
settings in the native Configuration view and edit them through the API or
operator workflow.

## Stop and resume an Agent

Open the Agent, select **Stop Agent**, and confirm after reviewing the effect on
running work. Stop requires `operate` permission on that exact Agent. It requests
shutdown while retaining revision history, credentials, gateway state, and
workspace files.

An accepted request means shutdown was queued. **Refresh stop status** rereads
the Agent's desired state and selected revision; it does not probe the runtime.
If the result is uncertain, refresh before retrying. Permission denials remain
visible, and the console never automatically repeats a stop request.

To resume, open **New revision** and select **Deploy new revision**. This creates a
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
`401` clears private content and closes an open channel editor and harness authentication controls. Provider
discovery shows configured IDs and types only; see
[Providers](providers.md#read-configured-providers) for its limits.

Logout immediately hides private content and stops pending reads. The console
returns to login after sign-out succeeds or a session check confirms that the
session is absent. If it cannot confirm logout, it stays on a blocking error with
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
`/console/agents/new`, `/console/agents/:agentId`, `/console/providers`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.
See the [request flow](../flows/platform-console.md) and
[local testing](../testing/local.md) for implementation and verification.
