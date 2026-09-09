# Platform console

The controller serves a browser console at `/console/` on its existing origin.
Sign in, select a Namespace, inspect accessible Agents, Providers, and
Namespaces, create Agents with editable Configuration JSON and Slack/Teams settings,
edit channel drafts, provision initial runtime credentials, deploy saved drafts, and read or replace supported live workspace files. Rollback,
live runtime health, and Agent deletion are unavailable in the console.
The [operator workflow](../flows/operator-workflow.md) connects the supported
management API commands and runtime checks, including current lifecycle and
retention limits. Browser chat is not exposed by this console.

## Start and sign in

Start the controller through the [quickstart](../guides/quickstart.md#open-the-platform-console)
or [deployment guide](../guides/deploy.md#open-the-platform-console), then visit
`/console/`. **Username** means your provisioned account email. Enter its password
and select **Login**. Public signup, SSO, and password recovery are unavailable.

The console uses the existing [email/password session contract](authentication.md).
The browser sends cookies to the same origin; it does not store tokens or accept
service keys. Production retains secure cookies and the internal API network
boundary. Visiting a page or using browser Back checks the current session before
showing private content. Expiry clears the view and asks you to sign in again.

## Browse and select a Namespace

The sidebar opens **Agents**, **Providers**, or **Namespaces**. Lists show names
and selectable IDs. Namespace rows include their server lifecycle status;
Provider rows show their configured type. Agent rows open detail pages. Provider
and Namespace rows remain read-only collection entries. **Refresh** repeats the
current read.

| Page       | Scope and permission                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Agents     | Selected Namespace; Namespace `read`, then exact Agent `read` filtering. |
| Namespaces | Installation-wide collection filtered by exact Namespace `read`.         |
| Providers  | Installation-wide configured inventory; Installation `administer`.       |

Use the bottom **OpenClaw Enterprise** menu for **Namespace**, **Settings**, or
**Logout**. The Namespace submenu supports pointer, touch, and keyboard use;
arrow keys move within menus and Escape closes them. A narrow viewport exposes
the same actions through the navigation drawer. Settings shows the signed-in
account and a return link; it contains no configurable settings.

The selected Namespace stays in `?namespace=<id>` across pages, reload, and Back.
Without an explicit selection, the console chooses the first readable `ready`
Namespace, otherwise the first readable Namespace, sorted by name then ID.
An explicit ID that is no longer readable shows **Namespace unavailable** and
requires another selection. With no readable Namespaces, Agents explains that
administrator provisioning or access is needed; global pages remain available.

Switching Namespace from Agent detail or creation returns to the Agents list in
the new scope. Global pages stay open; Providers and Namespaces remain
Installation-wide. Old rows clear immediately,
and late responses from prior navigation cannot restore them. The API makes all
authorization decisions; the selector does not broaden access.

## Create an Agent

Select **Create Agent** from the Agents page to create one Namespace-owned Agent.
Enter an Agent name and review the prefilled native Configuration JSON. The
editable starter matches the selected execution mode: dedicated uses
`codex/gpt-5.1`; embedded uses `openai/gpt-5.1`. These are examples, not discovered
Installation defaults or a guarantee of model access. Review the model and
provision the required credentials before deployment. Changing execution mode
updates untouched JSON; use **Reset template** to replace your edits. The form
requires valid JSON with an object at its root.

Use the Slack and Microsoft Teams cards to configure initial channels before creating
the Agent. Their settings update the same Configuration JSON, including the required
plugin entries. No channel request is sent until you submit **Create Agent**. Enabled
channels require Dedicated execution. Slack credentials can be provisioned from the saved Agent draft; Teams credential provisioning remains an operator procedure.

Workspace files cannot be initialized during creation: the backend accepts files
only after the Agent has an active revision and a reachable gateway. Create and
deploy the Agent, then open **Workspace files** to load or create the four supported
files. The creation form does not store unsaved file contents.

Choose an optional Provider and service account from the select lists. Provider
discovery requires Installation `administer`; service accounts are readable
accounts in the selected Namespace. Select the two associations independently.
Unavailable or loading lists show their status. You can leave either association
unset; the form does not accept freeform association IDs.

Submitting creates a same-Namespace `kind: "agent"` Configuration from the JSON,
then submits `POST /namespaces/:namespaceId/agents` with its returned ID and the
selected execution mode and associations. If the Configuration saves but Agent
creation fails, its ID remains visible and the saved JSON and execution mode are fixed.
Correct the name or associations and retry to reuse that Configuration. These are separate
API writes; failure does not remove the saved Configuration or retry automatically.
If a write’s reply is interrupted or unavailable, its outcome is unknown. The
form disables further creation until you leave or refresh it. Inspect the Agent
and Configuration collections before starting again; a lost response can follow
a successful write.
Successful creation opens the Agent detail page at
`/console/agents/:agentId?...&revision=draft`. It does not
admit an AgentRevision, deploy a workload, or prove runtime health.

## Initial runtime credentials

Before an Agent's first deployment, open its saved draft and provision the runtime
credentials. This path supports the Kubernetes Compute Driver's native per-Agent
OpenAI API key and optional Slack Socket Mode credentials. It does not replace
Provider-managed ServiceAccount credentials or Configuration Secret bindings.

Enter the OpenAI API key and, when Slack is enabled, its app and bot tokens.
The server generates independent gateway and app-server transport tokens and a
local gateway password. The password is projected only when native Configuration
explicitly selects the supported environment reference; it is never returned by
the credential API.
Inputs are masked and cleared after submission; the browser does not store them
in local storage, URLs, or Configuration. The API returns only whether each
complete, correctly owned credential group is stored. **Stored** does not mean
the provider accepted a credential or that a gateway is connected.

The API uses `GET` and `POST` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials`. Reading requires
exact Agent `read`; provisioning also requires `operate`. The server derives all
Kubernetes names from the admitted Namespace, Agent, and Installation driver
configuration. Credential values are transient API inputs and are stored only in
the Agent-owned Kubernetes Secrets; audit records contain the actor, target,
action, and outcome, never the values.

Provisioning creates missing whole Secrets before any AgentRevision exists.
It never rotates or overwrites existing credentials. A retry may reuse complete,
owned groups; supplying a different value for an existing group is a conflict.
Malformed or foreign Secrets require operator investigation. If a response is
lost or a dependency fails, refresh stored status before explicitly retrying.
Already-created Secrets remain in place even when later storage or audit work
fails; there is no automatic retry or rollback deletion.

## Deploy a saved draft

Open the Agent's saved draft and select **Deploy saved draft** after all required
credential groups show stored status. The console rereads the Agent and Configuration
and requests deployment through the existing exact-Agent endpoint. A changed draft
requires a refresh. These checks are separate reads, not an atomic compare-and-set.
Teams-enabled drafts cannot deploy through this console path because Teams credential
readiness is not exposed; use the operator deployment workflow for those Agents.

An accepted deployment opens **Workspace files**. Admission does not establish
runtime readiness; retry file loading after the gateway starts. If the deployment
reply is lost, inspect the Agent and revision history before another attempt.
The console does not replay an uncertain deployment automatically.

## Inspect detail, revisions, and channel drafts

An Agent detail page has two views: the saved draft and immutable
AgentRevisions. The saved draft reads the Agent's current Configuration and is
editable only through the supported channel editor. All AgentRevisions are
read-only admitted snapshots. **Selected revision** displays the Agent's current
`activeRevisionId`; neither the newest admitted revision nor the snapshot being
viewed must match it. The URL `revision=<id>` chooses a snapshot to inspect. Use
**View selected revision** to return to the Agent's selected snapshot.

Read-only AgentRevision snapshots cannot be edited, rolled back, redeployed, or
used as a live-health check. Activation means the revision was admitted and
selected by OCC; the console has no live gateway health API. Detail pages
explicitly show **Serving status unavailable**, including when a revision is
selected. There is no observation time, generation, serving revision, failed
activation, or shutdown outcome in the current Agent API response. The console
does not infer these from selection or admission. Follow the
[operator checks](../flows/operator-workflow.md#inspect-selection-and-runtime)
for the installed runtime.

The Channels tab edits Slack and Microsoft Teams settings on the saved
Configuration draft. Saving a channel change patches only `values` on the
Configuration, so existing `secretBindings` are omitted from the PATCH and
retained by the backend. The editor preserves other loaded native keys while
updating the provider block and enabling its plugin. An existing plugin allowlist
is extended; an omitted allowlist stays omitted. Because a Configuration can
be shared by multiple Agents, channel edits can affect future deployments of
other Agents that reference the same Configuration.

Before saving, the browser rereads the Agent and Configuration and checks that
the Agent still references the same Configuration and its generation is unchanged.
These are separate reads; a later concurrent change can still race the PATCH.
Refresh before retrying a conflict or uncertain save.
An unconfirmed PATCH shows **Outcome unknown**, closes the editor, and disables
channel writes until Refresh loads current saved state. The write may have
succeeded; there is no automatic replay. **Disable Slack** and **Disable
Microsoft Teams** edit only the draft. They do not disable access, stop execution,
or change an admitted revision.

Slack editing preserves existing per-channel user restrictions. **Allowed user IDs**
controls the direct-message allowlist. Editing supports Socket Mode settings with fixed unresolved environment
references to `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. Microsoft Teams editing
supports application ID, tenant ID, require-mention, and a fixed unresolved
environment reference to `MSTEAMS_APP_PASSWORD`. Both channel integrations
require dedicated execution and Kubernetes runtime projection. Initial Slack credentials
can be provisioned in the console; Teams credentials remain operator-provided.
Only Slack Socket Mode has live proof in the current test guide; Teams also
requires separately configured Bot Framework ingress. The simple editor may
reject native channel documents it cannot round-trip, including non-Socket Slack
settings, non-standard credential references, mixed per-channel mention settings,
or unsupported plugin shapes. The native Configuration view remains available for inspection; unsupported
settings require the API or operator workflow.

Agent deletion is unavailable in the current API, so the console cannot delete
an Agent or its revision history. The backend deletion scope remains an open
product question.

## Failures and logout

An authorized empty list is different from a failed read. Access denied,
unavailable dependencies, missing resources, and network failures clear affected
rows and offer the relevant recovery action. Include a displayed request ID when
reporting an API failure. Provider discovery shows configured IDs and types only;
see [Providers](providers.md#read-configured-providers) for its limits.
Backend error text is not rendered. Failure messages use local reason classes,
and request IDs are restricted to the server’s bounded `req_` identifier format.
A current protected `401` immediately clears all private content and closes an
open channel editor, even when a sibling read remains pending. Earlier page
responses cannot restore the view or expire a newer session.

Logout immediately hides private content and stops pending reads. The console
returns to login after sign-out succeeds or a session check confirms that the
session is absent. If it cannot confirm logout, it stays on a blocking error with
Retry. Do not treat that error as confirmation that the server session was revoked.

## Edit workspace files

Open **Workspace files** on an Agent to load `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
and `USER.md`. This view reads the live Agent workspace independently of the
Configuration draft or browsed AgentRevision. It requires an active revision and
reachable gateway; selection alone does not prove access. Files remain in the
Agent workspace and are never copied into a Configuration or revision.

Each file has its own **Save** and **Reload** action. A save creates or replaces
only that file through the [workspace file API](agents.md#workspace-files).
The editor enforces the API's 16 KiB UTF-8 and Unicode limits. A missing file can
be created; other failed reads keep editing disabled. Agent `read` permits
loading, while `operate` is required to save. Reload replaces unsaved edits with
the current file. Workspace writes have no version check; the last writer wins.

A failed write preserves the editor contents. An unknown outcome disables that
file's Save action until a successful reload, so an uncertain write is never
replayed automatically. Review the loaded contents before deciding whether to
write again. Files load and save independently; success for one file says
nothing about another file's result. For unavailable gateways, follow the
[workspace access setup](../guides/deploy.md#agent-workspace-files).

## Routes and packaging

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/providers`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.

Static HTML, CSS, and browser modules ship inside the controller image; no
separate frontend service or build is required. Console fallback does not handle
API routes or expose controller source files. See the
[request flow](../flows/platform-console.md) and [test guide](../testing.md) for
implementation and verification.
