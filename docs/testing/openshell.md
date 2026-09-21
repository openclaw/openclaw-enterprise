# OpenShell tests

Verify provider-owned Codex execution and OpenShell filesystem and network
enforcement. Prepare [credentials](README.md#requirements-and-credentials)
and use the suite-specific infrastructure below.

## OpenShell Sandbox

This suite needs the owned OpenShell CI recipe: a disposable K3s v1.36.4 k3d
cluster, matched kubectl, the selected RuntimeClass bound to the cluster's
`runc` handler, a successful RuntimeClass smoke Pod, Agent Sandbox
CRDs/controller, OpenShell CLI/Helm/chart files, imported immutable OpenShell
gateway and supervisor images, real gateway/Codex images, the Kubernetes test
database, `openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is
insufficient because it does not install the CI-owned admission config,
RuntimeClass, Agent Sandbox, or OpenShell assets.

For CI-shaped setup, let `prepare.mjs` create the pinned K3s cluster, install
OpenShell prerequisites, and export the lane environment before
`run-tests.mjs` invokes the case:

```sh
node scripts/ci/prepare.mjs \
  --lane openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --results "$RUNNER_TEMP/results/openshell.json"
```

For manual setup, prepare these inputs using the
[OpenShell test settings](#openshell-test-environment) and
[OpenShell requirements](../reference/drivers/openshell-sandbox.md#kubernetes-and-admission-requirements),
then run the exact file:

```sh
OCC_TEST_OPENSHELL_K3D_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs
```

With stock OpenShell, the selected test expects the driver to reject unsupported
Secret projection before the candidate can activate. This is a failure-path
check, not successful provider authentication or model execution.

Set `OCC_TEST_OPENSHELL_SECRET_PROJECTION=1` only for an upstream runtime that
supports the required genuine projections. That positive scenario requires a real
gateway model turn, provider-owned dedicated Codex execution, exact projected
workload identity, approved mounts and privileges, denied secret exposure, allowed
and denied tool egress, and lifecycle cleanup. Missing prerequisites after
selection fail rather than skip.

### Upstream projection prerequisite

The integration uses an operator-owned Helm wrapper to install the OpenShell
gateway before delegating to the driver. The bundled driver does not install
that gateway. Stock OpenShell `v0.0.113` cannot receive the required exact
`secretKeyRef` environment entries and projected workload identity through its
gateway configuration. The test does not substitute a credential bridge or
Pod-template patch. See the [production contract](../reference/drivers/openshell-sandbox.md#current-upstream-preconditions).

Local `sandbox-driver-startup`, `controller-lifecycle`, and
`postgres-platform-state` integration tests cover driver selection, revision
lifecycle, and persistence. They do not exercise these real OpenShell tools.

## OpenShell test environment

[`sandbox-driver-openshell-k3d-real.test.mjs`](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
is selected by `OCC_TEST_OPENSHELL_K3D_REAL=1` or by setting any Kubernetes,
image, database, or OpenShell-specific prerequisite. If any of those variables
is present while the flag is not `1`, prerequisite validation still fails; use a
scoped environment file for this suite.

| Variable                               | Requirement or default                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_OPENSHELL_K3D_REAL`          | Set to `1` to explicitly opt into the real OpenShell integration.                                                                                   |
| `OCC_TEST_OPENSHELL_SECRET_PROJECTION` | Set to `1` only when upstream supports genuine Secret and workload-identity projections; selects positive model/lifecycle proof.                    |
| `OPENAI_API_KEY`                       | Existing authorized provider credential for the required real model turn.                                                                           |
| `OCC_TEST_OPENAI_MODEL`                | Authorized provider model; defaults to `gpt-6-astra`.                                                                                               |
| `OCC_TEST_KUBERNETES_KUBECONFIG`       | Absolute kubeconfig path for the dedicated disposable k3d cluster.                                                                                  |
| `OCC_TEST_KUBERNETES_CONTEXT`          | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                                                        |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`    | Imported immutable real OpenClaw gateway image; `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` is accepted as a fallback.                                      |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`      | Imported immutable real Codex image; `OCC_TEST_KUBERNETES_CODEX_IMAGE` and runtime image fallbacks are accepted.                                    |
| `OCC_TEST_DATABASE_URL`                | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                                                                            |
| `OCC_TEST_OPENSHELL_CLI`               | Official OpenShell CLI binary.                                                                                                                      |
| `OCC_TEST_OPENSHELL_HELM`              | Helm binary used to install the namespace-scoped OpenShell gateway.                                                                                 |
| `OCC_TEST_OPENSHELL_HELM_CHART`        | OpenShell Helm chart path or chart archive.                                                                                                         |
| `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`     | Imported immutable OpenShell gateway image pinned by SHA-256 digest.                                                                                |
| `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`  | Imported immutable OpenShell supervisor image pinned by SHA-256 digest.                                                                             |
| `OCC_TEST_OPENSHELL_CHART_VERSION`     | Optional OpenShell chart version; defaults to `0.0.113`.                                                                                            |
| `OCC_TEST_OPENSHELL_RUNTIME_CLASS`     | Existing RuntimeClass used by Agent Sandbox Pods; CI creates the selected RuntimeClass, defaulting to `openshell-sandbox`, with the `runc` handler. |

The selected cluster must already expose the Agent Sandbox CRD and a ready Agent
Sandbox controller. See the
[OpenShell SandboxDriver testing guide](#openshell-sandbox) for
the required cluster, image, database, RuntimeClass, and chart setup.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
