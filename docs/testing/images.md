# Image and Helm tests

Check packaged controller and runtime images and render the production Helm
chart. These checks use local images and do not require model credentials.

## Images and Helm

Build the [runtime image](../../deploy/runtime/README.md), then run its startup smoke:

```sh
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:test deploy/runtime
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/runtime-image-startup.test.mjs
```

This checks gateway readiness and bundled Codex/Slack plugin loading from a
fresh runtime home, then initializes the image's real Codex app-server through
the installed plugin's version guard. The smoke runs offline without provider
credentials. It does not make a model call or establish a Slack connection;
run the [live Slack test](slack.md#slack) for channel delivery proof.

Build the controller image using the [production prerequisites](../guides/deploy.md#production-prerequisites),
then set `OCC_TEST_PRODUCTION_IMAGE` to the local tag you built:

```sh
OCC_TEST_PRODUCTION_IMAGE=openclaw-enterprise:reviewed \
  node --test tests/integration/production-image-startup.test.mjs
```

The controller smoke intentionally uses an unreachable database with networking
disabled. It verifies module loading and packaged OpenShell protocol assets;
the expected database error is the boundary being tested.

With Helm and a `yq` executable supporting `eval-all -o=json` installed:

```sh
node --test tests/integration/production-kubernetes-packaging.test.mjs
```

This renders the chart and verifies private Services, dedicated workload
identities, tenant-scoped RoleBindings, mounted Secrets, restrictive networking,
bootstrap ordering, and rejection of unsafe image or policy inputs. It does not
install the chart or exercise live admission and NetworkPolicy enforcement.
Missing Helm or `yq` skips the Helm cases; unset image selectors skip the image smokes.

## Development Compose packaging

Run the development credential-isolation and logging packaging checks with a
real Compose provider available on `PATH`:

```sh
node --test tests/integration/development-packaging.test.mjs tests/integration/logging-packaging.test.mjs
```

These tests resolve the checked-in Compose files using Docker Compose's JSON
output, or `podman-compose` YAML converted by `yq`. They verify bootstrap key
volume isolation, startup dependencies, and the logging override's private
Collector bindings. No containers are started or model credentials used; this
is configuration proof, not proof of live logging delivery. The logging file
also contains Helm checks requiring Helm and `yq`.

If a provider or YAML converter is missing, the Compose cases fail rather than
skip. A `docker` command pointing to Podman is supported: provider detection
selects `podman-compose` when Docker's JSON config capability is unavailable.

## Production image startup test environment

[`production-image-startup.test.mjs`](../../tests/integration/production-image-startup.test.mjs)
verifies a locally built production controller image before Helm installation.
It runs the image with no network, deliberately points it at an unreachable
database, checks that startup reaches that expected database boundary without
missing bundled production modules, and verifies that the OpenShell gRPC proto
asset is present.

| Variable                    | Requirement or default                                      |
| --------------------------- | ----------------------------------------------------------- |
| `OCC_TEST_PRODUCTION_IMAGE` | Locally built production controller image tag; unset skips. |
| `OCC_DOCKER_BIN`            | Optional Docker executable path; defaults to `docker`.      |

This check does not prove PostgreSQL connectivity, Helm rendering, Kubernetes
reconciliation, runtime image execution, or a model turn.

## Runtime image startup test environment

[`runtime-image-startup.test.mjs`](../../tests/integration/runtime-image-startup.test.mjs)
verifies a locally built OpenClaw runtime image before Docker Compose or
Kubernetes execution. It starts task-owned containers with the Docker Compute
Driver gateway entrypoint, UID `1000:1000`, a read-only root filesystem, and
tmpfs-backed `/home/node` and `/tmp`. Host Node.js 24+ is required to run the
test.

| Variable                 | Requirement or default                                 |
| ------------------------ | ------------------------------------------------------ |
| `OCC_TEST_RUNTIME_IMAGE` | Locally built OpenClaw runtime image tag; unset skips. |
| `OCC_DOCKER_BIN`         | Optional Docker executable path; defaults to `docker`. |

This check proves an embedded OpenClaw gateway reaches `/readyz` from a fresh
runtime home and the bundled Codex plugin can be discovered without missing
package dependencies. It does not prove Docker Compose orchestration,
Kubernetes reconciliation, model credentials, or a model turn.

## Helm packaging test environment

The checked-in production packaging integration renders the real Helm chart
and inspects it with an existing `yq` executable. `OCC_HELM_BIN` optionally
selects an existing Helm executable; otherwise the test resolves `helm` from
`PATH`. Missing Helm or `yq` skips this packaging check. Rendering does not
install the chart, reconcile a cluster, or establish a real model turn.

To select a Helm executable outside `PATH`:

```bash
OCC_HELM_BIN=/absolute/path/to/helm \
  node --test tests/integration/production-kubernetes-packaging.test.mjs
```

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
