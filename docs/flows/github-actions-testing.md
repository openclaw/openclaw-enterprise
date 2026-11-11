---
created: 2026-09-04
updated: 2026-11-11
last_updated_session: authoring-run/ca550d16-3b1c-4ed9-9ec7-d10efbb6baf9
---

# GitHub Actions testing flow

## Overview

[Ordinary CI lanes](../testing/ci/required-checks.md) reject missing or skipped coverage. Docs-only runs execute Suite Audit and Static Checks. Neither proves credentialed integrations.

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

`loadTestSuites` assembles `scripts/ci/test-suites.json` and ordered
`scripts/ci/test-suites/<lane>.json` references. Lanes own tests, environments,
inputs and preparation.

`run-tests.mjs:selectLane` and the action validate lane-owned focused paths before setup.
Focused results retain expected cases, environment and cleanup;
`validateLaneEvidence` rejects them for full-lane aggregation, including one-file lanes.

`CI Impact` selects coverage; `Suite Audit and Static Checks` verifies checkout identity in every mode. Ordinary CI uses the event checkout without external service credentials. The [coverage map](../testing/ci/required-checks.md#scenarios) lists lanes and `runtime-image-fixture`. Workflows select runners; Kubernetes requires a NetworkPolicy-enforcing kernel.

Pull requests compare the verified merge with its first parent using that parent’s
policy; the second parent must match the event head. Canonical main pushes use `before` policy
for the complete `before`→verified `after` diff. Missing history,
forced pushes, and older policies retain full CI.
Decoding preserves leading UTF-8 BOMs.
`scripts/ci/impact.mjs:documentationPath` admits allowlisted Markdown, `docs/docs.json`
and `specs/rfcs/**/*.png`. Generated API references, other images, executables and
symlinks require full CI.

Registered test changes may include docs and their own lane-manifest entries. CI runs
the owning lanes from either tree, adds `checks-baseline-2` for TypeScript, and uses
`checks-baseline-1` if only the fixture job would run. Test-only main pushes, other changes, and remaining event types select full CI. Missing policy or unverifiable source selects full or fails closed.

`CI Required` rechecks the mode and selected lanes. Impact, the combined static-checks job, and selected lanes must
succeed; other jobs must be skipped. Full and tests modes aggregate results from the same
source. Docs mode produces no test artifacts. The impact summary reports mode, fixed reason and accepted lanes, excluding paths and
raw output. Selector errors fail the job; missing evidence is unavailable.

For full-mode PRs, `affected-packages` verifies the checkout and reports dependents; it does not select tests or gate CI. Base-loaded policy cannot prevent PR changes to the workflow itself.

Advisory `.github/workflows/qa-advisory.yml:eligibility` selects fixed scopes,
excluding empty groups. Focused jobs verify SHA and ordered PR parents. QA
materializes only its selected credential; see
[inputs and evidence](../testing/ci/qa-advisory.md#trigger).

Full Integration checks out `github.sha`. [Scheduled admission](../testing/ci/full-integration.md#trigger)
checks the current main commit, cadence and exact execution receipts before the
automatic execution queue. The reusable workflow rechecks after acquiring the
queue. Manual dispatch retains dispatcher, team and environment checks and a
separate execution queue. Slack Live serializes channel/app access. Installation
and installed Skipper Git serialize per branch. Retry through a new
[approved dispatch](../testing/ci/configuration.md#environments).

`all` selects every suite. QA waits for Slack even after failure. Cancellation
stops QA. Aggregation requires the selected results.

PostgreSQL migration and application suites own separate servers; each Kubernetes fixture lane owns a separate cluster and PostgreSQL server. Before creating k3d nodes that share the runner kernel, the shared action enables bridge netfilter; missing filtering fails setup rather than leaving Pod network policies unenforced. The repository credential platform lane uses Blacksmith for full-image HTTP, PostgreSQL, Unix-control and credential-material proof; NetworkPolicy enforcement remains the fixture lanes' responsibility. State and cleanup stay on each runner; within a lane, `scripts/ci/run-tests.mjs:runLane` runs files sequentially except audited `parallelFiles`.

The application lane gives the native IAM barrier test its own migrated PostgreSQL database; only that test receives its application and migrator connection details, which the CLI keeps out of `GITHUB_ENV`. Its unregistered supplier stays in that disposable database. This fixture does not establish production writer participation in the barrier.

`runtime-artifact` supplies CI `image-lanes`, Full Integration's `image-lanes-same-sha`
and Docker Model Runtime, and First Agent Smoke. Aggregates check producer and consumers.

The [run-ci-lane action](../../.github/actions/run-ci-lane/action.yml) prepares, runs, and cleans up lanes and uploads sanitized results. Callers set the commit, environment, credentials, and timeout. Tests stop five minutes early.

PR dependency caches stay within GitHub's PR merge-ref scope; main caches stay main-scoped. Results and credential-bearing state are not caches; protected jobs do not promote PR artifacts.

### 2. Prepare resources under the job owner

`scripts/ci/prepare.mjs:main` and `scripts/ci/prepare.mjs:ensureK3dCluster`

[CI resource preparation](github-actions-testing/preparation.md) covers tools, images, clusters, credentials and ownership.

For `logging-collector`, `scripts/ci/prepare.mjs:prepareLane` pre-pulls configured
Collector and Node images and the shared Prometheus and Grafana pins.
`ensureDockerSourceImage` reuses verified local digests or verifies downloads from
`scripts/ci/image-pull.ts:pullImage` before publishing inputs. Registry 5xx/rate
limits retry within the shared budget; missing manifests/authorization refusals
fail immediately. Unpinned Node overrides retain test-owned pulls.

`scripts/ci/prepare.mjs:imageBuildArgs` restores scoped BuildKit caches for hosted image jobs. Only the [CI Image Cache workflow](../../.github/workflows/ci-image-cache.yml) calls `warmImageCache` to export the shared controller/runtime cache. Full OpenShell lanes retain this builder and `SOURCE_DATE_EPOCH=0` through
[source-build tests](../testing/ci/openshell-execution.md#hosted-preparation).
Cache credentials stay in preparation.

Kubernetes preparation records host snapshots. Failed reads, bounded
by time and size, save `<state-file>.diagnostics.json` outside the cluster directory.
These lanes use `--no-rollback`; workflows own teardown after capture, while
local callers use the failed state file. Observation failures preserve the original error. `nodeLogExcerpt` orders Docker streams
and retry summaries by full UTC timestamp precision using locale-independent ASCII comparison ([CI guide](../testing/ci.md)).

`scripts/ci/run-tests.mjs:runFile` watches Compute-managed Pods and namespace
events in ready k3d clusters before tests delete them. On pass or failure,
`scripts/ci/k3d-diagnostics.mjs:projectAgentNamespaceActivity` records
`agentNamespaces`: up to 200 Pod and 200 event records per file and cluster, retaining 40
entries. Messages are redacted and truncated; Pod specs are omitted. Raw watches
use separate files in the cluster directory and are removed on completion.
Cluster-wide watches can include sibling namespaces under `fileConcurrency`.
Failed starts log `Agent namespace activity unavailable`. Each producing lane
uploads the artifact.

API or worker Deployment readiness can fail before any Agent Pod exists.
`tests/helpers/kubernetes-real.mjs:waitForDeploymentAvailable` captures logs
and Pod/event snapshots; the artifact retains the last eight `containerLogs`
records. Without configured runner capture, it emits a projected test diagnostic.
Snapshots marked `unavailable` are failed observations; missing records do not
prove healthy startup.

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

`scripts/ci/staging-qualification.ts:pull` verifies release metadata and
[isolates pull credentials](../release/staging-qualification.md).
`smoke` runs trusted workflow code against the release images. Results identify
both commits.

### 3. Execute and account for actual cases

`scripts/ci/run-tests.mjs:main`, `scripts/ci/reporter.mjs:jsonLinesReporter` and `scripts/ci/failure-redaction.mjs:redactFailure`

`scripts/ci/run-tests.mjs:normalizeFile` validates `file.env`.
`runFile` merges, per child: filtered inherited values
with declared inputs restored, `lane.env`, preparation defaults, `file.env`, then
generated values. Later values win.
`scripts/ci/prepare.mjs:prepareFile` separates re-resolved defaults from generated outputs. `file.env` affects neither preflight nor resource preparation. Keep differing prerequisites in separate files.

The reporter records case names, locations and outcomes. Results and logs retain failure messages (600 characters) and top frames (240). Redaction removes repository paths, replaces nonpublic job/child environment values (8+ characters) with `[env:NAME]`, and masks token/key shapes, URL passwords and `password=` values as `[redacted]`; generated values require a matching shape.

HTTP diagnostics retain numeric actual/expected statuses, allowlisted OCC codes and available ChatGPT operation/status. Denied traffic retains an allowlisted category and plugin failures an allowlisted readiness/rollout stage. Rollouts retain allowed Pod phases, readiness/scheduling flags, restart counts, exit codes and allowlisted reasons.

`skipper-release.ts:runSkipperOperation` projects captured Skipper errors. After
failed installed proof, the workflow invokes `skipper-failure-receipt.ts` to publish
the wrapper's [checkpoints](../testing/ci/full-integration.md#results-and-limits).

`scripts/ci/openshell-progress.mjs:emitOpenShellProgress` emits fixed lifecycle
categories; `run-tests.mjs:runNode` adds lane/file labels. Installation ordinals
and millisecond offsets enter [file receipts](../testing/ci/openshell-execution.md#interpret-timing-and-proof),
not live logs. Readers bound partial records; parent byte limits apply first.
Markers and separators stay out of failure tails. Timing and case accounting remain separate.

Nested causes and AggregateError members use the same redaction before
head-and-tail windowing. This preserves context-dependent credential removal.

Required cases must pass; every skip or TODO fails the lane. There are no counterpart-skip lists or CI name filters. Synthetic file-wrapper success, missing output, zero cases, or interruption without final reporter output cannot establish coverage. Lane results retain failure, timeout and cleanup outcomes.

The reporter projects `cause` and `AggregateError.errors` with context labels into
message/stack fields: at most 32 values/eight levels. It marks cycles/limits and
keeps shared siblings separate. `scripts/ci/failure-redaction.mjs:captureFailureText`
normalizes controls and contextual shapes before retaining complete leading/tail
lines within 16,384 JavaScript UTF-16 units, including omission markers.
Oversized lines may be omitted. Reporter flags preserve redacted tails; expanded
labels are re-budgeted. Artifacts omit flags. Top-frame and 600-character summary
limits remain. Integration covers Node events and diagnostic artifacts;
passing files gain no text.

<a id="4-clean-up-and-publish-the-bounded-result" class="anchor-alias"></a>

### 4. Clean up and report results

`scripts/ci/cleanup.ts:main` and `scripts/ci/run-tests.mjs:main`

`.github/actions/run-ci-lane/action.yml` uploads one sanitized result artifact
per lane and run. A retry replaces that lane's artifact, preventing aggregation
of a stale result; other lanes retain theirs. Each attempt also uploads the same
file as `attempt-<run attempt>-<artifact-prefix>-<lane>`, which no aggregate
pattern matches, so a failed attempt's cases survive a `--failed` rerun.

`scripts/ci/memory-sampler.sh` samples memory pressure, RSS, process IDs,
containers and disk every 15 seconds, excluding arguments and environment.
`k3d-fixture-configuration` samples during tests and logs live summaries for
runner-loss diagnosis. Runtime startup and browser lanes sample from before
preparation through cleanup, then print summaries.

Each attempt uploads `memory-<artifact-prefix>-<lane>-attempt-<run attempt>`
(about 1 MiB maximum). Sampler and upload errors do not fail the lane.
Only live summaries survive runner loss.

For `images-packaging`, `scripts/ci/export-image-reconciliation.mjs` attempts to
retain attempt-specific cleanup records for prepared controller and runtime tags.
Planned records do not prove image creation; tag names confer no authentication
or deletion authority. Missing state is unavailable, and empty inventories do not
prove cleanup. The separate runtime-images test tag, other resource kinds and
private environment values are excluded. Export, upload or runner failure can
prevent retention.

Fixture bootstrap diagnostics upload separately as `diagnostics-<artifact-prefix>-<lane>-attempt-<N>`.
They survive cluster/private-state cleanup but cannot satisfy required test results.

Per-file cleanup releases its database; job cleanup removes owned resources. Deleting the
owned k3d cluster removes Collector RBAC and Namespace. Logging cleanup removes its Docker
backend and JSONL/config directory without Kubernetes. Cleanup errors fail the check except
for [hosted QA image warnings](github-actions-testing/preparation.md). Private state stays
on its original runner and path. User databases, contexts, unrelated containers and other
image references remain untouched.

`scripts/ci/cleanup.ts:execFile` awaits exit and drained output. On POSIX,
`scripts/ci/cleanup-command.ts` kills its group on caller IPC closure, including caller SIGKILL.
Completion drains output, kills grouped descendants and returns command status.
At [timeout](../testing/ci/configuration.md#runner-overrides), TERM then KILL still apply after
direct-child exit. Escaped groups are unsignaled; retained streams close after grace.
Windows bounds streams and terminates only the direct child.

`scripts/ci/run-tests.mjs:killDescendants` stops cleanup groups before sweeping descendants.
`tests/helpers/postgres-worker-revision-fixture.mjs:disposeStep` records timeouts and continues.
Root hooks allow two seconds for reports, immediately on cleanup failure; skipped hooks have a
60-second backstop. The runner reports failures; failed resources stay recorded.

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

- `node scripts/ci/run-tests.mjs audit` checks the actual checkout inventory against the suite map.
- `node --test tests/integration/ci-runner.test.mjs` exercises the runner with real child Node processes and controlled pass/fail/skip cases.
- Reproduce the reported case with approved prerequisites. The named aggregate bounds coverage.
- After measured disk or network instability on local VM-backed Docker hosts, run Kubernetes lanes sequentially. GitHub Actions retains its configured matrix.
- Missing protected environments, tools, images or credentials are setup failures. Configure the approved resource; do not mark its required test skipped or replace it with a fixture.
- Retain sanitized results for seven days; exclude private state and credentials from uploads. Recover local teardown using run-owned state on its original host and path.

## Related docs

- [Testing guide](../testing/README.md)
- [CI suite map](../../scripts/ci/test-suites.json)
- [Integration implementation specification](../../specs/plans/19-github-actions-test-coverage/index.md)
- [Upstream infrastructure report](../../specs/plans/19-github-actions-test-coverage/source-audit.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-11 02:49: Trace installed failure receipts. (authoring-run/ca550d16-3b1c-4ed9-9ec7-d10efbb6baf9 - 2f93d2d9a4e452c79813467b4fbe0f9218410835)

- 2026-11-11 02:22: Persist defaults separately. (authoring-run/468c8b0e-17e2-4d4e-988e-f00f3434ccfa - 52faf13e94dab59c20c80b161169c1d32429da36)

- 2026-11-11 02:08: Trace per-file environment precedence and preparation boundaries. (authoring-run/3950ed4c-e0a8-42f9-8fc0-6b5fa60d7d3a - 08c7419aea802667090483843a386071c13e9050)

[GitHub Actions testing documentation history](github-actions-testing/history.md) preserves the older dated entries.
