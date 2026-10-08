# Image and Helm tests

Check packaged controller and runtime images and render the production Helm
chart. These checks use images present in the local Docker engine, either pulled
from a registry or built from source. They do not require model credentials.

## Container publication registry proof

The Images and Packaging CI lane runs the publication command against a
loopback-only disposable Docker Distribution registry using Skopeo 1.13.3. Run it
locally from the repository root with Docker and that Skopeo version installed:

```sh
OCC_TEST_CONTAINER_REGISTRY=1 node --test tests/integration/container-registry-real.test.mjs
```

The test pulls a digest-pinned registry image and removes its own container. It
uses real multi-platform OCI archives, Skopeo transfers and registry reads, with
fixture GitHub metadata and a local registry address adapter. It verifies alias
replacement and the immutable source digests; it does not prove GHCR access,
GitHub permissions, or hosted publication. Without the selector the test skips.

## Images and Helm

### Check published images

On a `linux/amd64` or `linux/arm64` host, use the source revision that produced
the images. Docker pulls the variant matching the host; run these checks on a
native host for each target architecture. Run from the repository root with the
[local test prerequisites](local.md).

Public GHCR images pull anonymously. On each check host, authenticate Docker only
when the selected registry is private. The temporary Skopeo auth file used for
[private image delivery](../guides/deploy/private-registry-images.md) does not
authenticate Docker. For ECR, set `AWS_REGION` and `ECR_REGISTRY` to the target
Region and registry, then run this block on its own and stop if it fails:

```bash
if [[ -n "${AWS_REGION:-}" && -n "${ECR_REGISTRY:-}" ]]; then
  (
    set -o pipefail
    aws ecr get-login-password --region "$AWS_REGION" | \
      docker login --username AWS --password-stdin "$ECR_REGISTRY"
  )
else
  printf 'Set AWS_REGION and ECR_REGISTRY before logging in to ECR.\n' >&2
  false
fi
```

ECR credentials expire; authenticate again if needed. For GHCR, follow
[Use published images](../guides/deploy/production-installation.md#use-published-images)
without a login. For another private registry, follow its Docker login procedure.
Protect Docker credentials according to your registry policy. This login does
not grant nodes pull access.

For a current release or custom pair selected for installation, set the check-only
variables from the immutable `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` exports:

```bash
: "${CONTROLLER_IMAGE:?Set the controller digest reference}"
: "${RUNTIME_IMAGE:?Set the runtime digest reference}"
export OCC_IMAGE_CHECK_CONTROLLER="$CONTROLLER_IMAGE"
export OCC_IMAGE_CHECK_RUNTIME="$RUNTIME_IMAGE"
```

For historical image tests, follow [Use published images](../guides/deploy/production-installation.md#use-published-images)
to authenticate and export the historical pair. Select it explicitly without
changing the installation variables:

```bash
: "${HISTORICAL_CONTROLLER_IMAGE:?Set the historical controller digest}"
: "${HISTORICAL_RUNTIME_IMAGE:?Set the historical runtime digest}"
export OCC_IMAGE_CHECK_CONTROLLER="$HISTORICAL_CONTROLLER_IMAGE"
export OCC_IMAGE_CHECK_RUNTIME="$HISTORICAL_RUNTIME_IMAGE"
```

Pull and check the selected pair:

```bash
docker pull "$OCC_IMAGE_CHECK_CONTROLLER"
docker pull "$OCC_IMAGE_CHECK_RUNTIME"
OCC_TEST_PRODUCTION_IMAGE="$OCC_IMAGE_CHECK_CONTROLLER" \
OCC_TEST_RUNTIME_IMAGE="$OCC_IMAGE_CHECK_RUNTIME" \
  node --test tests/integration/production-image-startup.test.mjs \
    tests/integration/runtime-image-startup.test.mjs \
    tests/integration/runtime-image-startup-probe.test.mjs \
    tests/integration/runtime-image-gateway-peer.test.mjs \
    tests/integration/runtime-image-native-worker.test.mjs \
    tests/integration/repository-runtime-volume.test.mjs
```

Before installation, all these suites must pass without skips for the exact
current pair selected in `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`. Rebuilding or
changing a digest requires new checks. The historical pair does not meet current
installation requirements. If GHCR denies a pull, check package visibility and
network access to GHCR. These checks verify the selected images, not unbuilt
changes in the working tree.

### Build images from the checkout

Build the [runtime image](../../deploy/runtime/README.md), then run its startup smoke:

```sh
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:test .
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/runtime-image-startup.test.mjs \
    tests/integration/runtime-image-startup-probe.test.mjs \
    tests/integration/runtime-image-gateway-peer.test.mjs \
    tests/integration/runtime-image-native-worker.test.mjs \
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

## Repository image-pair qualification

Run the identity and node qualification fixtures without model credentials:

```sh
node --test tests/integration/production-image-qualification.test.mjs
```

The image identity case runs the production CLI against a synthetic OCI archive
with 34 small compressed filesystem layers. It verifies that the layers do not
consume the metadata allowance and that corrupt or excessive metadata is still
rejected. Docker inspection and export are fixture I/O; this does not establish
native Docker behavior or a live upgrade.

The qualification test invokes the actual staged controller and broker images
with synthetic App and TLS material and a disposable receipt listener. On a
Linux host running as UID 1000, stage immutable images for its native Docker
daemon architecture and run:

```sh
OCC_PROBE_CONTROLLER_IMAGE='<controller>@sha256:<digest>' \
OCC_PROBE_BROKER_IMAGE='<broker>@sha256:<digest>' \
OCC_PROBE_OLD_CONTROLLER_IMAGE='<old-controller>@sha256:<digest>' \
OCC_PROBE_OLD_BROKER_IMAGE='<old-broker>@sha256:<digest>' \
node --test tests/integration/production-image-real-qualification.test.mjs
```

The old images exercise both incompatible version directions. Select an old
controller without the admission probe and an old broker without durable-admission
capability; an older image alone may still support the required protocol. Omitted
image variables skip the corresponding real-image cases. To require both cases,
export all four variables and run the optional local suite lane:

```sh
umask 077
pair_state_dir=$(mktemp -d)
node scripts/ci/run-tests.mjs run image-pair-qualification \
  --state "$pair_state_dir/state.json" --results "$pair_state_dir/results.json"
```

The lane requires all four immutable references and fails if either case skips.
It is not part of the automated CI groups. The test does not connect
to a cluster or provider, and it proves protocol compatibility rather than
database durability, session disposal, or a real Agent workflow.
The images-packaging lane separately exercises node selection, deployed-identity
validation, and upgrade recovery with simulated external command responses;
those fixtures do not establish image-pair compatibility.

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

[`runtime-image-startup.test.mjs`](../../tests/integration/runtime-image-startup.test.mjs),
[`runtime-image-startup-probe.test.mjs`](../../tests/integration/runtime-image-startup-probe.test.mjs),
[`runtime-image-gateway-peer.test.mjs`](../../tests/integration/runtime-image-gateway-peer.test.mjs)
and [`runtime-image-native-worker.test.mjs`](../../tests/integration/runtime-image-native-worker.test.mjs)
verify a locally available OpenClaw runtime image before Docker Compose or
Kubernetes execution. They start task-owned containers with the Docker Compute
Driver gateway entrypoint, UID `1000:1000`, a read-only root filesystem, and
tmpfs-backed `/home/node` and `/tmp`. Host Node.js 24+ is required to run the
tests.

| Variable                         | Requirement or default                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_RUNTIME_IMAGE`         | Local runtime image tag or digest reference; unset skips.                                                                                    |
| `OCC_TEST_CODEX_SECCOMP_PROFILE` | Reviewed Codex Localhost seccomp profile path; required for Codex sandbox cases in CI and on Docker engines whose default seccomp blocks it. |
| `OCC_DOCKER_BIN`                 | Optional Docker executable path; defaults to `docker`.                                                                                       |

This check proves an embedded OpenClaw gateway reaches `/readyz` from a fresh
runtime home, the bundled Codex plugin can be discovered without missing
package dependencies, and, when the reviewed Codex seccomp profile is supplied,
the native Codex command execution path enforces the repository broker private
endpoint policy. A case that runs the Codex sandbox takes its Docker options from
`reviewedCodexSeccompSecurityOptions` in `tests/helpers/runtime-image-startup.mjs`.
In CI, or when `OPENCLAW_ENTERPRISE_CI_STATE` is set, it fails without the
profile instead of falling back to Docker's default seccomp, and
`tests/integration/ci-prepare.test.mjs` fails when a lane runs such a file
without preparing and requiring the profile. It does not prove Docker Compose orchestration, Kubernetes
reconciliation, model credentials, or a model turn. When the suite runs from
inside another container that talks to a host Docker daemon, mount the repository
and the fixture temp directory at the same absolute host paths and set `TMPDIR`
to that shared temp root; otherwise nested Docker bind mounts can turn missing
host files into directories and make fixture failures look like image failures.

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

## Verify installation image selections

For a registry-backed installation, compare the edited YAML with the retained
image selections before provisioning. The controller and each distinct runtime
image must pass the [image checks](#check-published-images) on a native host for
each architecture where it will run; one architecture does not prove another.
If a digest changes, check the new digest, update the retained selection, and
repeat the comparisons before continuing.

If the controller and runtimes target different architectures, run the controller
startup suite separately on each controller architecture and both runtime suites
on each runtime architecture, using the respective digest selectors. All suites
must pass without skips.

In the installation shell, retain `CONTROLLER_IMAGE` as the checked controller
digest. For a shared runtime, retain `RUNTIME_IMAGE` as its checked digest. If
checks ran in another shell or host, set these exports to the checked digests here.
For separately checked gateway and Agent runtimes, set `GATEWAY_IMAGE` and
`AGENT_IMAGE` to their respective digests; otherwise they default to
`RUNTIME_IMAGE`. Do not select the historical pair for the current installation.
Both comparisons must print `true`; stop on a mismatch or command failure.

```bash
: "${CONTROLLER_IMAGE:?Set the checked controller digest reference}"
export GATEWAY_IMAGE="${GATEWAY_IMAGE:-${RUNTIME_IMAGE:?Set the checked gateway digest reference}}"
export AGENT_IMAGE="${AGENT_IMAGE:-${RUNTIME_IMAGE:?Set the checked Agent digest reference}}"
yq e -e '.images.controller == strenv(CONTROLLER_IMAGE)' "$OCC_INPUT_DIRECTORY/values.yaml" && \
  yq e -e '.drivers.compute.configuration.images.gateway == strenv(GATEWAY_IMAGE) and .drivers.compute.configuration.images.agent == strenv(AGENT_IMAGE)' "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Continue with the remaining installation checks only after both comparisons
pass. The local Kubernetes import path uses its generated YAML and skips this
registry-backed comparison.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
