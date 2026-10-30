# Console Storybook Agent workflows

Walk through Agent creation, editing, deployment, Stop, and Delete in the
[Console Storybook](console-storybook.md). Start it as that page describes;
these stories use simulated responses.

## Create and deploy

Compare **New version queued**, **Deployment waiting for runtime**, and
**Deployment retry after dependency failure**; switch versions and check
**Since**.

**First deployment creates credentials** accepts **Deploy new version** without
a separate credential action. Its initial state is not a Stop request; OCC
generation is simulated.

Choose a Preset, fill its variables, review seeded workspace files, and create
a Codex-harness Agent: the Console submits inline Configuration and Secret
references, then follows simulated provisioning. Another flow uses the default
Preset with OpenAI Codex, a new or existing model Secret, and a model, editing
IDENTITY.md and clearing USER.md first.
OpenClaw and unsupported-runtime stories keep the draft workflow: provision
credentials and deploy from Agent detail.

**Plugins Curated** exercises token-free discovery against simulated Driver
responses, leaving access unverified. Hosted discovery requires an eligible Codex
service-account token. Workspace and Standard OpenClaw stories preview file and
harness settings. Preset Secret stories cover existing, pending, denied, and empty
results while keeping new-token entry.

The [DevDay storyboard](../../scripts/console-storybook/devday-storyboard.md)
gives presenter actions, expected visible states, and fallbacks for creating an
Agent from the SWE Agent Preset and opening the deployed `oceclaw` Agent's
simulated Admin UI, connected to no gateway, Slack, credential, or model.

**Choose provider, harness, and authentication** covers the supported
combinations; models appear before credentials. **Enter another model ID**
allows manual entry but does not prove access. Execution mode follows the
harness; saved tokens require Codex. **Experimental Dedicated OpenClaw** shows
the runtime-build warning; Embedded OpenClaw does not.

In **Enter another model ID**, switch to **Choose a model from the list** and
back: listed models survive both switches, focus moves to the active input, and
other settings persist. Edit the manual ID to another listed model; returning
selects it. A custom ID outside the list requires a new selection. After a provider
change through Configuration JSON, the list must match and drop the old
provider's model.

The fixture supplies a ready Namespace, Preset, and model Secret. Namespace
provisioning, Preset CRUD, and service-account issuance have no dedicated console
pages. One Secret picker selects or creates new version model Secrets and Slack
tokens (Credentials tab and Channels drawer). See
[Create and deploy in the console](../reference/console/create-and-deploy.md)
for the supported installation workflow, prerequisites, and Teams deployment limits.

The [repository collaborator walkthrough](../../scripts/console-storybook/repository-access-workflow.md)
covers new selections, saved access during discovery, and explicit Read-only overrides.

Repository previews cover access levels, empty or pending discovery, unavailable
choices, denied or unverified authorization, and reselection after a rejected save.
In **Locale-stable repository search**, search `ibm`, select `acme/platform`, and
confirm reference `IBM-platform`. Simulated data does not prove GitHub App access
or credential delivery.
In **Repository choices unavailable**, follow the setup link (no retry); creation
without repository access stays available. The recovery story keeps its saved
Configuration and needs a current nonempty repository selection to retry.
The fixture does not verify operator prerequisites: GitHub App setup, Namespace
approvals, runtime images, and credential-service networking.

## Return to loaded pages

In **Return to loaded pages**, Tab to Namespaces and press Enter: its heading
receives focus, then Tab reaches Refresh. Check retained editors through
Back/Forward, Refresh, refocus, and Namespace switches.

**Return Backend access denied** checks Installation-wide denial.
**Return access denied** and **Return session expired** must remove retained
private content on response. These fixtures prove presentation only; the
[browser suite](../testing/local.md#console-browser-checks) proves authorization.
Reset story clears retained state.

## Keep edits while navigating

In **Pages/Agent detail → Keep Configuration edits**, **Components/Workspace →
Keep unsaved files**, **Components/Credentials → Keep authentication choices**,
and **Components/Channels → Keep Slack edits**, edit the form, visit another tab
or Namespaces, and return with Back/Forward. Check empty and invalid text, then
explicit Cancel or Reload. The Configuration story keeps deployment disabled;
workspace Save changes only the selected simulated file.

**Components/Workspace → Save needs Agent operate** is only the first denial.
**Operate answer on return** keeps that editor mounted. The preview runs the
visits: the first Logs visit records the runtime-status refusal and Workspace
files stays read-only; the next Logs visit reads a simulated operate grant and
AGENTS.md is editable on return, the Stop row shows and Configuration offers Run
diagnostics; after the edit, the following Logs visit reads a revocation, and
returning keeps that unsaved text and makes the file read-only, hides Stop and
disables Run diagnostics.
Reset story replays it. The permission changes and the runtime refusal are
simulated. A failed permission read is not this story; the page keeps the previous
answer. The controller still authorizes every write. The browser test changes the
controller's real IAM policy across the same tab visits.

In **Flows → Keep an Agent draft**, fill a default starter form, leave, and
re-enter, also after a refused Create: it returns; Cancel clears it.

In **Pages/Create Agent → Preset with an invalid field**, Use Preset names
`agent.executionMode` and keeps the chooser. **Agent creation needs an
administrator** shows the denied capability check without retry; **Capability
check failure** keeps the retry.

Use **Pages/Create Agent → Keep Preset variables** before applying a Preset and
**Keep an unsaved Preset draft** afterward. Ordinary fields survive; token inputs
clear. Revisit the Agents list to check its search filter. Denied, loading,
missing-file, and uncertain-write stories verify retention never bypasses the
editor's access or recovery controls.

<a id="choose-and-switch-revision-secrets" class="anchor-alias"></a>

## Choose and switch version Secrets

**Slack token switch** blocks Deploy until you save or reselect the saved Secret.
In **Discard an unsaved Secret choice**, that Secret isn’t listed; reload to discard unsaved edits.

**Secret list denied** retains IDs. **Slack grant denied** requires recovery.
In **Issued service accounts unavailable**, switch authentication methods:
account feedback hides, then returns with the saved issued-account selection.

**Components/Credentials → Parked authentication grant** opens Credentials while
the simulated Namespace IAM read is still answering, selects Configuration, then
returns with **Set up credentials**. The missing-grant warning is written on the
parked form and is visible on return; Deploy stays disabled. The delay is
simulated. The browser test holds the controller's real IAM read.

In **Components/Channels → Slack Secret menu**, search names/IDs and select with
arrows and Enter. **Slack create Secret modal** shows Name and masked value.
In **Slack duplicate Secret name**, rename and retry without reentering the value;
browser tests cover controller rejection.

<a id="inspect-bound-secrets-in-revisions" class="anchor-alias"></a>

## Inspect bound Secrets in versions

In **Components/Channels → `Revision read only`**, inspect Slack Secret identities;
switch to **Configuration** for Harness authentication. Values never appear.

The **`Revision Secret metadata`** denied, missing, and loading stories retain IDs
during failed or pending reads.
**`Revision without Slack bindings`** shows **No Secret bound**.

## Discover and configure plugins

Plugin stories simulate catalogs, Secret metadata, and policy capabilities; they
do not prove installation, invocation access, runtime enforcement, or live Agent
turns.

In **Create Agent / Discover plugins with a service account token**, expand
**Access and credential setup** and inspect its links. Collapse it; at 390×844
and 390×640, check scrolling and reachable pagination. **Add Calendar**, edit a
tool, then **Done**: **Plugin selections JSON** shows the draft. **Search plugins**
queries the catalog; **Filter tools** filters locally. Credential changes clear
the catalog and keep selections.

**Preload plugins after entering a service account token** starts with the picker
closed; opening it reuses the background request. **Plugin search loading** holds
the response: loading starts while typing, keeps focus, and replaces empty-result
feedback. **Plugin tools loading** holds Calendar's details: check loading status
and disabled **Add Calendar**. Reset to replay pending states before timeout.

In **Discover plugins with a selected PAT Secret**, choose Calendar, then change
the Secret: discovery clears. **Selected PAT Secret discovery denied** previews
permission failure. Preset PAT Secrets enable discovery; API keys do not.

**Components/Plugins → Unavailable reason popover** covers keyboard access,
dismissal, compact rows, help links, detail guidance, and disabled **Add**.

In **Components/Plugins**, expand a tool to inspect inherited enablement and
approval. Where per-tool review is unsupported (Codex), the reviewer shortcut
opens the plugin default. New plugins omit tool defaults; an omitted reviewer
inherits the Harness reviewer. **Unsupported saved tool reviewer** stays visible
and can be cleared to inherit. Tool IDs match the JSON keys.

**Create Agent / Edit existing plugin policies** exercises the policy form.

**Pages/Agent detail → Edit plugins in new version** starts with Calendar saved;
**Plugins** preloads the catalog with its Service Accounts Secret. In **Configure
plugins**, add Documents, change Calendar's policy, save, and deploy. The deployment details show the saved plugin settings.

## Update

Compare **New version in progress** (v7 deploying) with **Current version during
deployment** (v6 current). Check queued, failed, activated, and unavailable states.
In **First version**, wrapped lines align under each step, not its number.

Press Enter on **Deploy new version**. Focus moves to “Deploying…”, then:

- **Deployment refused before admission:** back to Deploy, enabled and described by the refusal.
- **Deployment outcome unknown:** to “Outcome unknown.” Deploy stays disabled; inspect the saved state before retrying.

Open v7 Logs from **New version failed**, then go Back. At 390px, the selected
tab and log rows stay visible. [Lose and regain log or Pod access](../../scripts/console-storybook/runtime-access-workflow.md)
to check Follow, Download, and permission changes. These stories use simulated responses.

Unreadable Configuration does not hide version metadata. Check the [draft and
version banners](../../scripts/console-storybook/unreadable-configuration-workflow.md)
and their navigation.

**Current observations** starts without a request. Compare v7, unknown v6, and
unavailable observations: requesting timestamped diagnostics must not change the
recorded deployment result.

In **Components/Channels** and **Components/Credentials**, an unknown write
outcome disables deployment until **Reload draft**. Whether the write committed is still unknown.

Browsing never deploys. Deploy credential changes; workspace edits apply immediately.
Native JSON omits Agent-owned Backend and execution mode. See [versions and Slack
sender access](../reference/console/versions-and-channel-drafts.md).

In **Collaboration and safety**, Strict mode stages both locked-down values in the
Configuration JSON and keeps focus; the viewer story shows every toggle unavailable.
None proves a deployed Gateway's steering.

In **Enable gateway password access**, Cancel discards the staged reference.
To apply it, save Configuration, then deploy. Compare configured, save-denied,
and save-in-progress stories; none proves credential delivery or login.

## Stop

Open **Stop Agent**, inspect or cancel the confirmation, then confirm. The
fixture records the requested stopped state; **Refresh stop status** rereads it
without proving live shutdown.

In **Components/Stop Agent → Deletion discovered**, refresh stop status to see
the deletion recovery controls and focus move to **Refresh deletion status**.

Resume by deploying a new version; disabling Slack does not stop an Agent. See
[Stop and resume](../reference/agents/deployment.md#stop-and-resume).

## Delete

Open **Delete Agent**; inspect, cancel, or confirm permanent deletion. The UI
enters cleanup state without editing/deployment controls.
**Refresh deletion status** completes the fixture and returns to the Agent list.
The console has no detailed cleanup-progress view. Namespace-owned Configurations
and Secrets remain; manage them separately. See
[Agent deletion](../reference/agents.md#deletion).

Serving health, routing cutover, real shutdown, channel delivery, and model
responses require runtime verification outside Storybook. The console shows
persisted deployment status, not live serving health.
