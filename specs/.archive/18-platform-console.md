# Feature Spec: Platform console bootstrap

**Date:** 2026-09-01
**Status:** Completed — read-only resource UI; [PR #12](https://github.com/openclaw/openclaw-enterprise/pull/12)
**Owner:** OCC console / controller
**Current reference:** [Platform console](../../docs/reference/console.md)

## Problem and Decision

Add a small controller-hosted browser console for login, Namespace selection, and existing-resource lists, following the [platform design](../../docs/design.md). Use static HTML/CSS and a small browser module; independent frontend tooling is unnecessary for this phase.

Source baseline: fetched `origin/main` **`b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d`**. The [workspace](../../pnpm-workspace.yaml) and [authentication reference](../../docs/reference/authentication.md#session-lifecycle) contain an existing backend but no active console. Provider discovery is proposed below, not baseline behavior. Implementation base: `origin/main` `a222ae3182a3dfd7dd8cd56c34f20b0e9b5ed09e`, integrated in `97911d3`; the Provider abstraction is present there. Provider discovery and the console remain the work defined here.

![UI wireframe reference](https://raw.githubusercontent.com/openclaw/openclaw-enterprise/785544cee72f5d022c38fa55271c727644a99f23/specs/assets/18-platform-console-wireframe-reference.png)

[Earlier wireframe](https://github.com/openclaw/openclaw-enterprise/blob/785544cee72f5d022c38fa55271c727644a99f23/specs/assets/18-platform-console-wireframe.png). These images guide the layout; their create/detail annotations remain deferred under this spec's scope.

## Scope

Include login, the wireframe shell, accessible menus, Agents/Providers/Namespaces lists, minimal Settings, and Logout. Defer all creation APIs/UI, resource writes, instance detail screens, and other management workflows. Omit create/detail affordances, including disabled placeholders. Signup, SSO, password recovery, dashboards, and a settings suite are outside this phase.

## Contract

### Authentication

Follow the existing [authentication contract](../../docs/reference/authentication.md) and [implementation](../../apps/controller/src/auth/index.ts). The form has **Username** (email input; “Use your account email”), masked **Password**, and **Login**. Use username/current-password autocomplete, current input validation, unchanged passwords, Enter submission, and duplicate-submit protection.

Send exactly `{email,password}` to `POST /api/auth/sign-in/email`; use same-origin session cookies. Credentials/tokens never enter storage, URLs, or Authorization headers. Keep email after failure; clear passwords after success or departure. Invalid credentials get generic feedback; `429` asks users to try later; dependency/network failures offer Retry.

On load and browser Back, check `GET /api/auth/session` before protected reads/content. `data:null` shows login; dependency failure offers Retry. Valid sessions skip login. Login success opens Agents or a validated same-origin supported `/console/` return route.

Logout calls `POST /api/auth/sign-out`, immediately stopping reads and hiding private content. Confirmed success or a session check proving `data:null` clears selection/caches and replaces history with login. Failure keeps a blocking “Could not confirm logout” view with Retry; never redisplay cached resources or claim revocation.

### Navigation and selection

The sidebar lists **Agents**, **Providers**, **Namespaces**. Main content shows the feature title, scope, **Refresh** (disabled while pending), and simple rows. Show names and selectable IDs; Namespace rows include server lifecycle status, Provider IDs serve as names, and Agents have no invented health status. Rows are noninteractive.

The bottom **OpenClaw Enterprise** button toggles a menu containing **Namespace: <name>**, **Settings**, and **Logout**. The Namespace submenu lists readable Namespaces. Hover only opens it; click/touch, Enter/Space, arrow-key navigation, Escape/focus return, and outside dismissal must work. Announce expanded/current state and maintain visible focus. Narrow layouts preserve these actions through a drawer.

Routes are `/console/login`, `/console/agents`, `/console/providers`, `/console/namespaces`, and `/console/settings`; `/console/` resolves session/Namespace then redirects to Agents. Settings shows signed-in name/email, “No configurable settings in this release,” and Back to the prior collection. Unknown console paths share one not-found view linking to a collection; never fetch details or write resources.

Carry `?namespace=<id>` across authenticated routes, including global pages, refresh, and Back. Validate against readable Namespaces. Without an explicit selection, choose the first `ready` Namespace, otherwise the first readable one, ordered by name then ID. Sketch names are examples. An explicit unavailable selection shows “Namespace unavailable” and a switch action, never silently substituting another Namespace. No readable Namespaces means no Agent request; keep global navigation and explain administrator provisioning/access is needed. All returned lifecycle states remain viewable.

Switching preserves the feature: Agents refetch; Providers/Namespaces remain visibly Installation-wide. Revalidate Namespace access on route entry/refocus. Key reads by user, feature, Namespace, and session/navigation generation; immediately clear old rows when switching, cancel obsolete reads, and ignore their successes **and errors**. Old reads cannot change selection, redirect, or restore private state after logout.

### Collections and shared states

| Collection | API and authority | Row data |
| --- | --- | --- |
| Namespaces | `GET /namespaces`; Installation collection filtered by exact Namespace `read` | ID, name, lifecycle status |
| Agents | `GET /namespaces/:namespaceId/agents`; Namespace `read`, then exact Agent `read` filtering | ID, name |
| Providers | Proposed `GET /providers`; singleton Installation `administer` through existing IAM | ID, type |

Existing [routes/schemas](../../packages/contracts/src/api/routes.ts) and [list implementation](../../packages/occ/src/index.ts) own Agent/Namespace behavior. Collections return `{data:[...],meta:{requestId}}`; no query parameters or pagination. Sort returned rows by name/ID. URL Namespace selection is UI state, never a global API selector. Server IAM remains authoritative; do not fetch broader data for client filtering.

Use one shared state model: loading retains heading/scope without old rows; authorized empty results explain no accessible/configured resources and offer Refresh; read failures show Retry and request ID when available. Network/`500`/`503` failures are unavailable, never empty. `403` clears affected data and shows access denied within the shell; `404` clears it and offers return/refresh. Malformed context/`400` offers valid selection. Protected `401` clears private state and opens login with “Your session has expired.”

### Provider dependency

Provider configuration and creation will be API-managed in the subsequent creation spec. This phase reads validated, loaded operator configuration after verifying the accepted, landed [Provider abstraction at `a635483`](https://github.com/openclaw/openclaw-enterprise/blob/a635483aa62d41df7b45040b89d9edf4a3cee725/specs/17-provider-driver-abstraction.md). The abstraction is present at the implementation base above; its source and [current reference](../../docs/reference/providers.md) govern integration. Dirty checkout proposals are not shipped evidence. Do not synthesize Providers from legacy `integrations.chatgpt` or Agents.

Proposed `GET /providers` returns `{data:[{id,type}],meta:{requestId}}` using ordinary API success/error envelopes and Installation authorization before disclosure. Controller composition explicitly passes safe summaries of loaded Provider definitions. No secrets, credentials, paths, clients, full configuration, upstream calls, reloads, or new storage. “Configured” makes no health/activation claim. Authorized `[]` is valid; absent wiring or unavailable configuration/IAM is an error. Real Provider discovery is required for completion, though other views can proceed independently.

## Implementation

1. Add static HTML/CSS and a browser `.mjs` under `apps/controller/src/console`; keep the existing workspace/TypeScript projects. Connect authentication, menus, routes, and collection reads.
2. After verifying the Provider dependency, add discovery to [controller routing](../../apps/controller/src/index.ts) and shared contracts. Reuse IAM, errors, and request metadata.
3. Serve only public console assets under `/console/` on the controller origin; never expose arbitrary controller sources. Package assets in the existing [Dockerfile](../../Dockerfile). Preserve API JSON/404/405 behavior, MIME correctness, trusted-origin/cookie admission, and loopback/ClusterIP boundaries; refresh fallback applies only to console routes.
4. At implementation, add one console reference and link it from the [docs index](../../docs/README.md), [quickstart](../../docs/guides/quickstart.md), and [deployment guide](../../docs/guides/deploy.md). Update authentication's “no login UI” claim and [architecture's](../../docs/ARCHITECTURE.md) deferred-console claim; regenerate API documentation for Provider GET.

## Verification

Acceptance outcomes:

- **Browser:** real login/session/logout routes, reload/Back and safe returns; keyboard/click/narrow-layout menus, Settings, Refresh, selectable IDs, and generic recovery. Exercise all shared states, failed logout, two-Namespace delayed success/error races, access revocation, and expiry. Confirm global scope persists, no stale private content, no create/detail affordances or fetches, and only authentication uses POST.
- **API/IAM:** real supported resource setup proves list filtering and Namespace read requirements. Test Provider Installation-admin versus Namespace-only access, exact safe projection, authorized empty versus unavailable, canonical envelopes, and no writes/upstream calls. Verify trusted-origin rejection, secure production cookies, and no credentials in browser storage/URLs.
- **Static/build:** build/typecheck/workspace checks, packaged browser refresh, correct HTML/asset MIME, asset-only exposure, API JSON 404/405, and existing API/security suites.

Implementation verification (2026-09-01): 43 API/security tests and four packaged-image checks passed after integrating the latest main branch, including default-Namespace coverage. Build/typecheck, workspace, formatting, and generated API checks also passed. GitHub reported no active CI test jobs; its only reported check was skipped. Computer use in Chrome exercised the browser acceptance outcomes against real controller/auth/IAM routes with in-memory persistence and transport-only fault injection. The automated Playwright suite remains available but was not run; browser verification followed the requested computer-use method. No production deployment or live Provider/runtime verification is claimed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 11:59: Recorded the user's decision that Provider configuration and creation will be API-managed; retained read-only discovery in this bootstrap spec and deferred the creation contract to the subsequent spec. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)
- 2026-09-01 11:54: Narrowed this spec to UI bootstrap and existing-resource lists at user request; deferred all creation UI and removed the Provider write-ownership decision. Defined minimal read-only Provider discovery. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)
- 2026-09-01 10:59: Proposed the platform console from the supplied wireframe and current source, separating Provider branch dependencies and deferred detail screens. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)
- 2026-09-01 13:08: Simplified the bootstrap scope to controller-hosted static assets, shared contracts and states, selectable IDs, generic route recovery, and three proof groups; preserved read-only boundaries and deferred creation/detail screens. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)
- 2026-09-01 13:13: Added the supplied UI wireframe as an embedded reference, retained the earlier image, and kept creation/detail annotations outside the bootstrap scope. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)
- 2026-09-01 13:18: Started implementation on dev/kevinlin/platform-console after integrating the landed Provider abstraction at a222ae3; retained the approved read-only console scope. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - 97911d361ac02ddf561e46c8af0864ad66a6df45)
- 2026-09-01 15:04: Completed the read-only console, safe Provider discovery, source/docs review fixes, and local API/image/computer-use verification. Corrected the browser fixture to expire Date-valued auth sessions; creation and detail screens remain deferred. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - 97911d361ac02ddf561e46c8af0864ad66a6df45)
- 2026-09-01 17:15: Marked the read-only console complete for PR #12 and archived this implementation record; preserved Manual Notes and wireframe assets, and recorded the final local verification and CI limits. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - f7136f901f32a7080b8213164b3d32037b3f0148)
