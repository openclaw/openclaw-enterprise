# Feature Spec: Agent plugin drivers

**Date:** 2026-09-08
**Status:** Implemented port; live-runtime acceptance incomplete. Current contract: [Agent plugins](../docs/reference/agent-plugins.md)
**Owner:** OCC and bundled PluginDriver implementations

## Problem and Decision

Add Agent-scoped plugin management through one Installation-selected `PluginDriver`: `OCCPluginDriver` for embedded OpenClaw or `CodexPluginDriver` for dedicated Codex. OCC stores desired selections on the Agent; the next authorized deployment snapshots that requested map; Agent startup resolves the current curated metadata, validates representability, installs, and configures the native runtime for normal Agent turns. OCC provides no plugin-tool invocation API or new approval service.

This proposal adds Agent-owned configuration to the [platform design](../docs/design.md), whose plugin directory/approval work remains deferred beyond this bounded milestone. Preserve [Driver selection](../docs/reference/drivers/selection.md), exact-Agent authorization, immutable revisions, and separate Gateway/Harness credentials.

## Scope

- List curated installable/selected plugins; record plugin selections through Agent create/update; enable/disable a plugin or one of its tools; configure plugin/tool approval plus destructive-action/write overrides.
- Translate only semantics the selected native runtime already supports. Unsupported operations/combinations are accepted only as structurally valid desired state, then make the deployment/startup candidate fail or remain unready with startup diagnostics; changing OpenClaw or Codex, adding policy hooks, or approximating a requested review mode is out of scope.
- Use OpenClaw official and Codex curated catalogs only. No arbitrary source/version input, plugin-specific settings API, or new credential-management API.
- Defer Namespace plugin configuration, Code Mode enablement, importing all user-installed Codex plugins, and additional plugin permission/sandbox restrictions. Existing platform authorization and runtime restrictions remain mandatory.

## Contract

### Ownership, selection, and deployment

An Agent owns one `plugins` map keyed by an opaque, Driver-qualified catalog ID; no new `plugin` resource kind or shared Namespace selection is introduced. Each saved entry is policy-only. Empty is the default. A plugin update never modifies the Agent's reusable Configuration or another Agent. Driver settings belong to trusted Installation configuration, not API callers.

Add optional `drivers.plugin` selection with bundled IDs `occ-plugin` and `codex-plugin`; at most one is selected, with no automatic fallback. A missing selection permits existing plugin-free deployments. Agent create/update saves structurally valid plugin maps without catalog lookup. Deployment of nonempty selections requires a compatible selected Driver; startup validates catalog membership, Harness compatibility, native metadata, and policy representability. GET can still list saved entries after catalog removal or Driver changes; replacing the Agent's plugin map removes or changes desired selections.

Selections have required `enabled`, required `approvalMode`, optional `approvalsReviewer` (`user` or `auto_review`), optional `destructiveActions`/`writes` modes, and `tools` keyed by Driver-returned tool ID with optional `enabled` and `approvalMode`. Tool overrides inherit when omitted. The plugin-level reviewer applies to its owned tools; omission inherits the native reviewer configuration (Codex defaults to `user`). There is no per-tool reviewer field. Unknown fields, malformed IDs, and invalid enum values are rejected; well-formed catalog-missing IDs are saved and fail startup. `approvalMode` is required on initial selection so installation does not silently choose a review policy. Disabled always wins over approval settings.

Deployment snapshots the requested selections and selected Driver `{id, implementation}`. It does not snapshot resolved Codex release identities, app mappings, or native configuration artifacts. Startup resolves current curated metadata and translates it into native configuration inside the workload. A retry or restart can therefore resolve a later curated release for the same requested catalog ID. Do not store credentials in the Agent, revision, or plugin status. Native values outside Driver-owned plugin fields are preserved; incompatible raw Configuration values targeting those fields fail the deployment/startup candidate instead of silently overriding either owner. No shared Configuration mutation or new Configuration kind is needed. [Current Agent/revision contracts](../packages/contracts/src/index.ts)

Agent create/update changes desired state only. Existing turns and the active runtime keep their old plugins and policy until a later deployment begins runtime cutover. Removing a map entry removes desired selection; disabling retains it. Removal is not immediate revocation and does not interrupt active turns. Desired changes and revision admission use the existing state transaction so each revision contains a consistent selection set.

### API

Reuse the existing Agent create/update routes and API envelopes. Authorize exact Namespace Agent `create` for Agent creation and exact Agent `update` for Agent updates, plus the existing exact Configuration and ServiceAccount reads. Namespace membership alone grants nothing.

| Route                                                  | Plugin input           | Result                                                                                                              |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /namespaces/:namespaceId/agents`                 | Optional `plugins` map | `201` Agent response with saved policy-only map; no catalog lookup or runtime installation                          |
| `PATCH /namespaces/:namespaceId/agents/:agentId`       | Optional `plugins` map | `200` Agent response. Omission preserves the existing map; `{}` clears it; a nonempty object replaces it completely |
| `GET /namespaces/:namespaceId/agents/:agentId/plugins` | none                   | `200 {data: rows, meta:{requestId}}`; combined curated/selected inventory and desired-versus-installed status       |

Each list row has `id`, `name`, `available`, nullable `desired`, `installed`, and nullable `tools:[{id,name}]`. `desired` is the saved policy; `installed` means the active revision contains that plugin and its initial `agent_revision:<revisionId>:reconcile` work item reached `succeeded`, including disabled installations. Use existing revision endpoints for revision details. Saved entries remain listable after catalog removal or Driver changes; only a compatible selected Driver supplies current catalog availability. Public plugin IDs qualify native catalog IDs with their owning Driver identity.

A curated entry must supply reliable, release-specific tool IDs and native destructive/write metadata before startup can enforce tool or category policy. Use existing catalog/native runtime metadata, not a new inspection service. If unavailable, LIST returns `tools:null` (unknown, not empty), and a saved tool/category request fails the deployment/startup candidate with diagnostics; plugin-level operations remain eligible when existing native configuration can enforce them. With authoritative metadata, unknown tool IDs fail startup. Missing annotation fields within known native metadata use the conservative defaults below.

Agent update uses full replacement for the plugin map. Omission preserves existing selections. `{}` clears every desired selection. Supplying a nonempty object replaces the whole map, so callers add, remove, disable, or change entries by sending the complete desired set. `approvalMode` and `enabled` cannot be null. Omit `approvalsReviewer` or optional category/tool overrides to inherit native behavior. Agent and inventory responses expose no credentials or unredacted runtime configuration. Reuse attributable mutation/denial audit and request IDs; append one successful Agent mutation event atomically with the Agent write.

Return 400 for invalid request shapes, 404 for missing/cross-Namespace Agent or Configuration, 403 for denied authorization, 409 for ordinary Agent conflicts, and existing 503 for temporarily unavailable platform dependencies. Do not validate catalog membership or policy representability at Agent write time. Valid unsupported settings are saved and later reported on the failed deployment/startup candidate. Never turn authentication failures, timeouts, or missing packages into 501 during admission. [Existing error mapping](../apps/controller/src/index.ts)

### Approval meaning and precedence

| Mode     | Requested plugin-tool behavior                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `always` | No plugin approval step; existing authorization, enablement, and other restrictions still apply                                          |
| `never`  | Tool execution blocked, not merely hidden from the model                                                                                 |
| `prompt` | Request approval for each call through the effective reviewer; no reusable consent                                                       |
| `auto`   | Codex native `auto`: use native tool annotations to decide whether approval is needed, subject to native policy and remembered approvals |

Approval mode determines when review is requested; `approvalsReviewer` chooses who handles the request: `user` for human review or `auto_review` for Codex AutoReview. For example, `{approvalMode:"auto", approvalsReviewer:"auto_review"}` uses AutoReview only when Codex's native approval flow reaches review; `{approvalMode:"prompt", approvalsReviewer:"auto_review"}` requests AutoReview for each call. Reviewer selection alone neither forces review nor changes `always`/`never`. Preserve native policy, hook, and remembered-approval semantics for `auto`; do not implement an Enterprise review loop.

For enabled tools: explicit tool mode → stricter applicable category override → plugin default. Category strictness is `never > prompt > auto > always`; it orders our requested policies, not the probability of a reviewer allowing a call. A destructive tool is one with native `destructiveHint=true`; writes means native `readOnlyHint` is not true. Missing destructive metadata is conservatively treated as destructive. Explicit tool mode can override a category; disabling a tool/plugin cannot be overridden.

Classify using that native metadata, not names or an LLM guess. If the runtime cannot preserve this precedence or enforce it for the selected plugin's tools, fail startup with diagnostics. Do not create a generic policy engine or assume annotation truth proves harmlessness. Tool-specific policies apply only to the resolved tool set; plugin-wide policies must cover every owned tool, including when catalog tool metadata is unavailable.

### Configuration-only capability mapping

| Surface                                                | Supported translation / limit                                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw plugin enable/disable                         | `plugins.entries.<id>.enabled`, with exact selected plugin loading; preserve required built-in infrastructure plugins                                                                                      |
| OpenClaw tool enable/disable / `never`                 | Currently fails startup: curated tool metadata is unavailable. Future translation requires authoritative ownership and native tool grants/filters                                                          |
| OpenClaw `always`                                      | Add no plugin approval request; do not remove pre-existing operator restrictions                                                                                                                           |
| OpenClaw `prompt`, `auto`, reviewer/category overrides | Startup failure unless the current existing configuration exposes equivalent trigger/reviewer semantics; generic native plugin schema currently provides none. No new Enterprise hook                      |
| Codex plugin enable/disable                            | Native Codex app/plugin enablement plus the existing OpenClaw `codexPlugins` bridge with `allow_all_plugins:false` and selected curated entries; activation never admits unrelated user plugins            |
| Codex `auto` / `never`                                 | Bridge selected curated Codex `auto` to native Codex auto approval semantics; `never` or `enabled:false` disables the selected bridge entry                                                                |
| Codex `always`                                         | Set per-plugin `allow_destructive_actions:true`; accept supported approval requests without prompting. Explicit `auto_review` with this mode fails startup because native review can run before the bridge |
| Codex `prompt`                                         | Startup failure; the bridge does not force approval for every call, including read-only calls                                                                                                              |
| Codex `approvalsReviewer`                              | Map to the selected owned app's native `approvals_reviewer`; `auto_review` mirrors native Codex AutoReview reviewer semantics                                                                              |
| Codex reviewer conflicts                               | App reviewer is per app. Explicit reviewer requests that cannot be enforced at that scope fail startup; never change another plugin or unrelated tool's reviewer                                           |
| Destructive/write overrides                            | Currently fails startup: curated tool metadata is unavailable. Future translation requires exact native reductions; native `writes` is only a review trigger                                               |

Codex native `auto` requests approval for explicitly destructive tools; otherwise read-only tools skip approval, and remaining tools use destructive/open-world hints with conservative defaults for missing hints. Use the pinned runtime's implementation of this decision. Current keys are documented in the [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference); [managed policy](https://learn.chatgpt.com/docs/enterprise/managed-configuration) can further constrain them. Direct `mcpServer/tool/call` is not the model review path and is never used for Agent execution by OCC.

`CodexPluginDriver` supplies discovery from the existing `openai-curated-remote` catalog and shared policy translation. Compute writes the Agent's isolated native Codex configuration at startup and applies the separate OpenClaw bridge configuration when supported curated apps are selected. The bridge sets `codexPlugins.enabled:true`, keeps `allow_all_plugins:false`, and includes one entry per selected plugin. Native app configuration carries optional `approvals_reviewer`, translated from Enterprise `approvalsReviewer`; unrepresentable modes and tool/category requests fail startup rather than approximating the requested policy.

Start with no user plugins/apps enabled, while retaining Codex inventory capability and the OpenClaw Codex transport plugin required by dedicated Agents. Never copy an owner's plugins/marketplaces/app configuration into the Agent. Deny implicit remote-installed plugin admission outside its selected set. Required infrastructure capabilities are distinct from user plugin selection. Reject configurations that prevent the requested contract, such as bypassing every-call `prompt` or silently ignoring an explicit reviewer; native `auto` decisions to skip review remain valid. Do not weaken managed constraints to make a request pass.

### Driver execution and failure

The bounded PluginDriver contract supplies catalog listing, startup selection validation, and native configuration translation. OCC owns metadata, IAM, transactions, and revision admission. Compute alone owns workload installation, readiness, lifecycle, runtime connection, and activation through existing preparation/runtime entrypoints. Driver calls receive exact Agent/revision context and abort signal through trusted composition, never a caller-supplied host or generic shell endpoint. Neither implementation installs agent packages in the OCC process.

During admission, snapshot only the requested plugin map and selected Driver identity. Existing Compute preparation/runtime entrypoints resolve curated IDs, validate the whole requested policy against the operator-pinned runtime contract, install the resolved releases through native lifecycle operations inside the exact workload, and apply the rendered configuration. Before readiness, verify installed identity and metadata through native APIs, plus the effective native configuration overlay; mismatch prevents successful readiness/activation completion. Codex owns its cache layout and integrity; Enterprise does not inspect private cache files. Real normal-Agent-turn tests verify model-level tool and reviewer behavior. Extend this preparation path to carry requested state and invoke shared translation, not a second Driver lifecycle. Existing lifecycle hooks expose only an environment map. [Current hooks](../packages/contracts/src/index.ts), [runtime startup](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)

Plugin files/configuration are revision-isolated; the persistent Agent workspace and embedded OpenClaw installation registry remain Agent-owned. Existing embedded gateways use serialized replacement, so startup installation begins after the old gateway stops. Retries reuse the requested IDs and policy, but may resolve the current curated release at that later startup. Native API requests stay on authenticated internal runtime transport. Preparation failure before the worker commits `activeRevisionId` leaves the prior pointer unchanged. Post-commit activation/finalization failure retains the candidate pointer and records `REVISION_FINALIZATION_INCOMPLETE` for retry; the prior revision record remains stored, but no pointer rollback or uninterrupted cutover is guaranteed. Inventory remains uninstalled until initial reconciliation succeeds (`REVISION_ACTIVATED` or idempotent `REVISION_ALREADY_ACTIVE`).

SSH Compute is excluded from plugin-enabled runtime realization in this
milestone. Agent writes can save structurally valid plugin maps while SSH is the
selected Compute Driver, but any nonempty requested plugin map fails before SSH
host effects. Plugin-free SSH revisions remain supported.

The next revision contains exactly the requested plugin set; resolved package files live only in the prepared workload and old revision files remain only until ordinary revision retirement. Reuse existing reconciliation/retry/retirement, with no separate plugin worker, revocation gate, approval ledger, or garbage-collection service. If unsupported behavior appears only during runtime preparation, report it through the existing failed/unready candidate path; the earlier asynchronous deployment response is not retroactively a 501.

## Implementation

1. Add `plugin` capability, Agent desired policy and immutable revision fields in `packages/contracts`, OCC state interfaces/PostgreSQL schema, and admission logic. Keep plugin configuration isolated from shared Configuration updates; add typed create/update schemas, IAM metadata, and atomic audit. Remove dedicated plugin mutation routes because Agent create/update now own the map.
2. Add bundled `OCCPluginDriver`/`CodexPluginDriver` and trusted `drivers.plugin` selection in controller startup. Reuse native catalog identities and existing plugin commands/APIs. Keep unsupported-policy checks local to startup translation; no public capability-negotiation framework or installed third-party Driver package support this milestone.
3. Extend supported Compute preparation/runtime assets with revision-owned plugin configuration/cache mounts and bounded native install/readiness calls. Codex config must land in its own `CODEX_HOME`; credentials stay in the current dedicated-Harness authentication path and out of revisions/logs. No new OAuth UI, credential import, or approval-hook implementation.
4. Add outcome-focused tests below and update `docs/reference/agents.md`, API/Driver reference, current runtime flow and deployment guide when implemented. Source snapshots alone do not establish image/version compatibility; record actual image and native runtime versions with integration results.

## Verification

| Required outcome                              | Proof                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact Agent ownership and delayed application | Real API/PostgreSQL flow: update A sharing Configuration with B; B and A's active revision unchanged; deploy A and verify its new policy                                                                                                                                                                                                                                           |
| Agent-owned replacement semantics             | Create with plugins, update with omission to preserve, update with a complete replacement map, and update with `{}` to clear. Unknown fields and malformed IDs fail structurally before save; catalog-missing IDs are saved and fail startup                                                                                                                                       |
| Curated inventory and tool configuration      | LIST returns curated entries from native catalogs plus saved selections; missing tool metadata yields `tools:null`; saved tool/category requests fail the deployment/startup candidate when metadata or translation is unavailable                                                                                                                                                 |
| One selected Driver and default deny          | Exercise separate Installation configurations for each implementation; mismatched Harness/unsupported policy fails deployment/startup; fresh Codex Agent exposes no user plugin tools or skills                                                                                                                                                                                    |
| Saved requested state                         | Switch/remove Driver selection or remove a catalog entry: saved entries remain listable, colliding native IDs stay distinct, and mismatched saved entries cannot start successfully under an incompatible Driver                                                                                                                                                                   |
| Approval translation                          | Native model-turn tests: always executes without plugin review, never does not execute, prompt requests each-call review where supported, auto matches native annotation/remembered-approval behavior. Exercise `user` and `auto_review` independently, including auto calls that skip review and prompt with AutoReview; incompatible reviewer/category combinations fail startup |
| Reviewer configuration                        | Agent create/update/GET/LIST preserve `approvalsReviewer`; omission restores native inheritance. Changes apply on next deployment; same-reviewer mixed modes work, while managed-policy rejection or unrepresentable shared-scope requests fail startup                                                                                                                            |
| OpenClaw integration                          | Real official plugin install on Kubernetes, successful plugin-tool execution during an Agent turn, disable/remove on later deployment, and a second Agent remaining unaffected                                                                                                                                                                                                     |
| Codex Google Calendar integration             | Curated Google Calendar installation authenticated as the service-account test identity below; successful harmless `list_calendars(max_results:1)` read chosen by the model in a normal turn. Missing metadata, auth, or result is a failed/unready test, not a skip/pass                                                                                                          |
| Preparation boundary                          | Failed install/metadata or policy mismatch cannot complete readiness; pre-commit failure preserves the prior pointer, post-commit failure leaves the candidate incomplete/uninstalled. Retry preserves requested IDs/policy but may resolve a later curated release; records/logs omit credentials                                                                                 |
| SSH Compute rejection                         | Nonempty requested plugin maps fail before SSH host effects; plugin-free SSH revisions continue to deploy through the existing SSH lifecycle                                                                                                                                                                                                                                       |

Use real native runtimes and existing API/Compute integration infrastructure,
not a direct MCP invocation as a substitute for Agent behavior. The local Codex
test fixture uses a narrow test-only ServiceAccount import to preserve the
designated existing account token from `~/.secrets/.env.claw-kevinlin-svc-acct`,
bind it to the matching Provider, and run the normal Agent create/deploy/API
path. It does not prove native ChatGPT account creation, upstream credential
issuance, workspace administrator credentials, or creating a new upstream
account. The Google Calendar fixture must prove that account has connector
access through `list_calendars(max_results:1)`; model API authentication alone
is insufficient. Keep credential values and resolved account identifiers out of
the spec, revisions, and logs.

## Implementation status

- Target-port implementation is complete on branch
  `dev/kevinlin/plugin-driver-port` from base `5c58b95c`; the initial port commit
  is `185afba1608260adfa5b1fe9bda9ee700a4d9fee` in
  [PR #121](https://github.com/openclaw/openclaw-enterprise/pull/121). The port
  includes Agent-owned plugin maps, atomic API/state/audit changes, immutable
  requested-state revision snapshots, dynamic curated discovery, and
  Compute-owned startup resolution/installation/readiness. Unsupported mappings
  fail startup after structurally valid Agent writes are saved.
- Current target-port verification passed workspace, build, OpenAPI, format,
  docs, and flow validation. Baseline passed 495 checks; after one real
  activation regression was fixed, the full Kubernetes suite passed 89 tests.
  Focused suites passed API integration (17), contracts (7), plugin Compute plus
  SSH (34), and Driver plus startup (14).
- Real PostgreSQL target-port coverage passed 5 tests with zero skips; evidence:
  `/tmp/plugin-driver-postgres-platform-state-port.log`.
- Fresh target-port OpenClaw Kubernetes plugin proof passed on commit
  `185afba1608260adfa5b1fe9bda9ee700a4d9fee`: one test, zero failures/skips,
  187.3 seconds, native OpenClaw `2026.9.1`, Codex `0.152.1`, evidence
  `/tmp/plugin-driver-openclaw-k8s-port-live-v6.log`.
- The latest target-port Codex Calendar proof attempt used Codex `0.152.1` and
  is blocked before the normal Agent turn because the designated service account
  returned `403` during the native service-account authentication `whoami`
  check; rerun before claiming current target Calendar acceptance.
- Historical source-implementation evidence from PR #57 remains useful but does
  not by itself prove this target port. The source implementation had
  PostgreSQL plugin-state coverage for atomic Agent-owned updates, immutable
  requested-state revisions, and malformed-state rejection before persistence.
- Historical source-implementation OpenClaw Kubernetes acceptance passed on
  2026-09-09: one test, zero failures/skips, 227 seconds; Diffs installation,
  normal tool execution, disable/removal on later deployments, and sibling
  isolation. Evidence: `/tmp/plugin-driver-openclaw-k8s-final-live.log`.
- Historical source-implementation Codex discovery targeted the existing
  `openai-curated-remote` catalog instead of a production hardcoded
  Linear/Google Calendar allowlist. Linear and Google Calendar remained test
  fixtures. Historical live Agent cache verified Google Calendar metadata as
  `google-calendar@openai-curated-remote` version `1.2.7`, app
  `connector_947e0d954944416db111db556030eea6`, `required:true`.
- Historical source-implementation Google Calendar normal-Agent acceptance
  passed with the designated service account: one test, zero failures/skips,
  196 seconds, Codex `0.149.0`, OpenClaw `1391f7c`, `gpt-5.6-sol`, catalog
  discovery, native installation/configuration readiness, and a successful
  `list_calendars(max_results:1)` call/result through a normal Agent turn.
  Evidence: `/tmp/plugin-driver-calendar-k8s-live.log`.
- Linear diagnostic evidence remains historical: native direct execution
  required app reauthentication, and the diagnostic native model turn emitted a
  Codex Apps URL elicitation that was declined. Linear is no longer the required
  Codex acceptance target; Google Calendar is the required Codex acceptance
  target. No secret values or resolved account identifiers were recorded.

## Manual Notes

## Changelog

- 2026-09-08 13:13: Drafted the approved scope and configuration-only limits; independent review pending. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `cde262a81a894db6e48733368a58d61b4c331d56`.
- 2026-09-08: Applied the approved review direction: sole Compute lifecycle ownership, saved Driver identity and cleanup, metadata-gated tool policies, consolidated validation, and a smaller LIST response.
- 2026-09-08 13:40: Per user direction, aligned `auto` with native Codex `auto` and added independent plugin-level `approvals_reviewer`; updated inheritance, mappings, bridge limits, and verification. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `cde262a81a894db6e48733368a58d61b4c331d56`.
- 2026-09-08 13:45: Recorded the user-designated service-account credential source for the Codex Linear fixture; credential contents were not inspected. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `cde262a81a894db6e48733368a58d61b4c331d56`.
- 2026-09-08 16:05: Corrected the implementation notes: curated Codex Linear uses the existing OpenClaw Codex bridge with native Codex `auto` and optional `approvals_reviewer`; unsupported policy surfaces remain 501 and live local-Kubernetes proof is still pending. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `79021fa`.
- 2026-09-08 17:02: Recorded the current Codex Linear proof boundary: native install/readiness passed on Codex `0.149.0` with OpenClaw `1391f7c`, the bridge app batch request and force-refresh app state passed, Linear was enabled/callable, and a normal turn invoked Linear `list_teams` before timing out in native `waitingOnApproval` without a result. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `79021fa`.
- 2026-09-08 17:35: Confirmed the remaining prerequisite through a native diagnostic: the test account’s Linear connection requires reauthentication, and the model emits a URL authentication request. Normal OCC acceptance remains pending reconnection and rerun. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `b4fa273`.
- 2026-09-08 18:05: Per user direction, changed the required Codex live proof from Linear to Google Calendar using the same service-account path and a normal-turn `list_calendars(max_results:1)` result. Calendar metadata and live proof remain pending; Linear remains historical connector evidence. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `b4fa273`.
- 2026-09-08 18:12: Verified Google Calendar curated metadata from live Agent cache after native install: `google-calendar@openai-curated-remote` version `1.2.7`, app `connector_947e0d954944416db111db556030eea6`, `required:true`. The normal-turn Calendar result remains pending. Evidence `/tmp/plugin-driver-calendar-manifest-evidence.json`; Enterprise source `b4fa273`.
- 2026-09-08 18:18: Required Google Calendar normal-Agent acceptance passed: one test, zero failures/skips, 183 seconds. Source `ef51e45`; sanitized log `/tmp/plugin-driver-codex-calendar-live-v2.log`. Prior PostgreSQL and OpenClaw proof remains applicable.
- 2026-09-09: Verified native Codex 0.149.0 with a harmless destructive-annotated MCP tool during normal model turns: `approve` completed with zero approval requests; `auto` requested approval once. Feeding actual Codex requests through the pinned OpenClaw 1391f7c bridge accepted and completed with allow=true, and declined without execution with allow=false. Added the `always` mapping for default/user reviewers; this fixture does not constitute a new Calendar acceptance run. Session `01a087cc-356e-72e0-a9d9-caabfc180120`.
- 2026-09-09 13:39: Rebased the spec around Agent-owned plugin maps on create/update, full-map replacement, structural save-time validation, startup catalog/policy validation, runtime curated discovery, and revision snapshots that freeze requested state rather than resolved release metadata. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `237dd0a`.
- 2026-09-09 14:50: Applied the approved simplification: fixed Codex bootstrap configuration, one bridge renderer, minimal catalog rows, schema-owned validation, native installation metadata instead of private cache inspection, and Kubernetes-only real plugin proofs. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`; Enterprise source `44f80f2`.
- 2026-09-09 15:49: Audited implemented status, structural versus startup validation, current tool/category limits, Compute ownership, and pre/post-commit failure semantics against `08abf9c`. Session `01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7`.
