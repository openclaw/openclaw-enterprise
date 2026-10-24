# Console Storybook

Browse production Console pages, components, and Agent workflows against an
in-memory fixture. Previews contact no services and run no workloads. Use dummy
credentials. To build or change a page, start with
[Console components and styles](console-ui.md).

## Run locally

From the repository root, with Node.js 24+ and the pinned pnpm version:

```sh
npm run storybook:install
npm run storybook
```

Open `http://127.0.0.1:6006`. **Reset story** discards the isolated fixture changes.

To build and serve a static copy:

```sh
npm run storybook:build
python3 -m http.server 6006 --bind 127.0.0.1 \
  --directory scripts/console-storybook/dist/site
```

Serve at the origin root for absolute `/console/` URLs. Build fingerprints keep
cached fixture pages and module imports current. CI uploads a static artifact
without publishing the documentation site.

## Write Console modules in TypeScript

Put browser code in `.mts` files and import the public `.mjs` path. TypeScript
resolves that import to the source file. `pnpm typecheck` checks it against browser
APIs and rejects syntax that needs more than type erasure.

Add the source path to the controller's allowlist in
`apps/controller/src/console-assets.ts`. The controller and Storybook both use
Node 24 to remove types, preserve line numbers, and serve JavaScript at the same
URL as before.

Node resolves imports literally, including imports inside an `.mts` file. Point
Node callers of a standalone module directly at its `.mts` source. For example,
when the starter model moves, change the first-agent scripts and test helpers to
import `agents/starter-model.mts`.
Test browser behavior through the served `.mjs` URLs, where the controller
resolves the whole module graph.

Keep a temporary source forwarder such as `dom.mjs` only while a Node caller
still reaches that exact path. Renaming the caller alone leaves the import in
place. Remove the forwarder, then run those consumers and the browser tests to
verify both paths. A browser-only module needs no forwarder.

## Appearance review

Use **Pages/Agents → Populated** to review the shared shell and controls at
desktop (1440 × 1000), tablet (768 × 1024), and mobile (390 × 844).
Check keyboard focus, search, navigation, an open dialog, and empty, loading,
error, permission-denied, and missing-credential stories. The console stays light
under either system appearance.

The Claw palette, type scale, and surface geometry reference
[OpenClaw `6e8d06876fd166064abbec4928fb3bb109ebe999`](https://github.com/openclaw/openclaw/tree/6e8d06876fd166064abbec4928fb3bb109ebe999/ui),
particularly `src/styles/base.css`, `layout.css`, and `components.css`.
OCE keeps its own navigation and workflows. Inputs have stronger borders than
the reference's decorative dividers so controls stay distinguishable. The
self-hosted Instrument Sans subset ships its SIL Open Font License beside it;
unsupported glyphs use the system fallback.

Compare [before](../assets/console-style/agents-before.png),
[after](../assets/console-style/agents-1440-light.png),
[mobile](../assets/console-style/mobile-390-light.png), and the
[walkthrough](../assets/console-style/walkthrough.mp4): simulated Storybook
evidence, not live backend or deployment proof. The
[reference screen](../assets/console-style/openclaw-reference-light.png) shows
OpenClaw's disconnected gateway screen at the commit above.

## Pages and components

Stories reach error states through real controls after loading fixture data.

| Group                                                                      | Coverage                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in                                                                    | Password and GitHub sign-in, discovery failure, GitHub errors, disabled account, rejected login, expired session, delayed session status, failure and retry, unconfirmed logout.                                                                                                                                                                                                                                  |
| Agents                                                                     | Populated, empty, no matches, loading, inaccessible Namespaces, denied or failed reads; row Stop and Delete restrictions, refusals, uncertain outcomes.                                                                                                                                                                                                                                                           |
| Backends                                                                   | Configured, empty, discovery failure, and access denied.                                                                                                                                                                                                                                                                                                                                                          |
| [Namespaces](../../scripts/console-storybook/namespace-create-workflow.md) | Creation, status cards, empty, denied, recovery.                                                                                                                                                                                                                                                                                                                                                                  |
| [Secrets](../../scripts/console-storybook/secrets-workflow.md)             | Namespace listing, search, creation, masked values, consumers, replacement, deletion, missing values, readiness, denials, conflicts, and uncertain saves.                                                                                                                                                                                                                                                         |
| Settings and navigation                                                    | Account, sign-out failure, unknown route.                                                                                                                                                                                                                                                                                                                                                                         |
| Create Agent                                                               | Installed default, missing/loading/denied Presets, Preset variables, fixed model choices before credential entry and manual model IDs, OpenAI Codex/OpenClaw and Anthropic OpenClaw harnesses, Service Accounts switching and bound Presets, seeded workspace files, storage/grant denial, repository selection/discovery and rejected-grant recovery, invalid JSON, partial save/conflict, unknown save outcome. |
| Agent detail                                                               | First and later drafts, version details, native JSON and plugin editors, immutable plugin snapshot, queued/running/succeeded/failed activity, exact-version diagnostics, error and permission states.                                                                                                                                                                                                             |
| Navigation components                                                      | Account menu, Namespace switcher, mobile drawer, admin link and denial, OCE branding, simulated OCC version, missing development metadata, debug runtime image identities and unavailable metadata.                                                                                                                                                                                                               |
| Channels                                                                   | Unconfigured cards, Slack editor with pairing/open/disabled policies, everyone and restricted channel sender access, incomplete sender access, unsupported mixed sender lists, unsupported wildcard channel maps, read-only snapshot, save conflict.                                                                                                                                                              |
| Credentials                                                                | Named Secret selection and creation, API-key and Slack Secret switching, denied metadata and grants, partially missing tokens, missing authentication, operator-managed credentials, issued ChatGPT account, model Secret replacement, pending grants, and unknown authentication saves.                                                                                                                          |
| Native admin                                                               | Available launch, stopped or unsupported runtime, denied panel hidden. The launch target is an explanatory fixture page.                                                                                                                                                                                                                                                                                          |
| Workspace                                                                  | Four editable deployed files, undeployed Agent, denied reads, initial operate denial, a retained editor after an operate grant or revocation, missing file, unknown write outcome, rereads after a version change.                                                                                                                                                                                                |
| Stop Agent                                                                 | Confirmation, stopped requested state, permission denial, unknown outcome requiring refresh.                                                                                                                                                                                                                                                                                                                      |
| Deletion                                                                   | Confirmation, pending cleanup, permission denial, conflict, unknown outcome.                                                                                                                                                                                                                                                                                                                                      |

Pending-read stories use the real client's 15-second timeout; reset them to replay
loading.

## Return navigation

**Return while deployments load** shows the rechecked Agents list first. Watch
“Reading deployment…” become “Deployment access denied,” without the old result reappearing.

In **Return to loaded pages**, **Return to Agent panels**, and **Slow rechecks**,
Back preserves search, expanded panels, and Credentials. Refresh reloads.

<a id="agent-flows-and-ui-gaps" class="anchor-alias"></a>

## Namespace navigation and Agent flows

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
[Namespaces page, no selector](../assets/console-namespace-selector/namespaces.png),
and a [switching walkthrough](../assets/console-namespace-selector/namespace-switching.webm).

Agent creation, editing, deployment, Stop, and Delete stories are in
[Console Storybook Agent workflows](console-storybook-agent-workflows.md).

### Create and deploy

Moved to [Agent workflows](console-storybook-agent-workflows.md#create-and-deploy).

### Return to loaded pages

Moved to [Agent workflows](console-storybook-agent-workflows.md#return-to-loaded-pages).

### Keep edits while navigating

Moved to [Agent workflows](console-storybook-agent-workflows.md#keep-edits-while-navigating).

<a id="choose-and-switch-revision-secrets" class="anchor-alias"></a>

### Choose and switch version Secrets

Moved to [Agent workflows](console-storybook-agent-workflows.md#choose-and-switch-version-secrets).

<a id="inspect-bound-secrets-in-revisions" class="anchor-alias"></a>

### Inspect bound Secrets in versions

Moved to [Agent workflows](console-storybook-agent-workflows.md#inspect-bound-secrets-in-versions).

### Discover and configure plugins

Moved to [Agent workflows](console-storybook-agent-workflows.md#discover-and-configure-plugins).

### Update

Moved to [Agent workflows](console-storybook-agent-workflows.md#update).

### Stop

Moved to [Agent workflows](console-storybook-agent-workflows.md#stop).

### Delete

Moved to [Agent workflows](console-storybook-agent-workflows.md#delete).

## Maintain coverage

`scripts/console-storybook/` installs from its own manifest and lockfile under the
seven-day release-age policy, independently of root dependencies.

- `prepare-assets.mjs` reads the public Console assets through the controller's
  asset reader, then versions the preview in `dist/assets/`. Rebuild after source
  edits so the development server serves the new assets.
- `public/scenarios.mjs` owns story descriptions, initial data options, failure
  responses, automatic setup actions, and workflow instructions.
- `public/fixtures.mjs` intercepts API calls inside the preview. Unconfigured
  requests report an error and return 501, never reaching a server. Preview CSP
  also blocks network connections. Authentication and authorization
  responses are examples, not a security implementation.
- `public/frame.mjs` starts the production console and opens configured controls.
- `*.stories.ts` exports named stories by group. `story.ts` adds instructions,
  UI-gap notices, the preview, and Reset story. The repository's `pnpm typecheck`
  checks these files without installing the separate Storybook dependencies.

Update scenarios and instructions with console changes, exporting new scenarios
from their owning story file. Configure API responses; the console owns failure
messages and UI markup.

## Debug image walkthrough

Open **Pages / Navigation / Debug runtime images**, expand an Agent, and inspect
the gateway image reference, digest, Enterprise source commit, and upstream
OpenClaw commit. The sidecar has unknown provenance for both commits.
Navigate to Namespaces, confirm `debug=true` persists, and repeat in the mobile
drawer. **Debug metadata unavailable** covers a failed read; ordinary navigation
stories hide diagnostics. Docker image inspection and the Kubernetes API/worker
integration suite, not these fixtures, verify Driver behavior.

### Slack reply and DM policy checks

In **Components/Channels → Slack Threaded Default**, save a new
channel-only setup with DMs disabled and inspect its native Configuration.
**Slack Reply Override** must preserve an existing `replyToMode: "off"`.
In **Slack Dm Policy**, trigger an empty Allowlist error, save explicit DM
sender IDs, then switch through Open, Disabled, and Pairing. Reopen the editor
after saving: channel senders stay unchanged. **Slack Enterprise Dm**
shows organization-wide policy restrictions. Missing-credential, read-only, and
save-failure stories cover surrounding states. Capture final interactions and
native values outside the repository; attach screenshots and video to the task
and PR.

For policy-denial states and the reviewed-addition walkthrough, follow the
[Agent policy storyboard](../../scripts/console-storybook/policy-workflow.md).
