# Platform console

The controller serves a browser console at `/console/` on its existing origin.
Use it to sign in, choose a Namespace, inspect accessible Agents, Providers, and
Namespaces, create and deploy Agents, edit supported Slack or Microsoft Teams
draft settings, provision supported initial runtime credentials, and read or
replace supported live workspace files. Rollback, live runtime health, browser
chat, and Agent deletion are unavailable in the console.
The [deployment guide](../guides/deploy.md) owns runtime checks and operator
procedures; the [generated API reference](api.md) owns supported management API
shapes.

## Start and sign in

Start the controller through the [quickstart](../guides/quickstart.md#open-the-platform-console)
or [deployment guide](../guides/deploy.md#open-the-platform-console), then visit
`/console/`. **Username** means your provisioned account email. Enter its password
and select **Login**. Public signup, SSO, and password recovery are unavailable.

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
Agent-owned plugin selections, provisions supported initial runtime credentials,
and deploys the saved draft. Follow
[Create and deploy Agents](console/create-and-deploy.md) for the complete
workflow, channel constraints, and recovery after partial or uncertain writes.
Plugin selections use the same Agent create/update contract as the API: omitted
updates preserve the map, `{}` clears it, and deployment startup reports
unsupported catalog or policy choices.

## Inspect detail, revisions, and channel drafts

An Agent detail page has the saved draft and immutable AgentRevisions. The draft
reads the current Configuration and is editable only through the supported
channel editor. **Selected revision** displays `activeRevisionId`; neither the
newest admitted revision nor the viewed snapshot must match it.

Read-only AgentRevision snapshots cannot be edited, rolled back, redeployed, or
used as a live-health check. Activation means the revision was admitted and
selected by OCC; the console has no live gateway health API and always shows
**Serving status unavailable**. Follow the
[deployment guide](../guides/deploy/production-agents.md#configure-the-agent-runtime) and
[Agent deployment reference](agents/deployment.md#revisions-and-deployment) for the
installed runtime.

The Channels tab edits Slack and Microsoft Teams settings on the saved
Configuration draft. Saving patches only `values`, so existing
`secretBindings` are retained by the backend. An existing plugin allowlist is
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
automatic replay. **Disable Slack** and **Disable Microsoft Teams** edit only the
draft. They do not disable access, stop execution, or change an admitted
revision.

Slack editing preserves existing per-channel user restrictions. **Allowed user
IDs** controls the direct-message allowlist. Slack Socket Mode uses fixed
unresolved references to `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`; Microsoft
Teams uses application ID, tenant ID, require-mention, and `MSTEAMS_APP_PASSWORD`.
Both integrations require dedicated execution and Kubernetes runtime projection.
Teams also requires Bot Framework ingress.

The simple editor may reject native channel documents it cannot round-trip,
including non-Socket Slack settings, non-standard credential references, mixed
per-channel mention settings, or unsupported plugin shapes. Inspect unsupported
settings in the native Configuration view and edit them through the API or
operator workflow.

## Failures and logout

An authorized empty list is different from a failed read. Access denied,
unavailable dependencies, missing resources, and network failures clear affected
rows and offer the relevant recovery action. Include a displayed request ID when
reporting an API failure. Backend error text is not rendered. A current protected
`401` clears private content and closes an open channel editor. Provider
discovery shows configured IDs and types only; see
[Providers](providers.md#read-configured-providers) for its limits.

Logout immediately hides private content and stops pending reads. The console
returns to login after sign-out succeeds or a session check confirms that the
session is absent. If it cannot confirm logout, it stays on a blocking error with
Retry. Do not treat that error as confirmation that the server session was revoked.

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

## Routes

Supported pages are `/console/login`, `/console/agents`,
`/console/agents/new`, `/console/agents/:agentId`, `/console/providers`,
`/console/namespaces`, and `/console/settings`. `/console/` resolves the session
and opens Agents. Unknown console paths show a generic not-found page.
See the [request flow](../flows/platform-console.md) and
[local testing](../testing/local.md) for implementation and verification.
