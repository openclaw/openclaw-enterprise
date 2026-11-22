---
created: 2026-09-01
updated: 2026-11-22
last_updated_session: authoring-run/d86bdf09-8b77-410f-8646-4feb7a9071cf
---

# Platform console request flow

## Overview

[Console reference](../reference/console.md).

## Entry Points

- Browser entry: `apps/controller/src/console/console.mjs` composes the session,
  request client, view lifetime, navigation, and shell.
- HTTP: `apps/controller/src/index.ts:createFastifyApp`.
- Startup: `apps/controller/src/composition/production.ts:composeProduction`
  and `development-postgres.ts:composePostgresDevelopment`.
- Requires a bootstrapped Installation, provisioned account, selected IAM Driver,
  same-origin controller, and the [API permissions](../reference/api.md)
  for each read or mutation.

## Flow

```mermaid
graph TD
  THEME["API startup loads optional theme bundle"] -->|valid snapshot| ASSET["Serve branded HTML, CSS and images"]
  THEME -->|invalid| FAIL["Refuse API startup"]
  ASSET --> A
  subgraph Browser["Browser"]
    A["Open console or change page"] --> B["Restore scoped preview or show first-load state"]
    B --> B1["Recheck session and Namespace access"]
    B1 -->|no session| C["Login"]
    C -->|OIDC/Google| C1["External sign-in"]
    B1 -->|authenticated recovery key| NR["Resolve authorized Agent key"]
    NR -->|allowed| D
    NR -->|unavailable| D
    C1 -->|callback redirect| B1
    B1 -->|authenticated| D["Read readable Namespaces and validate selection"]
    D -->|Debug mode enabled| DBG["Read accessible Agents and runtime image metadata"]
    DBG --> F
    D --> E["Request current page resource"]
    E --> NC["Create Namespace"]
    E --> ND["Confirm deletion"]
    E --> SEC["Manage Namespace Secret metadata and values"]
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
    ND --> NDELETE["Authorize DELETE; check contents"]
    E --> F["Authenticate and authorize exact scope"]
    F -->|Agents or Namespaces| G["OCC reads and filters by IAM"]
    F -->|Backends and Installation admin| H["Project loaded Backend IDs and types"]
    NC --> NPOST["POST authorizes, persists and queues provisioning"]
    S1 -->|create| S2["POST stores Namespace Secret immediately"]
    S2 --> S3
    SEC --> SAPI["Authorize Secret list, read, create, replace or delete"]
    SAPI -->|metadata or confirmed mutation| I
    SAPI -->|unconfirmed write| SU["Erase input and block resubmission"]
    SU -->|manual inspection| SEC
    E1 -->|draft runtime| M1["POST creates Configuration with staged bindings"]
    E1 -->|supported Dedicated and valid repository selection| M3["POST queues provisioning with inline Configuration"]
    M3 --> M4["Worker creates resources, grants and first deployment"]
    M1 -->|returned Configuration ID| M["POST creates Agent draft only"]
    M --> M2["Console grants Agent use of selected Secrets"]
    E2 --> N["GET draft Configuration or Agent revision"]
    E3 --> O["PATCH Configuration, then grant selected Secret access"]
    E4 --> P["DELETE exact Agent"]
    E5 --> P2["POST exact Agent stop"]
  end
  subgraph Result["Browser result"]
    NDELETE -->|nonempty| NB["Show blockers and cleanup links"]
    NDELETE -->|accepted| NP["Poll Namespace until removed"]
    NDELETE -->|uncertain| NRD["Require status refresh before retry"]
    G --> I["Accept only current navigation response"]
    H --> I
    NPOST -->|201| NSUCCESS["Creation accepted"]
    NPOST -->|unconfirmed| NUNKNOWN["Inspect before retry"]
    NPOST -->|refused| K
    NUNKNOWN --> D
    NSUCCESS --> D
    M2 --> I
    M4 --> I
    N --> I
    O --> I
    P -->|accepted or uncertain| Q["Show status and refresh exact Agent"]
    P2 -->|accepted or uncertain| Q
    P2 -->|denied| K
    P -->|denied| K
    Q -->|Agent not found| R["Return to Agents list"]
    I --> J["Render list, draft, Agent revision, or channel state"]
    F -->|denied or unavailable| K["Clear rows and show recovery"]
    J -->|Logout| L["Hide private state and confirm sign-out"]
  end
```

## Execution Trace

### 1. Compose discovery metadata and serve public assets

`apps/controller/src/api-startup.ts:startApi` loads the [theme bundle](../reference/console/theming.md) once. Invalid bundles stop startup;
ConfigMap links stay inside the bundle. `renderConsoleThemeShell` escapes branding;
`console/shell.mts:brandContents` renders names as text. `/console/theme/` serves
images and generated CSS with `no-store`; missing assets return 404.

Startup passes Backend `{id,type}` to `createFastifyApp`.
[Backend-managed delivery](service-account-driver-credential-delivery.md) owns activation.

`apps/controller/src/console-assets.ts:readConsoleAsset` serves allowlisted HTML and assets with MIME types and same-origin CSP. Unknown paths return HTML 404s; API errors stay JSON. `encodedAsset` caches brotli/gzip output
according to `Accept-Encoding` and `Vary`; higher-weight `identity` wins.
HTML, including sign-in, stays uncompressed.

`scripts/build-console-metadata.mjs` stamps `OCC_BUILD_REVISION` into HTML.
`internal/occdev/openshell_k3d.go:importDevelopmentController` resolves Git `HEAD`
and runs the engine directly for cancellation and timing. Missing metadata
stops builds; the SHA excludes uncommitted edits.
`shell.mts:renderShell` displays it in Debug mode.

`console.mts:readDebugPreference` enables diagnostics only for local-storage
`oce.console.debug=true`. Storage failures default to off. `settingsView` saves,
clears retained views, and rebuilds the shell; failures show an error.
`navigation.mts` removes the old query flag.

`runtime-images.mts:renderRuntimeImages` allows three concurrent reads in the
selected Namespace. `packages/occ/src/agent-runtime-observations.ts:AgentRuntimeObservations.getAgentRuntimeImages`
checks Agent read and calls the active revision's Compute Driver.
Disabling Debug mode stops new reads. See the
[Compute contract](../reference/drivers/compute.md).

### 2. Resolve the session before private reads

`agents/collection.mts:renderAgentList` focuses the Agent link on plain row clicks.
Interactive targets, modified clicks, and selected text retain behavior.
Arrow keys from search visit visible name links. Enter in search follows the
same link when a nonempty query leaves one row.

`loadPage` reads `GET /api/auth/session`. Opening an Agent shows **Loading agent
details…** and **Back to Agents**. Back cancels once. Refocus waits. Other Agent
routes delay loading 400 ms. Other visits or Refresh delay it 250 ms. Visible
loading lasts at least 300 ms.

Return and refocus hold views inert. **Still checking…** appears after one
second. Up to 16 views retain drafts and disclosures by route, Namespace, and
session. Changed reads, newly readable Namespaces, and Refresh rebuild. Cancelled
returns preserve views. Cancelled Refresh discards them.
Discovery, passwords, mutations, and pending or failed reads prevent reuse.
Read-only POSTs permit reuse.

`console.mts:revalidateMountedAgent` checks session, Namespace, Agent, and detail
reads. Focus and visibility share the check. Navigation cancels it. Detail errors
hide protected content. A 5xx permits one retry unless refusal, 429, or delay
takes precedence. Narrowed access rebuilds. Reused and replacement views
require confirmed Agent permissions for grant-dependent controls.

Persistent errors warn with the confirmed Agent name. **Retry** starts
foreground admission after the latest deadline. Expiry opens sign-in.
Refusals remove private content.

`api-client.mts:createApiClient` preserves abort and socket failures through
response bodies without replay.

**Back to Agents** awaits admission and rows for newest readable versions.
`agents/collection.mts:currentRevision` reads versions off-page. `deniedReadsFor`
retains 403s. Reused deployment cells show **Reading deployment…** after 250 ms
for at least 150 ms and regain focus. Pending or failed reads resume. Search
cancels hidden reads (`collection.mts:retireHidden`). Redisplayed rows read once.

Changed users or session keys clear private state. Missing sessions
[open sign-in](platform-console/sign-in-return.md).

`GET /namespaces` selects the URL Namespace or first ready, readable Namespace.
Unreadable IDs stay unavailable. Unscoped Agent URLs require matching requested
Agent and selected or probed Namespace IDs plus a nonempty Configuration ID.
Malformed replies cannot establish absence. Back restarts interrupted lookups.
`shell.mts:namespaceSelector` hides choices during admission. Widening past 760 px
closes the drawer without focusing its toggle. An open drawer blocks scrolling.
`createShell` preserves navigation presses across renders. Namespace switches
return Agent detail and creation to Agents.

### 3. Authorize the selected page resource

`apps/controller/src/index.ts:perform`, `requireInstallationAdmin`

`packages/occ/src/namespace-operations.ts:listNamespaces`, `packages/occ/src/agent-queries.ts:listAgents`

Agent and Secret requests use the selected Namespace. OCC filters Installation
Namespaces and exact Agents by read permission. The Console requests Agents
only for a readable Namespace.
`GET /backends` ignores selection and requires Installation `administer` before
returning safe startup summaries. Empty configuration returns an empty list;
missing wiring or failed dependencies return errors.

`apps/controller/src/console/secrets.mts:renderSecrets` lists metadata and reads
the exact Secret's `consumers` and advisory `callerPermissions` before showing
actions, as the [Secrets guide](../guides/console/secrets.md) describes. Agent
names come from the readable Agent list. Known references disable Delete; the
server rechecks them. `console.mjs:takeLinkedSecret` keeps a `secret` link's ID
until the page shows it. Create and replacement wait for Namespace readiness.
Mutations use the tracked request client and Secret API, never a Driver.

`secrets.mjs:editValue` masks new input, preserves whitespace (CRLF becomes LF),
and clears it after the request, dismissal, or view retention
(`console.mjs:clearPasswordInputs`). Pending requests block navigation and
dismissal. A denied write disables submission; an unconfirmed write cannot be
replayed from that dialog. `secrets.mjs:confirmDelete` offers an explicit exact
status read after an uncertain delete; a denial never confirms removal.
Replacement hands delivery to explicit Agent deployment or CredentialSource
update under the [Secret delivery contract](../reference/drivers/kubernetes-secret.md#update-and-redeploy).

The Controller queues provisioning. HTTP 201 triggers
`apps/controller/src/console/namespaces.mts:confirmCreation`.
Exact list membership enables **Open Agents**. Inconclusive reads offer another
GET. Omissions and denials offer **Done**. Closing restores focus. A create 403
disables creation for that account until Refresh.

`namespace-deletion.mts` blocks navigation/dismissal during writes. OCC rechecks
IAM/contents (20 blocker IDs/kind). `202`: three-second polling; `404`: remove row,
repair selection; `403`: lost access. `readStatus` requires exact ID and scalar
[NamespaceSchema status](../../packages/contracts/src/api/resources.ts). Failed/invalid
reads close confirmation. Uncertainty shows **Status unknown**;
[**Refresh status**](../guides/console/delete-namespace.md) restores confirmed status
and deletion actions.

Agents, Secrets and Create Agent read Namespace permissions. False `agents.create` or an Agent-refusing
[Namespace status](../reference/namespaces.md#lifecycle) explains why, rechecking on return; failed reads keep creation open.
Refused `GET /installation` saves only drafts. `agents/collection.mts` polls provisioning Namespaces;
omission disables Create (`NAMESPACE_MISSING`), clears rows and feedback, closes
confirmations, and ends polling. Its note replaces empty states. Late outcomes are
generic, without replay; 401 expires the session. Focus: Search. Failed reads retry.

See [Agent setup and provisioning](platform-console/agent-creation.md).

### 4–6. Edit the Agent and access runtime files

[Agent editing](platform-console/agent-editing.md) traces version rendering,
channels and credentials; [workspace files](platform-console/agent-workspace-files.md) and
[stop and deletion](platform-console/agent-stop-and-deletion.md) trace those operations;
[Agent sharing](platform-console/agent-sharing.md) traces policy writes.

`channels/slack.mjs:supportSlack` rejects shapes the editor cannot preserve. The
[editing flow](platform-console/agent-editing.md#4-render-draft-revision-or-channels)
owns DM policies and channel-only reply defaults. Admission snapshots native values;
Kubernetes `prepareRevision` carries them into `openclaw.json` without adding defaults.

`apps/controller/src/console/agents/detail.mts:renderAgentDetail` registers tabs
with `console.mjs:loadPage`. Within one Agent, Namespace and version, tabs replace
content; shell, native-admin and version controls remain mounted. Configuration
and revision reads are shared; direct Workspace URLs start neither. Refresh,
version changes and successful channel/authentication edits reload fully.
`console.mjs:deniedReadsFor` remembers audited Configuration/revision `403` paths
in owner-scoped tab `sessionStorage`. Later views show **Configuration unavailable**
without rereading; **Retry** forgets and rereads. Logout clears denials.

`agents/detail.mts:renderTab` reveals clipped tabs horizontally without changing
focus or vertical scroll. Its ResizeObserver repeats on resize, disconnects for
inactive/detached views, and re-arms on resume.
Tabs retain DOM/drafts except during pending/failed reads, passwords or mutations;
unmounted responses are ignored.
[Draft captures](platform-console/agent-editing.md#4-render-draft-revision-or-channels)
exclude passwords. Secret saves update the shared snapshot.
`agents/detail.mts:boundSecretsDenied` reuses Deploy's authorized names.
Configuration excludes Harness-only Secrets; Plugins/Credentials include them.
Epochs fence publication; rechecks clear names and refresh authorized reads.
Deploy keeps its last Secret operate answer until the refreshed one lands.
Late names preserve state/focus; metadata failures keep IDs; unknown grants stay generic.

[Save handling](platform-console/agent-editing.md#5-save-authentication-and-deploy-the-first-version)
owns receipts and draft retirement.

**Open vN Logs** opens the failed version from any version or draft. Logs reserves space;
Stop and Delete stay put. Direct navigation focuses and scrolls to the output; selecting
the tab leaves visible output in place. Recovery links scroll their version tab into view
and focus its tab control, smoothly unless the page rebuilds or motion is reduced.

[Runtime logs](agent-runtime-logs.md) explains access. A false `readLogs` in the Agent
permission answer skips the audited log read. Status `403` hides Pod details, not
separately authorized logs. Denials last until logout; newly granted `operate` permits another
status read. Refused reads or downloads clear the rows; late successes cannot restore them or
download. Refusing allowed log text rereads status at once, superseding stale reads. Back
rebuilds refused views, else shows the checked page. Refresh keeps rows and cursor until
replaced; rate-limit notices update at the retry time without rereading. New streams or
rejected cursors clear rows.

### 7. Commit only the current response, or clear the view

`apps/controller/src/console/console.mjs:loadPage`, `logout`

After full-page navigation settles, `loadPage` focuses the destination heading if
focus fell to the body, using `preventScroll` to preserve return position. An Agent
opened from the list focuses its heading when the title renders. Tabs (one Tab
stop; arrows move) and focused controls keep focus. Navigation, Namespace changes, and logout invalidate
reads; generations reject late responses. Refocus coalesces events.
`revalidateMountedAgent` rechecks session, Namespace, Agent, version, and
[permissions](platform-console/agent-stop-and-deletion.md#stop-agent) with fresh reads.
`apps/controller/src/console/agents/detail.mts:syncHarnessRead` refreshes Sandbox
status once when admission confirms the same active, desired-running dedicated
version. A lifecycle change clears the old status and cancels its read before
any extra version lookup. Mismatched or unavailable results show unknown. A
current access refusal retires protected details. The Console sends no serving
test request.
Unchanged access keeps controls, input, and saves. Repeated draft 403s preserve
partial Agents with never-readable drafts. Checks skip versions already proved
unreadable. Access loss clears protected views. Other pages, including 403s and
404s, revalidate before reuse. Forms defer checks.
Unchanged views can restore focus to retained controls. If the reader leaves
again during **Still checking…** and the check succeeds in the hidden tab, the
Console remembers the Configuration editor with selected text. The next
successful foreground check can refocus that editor in the same view. Newer
focus or selections take precedence. Draft save baselines stay Namespace-scoped.

Other admission failures clear affected content;
a current protected `401` clears all private state. `pagehide` clears
private DOM, previews, and drafts even for BFCache; persisted `pageshow` performs
a fresh load. Failure views show local reasons and `req_<UUID>` request IDs. The
only backend text they show is a refusal the API explains (a 400 naming the field or
rule, a typed 409 naming the state), set as text. Backend authorization denial clears every retained preview,
including other Namespace selections, because the permission is Installation-wide.

The [detail action flow](platform-console/agent-stop-and-deletion.md#stop-agent) traces
acceptance, uncertainty, and replay guards. `agents/deletion.mts:refreshStatus` owns polling: 404 returns to Agents;
Postacceptance 403 stops polling without claiming completion.
See [asynchronous cleanup](../reference/agents.md#deletion).

Logout first hides private state, then calls the sign-out endpoint.
Confirmed success or session inspection proving absence replaces history with
login. An unconfirmed logout stays blocked with Retry. The
[authentication flow](local-password-authentication.md) owns server revocation;
this client never infers it from a network error.

<span id="deploy-the-saved-draft"></span>

<span id="deploy-the-new-revision" class="anchor-alias"></span>

## Deploy the new version

**Deploy new version** on the **Create new version** draft sends bodyless
`POST /namespaces/:namespaceId/agents/:agentId/deploy` after the checks and
uncertain-response handling that [Agent editing](platform-console/agent-editing.md#4-render-draft-revision-or-channels) traces.
**Operator-managed credentials** (`{ "method": "runtime" }`) skip managed setup; OCC
does not validate host credentials. The server saves the version; its read-only
details open while **Deployment activity** follows it. Workspace reads check
gateway startup and file availability.

## Debugging and Verification

- Match the displayed request ID to controller logs.
  A Namespace-only user cannot discover Backends; check Installation authority
  before treating that denial as a configuration problem.
- Browser suites use real Fastify, Better Auth, Native IAM, and in-memory storage.
  They verify navigation, isolation, creation, draft/history/channel editing, and
  authentication, not PostgreSQL persistence, Backend health, runtime dispatch,
  worker leases, or Compute effects.
- `node --test tests/browser/console-secrets.test.ts` exercises Secret mutation,
  Agent references, denials, and lost replies with passive test Secret storage.
  The `console-secrets` [QA scenario](../testing/ci/qa-advisory.md) selects real
  shipped storage; it requires the documented runtime and credential setup.
- API tests cover safe discovery, permission boundaries, empty versus missing
  wiring, static MIME/allowlisting, and unchanged API JSON errors. See
  [Testing](../testing/README.md) for commands and the image smoke boundary.

## Related docs

- [Namespaces](../reference/namespaces.md)
- [Authentication](../reference/authentication.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-22 11:28: Clarify Namespace list results. (authoring-run/d86bdf09-8b77-410f-8646-4feb7a9071cf - 5aa97a22d8d7d1ed8ca31a18d9892ad0313e24c6)
- 2026-11-22 11:16: Trace the read after Namespace creation. (authoring-run/4f0bae81-577e-4c6c-b34e-daa95bc82a3c - ad54d29adb562767e830020c504302479159c578)
- 2026-11-22 08:59: Trace keyboard search. (authoring-run/d7fa729b-2fe9-40b9-be53-eb2e0051e95c - f3996c521e94d8bf18ff9018069c699dda6913c6)

- 2026-11-22 02:59: Refresh the active Sandbox observation on Agent refocus. (authoring-run/2adc51f8-4b63-4436-af89-e2e8c4bb112b - 72a9006ec8c4b7a6e40947d75938f1518c7da364)
- 2026-11-21 19:15: Bind lookup. (authoring-run/71c8077a-06c3-42e4-9baf-a6bed016ab3d - e263cecbf94cb066d7c1b7879c57f47906ad495b)
- 2026-11-21 17:32: Preserve Agent URLs during lookup. (authoring-run/69ddfde5-0b74-4693-aebc-0deb1f64b083 - d91fdd7efd430c326419e17dacb9ce05d3aa5d2c)
- 2026-11-20 19:04: Refresh sources. (authoring-run/8a8bde8b-71de-4de5-80bf-e32f0e335c34 - 220f62d86ceb3dfc6f66dbee7c6f86cda50e5d05)
- 2026-11-20 16:29: Update source pointers for runtime observation and fleet inventory. (authoring-run/c41017eb-dc85-4c43-90e8-3040fbace6ac - c6acc7271f7753f74d3657251f23a036c08e671c)

- 2026-11-10 19:58: Confirm Agent permissions on foreground replacement views. (authoring-run/57445f4b-6a65-40ef-9674-e13c069e9ba1 - 218f9a954709d3b45b33c1155ff8bd0f08c71c9b)

- 2026-11-10 19:34: Apply fresh Agent permissions on tab return and honor the latest retry deadline. (authoring-run/0b2e6bf4-e95a-40bc-bb95-bfba7d8bf0d6 - 62a330c3d6f9bb36f2772b6bcbae9c6d07063c2a)

[Platform console request documentation history](platform-console/history.md) preserves the older dated entries.
