# Console Storybook

Browse production Console pages, components, and Agent workflows against an
in-memory fixture. Previews contact no services and run no workloads. Use dummy
credentials.

## Run locally

From the repository root, with Node.js 24+ and the pinned pnpm version:

```sh
npm run storybook:install
npm run storybook
```

Open `http://127.0.0.1:6006`. Each story starts an independent fixture, ignoring
existing Installations and other tabs' sessions; **Reset story** discards its
changes.

To build and serve a static copy:

```sh
npm run storybook:build
python3 -m http.server 6006 --bind 127.0.0.1 \
  --directory scripts/console-storybook/dist/site
```

Serve at the origin root for absolute `/console/` URLs. Build fingerprints keep
cached fixture pages and module imports current. CI uploads a static artifact
without publishing the documentation site.

## Appearance review

Use **Pages/Agents → Populated** to review the shared shell and controls at
desktop (1440 × 1000), tablet (768 × 1024), and mobile (390 × 844).
Check keyboard focus, search, navigation, an open dialog, and empty, loading,
error, permission-denied, and missing-credential stories. The console stays light
with either system appearance preference.

The Claw palette, type scale, and surface geometry reference
[OpenClaw `6e8d06876fd166064abbec4928fb3bb109ebe999`](https://github.com/openclaw/openclaw/tree/6e8d06876fd166064abbec4928fb3bb109ebe999/ui),
particularly `src/styles/base.css`, `layout.css`, and `components.css`.
OCE keeps its own navigation and workflows. Input borders are stronger than
the reference's decorative dividers so controls stay distinguishable. The
self-hosted Instrument Sans subset keeps its SIL Open Font License beside
the font; unsupported glyphs use the system fallback.

Compare [before](../assets/console-style/agents-before.png),
[after](../assets/console-style/agents-1440-light.png),
[mobile](../assets/console-style/mobile-390-light.png), and the
[walkthrough](../assets/console-style/walkthrough.mp4): simulated Storybook
evidence, not live backend or deployment proof. The
[reference screen](../assets/console-style/openclaw-reference-light.png) shows
OpenClaw's disconnected gateway screen at the revision above.

## Pages and components

Stories reach error states through real controls after loading fixture data.

| Group                   | Coverage                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in                 | Password and GitHub sign-in, discovery failure, GitHub errors, rejected login, expired session, session-read failure, loading, unconfirmed logout.                                                                                                                                                                                                                                                                |
| Agents                  | Populated and empty collections, no search matches, inaccessible Namespace, no readable Namespaces, permission denial, read failure, loading.                                                                                                                                                                                                                                                                     |
| Backends                | Configured, empty, and discovery failure.                                                                                                                                                                                                                                                                                                                                                                         |
| Namespaces              | Ready and provisioning, empty, permission denial.                                                                                                                                                                                                                                                                                                                                                                 |
| Settings and navigation | Signed-in account and unknown route.                                                                                                                                                                                                                                                                                                                                                                              |
| Create Agent            | Installed default, missing/loading/denied Presets, Preset variables, fixed model choices before credential entry and manual model IDs, OpenAI Codex/OpenClaw and Anthropic OpenClaw harnesses, Service Accounts switching and bound Presets, seeded workspace files, storage/grant denial, repository selection/discovery and rejected-grant recovery, invalid JSON, partial save/conflict, unknown save outcome. |
| Agent detail            | First and later drafts, version details, native JSON and plugin editors, immutable plugin snapshot, queued/running/succeeded/failed activity, exact-version diagnostics, error and permission states.                                                                                                                                                                                                             |
| Navigation components   | Account menu, Namespace switcher, mobile drawer, admin link and denial, OCE branding, simulated OCC revision, missing development metadata, debug runtime image identities and unavailable metadata.                                                                                                                                                                                                              |
| Channels                | Unconfigured cards, Slack editor with pairing/open/disabled policies, everyone and restricted channel sender access, incomplete sender access, unsupported mixed sender lists, unsupported wildcard channel maps, read-only snapshot, save conflict.                                                                                                                                                              |
| Credentials             | Named Secret selection and creation, API-key and Slack Secret switching, denied metadata and grants, partially missing tokens, missing authentication, operator-managed credentials, issued ChatGPT account, model Secret replacement, pending grants, and unknown authentication saves.                                                                                                                          |
| Native admin            | Available launch, stopped or unsupported runtime, denied panel hidden. The launch target is an explanatory fixture page.                                                                                                                                                                                                                                                                                          |
| Workspace               | Four editable deployed files, undeployed Agent, denied reads, missing file, unknown write outcome.                                                                                                                                                                                                                                                                                                                |
| Stop Agent              | Confirmation, stopped requested state, permission denial, unknown outcome requiring refresh.                                                                                                                                                                                                                                                                                                                      |
| Deletion                | Confirmation, pending cleanup, permission denial, conflict, unknown outcome.                                                                                                                                                                                                                                                                                                                                      |

Pending-read stories use the real client's 15-second timeout; reset them to replay
loading.

## Return navigation

Use **Pages/Navigation → Return to loaded pages** and **Return to Agent panels**.
Search, expanded configuration, native admin access, and Credentials should survive
Back/Forward and tab changes. Refresh reloads.

## Agent flows and UI gaps

In **Components → Navigation → Namespace switcher**, switch Engineering/Research
and check URL, collection, and Back behavior. **Mobile Namespace selector** checks
long names and direct switching. In **Mobile drawer**, widen past 760px while open:
Agents search must work without Escape. Shrink and check reopening and dismissal.
No-readable, unavailable, loading, and denied stories cover restrictions.

In **Pages → Namespaces → Unavailable selection**, recover inline and check the
URL, dismissed warning, unchanged page, and Back navigation. **Unavailable selection
mobile** repeats this at 390px; **Unavailable selection without access** shows access
guidance. Simulated examples:
[desktop](../assets/console-namespace-recovery/desktop.png),
[mobile](../assets/console-namespace-recovery/mobile.png),
[recovered](../assets/console-namespace-recovery/recovered.png),
[no access](../assets/console-namespace-recovery/no-access.png),
[walkthrough](../assets/console-namespace-recovery/walkthrough.webm),
[desktop selector](../assets/console-namespace-selector/desktop.png),
[mobile empty collection](../assets/console-namespace-selector/mobile.png),
[Namespaces page without a selector](../assets/console-namespace-selector/namespaces.png),
and a [switching walkthrough](../assets/console-namespace-selector/namespace-switching.webm).

### Create and deploy

Compare **New version queued**, **Deployment waiting for runtime**, and
**Deployment retry after dependency failure**; switch versions and check
**Since**.

**First deployment creates credentials** accepts **Deploy new version** without
a separate credential action. Its initial state is not a Stop request; OCC
generation is simulated.

Choose a Preset, fill its variables, review seeded workspace files, and create
an Agent with the Codex harness. The Console submits inline Configuration and
Secret references, then follows simulated provisioning. A separate flow uses
the default Preset with OpenAI Codex, a new or existing model Secret, and a
model, editing IDENTITY.md and clearing USER.md before creation.
OpenClaw and unsupported-runtime stories keep the draft workflow: provision
credentials and deploy from Agent detail.

**Plugins Curated** exercises token-free discovery against simulated Driver responses,
leaving access unverified. Hosted discovery requires an eligible Codex
service-account token. Workspace and Standard OpenClaw stories preview file and
harness settings. Preset Secret stories cover existing, pending, denied, and
empty results while keeping new-token entry.

The [DevDay storyboard](../../scripts/console-storybook/devday-storyboard.md)
gives presenter actions, expected visible states, and fallbacks for creating an
Agent from the SWE Agent Preset and opening the deployed `oceclaw` Agent's
simulated Admin UI, which connects to no gateway, Slack, credential, or model.

**Choose provider, harness, and authentication** covers the supported
combinations; models appear before credentials. **Enter another model ID**
allows manual entry but does not prove access. Execution mode follows the
harness; saved tokens require Codex. **Experimental Dedicated OpenClaw** shows
the runtime-build warning; Embedded OpenClaw does not.

In **Enter another model ID**, switch to **Choose a model from the list** and
back. Check that listed models survive both switches, focus moves to the active
input, and other settings are preserved. Edit the manual ID to another listed
model and confirm that returning selects it. A custom ID outside the list must
instead require a new selection. After changing the provider through Configuration
JSON, verify that the list matches and never retains a model from the old provider.

The fixture supplies a ready Namespace, Preset, and model Secret. Namespace
provisioning, Preset CRUD, and service-account issuance have no dedicated console
pages. New version model Secrets and Slack tokens (Credentials tab and Channels
drawer) are selected or created through one Secret picker.
See [Create and deploy in the console](../reference/console/create-and-deploy.md)
for the supported installation workflow, prerequisites, and Teams deployment limits.

Repository previews cover access levels, empty or pending discovery, unavailable
choices, denied or unverified authorization, and reselection after a rejected save.
In **Repository choices unavailable**, follow the setup link or retry; creation
without repository access remains available. The recovery story keeps its saved
Configuration and requires a current nonempty repository selection before retrying.
The fixture does not verify operator prerequisites: GitHub App setup, Namespace
approvals, runtime images, and credential-service networking.

### Return to loaded pages

In **Return to loaded pages**, Tab to Namespaces and press Enter: its heading
receives focus, then Tab reaches Refresh. Check retained editors through
Back/Forward, Refresh, refocus, and Namespace switches.

**Return Backend access denied** checks Installation-wide denial. **Return access denied** and **Return session expired** must remove retained private
content when the response arrives. These fixtures prove presentation only; the
[browser suite](../testing/local.md#console-browser-checks) proves authorization.
Reset story clears retained state.

### Keep edits while navigating

In **Pages/Agent detail → Keep Configuration edits**, **Components/Workspace →
Keep unsaved files**, **Components/Credentials → Keep authentication choices**,
and **Components/Channels → Keep Slack edits**, edit the form, visit another tab
or Namespaces, and return with Back/Forward. Check empty and invalid text, then
explicit Cancel or Reload. The Configuration story keeps deployment disabled;
workspace Save changes only the selected simulated file.

In **Flows → Restart Agent creation**, enter a default starter form, leave, and
confirm re-entry shows the initial choices and an empty form.

In **Pages/Create Agent → Preset with an invalid field**, Use Preset names
`agent.executionMode` and keeps the chooser. **Agent creation needs an
administrator** shows the denied capability check without a retry; **Capability
check failure** keeps the retry.

Use **Pages/Create Agent → Keep Preset variables** before applying a Preset and
**Keep an unsaved Preset draft** afterward. Ordinary fields survive; token
inputs clear. Revisit the Agents list to check its search filter. Denied,
loading, missing-file, and uncertain-write stories verify that retention does not
bypass the editor's access or recovery controls.

### Choose and switch revision Secrets

In **Components / Credentials / Slack tokens stored**, inspect references, cancel
creation, then switch app tokens; the bot binding stays unchanged. The API-key
switch offers another model Secret.

**Secret list denied** retains IDs. **Slack grant denied** requires recovery.
In **Issued service accounts unavailable**, switch authentication methods:
account feedback hides and returns with the saved issued-account selection.

In **Components/Channels → Slack Secret menu**, search names/IDs and select with
arrows and Enter. **Slack create Secret modal** shows Name and masked value.
In **Slack duplicate Secret name**, rename and retry without reentering the value;
browser tests cover controller rejection.

### Inspect bound Secrets in revisions

In **Components/Channels → Revision read only**, inspect Slack Secret identities;
switch to **Configuration** for Harness authentication. Values never appear.

**Revision Secret metadata denied**, **Revision Secret metadata missing**, and
**Revision Secret metadata loading** retain IDs during failed or pending reads.
**Revision without Slack bindings** shows **No Secret bound**.

### Discover and configure plugins

Plugin stories use simulated catalogs, Secret metadata, and policy capabilities;
they do not prove installation, invocation access, runtime enforcement, or live
Agent turns.

In **Create Agent / Discover plugins with a service account token**, expand
**Access and credential setup** and inspect its links. Collapse it; at 390×844
and 390×640, check scrolling and reachable pagination. **Add Calendar**, edit a
tool, then **Done**: **Plugin selections JSON** shows the draft. **Search plugins**
queries the catalog; **Filter tools** filters locally. Credential changes clear
the catalog and keep selections.

**Preload plugins after entering a service account token** starts with the picker
closed; open it to reuse the background request. **Plugin search loading** holds
the response: loading starts while typing, keeps focus, and replaces empty-result
feedback. **Plugin tools loading** holds Calendar's details: check its loading
status and disabled **Add Calendar**. Reset to replay pending states before
timeout.

In **Discover plugins with a selected PAT Secret**, choose Calendar, then change
the Secret to clear discovery. **Selected PAT Secret discovery denied** previews
permission failure. Preset PAT Secrets enable discovery; API keys do not.

**Components/Plugins → Unavailable reason popover** covers keyboard access,
dismissal, compact rows, help links, detail guidance, and disabled **Add**.

In **Components/Plugins**, expand a tool to inspect inherited enablement and
approval. Where per-tool review is unsupported, as in Codex, the reviewer shortcut
opens the plugin default. New plugins omit tool defaults; an omitted reviewer
inherits the Harness reviewer. **Unsupported saved tool reviewer** remains visible
and can be cleared to inherit. Tool IDs match the JSON keys.

**Create Agent / Edit existing plugin policies** exercises the policy form.

**Pages/Agent detail → Edit plugins in new version** starts with Calendar saved.
**Plugins** preloads the catalog using its Service Accounts Secret. In **Configure
plugins**, add Documents, change Calendar's policy, save, and deploy. **Plugins in
admitted revision** shows the frozen snapshot.

### Update

**New version in progress** shows v7 deployment work while v6 stays current;
**Current version during deployment** opens v6 details while activity follows
v7. Compare queued, failed, activated, and unavailable activity stories.
In **First version**, resize the preview: each preparation step keeps its own
row and continuation lines align under the text.

Use **New version failed** and **Failed deployment logs from draft** to check
focused v7 Logs, output or denial, and Back. In **Runtime status and logs for v7**,
exercise source, instance, debug, fields, Follow, and filters. At 390px, check
readable rows and visible selected tabs through direct routes and Back/Forward.
These fixtures prove presentation, not live reads.

Version metadata stays visible when saved settings are unreadable. Follow the
[walkthrough](../../scripts/console-storybook/unreadable-configuration-workflow.md)
in **Unreadable Agent draft** and **Unreadable revision snapshot** to check
banner scope and navigation.

**Current observations** starts unrequested; compare
**Current observations for v7**, **Unknown observation for v6**, and
**Current observation unavailable**. Clicking requests timestamped diagnostics
for that version without changing its recorded deployment result.

Outcome-unknown stories in **Components/Channels** and **Components/Credentials**
disable deployment until **Reload draft**; they cannot prove a write committed.

Browsing does not deploy. Credentials need deployment; workspace writes apply
immediately. Native JSON excludes Agent-owned Backend and execution mode.
[Revisions and channel drafts](../reference/console.md#inspect-detail-revisions-and-channel-drafts)
defines version deployment and Slack sender access.

**Enable gateway password access** stages a reference. Cancel discards it; Save
Configuration, then Deploy new version applies it. Compare **Gateway password access configured**, **Gateway
password save denied**, and **Gateway password save in progress**. These stories
do not prove credential delivery or login.

### Stop

Open **Stop Agent**, inspect or cancel the confirmation, and confirm the stop.
The fixture records the requested stopped state; **Refresh stop status** rereads
it but does not prove live shutdown.

Resume by deploying a new version; disabling Slack does not stop an Agent. See
[Stop and resume](../reference/agents/deployment.md#stop-and-resume).

### Delete

Open **Delete Agent**, inspect or cancel the confirmation, and confirm permanent
deletion. The UI enters cleanup state without editing/deployment controls.
**Refresh deletion status** completes the fixture and returns to the Agent list.
The console has no detailed cleanup-progress view. Namespace-owned Configurations
and Secrets remain and require separate management. See
[Agent deletion](../reference/agents.md#deletion).

Serving health, routing cutover, real shutdown, channel delivery, and model
responses require runtime verification outside Storybook. The console shows
persisted deployment status, not live serving health.

## Maintain coverage

`scripts/console-storybook/` installs from its own manifest and lockfile under the
repository's seven-day release-age policy, independently of root dependencies.

- `prepare-assets.mjs` copies the current console assets and the shared contract
  modules served by the controller into ignored `dist/assets/`. Rebuild after
  source edits; the development server does not recopy console sources.
- `public/scenarios.mjs` owns story descriptions, initial data options, failure
  responses, automatic setup actions, and workflow instructions.
- `public/fixtures.mjs` intercepts API calls inside the preview. Unconfigured
  requests report an error and return 501; they never fall through to a server.
  Preview CSP also blocks network connections. Authentication and authorization
  responses are examples, not a security implementation.
- `public/frame.mjs` starts the production console and opens configured controls.
- `*.stories.mjs` exports named stories by group; `story.mjs` adds instructions,
  UI-gap notices, the preview, and Reset story.

Update scenarios and instructions with console changes, exporting new scenarios
from their owning story file. Configure API responses; the console owns failure
messages and UI markup.

## Debug image walkthrough

Open **Pages / Navigation / Debug runtime images**, expand an Agent, and inspect
the gateway image reference, digest, Enterprise source commit, and separate upstream
OpenClaw commit. The sidecar has unknown provenance for both commits.
Navigate to Namespaces, confirm `debug=true` persists, and repeat in the mobile
drawer. **Debug metadata unavailable** covers a failed read; ordinary navigation
stories hide diagnostics. Docker image inspection and the Kubernetes API/worker
integration suite, not these fixtures, verify Driver behavior.

### Slack reply and DM policy checks

In **Components/Channels → Slack Threaded Default**, save a new
channel-only setup with DMs disabled and inspect its native Configuration.
**Slack Reply Override** must preserve an existing `replyToMode: "off"`.
In **Slack Dm Policy**, exercise an empty Allowlist error, save explicit DM
sender IDs, then switch through Open, Disabled, and Pairing. Reopen the editor
after saving and verify channel senders stay unchanged. **Slack Enterprise Dm**
shows organization-wide policy restrictions. Missing-credential, read-only, and
save-failure stories cover the surrounding states.
Capture the final interactions and native values outside the repository;
attach reviewable screenshots and video to the task and PR.
