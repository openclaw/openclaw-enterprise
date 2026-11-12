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

The runner removes inherited test selectors unless the manifest declares them.
`requiredEnv` fails when an input is missing or empty; `optionalEnv` forwards an
input only when supplied. Both may be declared on a lane or a file. A lane's
`focusedEnv` extends `optionalEnv` only after `--file` selects an exact file
in that lane.
File-specific test selectors do not reach sibling files, and optional inputs do
not select a file or change its required-case inventory.

## Shared runtime image in ordinary CI

The four image lanes and First Agent Smoke use one runtime image built from the
workflow's checked-out commit. On pull requests, that is the tested merge commit.
The producer uploads an OCI image artifact; each selected consumer verifies its
source, workflow run, archive checksum and platform before loading it. Packaging
still builds its controller, and each lane owns its other preparation and tests.
[First Agent Smoke](first-agent-smoke.md#trigger) adds runtime trust and reuses
its WebSocket package for the provider loaded into the job's Docker engine.

Full Integration also shares this runtime with Docker Model Runtime, Gateway
Routing and Production TUI. When Gateway Routing or Production TUI selects the
current runtime, both full and focused runs wait for the producer. Their job
budgets cover import, controller preparation and tests. Focused Gateway runs
with explicit Gateway/Agent images skip the producer; full runs still wait for
it because other lanes need it. Local TUI upgrade checks retain their selected
baseline and candidate images.

The shared action passes the downloaded directory in
`OCC_CI_RUNTIME_ARTIFACT_DIRECTORY` and the producer outputs in
`OCC_CI_RUNTIME_ARTIFACT_SHA256`, `OCC_CI_RUNTIME_ARTIFACT_SOURCE_SHA`,
`OCC_CI_RUNTIME_ARTIFACT_RUN_ID` and `OCC_CI_RUNTIME_ARTIFACT_ATTEMPT`.
These are CI preparation inputs, not product configuration. Supply the complete
selection or omit all five; a partial selection fails.

An invalid or missing selected artifact fails preparation; it does not start a
replacement source build. A partial rerun may reuse the successful producer's
artifact from the same workflow run and source. If that artifact has expired,
rerun the producer as well. Local runs without an artifact selection keep their
source-building path.

The producer's build has a provisional 180-minute limit within a 240-minute job.
These limits allow measurement of cold builds; they are not expected build times.
The **CI runtime image timing** notice measures source argument preparation,
the Buildx build and OCI export. Local image verification follows the notice.
Inspect producer build/export and consumer download/load timings separately from
test durations. Ordinary artifacts stay within their workflow and do not replace
native container verification or authorize publication.

### Find a retained runtime before building locally

Before a cold local build, check CI runs triggered by pushes to `main` for the
exact source revision. This example does not search manual, pull-request or
merge-group runs; an empty result rules out only matching main-push runs.
Discovery uses GitHub CLI access to Actions and `jq`; it does not load an image
or qualify a release. Use the full commit SHA, not a branch name:

```bash
SOURCE_SHA='<full-40-character-commit>'
REPOSITORY='openclaw/openclaw-enterprise'
gh api --method GET --paginate \
  "repos/$REPOSITORY/actions/workflows/ci.yml/runs" \
  -f head_sha="$SOURCE_SHA" -f event=push -f branch=main -f per_page=100 \
  --jq '.workflow_runs[] | {id, run_attempt, head_sha, status, conclusion, html_url}'
```

Select a run whose `head_sha` matches. Inspect its runtime producer in the
selected attempt; a green unrelated job is insufficient:

```bash
RUN_ID='<run-id>'
PRODUCER_ATTEMPT='<attempt-number>'
gh api --paginate \
  "repos/$REPOSITORY/actions/runs/$RUN_ID/attempts/$PRODUCER_ATTEMPT/jobs?per_page=100" \
  --jq '.jobs[] | select(.name == "Shared Runtime Image / Build ordinary CI runtime") |
    {id, run_id, run_attempt, head_sha, status, conclusion, html_url}'
```

Require one matching producer with the selected source, run and attempt,
`status: completed`, and `conclusion: success`. After a partial rerun, the
successful producer can belong to an earlier attempt; inspect that attempt
instead of assuming the latest run attempt produced the image.

List the image and separate small provenance receipt for that producer:

```bash
gh api --paginate "repos/$REPOSITORY/actions/runs/$RUN_ID/artifacts?per_page=100" |
  jq --arg image "ci-runtime-$RUN_ID-$PRODUCER_ATTEMPT" \
     --arg receipt "ci-runtime-receipt-$RUN_ID-$PRODUCER_ATTEMPT" \
    '.artifacts[] | select(.name == $image or .name == $receipt) |
      {id, name, expired, expires_at, digest, size_in_bytes, workflow_run}'
```

Require one image artifact and, for the small download below, one receipt artifact,
with `expired: false`, a future `expires_at`, and
`workflow_run.id` / `workflow_run.head_sha` matching the selected run and source.
Record both artifact IDs and digests. These artifacts expire after **one day**;
an absent or expired artifact cannot satisfy this lookup. The API `digest`
identifies the downloaded artifact ZIP, not the image manifest. If the separate
receipt upload is missing, the image archive also contains `receipt.json`; inspect
it during a separately verified image transfer.

Download only the small receipt into a fresh directory to inspect the platform
and image identities before transferring the image:

```bash
RECEIPT_DIR="$(mktemp -d)"
gh run download "$RUN_ID" --repo "$REPOSITORY" \
  --name "ci-runtime-receipt-$RUN_ID-$PRODUCER_ATTEMPT" --dir "$RECEIPT_DIR"
jq '{sourceSha, runId, producerAttempt, platform, archiveSha256,
     indexDigest, platformManifestDigest, configDigest}' "$RECEIPT_DIR/receipt.json"
```

Compare `sourceSha` with the intended Enterprise commit, `runId` with `RUN_ID`,
`producerAttempt` with the successful `PRODUCER_ATTEMPT`, and `platform` with the
local target platform. Its `archiveSha256` covers `runtime.tar`. Discovery and a matching receipt
alone do not verify downloaded image bytes, native behavior or installed
acceptance. The existing runtime-artifact helper accepts only same-workflow
consumers; there is no supported local import command. Do not set `GITHUB_*`
variables to bypass that check. Retain this evidence when planning separately
verified local reuse or a source build. For release-qualified image transfer,
follow [native image checks](../../release/containers.md#check-native-images-without-publication).

## Results and cleanup

A lane fails if required cases are missing, skipped, marked TODO, or failed, or if cleanup fails. This includes skipped suites and Go tests. Results prove only selected coverage: inspect outcomes, source, cleanup and image digests. Retries have attempt-specific artifacts and replace the current result. Kubernetes preparation failures retain sanitized diagnostics when collection succeeds. Missing state or empty inventory does not prove cleanup.

Shared k3d runtime preparation adds `runtimeProvenance` to lane results and
Kubernetes diagnostics for the selected Gateway and Agent images. Each record
lists the observed local image ID and imported platform manifest digest.
An `available` record confirms their config digests match and includes the image-reported Codex version, binary SHA-256,
platform and upstream `openclawCommit`; `unavailable` means the metadata or
image binding could not be verified. This is diagnostic evidence, not release
qualification or an additional readiness check. The result's `sourceSha` names
the tested checkout, not an image build revision. Source builds may still have
no OCE build revision, and the upstream OpenClaw commit is a separate identity.
No image configuration, credentials or arbitrary provenance fields are uploaded.
Collection bounds the archive before accepting a single regular metadata file;
directories, oversized files and unsupported archive records remain unavailable.
Provenance reads and diagnostic merges require the same lane and preparation.
The public preparation identity hashes the private resource prefix; stateless
runs receive a fresh invocation identity. Validated current-run evidence
survives state cleanup.

For a failed matrix job, inspect each lane's result artifact to find the failing
lane. The aggregate reports the parent failure once and requires every selected
lane's same-source evidence, even when other lanes passed. If the artifact is
missing, check the **CI lane first failure** annotation when present. It reports
the first failed or cancelled action step, or `unavailable` when unknown.

### Run a complete local attempt

On Linux, give the runner one fresh private attempt directory to prepare, run and
clean up a lane with one command. Its parent directory must already exist, belong
to the runner's user, and deny group and other write access:

```sh
node scripts/ci/run-tests.mjs run checks-baseline-1 --lifecycle complete \
  --attempt "$HOME/oce-profile-wire-attempt-1" \
  --file tests/conformance/openshell-provider-profile-wire.test.ts
```

Choose an unused attempt name. This example runs one existing wire-conformance
file without preparing services. Omit `--file` to run the whole selected lane.
The command validates the selection before preparation and retains the lane's
required inputs. A file-only run requires all of the file’s expected cases.
It does not select images, provide missing credentials, or enable optional
wire tests. Follow the selected lane's setup requirements first.

To select one top-level standalone Node.js case, keep `--file` and add
`--test-name`. With Docker Compose available, this example prepares PostgreSQL,
runs the idle-backend regression, and cleans up. Run it from the root of the
checkout you want to test. The pnpm prefix checks its installed dependencies
before the runner starts Docker. If pnpm reports a stale installation, run
`corepack pnpm install --frozen-lockfile` in that checkout and retry. The
runner’s `--root` option does not change the directory pnpm checks.

```sh
corepack pnpm exec node scripts/ci/run-tests.mjs run postgres-platform --lifecycle complete \
  --attempt "$HOME/oce-postgres-idle-attempt-1" \
  --file tests/integration/postgres-connection-auth.test.mjs \
  --test-name 'the pool survives PostgreSQL terminating an idle backend'
```

The value is a nonempty literal name of at most 256 UTF-8 bytes. Missing `--file`,
names outside that range, `<root>`, and the selected file's absolute path fail
before preparation. For names beginning with `--`, use
`--test-name='--dry-run preserves state'`. Both forms select literal names;
the runner rejects a second selector before preparation or attempt creation.
A bare `--test-name` still needs a value.
The runner rejects `--test-name-pattern`.

The name must exactly match one required case in the selected file’s manifest.
Exactly one standalone top-level case with that name must pass. Missing, extra
or duplicate cases, suites, nested tests, skips, TODOs and failures fail the run.
Use a file-only run for suites or nested tests. Other registered cases may be
omitted. Results record the literal `testName` and `scope: focused`, including
when preparation fails; aggregation rejects them as full-lane evidence.

Complete mode uses only `<root>/scripts/ci/test-suites.json`, where `--root`
selects the checkout and defaults to the runner's checkout. You can omit
`--manifest` or explicitly supply that canonical path. Relative manifest paths
resolve from the selected root; normalized relative and absolute paths must equal
the canonical pathname. Symlink aliases are rejected. A different manifest fails
before the runner creates an attempt or starts any phase, so selection,
preparation and execution use the same definitions. Ordinary externally managed
`run --state ... --results ...` still accepts alternate manifests.

Complete mode rejects `--state` and `--results`. It creates the attempt directory
exclusively with mode `0700`, then owns `state.json`, `run.json` and `result.json`
inside it. Do not write into an active attempt or reuse its directory. A competing
invocation that cannot claim the directory starts no phase and cleans nothing.

The final `result.json` includes separate `lifecycle.phases.prepare`, `run` and
`cleanup` outcomes. It is written after cleanup, or after the command determines
that cleanup cannot start safely. Passing tests alone do not make the attempt
pass. The ordinary test result, when available, remains in `run.json` even if later
cleanup fails. Phase exceptions use closed failure codes; command arguments and
output are not copied into phase errors.

SIGINT, SIGTERM and SIGHUP request deferred cancellation. The command reports the
request immediately, waits for the current phase, then cleans up without starting
the next test phase. Cancellation still fails the attempt. Preparation and tests
share a 30-minute deadline unless `CI_RUNNER_DEADLINE_MS` supplies an absolute Unix
millisecond deadline. Cleanup has its own `CI_RUNNER_CLEANUP_TIMEOUT_MS` allowance
(default 120 seconds). This mode does not promise immediate interruption.

A timeout, lost phase result or unconfirmed process termination produces
`reconciliation-required` and prevents a later cleanup phase. Command owners stop
their process groups when their phase loses its parent. Retain the attempt,
confirm its processes have stopped, then use the existing cleanup command below
with its `state.json`. Do not remove another attempt's resources. SIGKILL or host
failure can prevent a final result; a missing result is not cleanup evidence.

The [runner](../../../scripts/ci/run-tests.mjs) starts each phase through a private IPC channel.
[Preparation](../../../scripts/ci/prepare.mjs) and
[cleanup](../../../scripts/ci/cleanup.ts) report their owned command groups.
The runner checks that these groups have stopped before it starts cleanup.

This mode covers resources recorded by the selected preparation and test owners.
It does not add installed-image qualification, verify unrelated resource absence,
or restore host settings changed outside those owners.

### Keep an owned service between file runs

From the checkout root on a disposable host, prepare the lane and keep its private
state file until cleanup completes.

```sh
corepack pnpm exec node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>
node scripts/ci/run-tests.mjs run <lane> --state <private-state-file> --results <results-file>
node scripts/ci/cleanup.mjs --state <private-state-file>
```

Run cleanup after preparation or test failures too. See [local browser diagnostics](../local.md#browser-failure-diagnostics) and the [CI flow](../../flows/github-actions-testing.md) for failure evidence.

For focused local proof, first validate the exact manifest path with
`node scripts/ci/run-tests.mjs check-selection <lane> --file <manifest-path>`.
Then prepare the lane and pass the same `--file` argument to `run`. The `run`
command also accepts `--test-name` for the top-level cases described
above; `check-selection` validates only the file. Omit both selection arguments
for the complete lane. The composite action validates focused selection before
tool setup or preparation; an unknown path, path alias, or another lane's file fails.

<a id="no-github-workflow-entrypoint"></a>
<a id="manually-selected-lanes-without-github-workflows"></a>

## Manual tests

See [Manual tests](../manual-tests.md) for lanes without GitHub workflows, their
setup requirements, and the disabled installed repository-credentials lane.
