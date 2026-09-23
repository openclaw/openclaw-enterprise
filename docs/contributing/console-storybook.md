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

## Pages and components

The sidebar contains these groups. Stories with open dialogs or errors reach
those states by interacting with the real controls after loading fixture data.

| Group                   | Coverage                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign in                 | Signed out, rejected login, expired session, session-read failure, loading, unconfirmed logout.                                                                                                                                                  |
| Agents                  | Populated and empty collections, no search matches, inaccessible Namespace, no readable Namespaces, permission denial, read failure, loading.                                                                                                    |
| Providers               | Configured, empty, and discovery failure.                                                                                                                                                                                                        |
| Namespaces              | Ready and provisioning, empty, permission denial.                                                                                                                                                                                                |
| Settings and navigation | Signed-in account and unknown route.                                                                                                                                                                                                             |
| Create Agent            | Preset selection and variables, no Presets, dedicated and embedded forms, seeded workspace files, OpenAI and Anthropic key entry, storage and grant denial, invalid JSON, partial save with conflict, unknown save outcome.                      |
| Agent detail            | New revision, native JSON editor, invalid JSON, admitted snapshot, queued or failed deployment, denied deployment, missing Agent, unavailable Configuration and revision history.                                                                |
| Navigation components   | Account menu, Namespace switcher, mobile drawer, OCE branding, simulated OCC revision, missing development metadata.                                                                                                                             |
| Channels                | Unconfigured cards, Slack editor with pairing/open/disabled policies, unsupported Slack shape, read-only snapshot, save conflict.                                                                                                                |
| Credentials             | Stored and missing metadata, masked Slack tokens, one-token replacement, partially missing tokens, generated credentials locked after admission, metadata failure, missing authentication, operator-managed credentials, issued ChatGPT account. |
| Native admin            | Available launch, stopped or unsupported runtime, denied panel hidden. The launch target is an explanatory fixture page.                                                                                                                         |
| Workspace               | Four editable deployed files, undeployed Agent, denied reads, missing file, unknown write outcome.                                                                                                                                               |
| Stop Agent              | Confirmation, stopped requested state, permission denial, unknown outcome requiring refresh.                                                                                                                                                     |
| Deletion                | Confirmation, pending cleanup, permission denial, conflict, unknown outcome.                                                                                                                                                                     |

The production UI supplies buttons, forms, tables, badges, notices, JSON views,
revision controls, and dialogs inside these stories. Storybook does not duplicate
those components. Pending-read stories use the real client's 15-second timeout;
reset them to replay loading.

## Agent flows and UI gaps

Each flow includes steps above an interactive console frame.

### Create and deploy

Choose a Preset, fill its variables, review the seeded workspace files, and
create a Dedicated Agent. The Console submits its inline Configuration and saved
Secret references, follows simulated provisioning and deployment activation, and
opens Workspace files for the returned revision. A separate flow starts without
a Preset, enters a dummy OpenAI API key or Service Accounts token, selects a model, edits
IDENTITY.md, and clears USER.md before creation. Embedded and unsupported-runtime
stories retain the draft workflow: provision credentials and deploy from Agent detail.
These transitions demonstrate presentation only; they do not prove a worker ran.

The fixture supplies a ready Namespace, Preset, and model Secret. Namespace
provisioning, Preset CRUD, and service-account issuance have no console pages.
Create Agent discovers model choices after key entry, with empty-list and error
states offering manual model entry. Discovery uses synthetic model lists in
Storybook. Saving stores entered model keys through the existing Secret API and
grants the new Agent access. The stories simulate those writes; browser/API
integration tests verify their real route and permission behavior.
Slack tokens can be saved in Credentials after Agent creation. Teams credentials
remain operator-managed; the console blocks deployment while Teams is enabled.
See [Create and deploy in the console](../reference/console/create-and-deploy.md)
for the supported installation workflow and prerequisites.

### Update

Use **Edit Configuration** on the new revision to change native JSON, or edit
Slack through Channels. Save and compare the draft with the original revision.
Deploy again to admit a new snapshot. The fixture retains both versions.
Credential edits likewise need deployment to affect managed runtime configuration.
Workspace-file writes apply immediately and do not create a revision.

Native JSON editing changes Configuration values, not Agent-owned Provider or
execution-mode fields. The Slack drawer preserves existing access policies; it
does not provide a policy selector. See [Agent revisions](../guides/topics/agent-revisions.md).

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
