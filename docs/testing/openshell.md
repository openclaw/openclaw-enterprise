# OpenShell tests

Verify provider-owned Codex execution and OpenShell filesystem and network
enforcement. Prepare [credentials](README.md#requirements-and-credentials)
and use the suite-specific infrastructure below.

## Start a reusable development environment

Use the [local Kubernetes OpenShell profile](../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
for an ordinary OpenClaw Enterprise development stack. That profile starts the
real control plane, Gateway, and operator Workspaces. It prepares the supported
fail-closed Agent path but does not create an Agent.

Create the private Kubernetes-only OpenShell `v0.1.0` environment from the
repository root:

```sh
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

The launcher uses Docker or Podman only to host k3d and build or import images.
PostgreSQL, the OCE API and worker, and OpenShell Gateway run inside the cluster.
It leaves the environment running and does not change the default kubeconfig or
context. No model credential is needed because stock v0.1.0 cannot run the
regular Agent path.

Stop the reusable environment before proving the setup and cleanup lifecycle in
a separate fresh cluster:

```sh
./scripts/dev-down
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The command verifies control-plane Pods, Workspace reconciliation, and cleanup;
it does not use the compatibility bridge or perform a model turn. The reusable
environment's startup output prints its API URL, kubeconfig, context, and
service-key file without printing credential contents.

Select the alternate proof when PostgreSQL, the OCE API, and the worker must
remain in Compose:

```sh
OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

This case verifies the real Compose-backed control plane, Gateway NodePort,
operator Workspace, and combined Compose and cluster cleanup. It uses the same
disposable-cluster and no-model-turn boundary as the Kubernetes-only case.

The OpenShell CI lane runs this lifecycle through `scripts/dev-up` and
`scripts/dev-down` before its credentialed Sandbox case.

Remove the owned environment when finished:

```sh
./scripts/dev-down
```

Cleanup permanently deletes this helper's cluster and in-cluster database. A
partial setup remains recorded for safe cleanup; run `down` before retrying. Set
the absolute `OCC_DEVELOPMENT_STATE_DIRECTORY` before every command to keep
multiple checkouts separate. Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or
`podman` when automatic engine selection is ambiguous.

This launcher does not start a supported production Installation or an
interactive OCC Agent. The credentialed compatibility experiment remains the
separate real Sandbox suite below.

## OpenShell Sandbox

This suite needs the owned OpenShell CI recipe: a disposable K3s v1.36.4 k3d
cluster, matched kubectl, the selected RuntimeClass bound to the cluster's
`runc` handler, a successful RuntimeClass smoke Pod, Agent Sandbox
CRDs/controller, Helm, the OpenShell chart source, imported immutable OpenShell
gateway, sandbox runtime, and supervisor images, real gateway/Codex images, the
Kubernetes test database, `openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is
insufficient because it does not install the CI-owned admission config,
RuntimeClass, Agent Sandbox, or OpenShell assets.

For CI-shaped setup, let `prepare.mjs` create the pinned K3s cluster, install
OpenShell prerequisites, and export the lane environment before
`run-tests.mjs` invokes the case:

```sh
export OCC_TEST_OPENSHELL_SECRET_PROJECTION=1
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

Set `OCC_TEST_OPENSHELL_SECRET_PROJECTION=0` for the stock fail-closed proof. It
passes the production requirements to v0.1.0 unchanged and expects the Driver to
reject unsupported Secret projection before the candidate can activate. This
does not prove provider authentication or model execution.

Set the selector to `1` for the verification-only compatibility proof. The
strict CI runner forwards the selector and accounts for one stable test identity
in either mode. The positive scenario uses a test-only operator Job to stage the
exact Secret values, plugin-runtime files, and projected workload token in
revision-specific PVC subpaths before OpenShell starts the provider-owned
Harness. The Driver asks OpenShell to expose the app-server port in the original
Sandbox Create request. The test confirms that the returned route reaches the
protected Codex app server and that v0.1.0 strips its bearer authorization, so the
upgrade fails with `401` instead of weakening app-server authentication. It then
runs the real model turn over the authenticated Pod-loopback endpoint. The
scenario also requires exact workload identity claims, approved mounts and
privileges, denied secret exposure, allowed and denied tool egress, replacement,
and cleanup. It separately checks the OpenClaw Control Plane (OCC) Agent Service
selector. Missing prerequisites fail rather than skip.

Use an OCE runtime image built from the OpenClaw source commit pinned by
`deploy/runtime/Dockerfile`. The test requires the workspace-node
`--pair-if-needed` and `--commands` CLI options. The test configures
the private Gateway with its fully qualified `.svc.cluster.local` hostname so
OpenShell policy DNS, the listener certificate, the HTTPRoute, and node pairing
use the same name.

### Test bridge and upstream prerequisite

The integration uses an operator-owned Helm wrapper to install the OpenShell
gateway before delegating to the Driver. The bundled Driver does not install
that gateway. Stock OpenShell `v0.1.0` cannot receive the required exact
`secretKeyRef` environment entries, plugin-runtime ConfigMap, or projected
workload identity through its gateway configuration.

Positive mode bridges those shapes only inside this test. Its bootstrap Job
mounts the production Secret references, immutable `runtime.json` and
`config.toml` ConfigMap entries, and an audience-bound ServiceAccount token. It
copies them into private PVC subpaths. The compatibility request mounts the
credentials, plugin runtime, and workload token read-only; revision-owned node
state, runtime assets, and the Harness workspace remain writable. Helm permits
the OpenShell supervisor Pod to reach Envoy only from the Gateway-attached
tenant namespace because the supervisor owns the policy-enforced outbound
socket. The verification-only Gateway enables caller driver configuration and
disables v0.1.0 resource admission because this bridge attaches OCE-owned PVCs
without OpenShell approval labels. The Enterprise Driver still restricts the
request to its approved Harness mounts. This setting is not a supported
production path. OpenShell v0.1.0 also removes the
`Authorization` header before forwarding an exposed service request, while the
Codex app server accepts only bearer authorization. The integration therefore
proves exposed-route reachability and app-server rejection separately from its
authenticated in-Sandbox model turn. Production still rejects the original
requirements. See the
[production contract](../reference/drivers/openshell-sandbox.md#current-upstream-preconditions)
and the [pre.5 experiment handoff](openshell-pre5-local-experiment.md).

Local `sandbox-driver-startup`, `controller-lifecycle`, and
`postgres-platform-state` integration tests cover driver selection, revision
lifecycle, and persistence. They do not exercise these real OpenShell tools.

### Development profile

The opt-in development-profile integration installs PostgreSQL and OCE with
Helm in the owned k3d cluster, installs the checksum-pinned OpenShell assets,
and verifies the bootstrap Namespace, RuntimeClass, Agent Sandbox API,
deployment Gateway, operator label, workspace ServiceAccount, and actual
matching Workspace through the Gateway API. It then creates another
OCC Namespace and verifies that the Driver applies the same ServiceAccount and
creates its matching Workspace without another Helm release:

```sh
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The Driver, rather than a per-Namespace Helm release, applies the rendered
workspace-chart resources before creating the Workspace. The case requires an
executable checkout-local `bin/occ`, Docker or Podman, k3d, kubectl, Helm, and
network access to the pinned sources and images. Set
`OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman` to select a prepared Podman engine.
It creates unique cluster, state, API, and Kubernetes port names and removes
only those resources. Missing selected prerequisites fail.

This case proves development orchestration, the two real charts, Driver-owned
operator resource reconciliation, and Gateway Workspace creation. It does not
create an Agent or Sandbox. The
`OCC_TEST_OPENSHELL_SECRET_PROJECTION=0` real Sandbox Driver case remains the
Agent-level proof that the ordinary dedicated Codex workflow rejects unsupported
Secret projection without creating a Sandbox or Agent Pod.

## OpenShell test environment

[`sandbox-driver-openshell-k3d-real.test.mjs`](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
is selected by `OCC_TEST_OPENSHELL_K3D_REAL=1` or by setting any Kubernetes,
image, database, or OpenShell-specific prerequisite. If any of those variables
is present while the flag is not `1`, prerequisite validation still fails; use a
scoped environment file for this suite.

| Variable                                  | Requirement or default                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_OPENSHELL_K3D_REAL`             | Set to `1` to explicitly opt into the real OpenShell integration.                                                                                   |
| `OCC_TEST_OPENSHELL_SECRET_PROJECTION`    | `0` selects stock fail-closed proof; `1` selects the verification-only v0.1.0 compatibility proof with exposed-route and real model-turn checks.    |
| `OPENAI_API_KEY`                          | Existing authorized provider credential for the required real model turn.                                                                           |
| `OCC_TEST_OPENAI_MODEL`                   | Authorized provider model; defaults to `gpt-6-astra`.                                                                                               |
| `OCC_TEST_KUBERNETES_KUBECONFIG`          | Absolute kubeconfig path for the dedicated disposable k3d cluster.                                                                                  |
| `OCC_TEST_KUBERNETES_CONTEXT`             | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                                                        |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`       | Imported immutable real OpenClaw gateway image; `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` is accepted as a fallback.                                      |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`         | Imported immutable real Codex image; `OCC_TEST_KUBERNETES_CODEX_IMAGE` and runtime image fallbacks are accepted.                                    |
| `OCC_TEST_DATABASE_URL`                   | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                                                                            |
| `OCC_TEST_OPENSHELL_HELM`                 | Helm binary used to install the namespace-scoped OpenShell gateway.                                                                                 |
| `OCC_TEST_OPENSHELL_HELM_CHART`           | OpenShell Helm chart path or chart archive.                                                                                                         |
| `OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART` | OpenShell workspace Helm chart path or chart archive used for operator-mode namespace RBAC.                                                         |
| `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`        | Imported immutable OpenShell gateway image pinned by SHA-256 digest.                                                                                |
| `OCC_TEST_OPENSHELL_SANDBOX_IMAGE`        | Imported immutable OpenShell sandbox runtime image pinned by SHA-256 digest.                                                                        |
| `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`     | Imported immutable OpenShell supervisor image pinned by SHA-256 digest.                                                                             |
| `OCC_TEST_OPENSHELL_CHART_VERSION`        | Optional OpenShell chart version; defaults to `0.1.0`.                                                                                              |
| `OCC_TEST_OPENSHELL_RUNTIME_CLASS`        | Existing RuntimeClass used by Agent Sandbox Pods; CI creates the selected RuntimeClass, defaulting to `openshell-sandbox`, with the `runc` handler. |

The selected cluster must already expose the Agent Sandbox CRD and a ready Agent
Sandbox controller. See the
[OpenShell SandboxDriver testing guide](#openshell-sandbox) for
the required cluster, image, database, RuntimeClass, and chart setup.

The CI bootstrap verifies the `v0.1.0` source archive checksum, packages
the chart from that tag, and imports gateway, sandbox runtime, and supervisor
images published under the tag's commit SHA. It does not depend on prerelease
GitHub Release assets or a semver-tagged chart.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
