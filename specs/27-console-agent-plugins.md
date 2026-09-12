# Feature Spec: Console Agent plugin selection

**Date:** 2026-09-09
**Status:** Planning — draft pending independent reviews and user checkpoint
**Owner:** Platform console; Agent contracts and plugin Driver maintainers

## Problem and Decision

Add a dedicated **Plugins** section to Agent creation: search the configured
Driver's catalog, select valid plugins, and save those selections with the Agent.
Prove the resulting dedicated Codex runtime can call a selected plugin through
a real Agent turn. A catalog entry, saved selection, or successful deployment
alone is not proof of installation, account eligibility, or tool execution.

At `ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716`, the [creation form](../apps/controller/src/console/agents/create.mjs)
saves Configuration then Agent and does not deploy. Agent contracts have no
selected-plugin field. The native Configuration's `plugins.entries.codex`
enables the OpenClaw harness extension; it is not a curated-app selection list.

The dependency task `01a088a1-94f8-7860-9b77-be2f9d6af52b` proposes specs 23–26:
bundled catalog, list API, best-effort plugin installation, and deployment status.
Those are unimplemented proposals, not current support. This spec adds the two
consumer contracts below for joint approval; it does not silently amend them.
Use the [current console wireframes](assets/19-console-agents/index.html) and
[console reference](../docs/reference/console.md) for layout and behavior.
The private launch-claw-ent gallery `reports/legacy-console-screenshots-2026-09-01/index.md`,
especially `30-claw-create-tools-permissions.png`, supplies historical search/section
prior art only; its demo tools and policy controls are not implementation contracts.

## Scope

- Accessible typeahead multi-select in creation; persisted Agent selections and
  immutable revision snapshots; visible deployment/plugin outcomes.
- Initial plugin-backed creation targets dedicated Codex and users authorized
  both to create the Agent and to discover the Installation catalog.
- No custom marketplaces, freeform plugin IDs, account linking, credential entry,
  policy editor, plugin details, post-creation selection editing, or new call API.
  Keep native per-call approval; selecting a plugin never grants automatic approval.

## Contract

### Configured catalog and authorization

Proposed change to dependency spec 24: allow `GET /plugins` without `driverId`
to resolve the controller's selected catalog adapter; explicit
`GET /plugins?driverId=codex` retains its defined behavior. The release-owned
adapter registry supplies the configured default (`codex` initially), not browser
constants, Agent provider, or Compute Driver ID. No generic seventh Driver
capability or separate discovery endpoint is introduced. No configured adapter
returns 503; an explicitly unknown adapter returns 404.

Reuse specs 23–24's `data` envelope exactly: `driverId`, `inventory` metadata,
and `plugins: [{id, remoteMarketplaceName, pluginName, version}]`. Treat `id` as
opaque and unique within that Driver. The API returns the whole bundled catalog;
typing filters it locally by plugin name, marketplace, or ID without more requests.
Display `pluginName` with marketplace secondary text, never synthesize IDs.

Discovery retains Installation `administer` authorization. Namespace-only creators
see “Plugin catalog requires Installation administrator access” on 403 and may
create without plugins. Do not broaden IAM or proxy an administrator's credentials.
Server admission requires that same catalog permission when selections are nonempty,
in addition to existing exact Namespace/Agent-creation authorization.

### Selection and creation

Place Plugins after runtime/association fields, separate from native JSON and
Channels. Use a labelled combobox and result list with arrow navigation, Enter to
select, Escape to close, visible focus, announced loading/errors, and removable
selected chips. Enter inside the picker never submits the form. Show driver and
“Available in this release; installation and account access checked on deploy.”

Membership in the successfully loaded catalog is required; reject duplicate
`(driverId, id)` pairs and arbitrary typed text. A query with no matches is distinct
from a valid empty catalog, loading, denied, or unavailable catalog. Provide an
explicit retry; unavailable discovery permits an empty selection, not silent loss
of an existing selection. Render all catalog values as text, not HTML.
Only dedicated Codex supports selections initially. Switching to embedded with
selected plugins requires explicit removal or cancellation; never silently clear.
Reuse view-lifetime cancellation on Namespace changes, navigation and logout.

Extend `POST /namespaces/:namespaceId/agents` with optional
`plugins: [{driverId: "codex", pluginId: "<catalog id>"}]`; omitted means `[]`.
This spec owns the creation payload and Agent read projection of that same field.
Persist selections atomically with Agent creation, not in shared Configuration.
Resolve native locators from the server catalog; never accept client-supplied
paths, install URLs, marketplace overrides, account tokens or approval grants.
Invalid/duplicate identities or unsupported mode return 400; unavailable catalog
returns 503; failed admission creates no Agent or partial selected set.
The server validates independently of the browser against its current catalog.

Retain the existing Configuration-first flow and Agent-only retry after a known
failure. Freeze mode, saved JSON and selection while an Agent write is in flight.
A known rejection retains selections for correction; an ambiguous response must
not trigger an automatic repeat. Follow existing unknown-outcome handling and
offer the Agents list to locate the possibly created resource. Creation still
navigates to the saved Agent draft and never deploys automatically.

Dependency spec 25 owns copying the Agent's selections plus resolved native
locators into each immutable revision and installing them using the Agent's own
identity. Revalidate at deploy admission; later catalog changes do not rewrite
admitted snapshots. No controller/operator credential substitutes for runtime auth.

### Deployment feedback

On **Deploy saved draft**, consume spec 26's 202 `data: {deploymentId, revision}`.
Poll `GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId`
every two seconds while this view is active until `queued|running` becomes
`succeeded|failed`; cancel on navigation/logout. After two minutes pause with
“Still deploying” and an explicit Refresh, not a failure or another deploy POST.
Use the revision ID in the existing URL to recover the corresponding deployment
after reload. Poll failures show status unavailable with an explicit retry.

Show terminal `error` separately from `pluginErrors`. `succeeded` with nonempty
`pluginErrors` means “Deployed with plugin errors,” listing safe plugin IDs and
fixed error messages. No plugin errors means only no reported install errors,
not verified callable tools. Historical success is not current runtime health.
Keep deployment status read authorization and exact Agent/revision ownership.

## Implementation

1. Land and reconcile specs 23–26; coordinate the optional-driver list change
   and atomic Agent selection contract before implementing this consumer.
2. Update contracts, Agent persistence/read projection and revision admission in
   `packages/contracts` and `packages/occ`; reuse the dependency's installer.
3. Add `apps/controller/src/console/agents/plugins.mjs`; wire `create.mjs` and
   `detail.mjs` using existing API client, DOM helpers and view lifetime. No UI framework.
4. Update console/API/Agent references and the console flow with actual supported
   behavior, permissions and configured-versus-installed distinctions when shipped.

## Verification

- Add `tests/browser/console-agent-plugins.test.mjs` against the real Fastify/OCC/IAM
  fixture: keyboard search/select/remove, no-match versus unavailable, denied
  discovery, invalid-ID server rejection, duplicates, mode change, stale reads,
  saved selection/readback, immutable snapshot and no duplicate creation on retry.
  Verify real deployment status/plugin-error UI transitions with production routes;
  in-memory runtime coverage is not live plugin proof.
- Run `pnpm typecheck`, `pnpm openapi:check`, `pnpm check:workspace`,
  `pnpm test:console-browser` and affected persistence/API tests from repo root.
- Add a real-runtime browser case using the [testing setup](../docs/testing/README.md)
  and existing `harness-topology-k3d-real` infrastructure: disposable PostgreSQL/k3d,
  pinned real images and an authorized Agent identity with linked Google Calendar.
  A model API key alone does not establish that identity or linked-app access.
  Through the actual UI select the catalog's Google Calendar entry, create and
  deploy the dedicated Agent, then issue a native Agent turn through its gateway
  to read a prearranged harmless test-calendar event. Satisfy native approval if
  requested; assert the tool result and expected event, not just model prose.
- Retain a video of selection, save, deploy status and that Agent's visible result,
  plus correlated Agent/revision/deployment IDs and dedicated app-server tool-call
  evidence. No direct tool RPC bypass or manually preinstalled plugin counts.
  Record only test data; start after login and exclude tokens/credentials.
  Save video, screenshots and proof manifest in the run's private artifact directory;
  report actual paths, image digests and commands. Missing catalog entry, credentials
  or runtime is a named acceptance blocker, never a mock substitute or passing skip.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-09 17:20: Drafted UI, dependency contracts and live proof criteria (01a05901-204b-7b52-b9da-527ee94cbf81 - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716).
