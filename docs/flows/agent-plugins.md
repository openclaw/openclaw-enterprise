---
created: 2026-09-08
updated: 2026-09-09
last_updated_session: codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7
---

# Agent Plugin Deployment Flow

## Overview

An authorized caller stores one Agent's desired plugin selections through Agent
create/update, then deploys that Agent. OCC snapshots the requested selections
and selected Driver; Agent startup resolves current curated metadata, translates
native policy, and prepares the revision's isolated runtime. This flow ends at
successful reconciliation or a failed/incomplete revision. The active revision
pointer can change before runtime cutover finishes. Native tool invocation and
approval internals remain the Harness's responsibility.

## Entry Points

`apps/controller/src/index.ts:createFastifyApp`

- Trigger: Agent create/update with `plugins`, followed by Agent deployment.
- Assumptions: exact Agent create/update authorization, structurally valid plugin
  configuration, a compatible trusted PluginDriver selection by deployment time,
  and the existing deployment prerequisites.
- Source: [HTTP handlers](../../apps/controller/src/index.ts),
  [OpenClawController](../../packages/occ/src/index.ts), and
  [bundled PluginDrivers](../../apps/controller/src/drivers/plugin/index.ts).

## Flow

```mermaid
graph TD
  subgraph API["Agent configuration"]
    A["Agent create/update with plugins"] --> B["Authorize exact Agent and validate structure"]
    B --> C["Commit desired map and audit"]
  end
  subgraph OCC["Deployment admission"]
    C -->|explicit deploy| D["Freeze requested map and Driver identity"]
  end
  subgraph Compute["Kubernetes revision workload"]
    D -->|existing embedded gateway| R["Stage replacement; commit candidate pointer"]
    R --> S["Stop old gateway; install and ready replacement"]
    D -->|no embedded gateway to replace| F["Resolve catalog; install and ready runtime"]
    F -->|ready| G["Commit candidate pointer; finish activation"]
    F -->|failure| H["Preparation failed; prior pointer unchanged"]
    S -->|ready| I["Complete reconciliation"]
    G -->|success| I
    S -->|failure| J["Incomplete revision; candidate pointer retained"]
    G -->|failure| J
  end
```

## Execution Trace

### 1. Validate desired state under exact-Agent authority

`apps/controller/src/index.ts:createFastifyApp`

HTTP route contracts validate input shape before
[OpenClawController](../../packages/occ/src/index.ts) checks the exact Namespace
and Agent. Agent reads use Agent `read`; Agent create/update stores
the `plugins` map through the ordinary Agent mutation path. Shared contract
validators check plugin selection shape at OCC boundaries. Catalog membership,
native app mapping, release metadata, and policy representability are not
validated before save. A successful Agent mutation stores Agent-owned desired
state and appends audit evidence in the same transaction. It does not modify
the reusable Configuration or active runtime. On update, omission preserves the
existing map, `{}` clears it, and any supplied nonempty map replaces it completely.

### 2. Admit an immutable plugin deployment

`packages/occ/src/index.ts:OpenClawController.deployAgent`

A separate deploy request reads a consistent Agent selection set and referenced
Configuration. OCC records the selected Driver identity and requested
policy-only plugin map in AgentRevision. It does not resolve native Codex app
mapping, release metadata, or rendered plugin configuration during admission.
The existing reconciliation queue receives that revision; subsequent Agent
updates cannot change it.

### 3. Deliver requested state through Compute preparation

`apps/controller/src/drivers/compute/plugin-runtime.ts:pluginRuntimeSpecForRevision`

Compute validates the admitted requested state with the shared contract
validator and confirms its Driver and Harness match. Kubernetes projects the
nonsecret runtime request into the revision workload; Docker uses bounded
runtime environment delivery. The existing Compute lifecycle owns both paths.
No controller package installation, new worker, or external catalog service
runs here.

SSH Compute is a fail-closed exception in this release: any nonempty requested
plugin map is rejected before SSH host effects. Plugin-free SSH revisions
continue to use the ordinary SSH lifecycle.

For an initial embedded Kubernetes gateway, preparation applies the existing
exact-Agent HTTPS egress policy before startup installation needs the registry.
For an existing embedded gateway, `prepareRevision` does not start a second
candidate process against the Agent-owned state database.
`KubernetesComputeDriver.activateRevision` uses the existing `Recreate`
Deployment replacement: the old gateway stops before the new process installs.
Revision package files/configuration stay private; the native installation
registry remains in the Agent-owned database. Docker instead keeps native state
in its container's private temporary home.

### 4. Prepare native runtime state and hand off readiness

`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:installOpenClawPlugins`

For embedded OpenClaw, the entrypoint resolves the requested selection against
the bundled OpenClaw catalog, writes the resulting policy into its private
writable configuration, installs the supported npm package version with `--pin`
and `--force`, refreshes the registry, then reapplies and checks the policy overlay.
Native inspection verifies plugin ID, package name, runtime/install version,
recorded integrity, and the runtime source's containment in the install path.
Failure stops startup before the replacement gateway becomes ready.

Dedicated Codex uses one of two fixed bootstrap configurations in its isolated
`CODEX_HOME`: empty selections disable the apps/plugins/remote-plugin features;
nonempty selections enable those features. Both set `apps._default.enabled:false`.
For nonempty selections, Compute applies the shared selected-only OpenClaw
bridge renderer during gateway configuration construction: `codexPlugins.enabled:true`,
`allow_all_plugins:false`, and one entry per selected plugin. Disabled or `never`
entries remain selected but cannot execute through that bridge.

At startup, native `plugin/list` discovers the `openai-curated-remote` marketplace;
`plugin/read` resolves each selection using the summary's opaque remote identity.
The shared translator validates the entire selection set before Compute writes
native app configuration with `config/batchWrite`, including optional
`approvals_reviewer`. Compute then calls `plugin/install`, rejects missing app
authentication, rereads native metadata, and checks installed/enabled identity,
release version, and app mapping against the resolved selection. Finally,
`config/read` verifies the effective configuration overlay before readiness.
Codex owns its private cache layout and integrity; Enterprise does not inspect
private cache files. The Driver does not install packages in OCC. The normal
Codex readiness path remains responsible for runtime health.

### 5. Complete revision reconciliation

`apps/controller/src/worker.ts:finalizeRevision`

Preparation failure before the worker commits `activeRevisionId` leaves the
prior pointer unchanged. After that commit, activation/finalization failure
retains the candidate pointer and records `REVISION_FINALIZATION_INCOMPLETE` for
retry. Existing embedded Kubernetes replacement runs in this after-commit phase;
the old gateway may already be stopped. The previous revision record remains
stored, but there is no pointer rollback or guarantee of availability during
cutover. See the [controller worker flow](controller-worker.md).

Successful worker completion reports `REVISION_ACTIVATED` or, on the idempotent
already-active path, `REVISION_ALREADY_ACTIVE`. A candidate pointer alone
is not installation/readiness evidence. Normal Agent turns use native policy;
old workload state follows ordinary retirement. The persistent Agent workspace
and Kubernetes gateway state database retain their Agent-owned lifecycle.

## Debugging and Verification

- Compare `Agent.plugins` with the active revision snapshot and deployment status.
  A successful Agent write alone is not runtime installation evidence.
- Structurally invalid Agent writes leave desired state unchanged. Catalog
  membership, metadata, and unsupported policy are failed or unready candidate
  outcomes.
- Check missing native packages, release drift, connector authentication, and
  effective policy when readiness fails; preserve credential values in protected
  runtime state rather than copying them into logs.
- With SSH Compute, any nonempty requested plugin map should fail before host
  effects. Clear the Agent's plugin map or deploy through a compatible
  Kubernetes runtime.
- Prove behavior with a model-chosen plugin call during a normal Agent turn,
  then disable/remove on a later deployment and verify another Agent is unchanged.
  Source or fixture tests alone do not establish native runtime compatibility.
- Use the opt-in real-runtime lane in [Agent plugin testing](../testing/plugins.md)
  for Kubernetes, database, credential, native-runtime, and historical proof
  details. A skipped native lane is not proof.

## Related docs

- [Agent plugin reference](../reference/agent-plugins.md).
- [PluginDriver selection and limits](../reference/drivers/plugin.md).
- [Controller worker](controller-worker.md).
- [Harness execution topology](harness-execution-topology.md).
- [Deployment guide](../guides/deploy.md).
- [Agent plugin testing](../testing/plugins.md).

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-08 16:05: Corrected Codex Linear support to the existing bridge path and kept live local-Kubernetes proof pending (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 79021fa)
- 2026-09-08 17:02: Recorded current Codex Linear proof boundary: native install/readiness passed, bridge app batch request passed, force-refresh app state showed Linear enabled/callable, and a normal turn invoked Linear `list_teams` before timing out in native `waitingOnApproval` without a result (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 79021fa)
- 2026-09-08 17:34: Recorded the native diagnostic blocker: direct Linear execution requires app reauthentication, the diagnostic native model turn emitted a Codex Apps URL elicitation that was declined, and normal OCC proof remains pending reconnection and rerun (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - b4fa273)
- 2026-09-08 18:05: User substituted Google Calendar for the required Codex live proof; Calendar curated metadata and normal-turn `list_calendars(max_results:1)` proof remain pending, while Linear remains historical connector evidence (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - b4fa273)
- 2026-09-08 18:12: Verified Google Calendar curated metadata from live Agent cache after native install: `google-calendar@openai-curated-remote` version `1.2.7`, app `connector_947e0d954944416db111db556030eea6`, `required:true`; Calendar normal-turn proof remains pending (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - b4fa273)
- 2026-09-08 15:30: Added opt-in Kubernetes and test-only Docker plugin proof prerequisites without claiming live proof completion (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 1471b4c)
- 2026-09-08 14:30: Documented plugin admission, the Codex 501 boundary, and serialized OpenClaw replacement (codex/01a082a0-aa05-7af0-af28-5568d12d623f - 1471b4c217e4879a6b430890ac216b2026e9bd46)

- 2026-09-08 18:18: Google Calendar 1.2.7 normal-Agent acceptance passed with the designated service account, matching tool/result evidence, and zero skips (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - ef51e45).
- 2026-09-09 13:39: Updated the flow for Agent-owned plugin maps, full-map replacement, startup catalog resolution, and revision snapshots that freeze requested state rather than native release artifacts (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 237dd0a).
- 2026-09-09 14:50: Simplified bootstrap and catalog projection, kept native metadata/configuration readiness, and standardized both native plugin proofs on Kubernetes (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 44f80f2).
- 2026-09-09 15:49: Aligned bootstrap/install ordering, replacement semantics, and pre-commit versus post-commit failure and worker completion with current implementation (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 08abf9c).

- 2026-09-11: Removed the per-Agent plugin inventory GET and its inferred installation query. Read desired selections from Agent configuration and deployment outcomes from existing revision/status surfaces; native catalog discovery remains available to the PluginDriver. (NOT_IN_SPEC)
