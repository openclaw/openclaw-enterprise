---
created: 2026-09-01
updated: 2026-09-29
last_updated_session: authoring-run/1ca6a40a-a247-465f-9a83-182dbcb6ff4e
---

# Platform console request flow

## Overview

`/console/` renders session-authorized resources.
The [console reference](../reference/console.md) owns user-visible behavior;
API and IAM authorize access.

## Entry Points

- Browser entry: `apps/controller/src/console/console.mjs` composes the session,
  request client, view lifetime, navigation, and shell.
- `api-client.mjs` owns cancellation and session expiry; `view-lifetime.mjs`
  owns generation and abort state; `navigation.mjs` owns return paths and history;
  `shell.mjs` owns navigation and collections.
- `agents/{list,create,detail}.mjs` own Agent views;
  `channels/{slack,shared-ui}.mjs` own Slack editing. `agents.mjs` and
  `channels.mjs` compose them.
- HTTP: `apps/controller/src/index.ts:createFastifyApp`.
- Startup: `apps/controller/src/composition/production.ts:composeProduction`
  and `development-postgres.ts:composePostgresDevelopment`.
- Requires a bootstrapped Installation, provisioned account, selected IAM Driver,
  same-origin controller, and the [API permissions](../reference/api.md)
  for each read or mutation.

## Flow

```mermaid
graph TD
  subgraph Browser["Browser"]
    A["Open console or change page"] --> B["Restore scoped preview or show first-load state"]
    B --> B1["Recheck session and Namespace access"]
    B1 -->|no session| C["Login"]
    C -->|GitHub| C1["Start GitHub sign-in"]
    C1 -->|callback redirect| B1
    B1 -->|authenticated| D["Read readable Namespaces and validate selection"]
    D -->|debug=true| DBG["Read accessible Agents and runtime image metadata"]
    DBG --> F
    D --> E["Request current page resource"]
    E --> E1["Edit starter JSON and select associations"]
    E1 --> S1["Select Secret or open creation modal"]
    S1 -->|select| S3["Stage binding until Apply"]
    S3 -->|apply| E1
    E --> E2["Open new version draft or admitted version by URL"]
    E2 --> E3["Save supported channel draft edit"]
    E2 --> E4["Confirm Agent deletion"]
    E2 --> E5["Confirm Agent stop"]
  end
  subgraph Controller["Controller API"]
    E --> F["Authenticate and authorize exact scope"]
    F -->|Agents or Namespaces| G["OCC reads and filters by IAM"]
    F -->|Backends and Installation admin| H["Project loaded Backend IDs and types"]
    S1 -->|create| S2["POST stores Namespace Secret immediately"]
    S2 --> S3
    E1 -->|draft runtime| M1["POST creates Configuration with staged bindings"]
    E1 -->|supported Dedicated and valid repository selection| M3["POST queues provisioning with inline Configuration"]
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
    M4 --> I
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

Startup passes safe Backend `{id,type}` summaries to `createFastifyApp`.
[Backend-managed delivery](service-account-driver-credential-delivery.md) owns
Driver activation. Requests do not reread configuration or credentials.

`apps/controller/src/console-assets.ts:readConsoleAsset` serves allowlisted assets
and the shared HTML shell with MIME types and same-origin CSP. Unknown console
paths return the shell with `404`; API routes retain JSON errors.

`scripts/build-console-metadata.mjs` bakes the publisher's checked
`OCC_BUILD_REVISION` into HTML. With `debug=true`, `shell.mjs:renderShell` displays
the full commit; invalid or absent metadata remains unknown.

`runtime-images.mjs:renderRuntimeImages` issues at most three concurrent reads for
readable Agents in the selected Namespace.
`packages/occ/src/index.ts:OpenClawController.getAgentRuntimeImages` authorizes
exact Agent read, resolves its active revision, then calls its Compute Driver.
The [Compute contract](../reference/drivers/compute.md) owns workload inspection
and Enterprise/OpenClaw provenance. Navigation preserves `debug=true`; removing it
stops reads. Missing provenance stays explicit.

### 2. Resolve the session before private reads

`apps/controller/src/console/console.mjs:loadPage`

`loadPage` advances the request generation and requests `GET /api/auth/session`.
First loads show loading. Return navigation and Refresh can restore one of at most
16 document-local views keyed by route, Namespace, and session owner while reads
run. Password fields and their derived discovery state clear before retention.
Controls stay inert until admission succeeds; navigation remains available.

Completed views retain their DOM, handlers, and draft capture callbacks. On return,
`loadPage` rereads their GET dependencies and compares data and user identity.
Unchanged views reactivate without rebuilding panels; changed data rebuilds them.
Pending reads, read failures, password input, or mutations prevent reuse. Read-only
catalog and diagnostic POSTs do not invalidate views. Refresh always rebuilds.
Debug runtime disclosures follow the same validation and retain expanded state.

A changed user or session key clears retained views and drafts before further
private reads. Missing sessions open login; failed reads offer Retry.
`showLogin` reads `GET /api/auth/providers`; true `github`/`google` flags add their **Continue
with** buttons, and discovery failure keeps password login. Pending login disables
all; generations reject late redirects. With `sessionBinding`, `loadPage`
exchanges the button's stored `attemptId` once for its key. Tabs then send
their pinned `x-occ-session-key`, so a replaced cookie yields login.
`authError=<provider>` shows a generic, one-time error. The
[authentication flow](local-password-authentication.md#3-construct-session-authentication)
owns the server side.

`apps/controller/src/auth/index.ts:requireTrustedBrowserOrigin` checks Origin
before sign-in/out, even for SDK calls bypassing Better Auth middleware; headerless
CLI requests remain supported. The browser stores no credentials.

After authentication, `loadPage` reads `GET /namespaces`, preserving URL
selection or choosing the first ready/readable Namespace. Unreadable IDs stay
unavailable; selection never becomes an API query selector.

`shell.mjs:namespaceSelector` disables and hides choices through session and
Namespace checks for loads, Refresh, and admission-starting navigation;
retained-view validation can extend this.
Empty lists show access guidance. `navigation.mjs:navigate` returns Agent detail/creation
to Agents; global pages remain open; recovered warnings disappear.

### 3. Authorize the selected page resource

`apps/controller/src/index.ts:perform`, `requireInstallationAdmin`

`packages/occ/src/index.ts:OpenClawController.listNamespaces`, `listAgents`

Agents use the selected Namespace's route. OCC authorizes Namespace reads and
filters Agents by exact read permission; Namespace listing filters its
Installation-wide collection. No readable selection means no Agent request.
`GET /backends` ignores selection and requires Installation `administer` before
returning safe startup summaries. Empty configuration returns an empty list;
missing wiring or failed dependencies return errors.

`apps/controller/src/console/agents/create.mjs:renderCreateAgent` composes Provider,
Harness, Preset, Configuration, and workspace inputs. Provider/Harness changes
reset incompatible credentials and model choices while retaining unrelated JSON. The
[creation reference](../reference/console/create-and-deploy.md) owns combinations,
Preset constraints, token handling, permissions, and recovery.

`agents/plugin-fields.mjs:createPluginFields` edits Agent `plugins` separately
from Configuration. Invalid JSON and untouched fields survive; clearing overrides
restores inheritance. Submission, uncertain outcomes, or invalid JSON lock editing.
`capabilities.pluginPolicies` gates policy edits; unsupported reviewers remain clearable.

`create.mjs:loadPluginCatalog` and `loadPluginTools` implement
[PAT discovery](agent-plugins.md#credential-scoped-discovery): the selected or
Preset Secret takes precedence over an entered token. OCC reads the
Secret server-side. Pagination is upstream; filtering is local. Selecting a plugin loads tools.
Credential, provider, and Harness changes clear results and invalidate pending reads.

`create.mjs:MODEL_CHOICES` supplies unauthenticated static model lists and manual
entry.

`configurationTemplate` enables Control UI with loopback origins on port 18789.
Compute supplies gateway authentication; Presets replace the starter unchanged.
[Native admin access](agent-native-admin.md) owns HTTPS isolation.

`GET /namespaces/:namespaceId/agents/repository-options` discovers approved choices.
Console submits opaque references and an explicit common profile. Only
`503 REPOSITORY_OPTIONS_UNAVAILABLE` permits creation without repository bindings
when no selections are retained. Other failures block submission. `draftBindings()`
preserves choices; failed rediscovery blocks creation. Successful reads filter
choices against current policy.

Supported Dedicated runtimes submit inline Configuration, optional repository
bindings, and Secret references to [provisioning](agent-provisioning.md), including
when optional discovery is unavailable without retained selections. The worker
reauthorizes, creates resources and exact Secret grants, and deploys. Console polls
the job, then opens its revision.

Ordinary drafts post `{kind: "agent", values, secretBindings}` to
`POST /namespaces/:namespaceId/configurations`, then submit its ID, plugins,
`initialWorkspaceFiles`, and `workspaceDefaultsId` to
`POST /namespaces/:namespaceId/agents`. Success opens `revision=draft`.
OCC stages all four workspace textareas, including unchanged/empty values, outside
Agent/Configuration for [workspace setup](workspace-files.md).

`create.mjs:grantConfigurationSecretAccess` grants exact Secret `operate` for final
same-Namespace `env` bindings. Failure retains the Agent; **Retry credential access**
rereads grants without duplication. Failed Agent writes retain Configuration ID
and lock JSON/Harness for explicit reuse. Writes never retry automatically; drafts
admit no revision and start no runtime.

`agents/harness-auth.mjs` edits bindings and shows
[Secret identities](platform-console/agent-editing.md#4-render-draft-revision-or-channels),
never values.

### 4–6. Edit the Agent and access runtime files

[Agent editing](platform-console/agent-editing.md) traces revision rendering,
channels, credentials, workspace files, stopping, and deletion;
[Agent sharing](platform-console/agent-sharing.md) traces policy writes.
Responses follow the ordering checks below.

`channels/slack.mjs:supportSlack` rejects shapes the editor cannot preserve;
`updatedSlack` preserves untouched policies and reply overrides. The
[editing flow](platform-console/agent-editing.md#4-render-draft-revision-or-channels)
owns DM policies and channel-only reply defaults. Admission snapshots native values;
Kubernetes `prepareRevision` carries them into `openclaw.json` without adding defaults.

`apps/controller/src/console/agents/detail.mjs:renderAgentDetail` registers tab
navigation with `console.mjs:loadPage`. For the same Agent, Namespace, and
revision, tab clicks/history replace only tab content; shell, native-admin panel,
and revision controls stay mounted. Configuration and revision reads are shared;
direct Workspace URLs start neither. Refresh, revision changes, and successful
channel/authentication edits reload fully.

Completed tabs retain their DOM and draft capture callbacks within the detail view.
Returning restores loaded controls and expanded disclosures. Pending or failed
reads, password values, and mutations invalidate tab reuse. Each tab checks it
is mounted before applying a response; late reads cannot overwrite another tab.
Password values clear while [draft captures](platform-console/agent-editing.md#4-render-draft-revision-or-channels) retain edits. Channel
Secret saves update the shared draft snapshot used by other tabs and deployment
preflight.

### 7. Commit only the current response, or clear the view

`apps/controller/src/console/console.mjs:loadPage`, `logout`

Navigation, Namespace changes, and logout invalidate reads; generations reject
late responses. Refocus coalesces events. Agent detail rechecks access in place,
preserving controls, input, and saves; failures clear the view. Other pages
revalidate before reuse; forms defer refocus. Drafts keep save baselines and Namespace
scopes separate.

Authorization and dependency failures clear affected content and expose recovery;
a current protected `401` clears all private state. `pagehide` clears
private DOM, previews, and drafts even for BFCache; persisted `pageshow` performs
a fresh load. Failure views show local reasons and bounded request IDs, never
backend error text. Backend authorization denial clears every retained preview,
including other Namespace selections, because the permission is Installation-wide.

The [detail action flow](platform-console/agent-editing.md#stop-agent) traces
confirmed Stop and Delete requests and permissions. Acceptance
is not completed shutdown or deletion. Uncertain outcomes block replay until
readback; only confirmed absence returns to Agents. Deployment resumes
a stopped Agent through a new revision. The [Agent reference](../reference/agents.md#deletion)
owns asynchronous cleanup.

Logout first hides private state, then calls the sign-out endpoint.
Confirmed success or session inspection proving absence replaces history with
login. An unconfirmed logout stays blocked with Retry. The
[authentication flow](local-password-authentication.md) owns server revocation;
this client never infers it from a network error.

<span id="deploy-the-saved-draft"></span>

## Deploy the new revision

The **Create new version** draft exposes **Deploy new version**.
**Operator-managed credentials** persist `{ "method": "runtime" }` and bypass
managed credential setup in Console; OCC does not validate host credentials.
Deployment checks the Agent, Configuration association, and generation, then sends
bodyless
`POST /namespaces/:namespaceId/agents/:agentId/deploy`. The server authorizes
and admits the revision. Its read-only details open while **Deployment
activity** follows the latest visible deployment. Workspace reads check gateway
startup and file availability. An uncertain response disables replay until
refresh and inspection.

## Debugging and Verification

- Match the displayed request ID to controller logs.
  A Namespace-only user cannot discover Backends; check Installation authority
  before treating that denial as a configuration problem.
- Browser suites use real Fastify, Better Auth, Native IAM, and in-memory storage.
  They verify navigation, isolation, creation, draft/history/channel editing, and
  authentication, not PostgreSQL persistence, Backend health, runtime dispatch,
  worker leases, or Compute effects.
- API tests cover safe discovery, permission boundaries, empty versus missing
  wiring, static MIME/allowlisting, and unchanged API JSON errors. See
  [Testing](../testing/README.md) for commands and the image smoke boundary.

## Related docs

- [Console reference](../reference/console.md)
- [Authentication](../reference/authentication.md)
- [Backend-managed credential delivery](service-account-driver-credential-delivery.md)
- [Configuration and Agent revision](configuration-driver.md)
- [Docker development](docker-compose-development.md)
- [Production startup](production-startup.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-29 07:19: Guard recovery until session and Namespace reads finish. (authoring-run/1ca6a40a-a247-465f-9a83-182dbcb6ff4e - 90326e6fab11f84fc11b8990b6c8e197a2752c60)

- 2026-09-28 01:39: Move the sharing trace to its child flow. (authoring-run/462d5207-c3a1-4203-af4a-8db2551ccb9a - 4f32ebbca5d699296a142dfbd34c8ec46844fce7)

- 2026-09-27 19:38: Preserve validated page and tab DOM in accompanying changes. (01a0b1f2-e696-7232-a439-5b668154bcd9 - 0663fa97)

- 2026-09-27 05:05: Keep supported Dedicated provisioning available without optional repository discovery. (01a0cf72-6985-7712-ba92-d8cc32470f24 - c0f792d5b92e2dee596711654784759d327e0817)

- 2026-09-27 02:30: Use selected PAT Secrets for discovery. (01a0e099-da9d-78f1-8e79-ea4a919edf7d - ec4e9dc517497afe05be63a320542abcf61e8a55)

- 2026-09-26 00:37: Link Secret summary metadata flow. (01a0db1e-7ab2-7bf1-936b-e71c9d6f9911 - e387b38cc259ee4a55936ecb848bbce8210bcd68)

- 2026-09-25 17:27: Trace scoped return previews and session-aware invalidation in accompanying changes. (01a0d992-db83-7843-b40c-355c0f2c2b9a - 64ab72aed5c4926e4a2080ade91d785e531801a2)

- 2026-09-25 01:15: Trace channel-only Slack reply defaults and explicit DM policy editing. (01a0d5e6-743e-7743-8a5e-2d8c24b78b81 - 919f92c3bb3ea63acf7042b138e9a0c6e1d97719)

- 2026-09-25 00:15: Trace new Slack reply defaults and preservation through gateway rendering. (01a0d5e6-743e-7743-8a5e-2d8c24b78b81 - 29bf7a8681390fe60ced612beeb538101c87bc34)

- 2026-09-25 00:00: Retain repository draft bindings through failed rediscovery. (01a0d557-f6e3-7da2-af52-993d05735554 - 2e0604a2)

- 2026-09-24 22:03: Link shared editor draft capture before tab teardown. (01a0d557-f6e3-7da2-af52-993d05735554 - a91cbfdd37b64c88b7ee48647096ff6bfd993e02)
- 2026-09-24 20:03: Recover unavailable Namespace selection inline. (authoring-run/bb42c16a-c6e1-4900-adf5-9ba37629e491 - 09a392cbda669a99e69d5f6a905921b9f10b43d9)

- 2026-09-24 17:13: Trace the header Namespace selector and preserved navigation scope. (authoring-run/fdba83e7-9f34-4b8b-8af2-625214851f27 - 1a458b227585c572ec0ac70fd10efc3834165075)

- 2026-09-24: Keep Preset bindings internal.

- 2026-09-24 17:20: Expose upstream OpenClaw provenance separately. (01a0c179-19f7-7111-8bb4-fc7680da5545 - bd1a5c46eb069bfa7feedbb99b074dc015c4e9bc)

- 2026-09-24 15:44: Trace opt-in sidebar build metadata and authorized Compute image observations. (01a0c179-19f7-7111-8bb4-fc7680da5545 - 6b5c9093)

- 2026-09-24 06:19: Replace Console model discovery with an intentional static starter list and preserve manual entry. (01a0d20c-dc1b-7d22-a965-60b9c244b29d - 24ecb94b)

- 2026-09-24 05:40: Added Create Agent plugin JSON controls and transient PAT catalog discovery; policy integration remains pending. (01a0d1dd-aa36-7622-9f43-8376f6ff935e - f62e17c)

- 2026-09-23 21:41: Preserve edited Codex plugin settings across model and key changes. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - b8f23be17de4a4b077dab8d6b90b4add1f9146cb)

- 2026-09-23 23:50: Describe Service Accounts hints and expired-model filtering; consolidate repeated creation and action details. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 9e0095c7)

- 2026-09-23 19:28: Condense Console flow within the documentation length budget. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - da797e3afa3752a7b3321733d27b6b5e6d0a505a)

- 2026-09-23 18:51: Trace provider-dependent harness choices, derived execution mode, and Codex PAT switching boundaries. (01a0cf9b-8c16-7a73-a3d6-1496593034a0 - 6c6c3e4308946e7e66d656fb553da4dd5177f2c4)

- 2026-09-23 18:48: Keep saved API-key and PAT Presets bound to their provider before Configuration or Agent writes. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 4da114ac7b11f926d4b774b8d32a09fa136135eb)

- 2026-09-23 18:35: Reconcile provider credential creation with staged Slack Secret grants and shared retry recovery. (authoring-run/2516b0a6-7a82-4268-a586-d821679b2a78 - ae092fc7c13aad4c637b0238ae2f41ecb2b03219)

- 2026-09-23 20:21: Integrate repository selections with asynchronous provisioning and preserve draft-only discovery recovery. (public-pr/295 - 8bd367636aff766d484b4e684d42f6b4419c9e4e)

- 2026-09-23 19:39: Trace pending Slack grants across drawer applications and reconciliation with final saved bindings. (public-pr/295 - 7f6d9107dcb23ff1ad093c4914c89a0210169d20)

- 2026-09-23 19:52: Trace channel-scoped Slack sender access and leave direct-message access outside the drawer. (01a0d150-104a-71a3-9e56-6c5e3ee510ea - 77aedc620f443056f9ee859050b8dc657a9c3133)

- 2026-09-23 19:09: Trace image-baked OCC revision metadata and OCE sidebar branding. (01a0cfaa-2b68-7e61-b8ff-a7eb82f1edc5 - 150ec08f059cebc4897b839d8318f7b1e3aba0e3)

- 2026-09-23 11:20: Distinguished worker-owned first-time provisioning and Secret grants from ordinary Console draft creation. (01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:30: Trace pre-Agent Slack Secret selection and creation, staged Configuration bindings, and Agent Secret grants. (01a0cd92-fd3f-7d83-a51e-f6264ef6be09 - 941edc9f6971a24ae29a74a6ca749b6375e6ec01)

- 2026-09-23 07:45: Preserve provider transport across model/key edits and classify model-discovery failures without exposing upstream responses. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - f292aa623335021e3012a3e94f83fc183f93e2e1)

- 2026-09-23 07:20: Discover API-key model choices during Agent creation without saving credentials or selecting a hardcoded model. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - 553423dd2419ec19d2d71a2d1f8de75839a1642b)

- 2026-09-23 06:27: Move two-provider API-key setup into Agent creation using existing Secret and IAM operations. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - a8272f4e2760e5ff06dc09c5658f48bea382c790)

- 2026-09-22 23:02: Trace GitHub sign-in discovery and callback recovery. (public-pr/305 - 311bc23012d0fd269483168b865adf79df630542)

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
