# Find and run test lanes

Manifests list test files, selectors, prerequisites, and any expected-case checks.
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
with no hosted entrypoint. Each manifest is the exact file and selector inventory.

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

Selected lanes reject missing/skipped/TODO cases (skipped suites and Go tests too), failures, and cleanup errors. Results prove only selected coverage: inspect outcomes, source, cleanup and image digests. Retries have attempt-specific artifacts and replace the current result. Kubernetes preparation failures retain sanitized diagnostics when collection succeeds. Missing state or empty inventory does not prove cleanup.

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

## Manually selected lanes without GitHub workflows

These 11 lanes have no configured recurring GitHub runs and are excluded from
`ci`, `full`, and Full Integration dispatch. Select a lane explicitly after
completing its linked setup; see [Results and cleanup](#results-and-cleanup).
The `repository-credentials-installed` lane remains refused as noted below.

- [`egress-connected`](../../../scripts/ci/test-suites/egress-connected.json) ([setup](../static-egress.md#select-the-prepared-connected-lane)): select explicitly after preparing the protected controller, database, authenticated OpenShell stack, and synthetic HTTPS origin. CI runs the request preflight in `checks-baseline-2`; the generic `openshell` lane does not run this qualification.
- [`egress-custody-installed`](../../../scripts/ci/test-suites/egress-custody-installed.json) ([setup](../protected-repository-custody.md)): qualify repository dispatch and response custody on a separately prepared controller and OpenShell pair, with an independent dispatch observer.
- [`repository-credentials-live`](../../../scripts/ci/test-suites/repository-credentials-live.json): requires an authorized disposable repository and cleanup. See [repository credentials](../repository-credentials.md).
- [`repository-credentials-installed`](../../../scripts/ci/test-suites/repository-credentials-installed.json): temporarily refused pending safe remote cleanup. See [installed Agent qualification](../repository-credentials.md#qualify-an-installed-agent-against-github).
- [`postgres-azure-workload-identity`](../../../scripts/ci/test-suites/postgres-azure-workload-identity.json): see [Azure PostgreSQL tests](../postgresql.md#azure-workload-identity-connections).
- [`ssh-host`](../../../scripts/ci/test-suites/ssh-host.json): requires a disposable Linux/systemd host. Its optional model selector adds provider execution. See [SSH tests](../ssh.md).
- [`plugin-model`](../../../scripts/ci/test-suites/plugin-model.json): requires a disposable cluster with Envoy Gateway and cert-manager, its Gateway CA certificate and key, an authorized Codex account, an immutable Agent image and three distinct scenario databases. See [plugin tests](../plugins.md#native-runtime-prerequisites).
- [`openshell-linear`](../../../scripts/ci/test-suites/openshell-linear.json): starts a shipped OpenShell installation and verifies a Linear read through a normal Agent turn. It requires the connected-account file, model and read fixture from [Linear qualification](../openshell.md#linear-tool-use-qualification).
- [`k3d-two-cluster`](../../../scripts/ci/test-suites/k3d-two-cluster.json): requires two separately prepared clusters, a private configuration file and an OpenAI API key. See [two-cluster validation](../kubernetes.md#two-cluster-validation).
- [`openshell-oauth`](../../../scripts/ci/test-suites/openshell-oauth.json): requires a prepared OpenShell OAuth gateway, trust files, tokens and a Kubernetes context. See [OpenShell OAuth tests](../openshell-oauth.md).
- [`image-pair-qualification`](../../../scripts/ci/test-suites/image-pair-qualification.json): requires staged old and new controller and broker images. See [image-pair qualification](../docker.md#repository-image-pair-qualification).
