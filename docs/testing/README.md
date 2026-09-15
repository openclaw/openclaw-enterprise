# Testing

Choose a test suite, prepare its prerequisites, and interpret its results.
These guides are for contributors verifying Enterprise changes. Run commands
from the repository root. For installation and supported product settings, use
the [deployment guide](../guides/deploy.md) and [settings reference](../reference/settings.md).

## Run tests

| Command                 | Tests selected                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm test`             | All conformance and integration tests.                                    |
| `pnpm test:conformance` | Conformance tests only.                                                   |
| `pnpm test:integration` | Integration tests only, including infrastructure and real-runtime suites. |
| `pnpm podman:test`      | Podman Compose with one real embedded OpenClaw model turn.                |

`pnpm test` can finish green with skipped infrastructure cases; inspect skips
before claiming coverage. Run prepared infrastructure suites by exact filename,
one suite at a time. Keep suite variables scoped to one shell or process so
database, Kubernetes, image, or provider selectors do not accidentally select
another suite. The test scripts above run `scripts/verify-workspace-boundary.mjs`
before the Node.js test runner.

For test audits, proof selection, diff cleanup, and independent review, see
[Developer skills](developer-skills.md).

### Run an explicit file selection

Use `test:files` to validate every selected path and option before starting tests:

```sh
pnpm test:files --test-reporter=spec -- tests/conformance/contracts.test.mjs
```

The runner accepts literal, existing `.test.js`, `.test.cjs`, `.test.mjs`,
`.test.ts`, `.test.cts`, or `.test.mts` files inside this repository. Missing
files, duplicates, paths outside the repository, and unsupported options fail
before any selected file executes. Quote paths containing spaces or glob
characters so the shell passes the literal filename. Run
`node scripts/test-files.mjs --help` for concurrency, filter, and reporter options.

Prepare dependencies and infrastructure first. This command does not run the
workspace check or prepare fixtures. It preserves Node's failure, skip, todo,
process isolation, and cancellation behavior. A valid file selection or a green
filtered run does not prove that the intended cases ran; inspect the reported
case and skip counts. Existing suite discovery and CI selection remain available.

## Integration tests

Each suite page owns its setup, environment variables, model defaults, cleanup,
and coverage limits. See [GitHub Actions](ci.md) for CI coverage.

| Need                           | Suite                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Local source, API, and browser | [Local checks](local.md#local-checks) and [console browser checks](local.md#console-browser-checks)            |
| Persistence and packaging      | [PostgreSQL](postgresql.md), [Images and Helm](images.md), and [Docker Compose](docker.md)                     |
| Real runtime or host execution | [SSH](ssh.md), [Kubernetes](kubernetes.md), [Production TUI](production-tui.md), and [OpenShell](openshell.md) |
| External provider integrations | [Slack](slack.md), [ChatGPT service accounts](service-accounts.md), and [Agent plugins](plugins.md)            |

## Requirements and credentials

Use Node.js 24 or newer, the pnpm version pinned in
[`package.json`](../../package.json), and the Go version selected by
[`go.mod`](../../go.mod), with dependencies installed from the lockfiles:

```sh
pnpm install --frozen-lockfile
```

The tests import TypeScript source directly. OCC CLI integrations build the real
Go binary before invoking it; other local integrations also execute Git, `tar`,
and pnpm.

Supply real keys through your authorized credential manager or an existing
private environment file. Test entrypoints do not automatically load `.env`.
After preparing a file outside the repository:

```sh
TEST_ENV_FILE=/absolute/path/to/private/runtime-test.env
chmod 600 "$TEST_ENV_FILE"
node --env-file="$TEST_ENV_FILE" --test tests/integration/docker-compute-real.test.mjs
```

That file must contain the inputs for the selected suite, including its opt-in
and images. Node passes the loaded environment to test subprocesses. Existing
exported values take precedence over the file, so avoid stale selectors or keys
in the parent shell. Do not print credentials, commit them, or include them in
command-line arguments. Suite pages document model defaults and compatibility.

## Results, cleanup, and troubleshooting

Read the test runner's pass, failure, and skip counts. Record the selected files,
commit, nonsecret image digests/model, and which optional cases were enabled.
Do not report a skipped model turn, database case, or cluster case as verified.
Keep optional live Configuration cases and mutually exclusive Slack selection
distinct from missing prerequisites.

Tests normally clean up their own temporary processes, resources, and files, but
some suites leave clusters, databases, Slack messages, or provider accounts for
inspection or follow-up. Retain failure evidence before cleanup. Remove only
resources created for the run; do not delete shared Compose volumes, existing
databases, or unrelated clusters.

| Symptom                                                  | Check or recovery                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Green command with expected integration coverage absent  | Inspect skips and selection variables; target the exact suite with its full prerequisites.                                             |
| Provider authentication or unsupported custom-tool error | Check credential/model access without printing the key; explicitly select a compatible model from the owning suite page.               |
| Missing Helm or `yq`                                     | Install the required tools before claiming packaging coverage; these tests do not install them.                                        |
| Kubernetes or OpenShell prerequisite failure             | Use the [Kubernetes](kubernetes.md) or [OpenShell](openshell.md) setup and recovery notes instead of running the all-integration glob. |

## Related

- [Deployment guide](../guides/deploy.md)
- [Runtime image recipe](../../deploy/runtime/README.md)
- [Contributor integration boundaries](../../AGENTS.md#running-integration-tests)
