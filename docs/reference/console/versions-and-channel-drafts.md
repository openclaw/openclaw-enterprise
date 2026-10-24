# Inspect Agent detail, versions, and channel drafts

This page details the Agent detail page of the [platform console](../console.md):
tabs and drafts, deployment details, diagnostics, authentication, versions, and the
Slack channel editor with its Secret picker.

Agent tabs change only their panel; Back/Forward restores the selected tab.
Unsaved JSON, plugin policies, workspace text, authentication, Slack drawers,
Preset variables, and Agent search survive in-document navigation as drafts
scoped to user, Namespace, and Agent. Passwords clear; reload warns; sign-out
clears drafts.

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
**Save plugin selections** updates the Agent. Deployment snapshots the saved settings.
The Console confirms a save only when the response identifies the same Agent,
Namespace, and Configuration and matches the submitted selections and approvers.
An incomplete or mismatched success response leaves the draft visible and blocks
saving and deployment until you can [reload the saved settings](../../guides/console/configuration-plugins-and-files.md#plugins-tab).

**Operator-managed credentials** saves `{ "method": "runtime" }` for SSH embedded
OpenClaw; OCC neither validates host credentials nor generates metadata for that
binding, but API permissions and topology checks still apply. **Selected version** shows `activeRevisionId`, a selected pointer, not serving health.
**Deployment details** follows the newest readable deployment. Routine completion
starts folded; pending work, warnings, and cleanup are expanded. When the page shows
before the first record arrives (a read slower than about 2 s), that record fills the
folded row instead, and the summary above shows its outcome; cleanup and warnings still
expand it, as does every later change.
The viewed version retains its own result. Unreadable outcomes remain unknown.
Bootstrap failures retain safe evidence; cleanup refreshes separately.

A failure's card leads the page and folds the details. Its **Open vN Logs** opens
the failed version's [Logs panel](../../guides/topics/agent-logs.md), showing
output or the applicable access or availability message, even from the draft or another version.

**Run diagnostics for this version** fills **Current observations** with a
bodyless POST that checks the exact viewed version. It requires Agent
`read`/`operate` and exact AgentRevision `read`. Kubernetes checks cover only
Slack (`NOT_CONFIGURED`: no Slack channel), never model credentials. Each check
is timestamped `succeeded`, `failed`, or `unknown`; recorded failures stay shown,
and unavailable requests show an error. Results do not change deployment
history, repeat the startup model probe, or prove message delivery.

**Save authentication source** stores the binding and confirms exact
`secret:operate` access for the Agent principal on an API-key or Service Accounts
Secret. Grant changes require Installation `administer`; issued ChatGPT accounts
and operator-managed authentication skip the grant. A member's save sends no
grant, reports that access was not verified, and names the Installation
administrator. Opening Credentials as an administrator reads Namespace IAM and blocks
deployment while that grant is missing. A refused or failed grant request offers **Retry credential access**
without repeating the Agent update. Partial saves survive navigation. Grants do not prove runtime or
provider readiness.

Configuration and Slack summaries show bound Secret names and IDs for the viewed
draft or version. Names require exact same-Namespace Secret `read`; denied,
missing, or failed reads show the ID with **Metadata unavailable**. **No Secret
bound** means no binding. Values are never read, and metadata does not prove
credential validity.

AgentRevision snapshots cannot be edited, rolled back, or redeployed. **Create
new version** and **Edit current Configuration** open the saved draft without
changing the viewed snapshot; **Deploy new version** admits it as another
immutable version. Admission, recorded activation, and `activeRevisionId` are
separate facts, and startup evidence does not establish live gateway health; see the
[deployment guide](../../guides/deploy/production-agents.md#configure-the-agent-runtime)
and [deployment reference](../agents/deployment.md#versions-and-deployment).

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
the draft, not access, execution, or saved versions.

Slack requires dedicated execution and Kubernetes runtime projection. Socket Mode
uses unresolved `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` references.
New configurations use allowlist policies. **Allowed people in these channels**
replaces selected channels' `users` lists while preserving unrelated settings.
**Everyone in these channels** writes `users: ["*"]`; it and specific people are
mutually exclusive. **Require a mention** is independent of sender access.
Channel edits preserve group policies. Change DM access with
**Direct-message policy** and **Allowed people in direct messages** in the same drawer; see
[Slack policies](../configuration/secrets.md#native-channel-configuration).

Model, Harness, and Slack credentials share one searchable Secret picker; the
[Slack editor](../../guides/console/channels-and-credentials.md#slack-editor) lists
its controls. Escape restores the binding, and **Create new Secret...** stays
available without matches, with **Name** defaulting to the Agent name and
purpose. A name conflict keeps both inputs and overwrites no Secret. Namespace
readiness errors require refresh.

Creation stores the Secret immediately, under existing
[Secret IAM checks](../drivers/secret.md#iam); cancelling the surrounding editor
does not delete it, and values are never read back. An uncertain creation blocks
resubmission: the Secret may exist, so refresh and inspect metadata first.

Selections stay staged until **Save configuration**; Cancel discards them.
Saving patches Configuration, then grants Agent access through Namespace IAM;
both require caller permission. A failed grant leaves Configuration saved and
requires access recovery. A member's session sends no grant and reports that access
was not verified until **Reload draft**. Neither creation nor saving deploys a Secret.

Secret metadata links open new tabs, preserving edits. Save channel changes
before editing credentials on the Credentials tab.

The simple editor may reject native channel documents it cannot round-trip,
including non-Socket Slack settings, non-standard credential references, mixed
per-channel mention settings or sender lists, `*` channel maps, or unsupported
plugin shapes. Inspect those settings in the native Configuration view; edit them
through the API or operator workflow.
