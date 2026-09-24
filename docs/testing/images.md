# Image and Helm tests

Check packaged controller and runtime images and render the production Helm
chart. These checks use images present in the local Docker engine, either pulled
from a registry or built from source. They do not require model credentials.

## Images and Helm

### Check published images

On a `linux/amd64` or `linux/arm64` host, follow [Use published images](../guides/deploy/production-installation.md#use-published-images)
to authenticate to private GHCR and export `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`.
Docker pulls the variant matching the host. These commands check that variant;
they do not test both architectures in one invocation. Run from the repository
root with the [local test prerequisites](local.md).
To reproduce the published release's checks, use its recorded source revision;
when validating source changes, build images from that checkout instead.

```bash
docker pull "$CONTROLLER_IMAGE"
docker pull "$RUNTIME_IMAGE"
OCC_TEST_PRODUCTION_IMAGE="$CONTROLLER_IMAGE" \
OCC_TEST_RUNTIME_IMAGE="$RUNTIME_IMAGE" \
  node --test tests/integration/production-image-startup.test.mjs \
    tests/integration/runtime-image-startup.test.mjs \
    tests/integration/repository-runtime-volume.test.mjs
```

All three image suites must run without skips. If the registry denies a pull, check
the account's package access and token scope; successful `git clone` alone does not
establish `read:packages` token scope. These checks verify the release images,
not unbuilt changes in the working tree. Source CI continues to build the
revision it tests.

### Build images from the checkout

Build the [runtime image](../../deploy/runtime/README.md), then run its startup smoke:

```sh
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:test .
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/runtime-image-startup.test.mjs \
    tests/integration/repository-runtime-volume.test.mjs
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

### Render the Helm chart

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

## Emulated image startup checks

Both startup suites accept `OCC_TEST_IMAGE_TIMEOUT_MULTIPLIER`, an integer from
1 through 10, to scale command and in-container probe deadlines. It defaults to

1. Release preparation sets it to 6 for ARM64 running under QEMU and 1 for native
   amd64. Expected errors, readiness, plugin discovery, and packaging assertions are
   unchanged; a timeout still fails the suite.

## Production image startup test environment

[`production-image-startup.test.mjs`](../../tests/integration/production-image-startup.test.mjs)
verifies a locally available production controller image before Helm installation.
It runs the image with no network, deliberately points it at an unreachable
database, checks that startup reaches that expected database boundary without
missing bundled production modules, and verifies that the OpenShell gRPC proto
asset is present.

| Variable                    | Requirement or default                                       |
| --------------------------- | ------------------------------------------------------------ |
| `OCC_TEST_PRODUCTION_IMAGE` | Local controller image tag or digest reference; unset skips. |
| `OCC_DOCKER_BIN`            | Optional Docker executable path; defaults to `docker`.       |

This check does not prove PostgreSQL connectivity, Helm rendering, Kubernetes
reconciliation, runtime image execution, or a model turn.

## Runtime image startup test environment

[`runtime-image-startup.test.mjs`](../../tests/integration/runtime-image-startup.test.mjs)
verifies a locally available OpenClaw runtime image before Docker Compose or
Kubernetes execution. It starts task-owned containers with the Docker Compute
Driver gateway entrypoint, UID `1000:1000`, a read-only root filesystem, and
tmpfs-backed `/home/node` and `/tmp`. Host Node.js 24+ is required to run the
test.

| Variable                 | Requirement or default                                    |
| ------------------------ | --------------------------------------------------------- |
| `OCC_TEST_RUNTIME_IMAGE` | Local runtime image tag or digest reference; unset skips. |
| `OCC_DOCKER_BIN`         | Optional Docker executable path; defaults to `docker`.    |

This check proves an embedded OpenClaw gateway reaches `/readyz` from a fresh
runtime home and the bundled Codex plugin can be discovered without missing
package dependencies. It does not prove Docker Compose orchestration,
Kubernetes reconciliation, model credentials, or a model turn.

## Repository runtime volume test environment

[`repository-runtime-volume.test.mjs`](../../tests/integration/repository-runtime-volume.test.mjs)
runs both production repository initializers and the client installed in the
selected runtime image. It creates a root-owned mode-02775 tmpfs volume and mounts
its private subPath into nonroot init and consumer containers, with networking
disabled. Docker must support `volume-subpath` mounts.

```sh
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/repository-runtime-volume.test.mjs
```

`OCC_DOCKER_BIN` optionally selects the Docker executable. An unset image selector
skips this standalone invocation. The `images-packaging` CI lane requires
`OCC_TEST_RUNTIME_IMAGE` and this exact case; a missing prerequisite, failure or
skip fails the selected lane. Build the image from the candidate being qualified.
The test resolves its selector to an immutable image ID and uses the installed
bundle without mounting a detached client overlay.

The case checks rejection of a different UID, repair of partial native Git
configuration, repeat preparation and read-only consumer delivery. It removes
its owned container and volume. This proves the exercised Docker mounts and
installed client composition; it does not prove Kubernetes fsGroup behavior,
NetworkPolicy enforcement, a model turn or live GitHub operations.

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
