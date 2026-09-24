# Console Storybook

Browse the console's pages, component states, and Agent workflows without starting
OCC or a cluster. Storybook uses the production console modules and styles with
an isolated, in-memory API fixture for each preview. It does not deploy workloads,
contact Providers, or verify runtime behavior. Use only dummy credentials.

## Run locally

From the repository root, with Node.js 24+ and the pinned pnpm version:

```sh
npm run storybook:install
npm run storybook
```

Open `http://127.0.0.1:6006`. Use **Reset story** to discard changes. Selecting a
new story starts an independent fixture. Installations and browser sessions in
other tabs are not used.

To build and serve a static copy:

```sh
npm run storybook:build
python3 -m http.server 6006 --bind 127.0.0.1 \
  --directory scripts/console-storybook/dist/site
```

Serve this build at its own origin's root. The console uses absolute `/console/`
URLs. Reload with **Reset story**, not the embedded frame's current console URL.
The Storybook build workflow also uploads a static artifact; it does not publish
or change access to the documentation site.

## Appearance review

Use **Pages/Agents → Populated** to review the shared shell and controls.
Check desktop (1440 × 1000), tablet (768 × 1024), and mobile (390 × 844);
use keyboard focus, search, navigation, and an open dialog. Include empty,
loading, error, permission-denied, and missing-credential stories. The console
stays light with either system appearance preference.

The console's Claw palette, type scale, and surface geometry reference
[OpenClaw `6e8d06876fd166064abbec4928fb3bb109ebe999`](https://github.com/openclaw/openclaw/tree/6e8d06876fd166064abbec4928fb3bb109ebe999/ui),
particularly `src/styles/base.css`, `layout.css`, and `components.css`.
OCE retains its own navigation and workflows. Input borders are stronger than
the reference's decorative dividers to keep controls distinguishable. The
self-hosted Instrument Sans subset retains its SIL Open Font License beside
the font; unsupported glyphs use the system fallback.

The styling comparison includes [before](../assets/console-style/agents-before.png),
[after](../assets/console-style/agents-1440-light.png),
[mobile](../assets/console-style/mobile-390-light.png), and a
[walkthrough](../assets/console-style/walkthrough.mp4). These are simulated
Storybook UI evidence, not live backend or deployment proof. The
[reference screen](../assets/console-style/openclaw-reference-light.png) is the
actual OpenClaw disconnected gateway screen at the revision above.

## Pages and components

The sidebar contains these groups. Stories with open dialogs or errors reach
those states by interacting with the real controls after loading fixture data.

| Group                   | Coverage                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in                 | Signed out, rejected login, expired session, session-read failure, loading, unconfirmed logout.                                                                                                                                                                                                                                                                            |
| Agents                  | Populated and empty collections, no search matches, inaccessible Namespace, no readable Namespaces, permission denial, read failure, loading.                                                                                                                                                                                                                              |
| Providers               | Configured, empty, and discovery failure.                                                                                                                                                                                                                                                                                                                                  |
| Namespaces              | Ready and provisioning, empty, permission denial.                                                                                                                                                                                                                                                                                                                          |
| Settings and navigation | Signed-in account and unknown route.                                                                                                                                                                                                                                                                                                                                       |
| Create Agent            | Preset variables, no Presets, fixed model choices before credential entry and manual model IDs, OpenAI Codex/OpenClaw and Anthropic OpenClaw harnesses, Service Accounts switching and bound Presets, seeded workspace files, storage/grant denial, repository selection/discovery and rejected-grant recovery, invalid JSON, partial save/conflict, unknown save outcome. |
| Agent detail            | New revision, native JSON editor, invalid JSON, admitted snapshot, queued or failed deployment, denied deployment, missing Agent, unavailable Configuration and revision history.                                                                                                                                                                                          |
| Navigation components   | Account menu, Namespace switcher, mobile drawer, OCE branding, simulated OCC revision, missing development metadata, debug runtime image identities and unavailable metadata.                                                                                                                                                                                              |
| Channels                | Unconfigured cards, Slack editor with pairing/open/disabled policies, everyone and restricted channel sender access, incomplete sender access, unsupported mixed sender lists, unsupported wildcard channel maps, read-only snapshot, save conflict.                                                                                                                       |
| Credentials             | Stored and missing metadata, masked Slack tokens, one-token replacement, partially missing tokens, generated credentials locked after admission, metadata failure, missing authentication, operator-managed credentials, issued ChatGPT account.                                                                                                                           |
| Native admin            | Available launch, stopped or unsupported runtime, denied panel hidden. The launch target is an explanatory fixture page.                                                                                                                                                                                                                                                   |
| Workspace               | Four editable deployed files, undeployed Agent, denied reads, missing file, unknown write outcome.                                                                                                                                                                                                                                                                         |
| Stop Agent              | Confirmation, stopped requested state, permission denial, unknown outcome requiring refresh.                                                                                                                                                                                                                                                                               |
| Deletion                | Confirmation, pending cleanup, permission denial, conflict, unknown outcome.                                                                                                                                                                                                                                                                                               |

The production UI supplies buttons, forms, tables, badges, notices, JSON views,
revision controls, and dialogs inside these stories. Storybook does not duplicate
those components. Pending-read stories use the real client's 15-second timeout;
reset them to replay loading.

## Agent flows and UI gaps

Each flow includes steps above an interactive console frame.

### Create and deploy

Choose a Preset, fill its variables, review the seeded workspace files, and
create an Agent with the Codex harness. The Console submits its inline Configuration
and saved Secret references, follows simulated provisioning and deployment
activation, and opens Workspace files for the returned revision. A separate flow
starts without a Preset, selects OpenAI with Codex, enters a dummy API key or service account
token, selects a model, edits IDENTITY.md, and clears USER.md before creation.
OpenClaw and unsupported-runtime stories retain the draft workflow: provision
credentials and deploy from Agent detail. These transitions demonstrate
presentation only; they do not prove a worker ran.

**Choose provider and harness** walks through the OpenAI Codex default, OpenClaw
selection, Anthropic's OpenClaw-only choice, and switching from an unsaved service account
token to API-key authentication. Model choices are hardcoded in the Console and
available before credential entry; **Enter another model ID** covers manual entry.
These choices do not establish whether a credential can access a model. Execution mode follows the harness. The saved-token
Preset story shows why its harness is fixed to Codex.

The fixture supplies a ready Namespace, Preset, and model Secret. Namespace
provisioning, Preset CRUD, model-Secret creation, and service-account issuance
have no console pages. The model API-key field takes an existing Secret ID.
Slack tokens can be created and selected in the Slack drawer under Channels.
Teams credentials remain operator-managed; the console blocks deployment while Teams is enabled.
See [Create and deploy in the console](../reference/console/create-and-deploy.md)
for the supported installation workflow and prerequisites.

Repository previews cover shared access levels, empty or pending discovery,
optional service unavailability, denied or unverified authorization, and reselection
after a rejected save. The recovery story retains its saved Configuration and
requires a current nonempty repository selection before retrying. GitHub App
setup, Namespace approvals, runtime images, and credential-service networking
remain operator prerequisites; the fixture does not verify them.

### Discover and configure plugins

**Create Agent / Discover plugins with a service account token** uses a dummy
token and simulated OCC discovery routes. Open **Configure plugins**, browse the
pages, and select Calendar to load its details. **Add Calendar** exposes plugin
policies; expand a tool row to edit an override. **Done** returns to the form,
where **Plugin selections JSON** shows the draft. **Filter this page** searches
only the current page. Replacing the token or switching authentication, provider,
or Harness clears the catalog while preserving selections. Companion stories
cover empty results, pending reads, rejected tokens, service failures, tool lookup
errors, and the next page.

Discovery requires an entered Service Accounts token with the Codex Harness;
saved Preset credentials and API keys do not enable it. Fixtures provide the
capability descriptor used by the editor. Catalog visibility does not establish
that a plugin or tool can be invoked.

**Components/Plugins** covers the modal with simulated catalogs and capabilities:
available plugins, selected overrides, unknown tools, and empty, loading, denied,
and capability-unavailable states. Select a plugin, expand a tool row, and inspect
its enablement, approval, and reviewer fields. Each field inherits independently.
Adding a plugin leaves its tool defaults omitted. Reviewer omission inherits the
Harness reviewer, and automatic review can deny a call. The Codex fixture offers
reviewer selection at the plugin default scope only. **Unsupported saved tool
reviewer** keeps an unsupported override visible and lets you clear it to inherit.

**Create Agent / Edit existing plugin policies** exercises that editor in the
actual form with simulated policy capabilities. These previews do not verify live
plugin-service access, installation, or policy enforcement by a runtime.

### Update

Use **Edit Configuration** on the new revision to change native JSON, or edit
Slack through Channels. Save and compare the draft with the original revision.
Deploy again to admit a new snapshot. The fixture retains both versions.
Credential edits likewise need deployment to affect managed runtime configuration.
Workspace-file writes apply immediately and do not create a revision.

Native JSON editing changes Configuration values, not Agent-owned Provider or
execution-mode fields. The Slack drawer preserves existing access policies; it
does not provide a policy selector. Its channel sender controls edit per-channel
`users` lists, including `users: ["*"]` for everyone, while direct-message
`allowFrom` stays unchanged. See [Agent revisions](../guides/topics/agent-revisions.md).

### Stop

Open **Stop Agent**, inspect or cancel the confirmation, and confirm the stop.
The fixture records the requested stopped state. **Refresh stop status** rereads
that metadata. The story demonstrates the controls and request handling; it does
not run a Compute Driver or prove live shutdown.

Resume with **New revision** → **Deploy new revision**, creating a new revision.
Disabling Slack does not stop an Agent. See
[Stop and resume](../reference/agents/deployment.md#stop-and-resume).

### Delete

Open **Delete Agent**, inspect or cancel the confirmation, and confirm permanent
deletion. The UI enters cleanup state and removes editing/deployment controls.
**Refresh deletion status** completes the fixture and returns to the Agent list.
The console has no detailed cleanup-progress view. Namespace-owned Configurations
and Secrets remain and require separate management. See
[Agent deletion](../reference/agents.md#deletion).

Serving health, completed routing cutover, real shutdown, channel delivery, and
model responses require runtime verification outside Storybook. The console displays persisted deployment status without a live serving-health indicator.

## Maintain coverage

The isolated tool lives in `scripts/console-storybook/` and has its own manifest,
lockfile, and dependency installation. It uses the same seven-day dependency
release-age policy as the repository. Root workspace dependencies are unchanged.

- `prepare-assets.mjs` copies the current console assets and the shared contract
  modules served by the controller into ignored `dist/assets/`. Run the build
  again after source edits; the development server does not automatically recopy
  console source files.
- `public/scenarios.mjs` owns story descriptions, initial data options, failure
  responses, automatic setup actions, and workflow instructions.
- `public/fixtures.mjs` intercepts API calls inside the preview. Unconfigured
  requests report an error and return 501; they never fall through to a server.
  Preview CSP also blocks network connections. Authentication and authorization
  responses are examples, not a security implementation.
- `public/frame.mjs` starts the production console and opens configured controls.
- `*.stories.mjs` exports named stories by group; `story.mjs` adds instructions,
  UI-gap notices, the preview, and Reset story.

When changing console pages, shared components, or lifecycle controls, update the
corresponding scenarios and flow instructions in the same PR. Add an export to
the owning story file for a new scenario. Keep visible failure messages owned by
the console; configure API responses instead of writing replacement UI markup.

Build Storybook, inspect the affected previews, and walk through changed flows.
Keep backend and runtime verification in the existing code suites; a successful
storybook fixture is not evidence that the real API or infrastructure works.

## Debug image walkthrough

Open **Pages / Navigation / Debug runtime images**. Expand an Agent and inspect
the gateway image reference, digest, Enterprise source commit, and separate upstream
OpenClaw commit. The sidecar has unknown provenance for both commits.
Navigate to Namespaces and confirm `debug=true` persists. Repeat in the mobile
drawer. **Debug metadata unavailable** covers a failed read; ordinary navigation
stories keep diagnostics hidden. These are presentation fixtures; Docker image
inspection and the Kubernetes API/worker integration suite verify Driver behavior.
