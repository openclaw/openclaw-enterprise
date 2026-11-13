---
created: 2026-09-04
updated: "2026-11-12 11:00"
last_updated_session: "authoring-run/2f421f2e-6313-4a70-a0e0-821995778b2f"
---

# GitHub Actions testing flow

## Overview

[Ordinary CI lanes](../testing/ci/required-checks.md) reject missing or skipped coverage. Docs-only static checks do not prove credentialed integrations.

## Entry Points

- `.github/workflows/ci.yml:jobs`: PR, main push, merge-group and manual checks on ephemeral runners.
- `.github/workflows/qa-advisory.yml:jobs`: 6-hourly QA on `main`, and post-merge QA when `QA_ADVISORY_ON_PUSH` is `true`; trusted pull requests select [full or focused advisory QA](../testing/ci/qa-advisory.md).
- `.github/workflows/full-integration.yml:jobs`: scheduled and approved manual main integrations, pinned to `github.sha`.

## Flow

```mermaid
graph TD
  A["PR or other CI event"] --> S["Select impact mode"]
  A --> AQ["Select advisory scope"]
  AQ -->|eligible; focused source verified| AJ["Selected advisory jobs: setup, tests, cleanup, results"]
  A --> N["Suite Audit and Static Checks: every mode"]
  S -->|full PR| Q["Report affected packages (advisory)"]
  S -->|full or tests| B["All ordinary or selected CI lanes"]
  B --> F["Prepare owned resources"]
  F -->|prepared| H["Run tests and validate cases"]
  F -->|preparation fails| J["Owned-resource cleanup"]
  H --> J
  H --> K["Sanitized lane results"]
  J --> G["CI Required: verify mode and job states"]
  S --> G
  N --> G
  K --> G
  G -->|full or tests| L["Aggregate same-source lane results"]
  G -->|docs| M["Documentation coverage result"]
  L --> R["Full CI coverage result"]
  C["Scheduled tick or approved manual dispatch"] --> P["Source and environment preflight"]
  P -->|scheduled tick skips admission| D["Finish without suite jobs"]
  P -->|eligible| V["Acquire execution lock and revalidate"]
  V -->|scheduled recheck skips admission| D
  V -->|eligible| E["Protected test jobs"]
  V -->|all or dev-up-k3d| U["Credential-free installation job"]
  U --> T
  P -->|missing protection| X["Failed check"]
  V -->|missing protection| X
  E --> T["Owned preparation, tests, cleanup and aggregation"]
```

## Execution Trace

<a id="1-select-one-source-revision-and-coverage-group" class="anchor-alias"></a>

### 1. Select one source commit and coverage group

`.github/workflows/ci.yml:jobs`, `.github/workflows/full-integration.yml:jobs`,
`.github/workflows/full-integration-execution.yml:jobs`,
`scripts/ci/full-integration-preflight.mjs:validateFullIntegrationPreflight`, and
`scripts/ci/test-suites.mjs:loadTestSuites`

`loadTestSuites` reads ordered `scripts/ci/test-suites.json` lanes: tests, inputs, preparation.

`run-tests.mjs:main` rejects noncanonical manifests before [complete attempts](../testing/ci/run-lanes.md#run-a-complete-local-attempt).

`run-tests.mjs:parseArgs` accepts `--test-name=<literal>` with leading dashes;
duplicates, including empty values, fail before effects. `selectLane` validates paths/names.
`runFile` requires one passing standalone case through an escaped, anchored Node-child pattern.
Results retain environment, cleanup and focus/name on preparation failure.
`validateLaneEvidence` rejects focused aggregation.

`CI Impact` selects coverage; `Suite Audit and Static Checks` verifies checkout identity.
[Ordinary CI](../testing/ci/required-checks.md#scenarios) uses the event checkout without external service credentials.
Workflows select runners. Kubernetes requires NetworkPolicy enforcement in the kernel.

Pull requests compare the verified merge to its first parent using that parent’s policy.
The second parent must match the event head. Main pushes use `before` policy for the
`before`→verified `after` diff. Missing history,
forced pushes, and older policies retain full CI.
Decoding preserves leading UTF-8 BOMs.
`scripts/ci/impact.ts:documentationPath` admits allowlisted Markdown, `docs/docs.json`
and `specs/rfcs/**/*.png`. Generated API references, other images, executables and
symlinks require full CI.

Registered test changes may include docs and their own lane-manifest entries. CI runs
the owning lanes from either tree, adds `checks-baseline-2` for TypeScript, and uses
`checks-baseline-1` if only the fixture job would run. Test-only main pushes, other changes, and remaining event types select full CI. Missing policy or unverifiable source selects full or fails closed.

`CI Required` rechecks mode and lanes: impact, static checks and selected lanes
must succeed; other jobs must skip. Full/tests modes aggregate same-source results;
docs emits no test artifacts. Impact summaries expose mode, fixed reason and
accepted lanes, excluding paths and raw output. Selector errors fail.

`affected-packages` verifies full-mode PR checkouts and reports dependents without
selecting tests or gating CI. Base-loaded policy cannot prevent PR workflow changes.

`.github/workflows/qa-advisory.yml:eligibility` selects fixed, nonempty scopes.
Focused jobs verify SHA and ordered PR parents. QA materializes only the
[selected credential](../testing/ci/qa-advisory.md#trigger).

Full Integration pins `github.sha`. [Scheduled admission](../testing/ci/full-integration.md#trigger)
rechecks main, cadence and receipts under lock.
`scripts/ci/full-integration-schedule-history.ts:readUnmarkedClock` requires explicit
targeting to ignore live shared work.
`scripts/ci/full-integration-preflight.mjs:fetchGithubJson` distinguishes malformed
JSON from request failures; diagnostics omit raw content.
Manual dispatch verifies dispatcher, team and environment.
Slack serializes channel/app access; installation and Skipper Git serialize per branch.
Retries require [approved dispatch](../testing/ci/configuration.md#environments).

First-attempt `all` reuse requires completed execution
(`scripts/ci/full-integration-reuse.ts:validateResults`). Success selects artifacts,
skipping lanes. Failure uses preflight’s fresh fallback.
QA awaits Slack despite failure, stops on cancellation, and requires selected results.

PostgreSQL migration and application suites own separate servers; each Kubernetes fixture lane owns its cluster and PostgreSQL server. Before creating k3d nodes, the shared action enables bridge netfilter in the shared runner kernel; missing filtering fails setup. The repository credential platform lane uses Blacksmith for full-image HTTP, PostgreSQL, Unix-control and credential-material proof; NetworkPolicy enforcement remains the fixture lanes' responsibility. State and cleanup stay runner-local; `scripts/ci/run-tests.mjs:runLane` runs files sequentially except audited `parallelFiles`.

Only the native IAM barrier test receives its migrated PostgreSQL database and both application and migrator connection details. The CLI excludes them from `GITHUB_ENV`. The unregistered supplier stays in this disposable database. Production writers still require separate barrier verification.

`runtime-artifact` supplies CI `image-lanes`, Full Integration's `image-lanes-same-sha`
and Docker Model Runtime, and First Agent Smoke. Aggregates check producer and consumers.

[run-ci-lane](../../.github/actions/run-ci-lane/action.yml) prepares and cleans resources, runs tests, and uploads sanitized results. Callers set source, credentials, environment and timeout; tests stop five minutes early.

Dependency caches stay scoped to GitHub PR merge-refs or main. Results and credential-bearing state are never cached; protected jobs never promote PR artifacts.

### 2. Prepare resources under the job owner

`scripts/ci/prepare.mjs:main` and `scripts/ci/prepare.mjs:ensureK3dCluster`

[Preparation](github-actions-testing/preparation.md) covers tools, images, clusters, credentials and ownership.

`scripts/ci/prepare.mjs:prepareLane` pre-pulls `logging-collector`’s configured
Collector and Node images and the shared Prometheus and Grafana pins.
`ensureDockerSourceImage` reuses verified local digests or verifies downloads from
`scripts/ci/image-pull.ts:pullImage` before publishing inputs. Registry 5xx/rate
limits retry within the shared budget; missing manifests/authorization refusals
fail immediately. Unpinned Node overrides retain test-owned pulls.

Full Integration requires [compatible cache exports](github-actions-testing/preparation.md)
before OpenShell source builds. These retain their builder and fixed epoch;
cache credentials stay in preparation. Mutable scopes make cache hits best effort.

Kubernetes preparation records host snapshots. Failed reads, bounded
by time and size, save `<state-file>.diagnostics.json` outside the cluster directory.
Fixture lanes use `--no-rollback` and registered teardown. Staged sign-in also
disables rollback, but unacknowledged creation requires reconciliation instead of
name-based deletion/retry. Observation failures preserve the original error.
`nodeLogExcerpt` orders streams and retry summaries by UTC timestamp and ASCII
comparison ([CI guide](../testing/ci.md)).

`scripts/ci/run-tests.mjs:runFile` watches Compute-managed Pods and namespace
events in ready k3d clusters before tests delete them. On pass or failure,
`scripts/ci/k3d-diagnostics.mjs:projectAgentNamespaceActivity` records
`agentNamespaces`: up to 200 Pod and 200 event records per file and cluster, retaining 40
entries. Messages are redacted and truncated; Pod specs are omitted. Raw watches
use separate files in the cluster directory and are removed on completion.
Cluster-wide watches can include sibling namespaces under `fileConcurrency`.
Failed starts log `Agent namespace activity unavailable`. Each producing lane
uploads the artifact.

Before Agent Pods exist, `tests/helpers/kubernetes-real.mjs:waitForDeploymentAvailable`
captures Deployment logs and Pod/events, retaining the last eight `containerLogs` records.
Without runner capture, it emits a projected diagnostic. `unavailable` means a
failed observation; missing records do not prove healthy startup.

Dedicated Codex preparation and the operator's offline profile generator share
`scripts/lib/codex-seccomp-profile.mjs:deriveCodexBwrapProfile`. Preparation
requires an actual workspace write and denied write to a container-writable
outside path before publishing the selected Localhost profile to the live suite.
Native runtime-image tests trust a dynamic Codex Docker seccomp profile only when
`OPENCLAW_ENTERPRISE_CI_STATE` records the exact prepared
`cluster.codexDockerSeccompProfile` path and SHA. A self-hashed profile without
that state is not CI proof; the standalone fallback remains the pinned reviewed
manual profile. Production node provisioning remains outside CI ownership; see
[Codex sandbox setup](../guides/deploy/codex-sandbox.md).

`scripts/ci/staging-qualification.ts:prepare-signin` binds verified publications
to the reviewed v3 inputs and catalog; [staging qualification](../release/staging-qualification.md)
owns credential isolation and historical-pair limits.

### 3. Execute and account for actual cases

`scripts/ci/run-tests.mjs:main`, `scripts/ci/reporter.mjs:jsonLinesReporter` and `scripts/ci/failure-redaction.mjs:redactFailure`

`scripts/ci/run-tests.mjs:normalizeFile` validates `file.env`.
`runFile` merges filtered inherited values, restored declared inputs, `lane.env`,
preparation defaults, `file.env`, then generated values; later values win.
`scripts/ci/prepare.mjs:prepareFile` separates defaults and outputs.
For OpenShell model selectors, `validateLaneInputsBeforeSideEffects` reads the
manifest entry; `runFile` forwards inputs with `file.env` precedence.
Unfocused `openshell`, `openshell-policy` and `openshell-installers` require both credentials before setup.
`scripts/k3d` scopes preparation with `--selected-file`.
Custom-destination/provider-file guards remain; other file values do not affect preparation.

The reporter retains names, locations, outcomes, failure messages (600 characters) and top frames (240). Redaction removes repository paths, substitutes nonpublic job/child values (8+ characters) with `[env:NAME]`, and masks token/key shapes, URL passwords and `password=` as `[redacted]`. Generated values require a matching shape.

HTTP diagnostics retain numeric actual/expected statuses, allowlisted OCC codes and available ChatGPT operation/status. Denied traffic retains an allowlisted category and plugin failures an allowlisted readiness/rollout stage. Rollouts retain allowed Pod phases, readiness/scheduling flags, restart counts, exit codes and allowlisted reasons.

`skipper-release.ts:runSkipperOperation` projects captured Skipper errors. After
failed installed proof, the workflow invokes `skipper-failure-receipt.ts` to publish
the wrapper's [checkpoints](../testing/ci/full-integration.md#results-and-limits).

`scripts/ci/openshell-progress.mjs:emitOpenShellProgress` emits fixed lifecycle
categories; `run-tests.mjs:runNode` adds lane/file labels. Installation ordinals
and millisecond offsets enter [file receipts](../testing/ci/openshell-execution.md#interpret-timing-and-proof),
not live logs. Readers bound partial records; parent byte limits apply first.
Markers and separators stay out of failure tails. Timing and case accounting remain separate.

Required cases must pass; skips and TODOs fail. Synthetic wrappers, missing output, zero cases, or interruption without final reporter output cannot establish coverage. Results retain failure, timeout and cleanup outcomes.

<a id="4-clean-up-and-publish-the-bounded-result" class="anchor-alias"></a>

### 4. Clean up and report results

`scripts/ci/cleanup.ts:main` and `scripts/ci/run-tests.mjs:main`

`.github/actions/run-ci-lane/action.yml` replaces only the retried lane’s sanitized result.
Separate `attempt-<run attempt>-<artifact-prefix>-<lane>` artifacts preserve failed
`--failed` attempts outside aggregation.

`scripts/ci/memory-sampler.sh` samples memory pressure, RSS, process IDs,
containers and disk every 15 seconds, excluding arguments and environment.
`k3d-fixture-configuration` samples during tests and logs live summaries for
runner-loss diagnosis. Runtime startup and browser lanes sample from before
preparation through cleanup, then print summaries.

Each attempt uploads `memory-<artifact-prefix>-<lane>-attempt-<run attempt>`
(about 1 MiB maximum). Sampler and upload errors do not fail the lane.
Only live summaries survive runner loss.

For `images-packaging`, `scripts/ci/export-image-reconciliation.ts` retains
prepared controller and runtime tag cleanup records when available.
Planned records do not prove creation; tags confer no authentication or deletion
authority. Missing state or empty inventories cannot prove cleanup. The runtime-images
test tag, other resources and private environment values are excluded.
Export, upload or runner failure can prevent retention.

Fixture bootstrap diagnostics upload separately as `diagnostics-<artifact-prefix>-<lane>-attempt-<N>`.
They survive cluster/private-state cleanup but cannot satisfy required test results.

Per-file cleanup releases databases; job cleanup removes owned resources,
including Collector objects and logging data.
Sign-in transitions and proof readers reject already-expired issuance observations.
Cleanup errors fail except [QA image warnings](github-actions-testing/preparation.md).
`cleanup-staged-signin.mjs` passes the prepared state digest and custody to
`scripts/ci/cleanup.ts:cleanupState`: locked validation precedes exact server/network
deletion and volume checks. A persisted mutation marker forbids fixture fallback
without completed cleanup; verified pre-mutation refusals retain fallback authority.
[Named-volume limits](../testing/local.md#staged-sign-in-cleanup) remain.

`scripts/ci/cleanup.ts:execFile` awaits exit and drained output. On POSIX,
`scripts/ci/cleanup-command.ts` kills its group on caller IPC closure, including caller SIGKILL.
Completion drains output, kills grouped descendants and returns command status.
At [timeout](../testing/ci/configuration.md#runner-overrides), TERM then KILL still apply after
direct-child exit. Escaped groups are unsignaled; retained streams close after grace.
Windows bounds streams and terminates only the direct child.

`scripts/ci/run-tests.mjs:killDescendants` stops cleanup groups before sweeping descendants.
`tests/helpers/postgres-worker-revision-fixture.mjs:disposeStep` records timeouts and continues.
Root hooks allow two seconds for reports (immediate on cleanup failure), with a
60-second skipped-hook backstop. Failed resources remain recorded.

`scripts/ci/run-tests.mjs:aggregateGroup` checks SHA, ownership, jobs and execution.
Reused lanes retain separate owners; fresh lanes retain matrix parents.
`scripts/ci/cleanup.ts:main` records final cleanup; missing state cannot clear failure.
Installed Skipper records its own. [Execution evidence](../testing/ci/full-integration.md#results-and-limits)
requires every lane's required cleanup to pass. Later delivery failures
keep checks red; missing artifacts cannot qualify.
`ssh-host` needs a [disposable host](../testing/ssh.md#ssh-raw-hosts).
Runner loss can prevent teardown and erase private `RUNNER_TEMP` state; external reconciliation
awaits an approved resource ledger.

## Debugging and Verification

- `node scripts/ci/run-tests.mjs audit` checks checkout inventory against the suite map.
- `node --test tests/integration/ci-runner.test.mjs 'tests/integration/ci-runner-{case-enforcement,file-outcomes,deadline,cleanup-allowance,preparation,failure-output,aggregate,scheduling,redaction,first-agent-startup,openshell-progress}.test.ts'` checks runner outcomes, preparation, redaction, startup, and OpenShell reporting.
- After measured local VM disk/network instability, serialize Kubernetes lanes; GitHub Actions keeps its matrix.
- Missing prerequisites fail setup; supply approved resources without skipping required tests or substituting fixtures.
- Retain sanitized results for seven days; exclude private state and credentials from uploads. Recover local teardown using run-owned state on its original host and path.

## Related docs

- [Testing guide](../testing/README.md)
- [CI suite map](../../scripts/ci/test-suites.json)
- [Integration implementation specification](../../specs/plans/19-github-actions-test-coverage/index.md)
- [Upstream infrastructure report](../../specs/plans/19-github-actions-test-coverage/source-audit.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-12 11:00: Validate OpenShell cohort credentials. (authoring-run/2f421f2e-6313-4a70-a0e0-821995778b2f - 7040f7a648359a9c43d280b83efbc27be991049c)

- 2026-11-12 04:19: Reconcile admission history. (authoring-run/8af5a8e8-5e42-409d-b53e-989087ed46ce - e17d59871db7fbdf53543e055236a849d33f9efd)

- 2026-11-12 04:02: Repair admission diagnostics. (authoring-run/8403e2bb-cd27-449b-8ae7-ef78b7a05922 - 61ec16d5f18a8875213dd072b97384a880f82b25)

- 2026-11-11 23:18: Require the complete installer cohort’s credentials before setup. (authoring-run/1eb4586e-e5dd-41d2-80e3-338b75d13f6a - 0e264d010c2f5c80f4077a1e9fee5515216bcfe4)

- 2026-11-11 23:11: Include declared file model selectors in OpenShell credential admission. (authoring-run/0759ff85-9e18-4fc7-b2bb-29e29bb5935a - f63959062058a5e5c630f36318a381e27ac07cf2)

- 2026-11-11 10:47: Fix PostgreSQL topology ordering. (01a1cbd6-deb9-71a1-bebc-ec5228d76c16 - 225ef5203)

- 2026-11-11 16:52: Publish journals atomically. (authoring-run/fac6c060-7d04-496a-9194-8dfc3ba080e5 - 9209a107a78a5850f7f11b68e1763956d65cde3a)

- 2026-11-11 16:18: Bind child cleanup ownership. (authoring-run/bfbc4468-ece0-4912-b2df-e60c34f373b1 - b5eb70f7384601a69ad62e089e5909c01789e011)

- 2026-11-11 15:55: Retain child cleanup custody. (authoring-run/567c3011-a36a-4bfb-b1f1-c2390ca67345 - cbd2ffb5bff1896373bd4a91d0a1636fcd3a40ff)

- 2026-11-11 15:48: Preserve named-test selection. (authoring-run/8a46c797-57e1-4ac7-8fae-a65a81c7975a - 757f3c5eaf042c55e92f0776384fdbb853cd7bc5)

- 2026-11-11 15:36: Require the real PostgreSQL preparation lifecycle in its Docker-capable lane. (authoring-run/8381f18d-77a3-4a7a-91af-23d1151f2f9e - 7dbcfc5ec7a62c35ff3585e965470db8cc8c840b)

- 2026-11-11 15:21: Literal selection. (authoring-run/713d85c0-4416-4c1d-b492-d63c41faeea4 - 93460c542b3ca6840aab156e2311fe5b22d1ad29)

- 2026-11-11 14:43: Preserve installed sign-in and complete CI lifecycle paths. (authoring-run/e533d196-4ff0-450d-b662-d41ede51e945 - 21417f21dd22a6410350395ac43a24146a2f8027)

- 2026-11-11 14:02: Document canonical manifest guard. (authoring-run/c4d4109e-2324-46f7-bceb-42e3780475b1 - 6bfff2b8a3a07d91637dac4391affc9dde8e0547)

- 2026-11-11 13:14: Refresh the exact current sign-in profile. (authoring-run/d71f35f5-549c-4312-9000-cc24c8cee1cd - 2b8436a5da1e75427c8aa72523d16b9bdc6d0f35)

- 2026-11-11 09:34: Allocate PostgreSQL ports through Docker and retain discovery cleanup ownership. (authoring-run/24db2a8e-6abc-40a2-9332-103ff02f4d4f - 89e4d8b565e511f0dc4688e6dcaed093659e447a)

- 2026-11-11 08:45: Preserve uncertain cleanup. (authoring-run/2f6528e7-fc71-4854-a473-7c5fd68410cc - b561b6bc134053ea9ff7ab4286c4f2f501a80391)

- 2026-11-11 08:39: Retain unacknowledged staging resources. (authoring-run/43e450db-975c-4b32-b88b-ed179d4d50f0 - 16478e96645985bd7501e149a19dbbd784500501)

- 2026-11-11 08:17: Carry prepared custody into destructive cleanup. (authoring-run/f3df3f10-664e-40c7-9f31-907e3bcf7ad1 - 6a60e750c83a3508041ef5100a36f7232ed226ea)

- 2026-11-11 08:11: Bind sign-in rehearsal to the current v3 profile. (authoring-run/8a266aca-074d-4db2-a374-624cabc77861 - 9bf18bf3244b0a0e6f26f5a10263f51ea0b08b3c)

- 2026-11-11 07:55: Retain selected runtime Codex provenance in CI evidence. (authoring-run/59e3fbae-c2ef-496b-ad18-c965758bee04 - 7fa7a37738bb24b27d9a835e409ea20eafb43cee)

- 2026-11-11 04:31: Order OpenShell cache prerequisites. (authoring-run/3b974b52-31d5-4b10-a36c-7cd8a485fc74 - 5d28dd8e93338af9f0ece8796b3bb4a83bd46295)

- 2026-11-11 03:43: Guard reuse and fresh fallback. (authoring-run/c0ca6f34-2aa6-47f9-87c1-e5f3708617f6 - 993a38b318c249b00f951bf92c8d136214ec82fd)
- 2026-11-11 03:28: Explain qualified CI reuse. (authoring-run/1b85588b-87c6-47d0-8c6e-8b78b0030aea - dfd55e679c9c9869ddc786b85f6f9b27a53fb833)

- 2026-11-11 02:49: Trace installed failure receipts. (authoring-run/ca550d16-3b1c-4ed9-9ec7-d10efbb6baf9 - 2f93d2d9a4e452c79813467b4fbe0f9218410835)

- 2026-11-11 02:22: Persist defaults separately. (authoring-run/468c8b0e-17e2-4d4e-988e-f00f3434ccfa - 52faf13e94dab59c20c80b161169c1d32429da36)

- 2026-11-11 02:08: Trace per-file environment precedence and preparation boundaries. (authoring-run/3950ed4c-e0a8-42f9-8fc0-6b5fa60d7d3a - 08c7419aea802667090483843a386071c13e9050)

- 2026-11-11 01:21: Include the OTEL lane in sanitized image-cache observations. (authoring-run/d63d3aa5-5c9c-493a-b4ea-51a1d64e9454 - 60289cbf3d6995ed46960ddb32402e52bf5efad7)

- 2026-11-11 00:08: Select focused advisory jobs and verify their PR merge identity. (authoring-run/bf3df73c-1de0-42d0-b8e4-1326f775739f - 90cee90b34bf20c96538423778a652e55ff02eb4)

- 2026-11-10 19:00: Classify RFC PNG illustrations as documentation. (authoring-run/320d719f-dd4a-44fd-968c-59c377d1a5bc - b3f542cdf738ffcbc4c351e7c9123228ae76a415)

- 2026-11-10 18:32: Preserve safe Installed Skipper operation details for asynchronous failures. (authoring-run/0336b456-2d89-4535-9e04-eeb36c2970d9 - b4528e53458339a1df59473f068142675b1982a5)

- 2026-11-10 17:37: Admit eligible Full Integration work before acquiring its execution lock. (authoring-run/9f72faf1-4740-48d3-8519-5d38e749b961 - c6541831756ae40d0485d16d8f0ffeab9851372d)

- 2026-11-10 16:48: Consolidate native proof diagnostics and clarify observation limits. (authoring-run/62ff26b1-e2b9-4035-a938-e86a07a423b7 - faf4426fba16f164353970c5eaebd4b6b41b60f4)

- 2026-11-10 16:26: Reconcile installation receipts and cleanup coverage. (authoring-run/b99ad0c3-5ba1-40a6-8719-e0216a7c49a8 - 9641a352044b81f1f00afc40870ba54cccdefa75)

- 2026-11-10 16:05: Preserve cleanup failures across missing-state retries. (authoring-run/9259c9bd-8e96-4172-ba73-d945dedd0c0e - ef14f2ab13e47d703fd4bddac3c1862de65b0092)

- 2026-11-10 16:02: Document installation receipt retention. (authoring-run/a06db5de-e6ec-40b7-811e-7f04ff14b7e2 - 242eed4481d16c13227383acd8b58c4d8757ae1f)

- 2026-11-10 15:47: Require final lane cleanup evidence for execution coverage. (authoring-run/8af45432-2706-4ed9-aafd-7750cfea1905 - 60dba17cf36b796aee257e61499803b5dacc5a8c)

- 2026-11-10 13:06: Admit navigation in docs-only CI. (authoring-run/3fcf2723-e440-4ce4-8994-00066241bc2b - 554857e441d9348adfac651bd382c17ffef67c8d)

- 2026-11-10 12:53: Trace cache observations. (authoring-run/9ff30b3c-1145-4acb-9fa3-8a4eb3a5e594 - dd7a47c0e1d7428068bdc79d311ceb07fbea767f)

- 2026-11-10 10:38: Reconcile builder reuse and live progress documentation. (authoring-run/d839dc55-f4be-4689-85a1-3ab9527ad4c4 - 280ae7e6db4b38b68bd76bd7aefdd7d874d28bbd)

- 2026-11-10 10:19: Trace portable, bounded OpenShell progress through the reporter and runner. (authoring-run/d839dc55-f4be-4689-85a1-3ab9527ad4c4 - 1af8c3c4f21c6fe1c8b36ef9545e9e4754e74de6)

- 2026-11-10 10:07: Preserve the builder and epoch for full OpenShell source-build tests. (authoring-run/0c79fd33-2fb7-4114-a408-f08f34d1048d - ce80e6a6b254add076625a1087d098327370672c)

- 2026-11-10 09:09: Document qualified registry-tool reuse and APT setup deadlines in the preparation flow. (authoring-run/dc4064e9-3291-42b3-aaf2-9c36fb81f1a6 - 49e3f601c762f94c8d7b97f594c4a342986d68bd)

- 2026-11-08 08:28: Preserve matrix failure attribution alongside admitted CI reuse. (authoring-run/7219e3b9-3091-4a5b-8712-c543ff5f0c68 - 006cf6288913ff8eb56d0fbc2283885bd551ecc9)

- 2026-11-08 16:09: Reuse admitted same-source ordinary CI results before fresh Full Integration execution. (authoring-run/d394120a-859d-45f1-ba62-9bf9dd9b66c1 - 832dbfca29eca2dd3cb98bd9dd5d803d9100911e)

- 2026-11-08 16:02: Select documentation-only main pushes from verified before-tree policy. (authoring-run/bafcfe3a-329e-4d07-8f36-f178b64e37d0 - ca3ad3c4f3ec8ec5660ec2909bd4673adf78ff90)

- 2026-11-04 12:10: Isolate the Codex Git proof queue without Slack. (authoring-run/14bcb9d6-2d4c-449d-8bbc-b64e3ef7e632 - aa60a72115e342ec020d1083fb5e30c139202c84)

- 2026-11-06 09:03: Validate lane identity before attributing outcomes from matrix results. (authoring-run/acefb857-8e57-4f00-b7f5-ed9224944d88 - 048b2cd25cc59087bcb2551fce03a39eef023340)

- 2026-11-04 10:07: Consolidate Full Integration policy and bound the cutover proof routes. (authoring-run/79147f32-199a-48ad-9b7e-fbdf94bf9d60 - 2628dba73edd44e4980711129e48fb7842828019)

- 2026-11-03 01:07: Bind staging tests to release source. (authoring-run/c1bf6b1d-bea1-4de7-b3af-4a2ea197ba06 - d2fc28e1d6d70292e462956cedef0dae9281c48c)

- 2026-11-02 23:56: Trace staging authentication. (authoring-run/5817dfd2-487d-44bc-a2f7-2d57659ea0fc - db2cc11c4fd767c47394d680ef46bf26e1202fbc)

- 2026-10-29 02:11: Add focused Compose OpenShell selection and sanitized native worker observations. (authoring-run/01a17fae-f253-7d71-af12-d3f259c4faf0 - aa2cfe543b3bba361679e7e1a3028c3327d2c388)

- 2026-10-23 07:40: Preserve upstream CI selection alongside locale-independent timestamp ordering after conflict resolution. (authoring-run/01a10a81-070c-7aa3-97d0-fbce8f285d4d - a6a49a5192fa1c9cc5035801eed7d64b03336491)

[GitHub Actions testing documentation history](github-actions-testing/history.md) preserves the older dated entries.
