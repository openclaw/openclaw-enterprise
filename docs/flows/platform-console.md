---
created: 2026-09-01
updated: 2026-10-08
last_updated_session: 01a11d68-d6e8-7033-ab93-03767bced2da
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
Unchanged views reactivate without rebuilding panels; changed data rebuilds them,
as does a first readable Namespace for a view retained without a selection.
Pending reads, read failures, password input, or mutations prevent reuse. Read-only
catalog and diagnostic POSTs do not invalidate views. Refresh always rebuilds.
Debug runtime disclosures follow the same validation and retain expanded state.

A changed user or session key clears retained views and drafts before further
private reads. Missing sessions open login; failed reads offer Retry.
`showLogin` reads `GET /api/auth/providers`; true `github`/`google` flags add their **Continue
with** buttons, and discovery failure keeps password login. A true `oidc` flag adds a button
labelled from `oidcSignIn.label` only when `oidcSignIn.authorizationUrl` is `https:`; its start
URL must use that endpoint's origin and path, as GitHub's and Google's must use their fixed ones. `password: false`
(recovery-only) hides the form behind **Recovery sign-in** and changes the
provider-error advice from "use your password" to asking an administrator. Pending login disables
all; generations reject late redirects. With `sessionBinding`, `loadPage`
exchanges the button's stored `attemptId` once for its key. Tabs then send
their pinned `x-occ-session-key`, so a replaced cookie yields login.
`authError=<provider>` shows a generic, one-time error; with `authError=github`, an
`authReason` of `membership` or `membership-unavailable` explains a GitHub
[allowlist](../reference/authentication/external-sign-in.md#organization-and-team-allowlist)
refusal instead. The
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
retained-view reads do not extend this.
`shell.mjs:createShell` listens for the 760px mobile breakpoint; widening closes
the drawer without focusing its hidden toggle and releases `main.inert`.
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
The picker keeps a compact credential/access reminder beside an expandable
**Access and credential setup** disclosure. Its bounded instructions, list, and
details scroll within the dialog while search and pagination remain reachable.

`create.mjs:loadPluginCatalog` and `loadPluginTools` implement
[PAT discovery](agent-plugins.md#credential-scoped-discovery): the selected or
Preset Secret takes precedence over an entered token. OCC reads the
Secret server-side. Pagination is upstream; filtering is local. Selecting a plugin loads tools.
Credential, provider, and Harness changes clear results and invalidate pending reads.

`create.mjs:MODEL_CHOICES` supplies unauthenticated static model lists and manual
entry. In `renderAgentForm`, the model-entry button switches `manualModel` and
calls `updateModelConfiguration` and `updateControls`. Entering manual mode
keeps `model.value` and clears the hidden dropdown selection.
Returning to the list uses `resetModelChoices` to rebuild the current provider's
options, including after Configuration JSON changes the provider. It retains
the model only if that provider's list contains it; otherwise it clears both
inputs. Provider and authentication changes call the same reset without a model
to retain. `model.value` supplies one Configuration model, and submission checks
that its primary model matches that value.
`updateControls` updates the button label, visibility, and required input; focus moves
to that input. Switching back to the list preserves credentials and unrelated
Configuration values. Saved Configuration and pending-request locks apply to
both directions.

`configurationTemplate` enables Control UI with loopback origins on port 18789.
Compute supplies gateway authentication; Presets replace the starter unchanged.
[Native admin access](agent-native-admin.md) owns HTTPS isolation.

`createRepositoryFields` loads `GET /namespaces/:namespaceId/agents/repository-options`,
then requests optional descriptions for visible refs. [Repository admission](agent-repository-credentials.md) resolves the
submitted `repositoryAccess`. Retained drafts keep selections through failed
discovery; retries recheck current policy. Only `503 REPOSITORY_OPTIONS_UNAVAILABLE`
permits creation without bindings, and only without retained selections; other
failures block submission.

Supported Dedicated runtimes submit inline Configuration, optional repository
access, and Secret references to [provisioning](agent-provisioning.md), even after
that outage. The worker reauthorizes, creates resources and exact Secret grants,
and deploys; Console polls, then opens the revision.

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
never values. Authentication source uses the shared form-field presentation;
issued-account lookup feedback stays inside its conditionally visible account field.
Switching methods hides that feedback without changing the lookup or saved choice.

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
channel/authentication edits reload fully. A `403` on the configuration or revision
read is an audited denial, so `console.mjs:deniedReadsFor` remembers that path in tab
`sessionStorage` for the session owner; later views show **Configuration unavailable**
without asking again, and **Retry** forgets the path and rereads. Logout clears it.

`agents/detail.mjs:renderTab` brings a clipped selected tab into the horizontal
strip without moving page focus or vertical scroll. A strip ResizeObserver repeats
this on viewport changes, disconnects for inactive or detached views, and re-arms
through the retained view's resume hook.
Completed tabs retain their DOM and draft capture callbacks within the detail view.
Returning restores loaded controls and expanded disclosures. Pending or failed
reads, password values, and mutations invalidate tab reuse. Each tab checks it
is mounted before applying a response; late reads cannot overwrite another tab.
Password values clear while [draft captures](platform-console/agent-editing.md#4-render-draft-revision-or-channels) retain edits. Channel
Secret saves update the shared draft snapshot used by other tabs and deployment
preflight.

`agents/detail.mjs:renderAgentDetail` passes an `agents/list.mjs:link` to
`deploymentFailure` for **Open vN Logs**. Client navigation selects the failed
revision's `tab=logs`, even from the draft or a different version. After mounting
the Logs panel and finishing the snapshot read, it focuses the Logs tab and
scrolls the panel into view if the view is still current. The panel's
`agents/logs.mjs:renderAgentLogs` reads that revision's runtime status and output,
or displays its access or availability error;
[Agent runtime logs](agent-runtime-logs.md) owns those reads.

### 7. Commit only the current response, or clear the view

`apps/controller/src/console/console.mjs:loadPage`, `logout`

After a full-page client navigation settles, `loadPage` focuses the destination
heading if focus fell to the document body. It uses `preventScroll` to preserve
return position; tab navigation and controls that already have focus keep it.
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

- 2026-10-08 15:59: Trace responsive drawer and tab visibility, destination focus, scoped authentication feedback, and compact plugin setup. (01a11d68-d6e8-7033-ab93-03767bced2da - 58daaa5a3ac4c64bc5fb3af00759b59b365b20ca)
- 2026-10-08 14:30: Trace client navigation from a failed deployment to its exact version and focus its Logs tab and scroll the panel into view. (01a11d68-d6e8-7033-ab93-03767bced2da - 0ff96342dc416325770eebed5963e9886fd3dff3)
- 2026-10-03 22:38: Trace switching between listed and manual model entry, preserving listed models and one submitted model. (01a10328-9de5-7081-ada2-d88ff80161e4 - 340feea42)
- 2026-10-03 20:00: Rebuild a view retained without a Namespace selection once one is readable, so the header selector shows the default.
- 2026-10-03 18:00: Re-enable the header selector during retained-view reads once Namespace access is checked.
- 2026-09-30 19:00: Remember denied Agent detail snapshot reads per tab so reloads do not add an audited denial per view.
- 2026-09-29 20:00: Trace repository descriptions and inherited access. (public-pr/374)

- 2026-09-29 07:19: Guard recovery until session and Namespace reads finish. (authoring-run/1ca6a40a-a247-465f-9a83-182dbcb6ff4e - 90326e6fab11f84fc11b8990b6c8e197a2752c60)

- 2026-09-28 01:39: Move the sharing trace to its child flow. (authoring-run/462d5207-c3a1-4203-af4a-8db2551ccb9a - 4f32ebbca5d699296a142dfbd34c8ec46844fce7)

[Platform console request documentation history](platform-console/history.md) preserves the older dated entries.
