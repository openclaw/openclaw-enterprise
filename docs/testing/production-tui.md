# Production TUI tests

Verify a Helm-installed control plane, native TUI interaction, and revision
cutover on a disposable k3d cluster. Prepare the
[shared requirements](README.md#requirements-and-credentials) first.

## Production TUI Helm test environment

[`production-tui-k3d-real.test.mjs`](../../tests/integration/production-tui-k3d-real.test.mjs)
is the opt-in end-to-end production TUI proof. It installs the actual Helm
chart into the selected disposable k3d cluster, starts task-owned PostgreSQL and
HTTPS operator proxy Pods, provisions a Namespace and embedded OpenClaw Agent
through the production API, drives the native TUI with a PTY, verifies revision
cutover, and records nonsecret evidence as it progresses. The test sets
`agents.defaults.skipBootstrap` to `true` in the disposable demo Agent
Configuration so fresh-workspace `BOOTSTRAP.md` onboarding does not replace the
nonce reply; existing workspaces with bootstrap files are unaffected. Missing
prerequisites fail the selected test instead of skipping. Allow at least 4 GiB
per gateway container because the test runs the TUI as a second OpenClaw process
inside the embedded gateway.

| Variable                                       | Requirement or default                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_PRODUCTION_TUI_REAL`                 | Set to `1` to explicitly opt into the Helm-backed production TUI suite.                                                 |
| `OCC_TEST_KUBERNETES_KUBECONFIG`               | Absolute path to the dedicated disposable k3d kubeconfig.                                                               |
| `OCC_TEST_KUBERNETES_CONTEXT`                  | Explicit `k3d-*` context with a verified loopback HTTPS Kubernetes API.                                                 |
| `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`         | Imported immutable controller image reference used by the Helm chart.                                                   |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`            | Imported immutable runtime image reference used for the embedded OpenClaw gateway.                                      |
| `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`           | Imported immutable PostgreSQL image reference for the task-owned database Pod.                                          |
| `OCC_TEST_PRODUCTION_NODE_IMAGE`               | Imported immutable Node image reference for the operator HTTPS proxy and network probes.                                |
| `OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE` | Optional second immutable controller image; set with the runtime candidate to exercise both independent release paths.  |
| `OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE`    | Optional second immutable runtime image; set with the controller candidate to exercise both independent release paths.  |
| `OPENAI_API_KEY`                               | Existing authorized provider credential used only by the Agent-owned embedded gateway path.                             |
| `OCC_TEST_OPENAI_MODEL`                        | Authorized provider model; defaults to `gpt-6-astra`.                                                                   |
| `OCC_TEST_PRODUCTION_TUI_KEEP`                 | Optional `1` retains the owned Helm release, namespaces, final gateway, `attach.sh`, and `proof.json` rehearsal output. |

Use the production TUI suite only with image references that already exist in
the selected cluster, including the Node, PostgreSQL, controller, and runtime
digests. Default cleanup uninstalls the Helm release and deletes only the
task-owned namespaces. `OCC_TEST_PRODUCTION_TUI_KEEP=1` changes that finalizer
for operator rehearsal: it keeps the owned setup running, leaves an executable
`attach.sh` for the final gateway TUI session, and writes `proof.json` with the
cluster, image, Namespace, Agent, revision, Pod, and nonce-response evidence.
Do not treat an in-progress run as passing live proof until the test completes.

When both upgrade image variables are set, the test runs a controller-only
release and then a runtime-only release after the initial revision and model
proof. It verifies that the controller release retains every Agent revision and
that the runtime release keeps the controller digest, replaces two running
Agents, preserves one stopped Agent, and completes a fresh model turn. Setting
only one variable fails the selected test. Omitting both keeps the original
installation and TUI coverage but does not prove either upgrade path.

## Run the suite

Put the required inputs in the [private environment file](README.md#requirements-and-credentials)
after importing the selected images into the disposable cluster:

```sh
OCC_TEST_PRODUCTION_TUI_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/production-tui-k3d-real.test.mjs
```

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
