---
created: 2026-09-01
updated: 2026-09-23
last_updated_session: 01a0cce9-23e3-7072-aa3f-a2e26d2dbf11
---

# Platform console request flow

## Overview

Opening `/console/` resolves a cookie session and renders authorized resources.
This trace follows Namespace selection, Agent creation and editing, runtime
actions, Providers, and logout. It ends at rendered state or an API mutation;
deletion additionally confirms absence. The [console reference](../reference/console.md)
owns user-visible behavior. API and IAM retain resource authority.

## Entry Points

- Browser entry: `apps/controller/src/console/console.mjs` composes the session,
  request client, view lifetime, navigation, and shell.
- Browser modules: `apps/controller/src/console/api-client.mjs` owns request
  cancellation and current-session expiry handling; `view-lifetime.mjs` owns
  generation and abort state; `navigation.mjs` owns safe return paths and history;
  `shell.mjs` owns shared navigation and collection rendering.
- Capability pages: `apps/controller/src/console/agents/{list,create,detail}.mjs`
  own Agent views, while `channels/{slack,shared-ui}.mjs` own the Slack form
  and its shared editor. Existing `agents.mjs` and `channels.mjs` compose these
  modules through their current entrypoints.
- HTTP: `apps/controller/src/index.ts:createFastifyApp`.
- Startup: `apps/controller/src/composition/production.ts:composeProduction`
  and `development-postgres.ts:composePostgresDevelopment`.
- Assumptions: a bootstrapped Installation, provisioned account, selected IAM
  Driver, and the configured same-origin controller URL. Reads and mutations
  require the exact permissions in the [API reference](../reference/api.md).

## Flow

```mermaid
graph TD
  subgraph Browser["Browser"]
    A["Open console or change page"] --> B["Clear old rows and check session"]
    B -->|no session| C["Login"]
    B -->|authenticated| D["Read readable Namespaces and validate selection"]
    D --> E["Request current page resource"]
    E --> E1["Edit starter JSON and select associations"]
    E1 --> S1["Select Secret or open creation modal"]
    S1 -->|select| S3["Stage binding until Apply"]
    S3 -->|apply| E1
    E --> E2["Select new revision or AgentRevision by URL"]
    E2 --> E3["Save supported channel draft edit"]
    E2 --> E4["Confirm Agent deletion"]
    E2 --> E5["Confirm Agent stop"]
  end
  subgraph Controller["Controller API"]
    E --> F["Authenticate and authorize exact scope"]
    F -->|Agents or Namespaces| G["OCC reads and filters by IAM"]
    F -->|Providers and Installation admin| H["Project loaded Provider IDs and types"]
    S1 -->|create| S2["POST stores Namespace Secret immediately"]
    S2 --> S3
    E1 -->|ordinary draft| M1["POST creates Configuration with staged bindings"]
    E1 -->|supported Dedicated runtime| M3["POST queues provisioning with inline Configuration"]
    M3 --> M4["Worker creates resources, grants and first deployment"]
    M1 -->|returned Configuration ID| M["POST creates Agent draft only"]
    M --> M2["Console grants Agent use of selected Secrets"]
    E2 --> N["GET draft Configuration or immutable revision"]
    E3 --> O["PATCH Configuration, then grant selected Secret access"]
    E4 --> P["DELETE exact Agent"]
    E5 --> P2["POST exact Agent stop"]
  end
  subgraph Result["Browser result"]
    G --> I["Accept only current navigation response"]
    H --> I
    M2 --> I
    N --> I
    O --> I
    P -->|accepted or uncertain| Q["Show status and refresh exact Agent"]
    P2 -->|accepted or uncertain| Q
    P2 -->|denied| K
    P -->|denied| K
    Q -->|Agent not found| R["Return to Agents list"]
    I --> J["Render list, draft, revision, or channel state"]
    F -->|denied or unavailable| K["Clear rows and show recovery"]
    J -->|Logout| L["Hide private state and confirm sign-out"]
  end
```

## Execution Trace

### 1. Compose discovery metadata and serve public assets

`apps/controller/src/composition/production.ts:composeProduction`

`apps/controller/src/composition/development-postgres.ts:composePostgresDevelopment`

Startup projects validated Provider definitions into safe `{id,type}` summaries
and passes them to `createFastifyApp`. This is a startup snapshot, not a live
configuration scan. The request path never reads credentials or contacts a
Provider. The existing [Provider-managed credential delivery](service-account-driver-credential-delivery.md) owns
client construction and Driver activation.

`apps/controller/src/console-assets.ts:readConsoleAsset` maps public console
assets to individually allowlisted files, including each capability module, and
recognized page URLs to the HTML shell. No module directory is served wholesale. Agent create
and detail paths share the shell. Unknown console paths receive the same shell
with HTTP `404`. The controller sets the HTML, CSS, or JavaScript MIME type and
a same-origin content security policy. Other routes retain canonical API JSON
errors. The Dockerfile copies these files into the existing controller image.

`scripts/build-console-metadata.mjs` stamps the console HTML during image build.
The publisher supplies its checked `source_sha` as `OCC_BUILD_REVISION`, also used
for the image revision label. Empty metadata stays empty; a nonempty value must
be a full lowercase Git SHA. `apps/controller/src/console/shell.mjs:renderShell`
reads that HTML metadata and renders the short hash beside OCE at the top of the
sidebar, with the full OCC revision in a tooltip. Missing or invalid metadata
displays **dev** beside OCE. No browser or controller request inspects Git or an Agent gateway version.

### 2. Resolve the session before private reads

`apps/controller/src/console/console.mjs:loadPage`

The browser clears the prior view, advances its navigation generation, and
requests `GET /api/auth/session`. No session opens login; unavailable session
inspection blocks private reads and offers Retry. Login submits exactly email
and password to the existing sign-in route.
`apps/controller/src/auth/index.ts:requireTrustedBrowserOrigin` compares browser
Origin to the configured controller origin before either sign-in or sign-out.
The server SDK calls do not run Better Auth's request-origin middleware, so this
HTTP boundary performs that check while retaining headerless CLI requests.
Better Auth then owns the session cookie and password verification; the browser
stores no credentials or tokens.

After authentication, the client reads `GET /namespaces`. It validates the URL's
explicit selection against that readable list, or chooses the first ready
Namespace followed by the first readable one. An unavailable explicit ID stays
unavailable until the user selects another. The selection is carried in the URL
through global pages and history, without becoming an API query selector.

### 3. Authorize the selected page resource

`apps/controller/src/index.ts:perform`, `requireInstallationAdmin`

`packages/occ/src/index.ts:OpenClawController.listNamespaces`, `listAgents`

Agents use the selected Namespace's route. OCC requires Namespace read authority
and filters Agents by exact read permission; Namespace listing similarly filters
its Installation-wide collection. With no readable selection, the browser makes
no Agent request. Providers use `GET /providers` independently of selection:
Installation `administer` precedes the safe startup-summary response. Explicit
empty configuration is a successful empty list; absent wiring and dependency
failure return errors.

`apps/controller/src/console/agents/create.mjs:renderCreateAgent` selects Provider,
then Harness. OpenAI defaults to Codex (Dedicated) and offers OpenClaw (Embedded);
Anthropic offers OpenClaw. Codex accepts API keys or **Service Accounts**
(`codex_pat`); OpenClaw accepts API keys. Provider changes reset harness,
credential, and model. Switching an unsaved service account token to OpenClaw
clears token/model and selects API-key auth; API-key harness changes retain both.
Credential hints link to the token console and show expected prefixes.

Presets fix saved credential providers and reject cross-provider JSON before
writes. Saved service account tokens lock Codex; operator-managed credentials
lock OpenClaw across provider changes. These choices do not discover Installation
Providers; that navigation item is hidden. The [creation reference](../reference/console/create-and-deploy.md)
owns permissions and partial-save recovery.

The form starts with editable native JSON, optional plugins, and no model.
`POST /namespaces/:namespaceId/agents/models` reaches
`OpenClawController.discoverAgentModels`, which authorizes Namespace Agent creation
and calls Compute outside a state transaction. `compute/model-discovery.ts` uses
fixed provider URLs, bounded responses and pagination, and returns IDs/labels.
`authMethod` selects API-key or service-account discovery; OpenAI API-key results
exclude valid `shutdown_date` values on or before today (UTC). Discovery writes
nothing. Empty/error results allow manual entry; credential/provider/method
changes invalidate pending results. Model and key edits preserve provider transport
and Codex plugin settings. Provider or Harness changes regenerate those entries
while preserving unrelated JSON; reset restores the selected starter.

`configurationTemplate` enables Control UI with loopback origins on port 18789.
Compute supplies gateway authentication from Installation trust; Presets replace
the starter unchanged. [OCE native admin access](agent-native-admin.md) still
requires isolated HTTPS origins. [Agent editing](platform-console/agent-editing.md#4-render-draft-revision-or-channels)
traces Slack Secret selection/creation. **Apply channel settings** copies values
and bindings into the form; cancellation discards selections but retains Secrets
already created in the Namespace.

For supported Dedicated runtimes, submission sends the inline Configuration and
ordinary Secret references to the [provisioning API](agent-provisioning.md).
Console polls the accepted job before an Agent exists, then opens the returned
Agent revision. The worker creates resources and exact Secret grants before
admitting deployment; Console does not duplicate those grants.

Ordinary draft creation posts `{kind: "agent", values, secretBindings}` to
`POST /namespaces/:namespaceId/configurations`, then sends its returned ID to
`POST /namespaces/:namespaceId/agents` with plugins, `initialWorkspaceFiles`, and
`workspaceDefaultsId`. Success opens `revision=draft`. All four seeded workspace
textareas, including unchanged/empty values, are submitted. OCC stages them
outside Agent/Configuration; [workspace setup](workspace-files.md) applies them
before execution.

`create.mjs:grantConfigurationSecretAccess` grants the returned Agent exact
Secret `operate` through separate Namespace IAM writes. Failure preserves the
Agent and enables **Retry credential access**, which rereads exact grants without
duplicating resources; the saved Agent link permits manual recovery. Failed Agent
writes retain the Configuration ID and lock JSON/Harness; explicit retries reuse
it. Writes never retry automatically. Draft creation neither admits revisions,
validates the plugin catalog, nor starts runtime work.

`apps/controller/src/console/agents/harness-auth.mjs:createHarnessAuthFields`
masks the existing Secret ID input in the Credentials editor. `harnessAuthDescription` reports a configured Secret
without displaying its ID in either draft or revision summaries. Native
Configuration displays unresolved references; the console does not fetch
Secret values for these views.

### 4–6. Edit the Agent and access runtime files

[Console Agent editing and runtime requests](platform-console/agent-editing.md)
traces draft/revision rendering, channel changes, credential provisioning,
workspace reads/writes, Agent stopping, and Agent deletion. Each request returns through the
response-ordering checks below.

`apps/controller/src/console/channels/slack.mjs:supportSlack` checks whether the
channel editor can preserve the stored settings. Existing `dmPolicy` and
`groupPolicy` values do not block editing. `updatedSlack` copies those values
unchanged, including their absence, when saving channel IDs, allowed users, or
mention settings. Only a new Slack configuration receives allowlist defaults.

`apps/controller/src/console/agents/detail.mjs:renderAgentDetail` registers a
handler for tab-only navigation with `console.mjs:loadPage`. For the same Agent,
Namespace, and revision, tab clicks and browser history update the URL and replace
only the content below the tabs. The shell, native-admin panel, and loaded
revision controls remain mounted. Configuration and revision reads are shared
within that detail view; a direct Workspace files URL does not wait for or start
those reads. Refresh, revision changes, and successful channel or authentication
edits use the full page read path.

Each tab render captures its own generation. Late panel reads and form callbacks
cannot overwrite a newer tab; leaving a tab clears its password inputs. Channel
Secret saves update the shared draft snapshot used by other tabs and deployment
preflight. Session expiry still clears the whole private view.

### 7. Commit only the current response, or clear the view

`apps/controller/src/console/console.mjs:loadPage`, `logout`

Page or revision navigation, Namespace changes, refocus, and logout invalidate prior reads. The
client cancels their requests and checks generation before accepting either
success or failure. A late response cannot restore rows, change selection, or
redirect a newer session. Current authorization and dependency errors clear
rows and expose recovery; a current protected `401` clears private state and
opens login immediately, without waiting for sibling reads. A late error from an
older view cannot redirect a newer session. Only locally defined reason messages
and bounded server request IDs enter failure views; backend error text is omitted.
Global Providers and Namespaces pages remain visibly Installation-wide.

The [detail action flow](platform-console/agent-editing.md#stop-agent) traces
confirmed Stop and Delete requests and their exact permission checks. Acceptance
is not completed shutdown or deletion. Uncertain outcomes block replay until
readback; only confirmed absence returns to the Agents list. Deployment resumes
a stopped Agent through a new revision. The [Agent reference](../reference/agents.md#deletion)
owns asynchronous cleanup.

Logout first hides private state, then calls the existing sign-out endpoint.
Confirmed success or session inspection proving absence replaces history with
login. An unconfirmed logout stays blocked with Retry. The
[authentication flow](local-password-authentication.md) owns server revocation;
this client never infers it from a network error.

<span id="deploy-the-saved-draft"></span>

## Deploy the new revision

The **New revision** detail view exposes **Deploy new revision**. The **Operator-managed
credentials** option persists `{ "method": "runtime" }` and explains that OCC does
not validate host credentials. It bypasses only the managed runtime-credential
metadata gate. Deployment rereads the Agent and
Configuration, checks their loaded association and generation, then sends the existing
bodyless `POST /namespaces/:namespaceId/agents/:agentId/deploy`. The server retains
its existing authorization and admission checks. The returned admitted revision opens
the workspace view; gateway startup and file availability are checked by subsequent
workspace reads. An uncertain deployment response disables replay until the user
refreshes and inspects the Agent and revision history.

## Debugging and Verification

- Use the displayed request ID to associate API failures with controller logs.
  A Namespace-only user cannot discover Providers; check Installation authority
  before treating that denial as a configuration problem.
- The browser suites exercise real Fastify routes, Better Auth, and Native IAM
  with in-memory storage. They verify user-visible navigation, list isolation,
  Agent creation, draft/history rendering, channel draft editing, and auth
  behavior; they do not establish PostgreSQL persistence, live Provider health,
  runtime dispatch, worker lease handling, or Compute Driver effects.
- API tests cover safe discovery, permission boundaries, empty versus missing
  wiring, static MIME/allowlisting, and unchanged API JSON errors. See
  [Testing](../testing/README.md) for commands and the image smoke boundary.

## Related docs

- [Console reference](../reference/console.md)
- [Authentication](../reference/authentication.md)
- [Provider-managed credential delivery](service-account-driver-credential-delivery.md)
- [Configuration and Agent revision](configuration-driver.md)
- [Docker development](docker-compose-development.md)
- [Production startup](production-startup.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-23 21:41: Preserve edited Codex plugin settings across model and key changes. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - b8f23be17de4a4b077dab8d6b90b4add1f9146cb)

- 2026-09-23 23:50: Describe Service Accounts hints and expired-model filtering; consolidate repeated creation and action details. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 9e0095c7)

- 2026-09-23 19:28: Condense Console flow within the documentation length budget. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - da797e3afa3752a7b3321733d27b6b5e6d0a505a)

- 2026-09-23 18:51: Trace provider-dependent harness choices, derived execution mode, and Codex PAT switching boundaries. (01a0cf9b-8c16-7a73-a3d6-1496593034a0 - 6c6c3e4308946e7e66d656fb553da4dd5177f2c4)

- 2026-09-23 18:48: Keep saved API-key and PAT Presets bound to their provider before Configuration or Agent writes. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 4da114ac7b11f926d4b774b8d32a09fa136135eb)

- 2026-09-23 18:35: Reconcile provider credential creation with staged Slack Secret grants and shared retry recovery. (authoring-run/2516b0a6-7a82-4268-a586-d821679b2a78 - ae092fc7c13aad4c637b0238ae2f41ecb2b03219)
- 2026-09-23 19:09: Trace image-baked OCC revision metadata and OCE sidebar branding. (01a0cfaa-2b68-7e61-b8ff-a7eb82f1edc5 - 150ec08f059cebc4897b839d8318f7b1e3aba0e3)

- 2026-09-23 11:20: Distinguished worker-owned first-time provisioning and Secret grants from ordinary Console draft creation. (01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:30: Trace pre-Agent Slack Secret selection and creation, staged Configuration bindings, and Agent Secret grants. (01a0cd92-fd3f-7d83-a51e-f6264ef6be09 - 941edc9f6971a24ae29a74a6ca749b6375e6ec01)

- 2026-09-23 07:45: Preserve provider transport across model/key edits and classify model-discovery failures without exposing upstream responses. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - f292aa623335021e3012a3e94f83fc183f93e2e1)

- 2026-09-23 07:20: Discover API-key model choices during Agent creation without saving credentials or selecting a hardcoded model. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - 553423dd2419ec19d2d71a2d1f8de75839a1642b)

- 2026-09-23 06:27: Move two-provider API-key setup into Agent creation using existing Secret and IAM operations. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - a8272f4e2760e5ff06dc09c5658f48bea382c790)

- 2026-09-22 23:19: Enable native Control UI in Console starters with explicit loopback origins; preserve Preset and edited configuration. (01a0ccc0-00fa-7173-ab45-f7a5fb55b3b6 - 6d23cef977270fdf8ced6ea54ac8e1302cf8acd6)

- 2026-09-22 20:56: Rename the deployment-facing Console view to New revision. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 081bccfcf3f5b114588dde1b42a0deb07f326017)

- 2026-09-22 20:43: Trace Console stop confirmation, admission, and state refresh. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 6adfd148a517e84ae064a8e08438b051f80820fb)
- 2026-09-22 20:32: Remove the deleted Teams editor from current module ownership. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 43776d25c5007e017f7d0ffdca6b06f063afcd37)

- 2026-09-22 04:31: Trace initial workspace inputs separately from Configuration creation and link setup before execution. (01a0c755-0518-7502-a533-64cd7465de15 - f3dbdd41c8f3b49573d1353a4b06ce510ee43a56)

- 2026-09-22 04:11: Preserve existing Slack policies while editing channel settings. (01a0b1f2-e696-7232-a439-5b668154bcd9 - f3dbdd41)

- 2026-09-22 04:07: Keep Agent tab navigation within the content panel and preserve page state and browser history. (01a0b1f2-e696-7232-a439-5b668154bcd9 - f3dbdd41)

- 2026-09-21 21:46: Trace confirmed Agent deletion, exact readback, and permission or uncertain-outcome recovery. (01a0c76f-2534-7991-932a-345782408759 - b61c3cae6c35e28db4153eaee9b477e8f5637894)

- 2026-09-22 00:47: Mask authentication Secret IDs in forms and omit them from configuration summaries. (01a0b1f2-e696-7232-a439-5b668154bcd9 - ebcdaac25bc3890486badcfadf56cfc7c99bb95e)

- 2026-09-21 19:52: Trace the shared default in dedicated and embedded Agent creation and preserve edited model selection. (01a0c580-9e39-7e21-bb0f-28fcc4752c59 - 4ec004dbefd25070ff1bdeb89cfb16d245296ac9)

- 2026-09-17 19:14: Expose operator-managed credentials without a managed-credential deployment gate. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - b8cabaf9a49e069a7668ccf88b9e71a7484227b7)

- 2026-09-01 19:09: Trace static serving, session resolution, exact collection authorization, Namespace isolation, and logout. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - 97911d361ac02ddf561e46c8af0864ad66a6df45) (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-09-01 17:47: Add Agent creation, detail revision selection, and saved channel draft editing flow boundaries. (01a05f94-886b-7122-8784-c4b5aa5c5d1d - b02a07f2e575b13260b8792f87975d51c5ef7a61)
- 2026-09-01 18:07: Trace association discovery and Configuration-first creation from editable starter JSON. (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f - 1dd4b6b)
