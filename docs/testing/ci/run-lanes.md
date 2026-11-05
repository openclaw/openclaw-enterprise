---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Find and run test lanes

A lane is a named set of test files and setup requirements. Its manifest lists
test files, selectors, prerequisites, and any expected-case checks.
[The suite index](../../../scripts/ci/test-suites.json) defines lane groups. Workflows
without test suites build, publish, scan, or dispatch; see the [workflow index](../../reference/cheatsheets/github-actions.md).
Files that share a runner start longest first, by [measured file times](../../../scripts/ci/test-suites/file-durations.json).
A file without a row starts first; refresh rows when a lane's longest files change.

## Find test coverage

Every `*.test.mjs` and `*.test.ts` file under `tests/integration/` must belong to
exactly one lane. The same audit covers `tests/conformance/`, `tests/browser/`,
and `tests/docs/`. Check registration without running tests or provisioning resources:

```sh
node scripts/ci/run-tests.mjs audit
```

The audit fails for unmapped files, duplicate ownership, missing files, or invalid
lane/group definitions. Registration does not mean a test runs on every PR:
the check pages distinguish ordinary CI, manual/advisory workflows, and lanes
with [no GitHub workflow](../manual-tests.md). Each manifest is the exact file and selector inventory.

To find the owning lane for a file name or path fragment, run from the repository root:

```sh
node --input-type=module - local-first-agent <<'JS'
import { loadTestSuites } from './scripts/ci/test-suites.mjs';

const { lanes } = loadTestSuites('scripts/ci/test-suites.json');

for (const [lane, { files }] of Object.entries(lanes)) {
  for (const { path } of files) {
    if (path.includes(process.argv[2])) {
      console.log(`${lane}\t${path}`);
    }
  }
}
JS
```

Replace `local-first-agent` with the file name you need. When adding a test,
register it in its owning manifest and check that the intended workflow selects
that lane. A passing inventory audit does not prove that a credentialed or
manually prepared lane has run.

## Results and cleanup

A lane fails if required cases are missing, skipped, marked TODO, or failed, or if cleanup fails. This includes skipped suites and Go tests. Results prove only selected coverage: inspect outcomes, source, cleanup and image digests. Retries have attempt-specific artifacts and replace the current result. Kubernetes preparation failures retain sanitized diagnostics when collection succeeds. Missing state or empty inventory does not prove cleanup.

Prepare infrastructure on a disposable host. Keep the private state file until cleanup completes:

```sh
node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>
node scripts/ci/run-tests.mjs run <lane> --state <private-state-file> --results <results-file>
node scripts/ci/cleanup.mjs --state <private-state-file>
```

Run cleanup after preparation or test failures too. See [local browser diagnostics](../local.md#browser-failure-diagnostics) and the [CI flow](../../flows/github-actions-testing.md) for failure evidence.

For focused local proof, first validate the exact manifest path with
`node scripts/ci/run-tests.mjs check-selection <lane> --file <manifest-path>`.
Then prepare the lane and pass the same `--file` argument to `run`. Omit `--file`
for the complete lane. The composite action validates focused selection before
tool setup or preparation; an unknown path, path alias, or another lane's file fails.

<a id="no-github-workflow-entrypoint"></a>
<a id="manually-selected-lanes-without-github-workflows"></a>

## Manual tests

See [Manual tests](../manual-tests.md) for lanes without GitHub workflows, their
setup requirements, and the disabled installed repository-credentials lane.
