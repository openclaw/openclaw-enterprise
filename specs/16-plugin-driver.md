# Feature Spec: Agent plugin drivers

**Date:** 2026-09-08
**Status:** Implemented port; Codex Calendar current target-port acceptance blocked. Current contract: [Agent plugins](../docs/reference/agent-plugins.md)
**Owner:** OCC and bundled PluginDriver implementations

## Problem and Decision

OpenClaw Enterprise needs per-Agent plugin selections for embedded OpenClaw and
dedicated Codex without turning plugins into separate platform resources. The
accepted design stores a policy-only `plugins` map on the Agent, snapshots the
requested map into the next immutable AgentRevision, and lets the selected
PluginDriver resolve native catalog metadata during startup.

There are no dedicated install/delete/patch/plugin-tool routes. Adding, removing,
disabling, or changing policy is expressed by Agent create/update. Catalog
membership and policy representability are startup concerns, so structurally
valid Agent writes can be saved even if a later deployment candidate fails.

## Scope

In scope:

- Agent create/update/response `plugins` map with camelCase Enterprise fields.
- Full replacement on update: omitted `plugins` preserves, `{}` clears, and a
  nonempty map replaces the saved map.
- One Installation-selected PluginDriver for this milestone.
- Curated OpenClaw and native Codex marketplace discovery, with Linear and Google
  Calendar kept as tests rather than production allowlist entries.
- Native approval semantics for supported mappings: `always`, `never`, `prompt`,
  `auto`, and optional `approvalsReviewer`.
- Exact-Agent authorization, atomic structural save/audit, immutable requested
  revision snapshots, and next-deployment effect.

Out of scope:

- Namespace plugin policy, arbitrary catalogs, plugin-specific settings or
  credential APIs, Code Mode, approval-service implementation, new sandbox or
  permission restrictions, and upstream runtime changes.
- Freezing resolved Codex release identity or native app metadata in the
  AgentRevision. Retries or restarts may resolve the current curated release for
  the same requested catalog ID.

## Contract

Agent-owned plugin state is independent of the reusable Configuration resource.
New Codex Agents start with no user plugins enabled. Plugin selection never
changes another Agent or an active revision. Deployment snapshots requested IDs,
policy, and selected Driver identity; startup resolves native identity, release
metadata, app mapping, and rendered runtime configuration.

Policy precedence for representable tool execution is explicit tool mode, then
the stricter matching category override, then the plugin default. `auto` means
native Codex automatic review behavior, not forced review. `approvalsReviewer`
maps to native `approvals_reviewer`; generated Codex configuration retains that
snake_case spelling. `always` means allow without a plugin approval prompt, while
`never` blocks execution. Unsupported combinations fail the startup candidate
without retroactively turning the accepted Agent write into HTTP 501.

OpenClaw supports the bundled Diffs plugin, enable/disable, and `always`/`never`.
Codex discovers installable entries from the existing `openai-curated-remote`
catalog and enables only selected supported apps through the OpenClaw Codex
bridge. Tool/category overrides require reliable native tool metadata; current
curated entries report unknown metadata, so those selections fail startup when
not exactly representable. SSH Compute rejects any nonempty plugin map before
host effects.

Inventory combines current curated catalog rows, saved desired selections, and
active-revision installation status. Saved selections remain listable even if the
catalog entry or Driver disappears. `installed:true` requires the active revision
to contain the plugin and its initial startup work to have succeeded; an
`activeRevisionId` alone is not installation proof.

## Implementation

1. Add plugin schemas to `packages/contracts`, OCC state, PostgreSQL, Agent
   create/update responses, and AgentRevision snapshots. Validate request shape
   before committing Agent state and audit; do not validate catalog membership at
   admission.
2. Remove dedicated plugin mutation routes. Preserve existing Agent
   authorization: create needs Namespace Agent `create` and exact referenced
   reads; update needs exact-Agent `update`; inventory read needs exact-Agent
   `read`.
3. Add bundled `OCCPluginDriver` and `CodexPluginDriver`, trusted
   `drivers.plugin` selection, and native catalog readers. Reuse existing
   OpenClaw/Codex discovery interfaces rather than adding a catalog service,
   database, cache, or upstream runtime endpoint.
4. Extend Compute startup to call the selected PluginDriver, render revision-owned
   native configuration, prepare plugin runtime state, and fail readiness for
   unsupported mappings, missing metadata, install/auth failures, or conflicting
   managed native fields. Keep credentials in the existing Harness and
   ServiceAccount paths.
5. Update current references, runtime flow docs, deployment guidance, generated
   API, and contributor testing docs together.

## Verification

Required outcomes:

- Agent plugin create/update preserves exact ownership, replacement semantics,
  structural rejection, atomic audit, and immutable revision snapshots.
- Inventory lists curated entries plus saved selections, distinguishes
  desired/installed/unknown tool metadata, and remains selected-Driver aware.
- Startup validates catalog membership and policy support, applies selected-only
  native Codex/OpenClaw configuration, and fails unrepresentable selections before
  readiness.
- Approval modes preserve native semantics, including Codex `auto`, default/user
  reviewer behavior, and startup rejection for unsupported `auto_review` with
  `always` or unsupported prompt/category/tool policies.
- OpenClaw Diffs works in a real Kubernetes Agent turn, can be disabled/removed on
  later deployment, and leaves a sibling Agent unchanged.
- Codex Google Calendar is accepted only after a normal Agent turn performs a
  harmless model-chosen `list_calendars(max_results:1)` read using the designated
  existing test account.
- SSH Compute rejects nonempty plugin maps before host effects while plugin-free
  SSH revisions continue to work.

Contributor commands, fixture environment variables, current target-port proof
notes, and historical PR #57 evidence live in [Agent plugin testing](../docs/testing/plugins.md).
Use real native runtimes and existing API/Compute integration infrastructure; a
direct MCP invocation, package listing, or rendered configuration is not a normal
Agent-turn proof. Keep credential values and resolved account identifiers out of
specs, revisions, and logs.

## Implementation status

The target port on `dev/kevinlin/plugin-driver-port` started from base
`5c58b95c`; the initial port commit was
`185afba1608260adfa5b1fe9bda9ee700a4d9fee` in
[PR #121](https://github.com/openclaw/openclaw-enterprise/pull/121). The port
implements Agent-owned plugin maps, atomic structural Agent writes, immutable
requested-state revision snapshots, dynamic curated discovery, and Compute-owned
startup resolution/installation/readiness. Unsupported mappings fail startup
after structurally valid Agent writes are saved.

Current target-port source, PostgreSQL, and OpenClaw Kubernetes proof is recorded
in [Agent plugin testing](../docs/testing/plugins.md). Codex Calendar target-port
acceptance remains blocked before the normal Agent turn because the designated
service-account authentication check returned `403`; rerun before claiming
current target Calendar acceptance. Historical source-implementation PR #57
Google Calendar proof remains provenance only and does not prove this target port.

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
