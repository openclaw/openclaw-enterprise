---
created: 2026-09-04
updated: 2026-09-09
last_updated_session: codex/01a08326-8d46-70c1-bd36-dcdfdd7cc25c
---

# GitHub Actions testing flow

## Overview

GitHub Actions selects explicit test lanes, prepares disposable resources, runs the real Node test runner, and rejects missing or skipped required coverage. This flow ends at the aggregate check and resource cleanup. A PR check proves its five selected noncredentialed lanes, including the logging collector lane; it does not establish that protected model or service integrations passed.

## Entry Points

- `.github/workflows/ci.yml:jobs`: PR, main push, merge-group and manual checks on ephemeral runners.
- `.github/workflows/full-integration.yml:jobs`: manual main-only integration, bound to the dispatched commit.
- `scripts/ci/run-tests.mjs:main`: local or workflow `audit`, `run` and `aggregate` commands; the suite map is the coverage owner.

## Flow

```mermaid
graph TD
  subgraph Actions["GitHub Actions"]
    A["PR or main event"] --> B["PR-safe jobs"]
    C["Manual integration dispatch"] --> D["Environment protection preflight"]
    D -->|main-only provider or approved other lane| E["Protected jobs"]
    D -->|missing protection| X["Failed check"]
  end
  subgraph Runner["Disposable job runner"]
    B --> F["Prepare lane resources"]
    E --> F
    F -->|prepared| G["Prepare file prerequisites"]
    G --> H["Node tests and structured reporter"]
    H --> I["Case and skip validation"]
    F -->|preparation fails| J["Owned-resource cleanup"]
    I --> J
  end
  subgraph Results["Check results"]
    I --> K["Sanitized lane result"]
    J --> L["Aggregate expected jobs and results"]
    K --> L
    L --> M["Pass or fail for named coverage"]
  end
```

## Execution Trace

### 1. Select one source revision and coverage group

`.github/workflows/ci.yml:jobs`, `.github/workflows/full-integration.yml:jobs`, and
`scripts/ci/full-integration-preflight.mjs:validateFullIntegrationPreflight`

The PR workflow uses the event checkout and supplies no external service credentials. Its aggregate requires exactly five lanes: `checks-baseline`, `postgres`, `images-packaging`, `k3d-fixture-configuration`, and `logging-collector`. Full Integration admits only `refs/heads/main`, checks configured environment protection, and checks out the immutable event SHA. A manual dispatch selects its requested lane or `all`; pushes and merges do not start this workflow. Manual runs share one concurrency group and do not cancel an in-progress run. The provider environment must allow exactly the `main` branch and needs no per-run reviewer approval. Other credentialed environments still require reviewers with self-review prevention. No PR event enters this credentialed workflow. A targeted integration run has a narrower claim than a full inventory run.

Both workflows call the shared [run-ci-lane action](../../.github/actions/run-ci-lane/action.yml) after checkout. It owns tool and dependency setup, baseline checks when selected, lane preparation, execution, unconditional cleanup, and sanitized result upload. Callers keep the source revision, timeout, protected environment and explicit credentials.

Ordinary PR dependency caches may be restored and saved within GitHub's PR merge-ref scope. Main jobs use main-scoped caches. Test results and credential-bearing state are not dependency caches, and protected jobs do not promote PR build artifacts.

The provider job selects the shared `blacksmith-8vcpu-ubuntu-2404` runner for disk headroom during runtime image build and k3d import. The standard Ubuntu runner reached `DiskPressure` and evicted the seccomp probe before it could start. The repository must retain access to this organization runner label. Image preparation uses k3d's direct archive transport; the default tools-container transport reported success without registering the image on Blacksmith. The imported manifest and CRI checks remain required before any test starts.

### 2. Prepare resources under the job owner

[CI resource preparation](github-actions-testing/preparation.md) traces tool setup, image and cluster preparation, protected credentials, and resource ownership. Continue below when preparation has produced the lane state.

### 3. Execute and account for actual cases

`scripts/ci/run-tests.mjs:main` and `scripts/ci/reporter.mjs:jsonLinesReporter`

The runner discovers active test files and verifies that the map assigns each file to exactly one lane. Tests with different prerequisites live in separate files. The runner invokes whole files with invocation-scoped environment inputs. A custom Node reporter exposes case names, locations and outcomes; arbitrary test output and credential-bearing error payloads are excluded from published results. Failed provider-test HTTP assertions also retain numeric actual and expected status codes, an allowlisted OCC error code, and the upstream ChatGPT operation and status when available. Response bodies, credentials, and identities remain excluded.

Required named cases must pass. Every skip or TODO fails the selected lane; there are no counterpart-skip lists or CI name filters. A synthetic file-wrapper success, missing result output, zero executed cases or an interrupted run without final reporter output cannot establish coverage. The runner retains failure, timeout and cleanup outcomes in the lane result.

### 4. Clean up and publish the bounded result

`scripts/ci/cleanup.mjs:main` and `scripts/ci/run-tests.mjs:main`

Per-file cleanup releases its disposable database. Job cleanup removes only the state-owned resources. A whole owned `k3d-cluster` resource owns Kubernetes API object deletion for its Collector Namespace and RBAC. Logging cleanup cleans the local Docker backend container and JSONL/config directory independently, so a dead Kubernetes API does not block local log backend teardown. Cleanup failure fails the check and keeps the private state file usable only while that runner host and path remain available. User databases, contexts, unrelated containers and global images remain outside that ownership.

The aggregate runs after success or failure and checks expected job outcomes plus same-revision lane results. Case validation belongs to the runner; the aggregate checks lane identity and success, required evidence, and cleanup outcomes without interpreting cases again. Missing, failed, cancelled or skipped selected jobs cannot pass. A full-suite result accounts for every lane selected by the `full` group. The explicitly selected `ssh-host` lane remains outside the automatic groups until an operator prepares its disposable host; see [SSH raw-host testing](../testing/ssh.md#ssh-raw-hosts). Abrupt hosted-runner loss can prevent teardown and also loses the private `RUNNER_TEMP` state at job end. External resource reconciliation is deferred until an approved resource ledger exists.

## Debugging and Verification

- `node scripts/ci/run-tests.mjs audit` checks the actual checkout inventory against the suite map.
- `node --test tests/integration/ci-runner.test.mjs` exercises the runner with real child Node processes and controlled pass/fail/skip cases.
- Use the failing test's file, name and location in the sanitized result to reproduce its exact invocation with approved local prerequisites. Treat the named aggregate as its coverage boundary.
- On local Docker Desktop or equivalent VM-backed Docker hosts, run one Kubernetes lane at a time when disk or network pressure has caused measured instability. GitHub Actions still runs the configured matrix; this local guidance is for reproducible operator runs.
- Missing protected environments, tools, images or credentials are setup failures. Configure the approved resource; do not mark its required test skipped or replace it with a fixture.
- Retain sanitized results for seven days. Keep private cleanup state and credential files outside uploaded artifacts. On local runs, follow the run-owned state when recovering a failed teardown while that host and state path still exist.

## Related docs

- [Testing guide](../testing/README.md)
- [CI suite map](../../scripts/ci/test-suites.json)
- [Integration implementation specification](../../specs/19-github-actions-test-coverage.md)
- [Upstream infrastructure report](../../specs/reports/openclaw-testing-infrastructure.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-09: Restore manual-only Full Integration dispatch because the configured provider admin credential cannot authenticate from the hosted runner.

- 2026-09-09: Run provider-account automatically for every main push, preserve main-only credentials, and retain per-run approvals for other credentialed lanes.

- 2026-09-08 07:42: Distinguish the explicit SSH host lane from automatic CI and full-group coverage. (01a07d92-d866-7731-afe5-abab67d8966c - 4d83087229961f3665b923d2581c0b71b988cc9c)

- 2026-09-05: Documented whole-file selection, centralized lane prerequisites, shared workflow execution and aggregate boundaries.

- 2026-09-04 22:40: Added the real-image nested Codex home ownership startup-smoke regression boundary. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 216260fc902d43e99d6f7513d8c0f962c63f44f5)

- 2026-09-04 21:44: Documented the separate Docker-local gateway publisher image ID required by routing proof. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - e491e7618ee894e6cf0c2336e5d16081be512b73)

- 2026-09-04 21:04: Clarified that interrupted runs without final reporter output are not completed lane results. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 87234e1766e5802b45424523246a52a4b2d45590)

- 2026-09-04 20:44: Clarified the dedicated Codex seccomp preparation order and the effective-model guard before live turns. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - d189689018ab11faa9b97d01d9c1310b597482f0)

- 2026-09-04 20:04: Documented runtime package compatibility, startup smoke and distinct routing/media acceptance gates. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f7a85e72d70c46d05022aa0877665514d2cfd84d)

- 2026-09-04 13:52: Documented explicit CI selection, disposable resource ownership, Node outcome accounting and aggregate boundaries. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
- 2026-09-04 14:13: Corrected hosted-runner cleanup-state limits and named the PR-safe logging collector lane. (01a06e43-6504-7810-9f09-4dd31b2e9681 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
- 2026-09-04 15:10: Clarified independent logging backend cleanup and local one-Kubernetes-lane-at-a-time guidance after measured Docker VM pressure.
- 2026-09-04 15:35: Documented the shared Docker 29.4.0 setup action for Collector and Docker-model compatibility.
- 2026-09-04 16:00: Pointed evolving proof status to spec19 after PR #23 head `27bd0e9` passed the hosted PR lanes and local live Docker-model execution passed.
