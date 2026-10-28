# Docker, image, and Helm tests

## Overview

Run Compose startup, container image, and Helm checks. Use [Kubernetes](kubernetes.md)
for an authenticated Agent journey: the Docker Compute Driver rejects Agent
harness authentication bindings, so no Docker test deploys an Agent or makes a
model call.

## Verify Compose startup

Compose supports control-plane startup and Namespace operations.

Follow the [quickstart](../guides/quickstart.md), or run the host/startup cases:

```sh
node --test tests/integration/dev-up-compose.test.mjs
```

On macOS, follow the Podman prerequisite in the [startup flow](../flows/docker-compose-development/startup.md).
Use the cleanup command printed by `dev-up` to preserve the database and credentials.

## Verify Compose cleanup

With Go, Podman and `podman-compose` installed, run:

```sh
OCC_TEST_PODMAN_COMPUTE_REAL=1 node --test --test-name-pattern='Compose cleanup preserves' \
  tests/integration/docker-compute-real.test.mjs
```

On macOS, select the machine with `CONTAINER_CONNECTION`. For Docker Engine and
Compose, use `OCC_TEST_DOCKER_COMPUTE_REAL=1` instead. This case uses disposable
resources and verifies that `occ dev down` preserves the database volume unless
`--volumes` is specified. It does not deploy an Agent.

## Driver regressions

```sh
node --test tests/conformance/docker-compute.test.mjs
OCC_TEST_DOCKER_TOKEN_RETRY=1 NODE_BASE_IMAGE=node:24-bookworm \
  node --test tests/integration/docker-compute-token-retry.test.mjs
```

The first uses a local HTTP fault fixture. The second requires Docker at
`/var/run/docker.sock`, builds a fixture image, and removes its own resources.
Its gateway, app-server and provider responses are fixtures: it does not prove
Agent admission, a model call, or Compose orchestration.

## Verify Codex startup probe recovery

With a running Docker engine and an existing immutable Node 24+ Linux image:

```sh
OCC_TEST_CODEX_PROBE_IMAGE=sha256:<local-image-id> \
  node --test tests/integration/codex-model-probe.test.mjs
```

The image may be a repository digest; the test does not pull it. It uses a
fixture CLI and removes its containers and temporary files. It takes about 95
seconds and does not prove provider compatibility.

## Docker Compose development test environment

`tests/integration/docker-compute-real.test.mjs` starts the Compose stack and
checks the bootstrap service key, API authentication denials, Namespace networks
and empty-Namespace deletion. It also checks that OCC refuses a Harness
authentication binding and an Agent deployment without one (409). Model turns
return when Docker Compute supports Harness authentication, a Compute Driver
contract change. The workspace setup cases call the Driver directly.
`pnpm podman:test` selects Podman; unselected cases skip. The inputs are
`OCC_TEST_DOCKER_COMPUTE_REAL` or `OCC_TEST_PODMAN_COMPUTE_REAL`,
`OCC_DOCKER_GATEWAY_IMAGE`, `OCC_DOCKER_AGENT_IMAGE` (or shared
`OCC_DOCKER_RUNTIME_IMAGE`), `OCC_TEST_OPENAI_MODEL` and `OPENAI_API_KEY`, which
only the workspace setup cases pass to the runtime. See the test source for defaults.

See the [Docker Compute support boundary](../reference/drivers/docker-compute.md).

## Container publication registry proof

With Docker and Skopeo 1.13.3, run:

```sh
OCC_TEST_CONTAINER_REGISTRY=1 node --test tests/integration/container-registry-real.test.mjs
```

The test pulls a digest-pinned registry image and removes its disposable
loopback registry. It checks publication against that registry, not GHCR access
or GitHub permissions. It skips without the selector.

## Images and Helm

Image and Helm checks require Node 24+, installed dependencies, and Docker
unless stated otherwise. Use locally built images or pull the immutable published
images selected below. These checks make no model calls.

### Check published images

On a native host for each target architecture, use the source commit that
produced the images. Follow [image selection and registry authentication](../guides/deploy/production-installation.md#use-published-images).
Set the immutable `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` references, then run:

```sh
docker pull "$CONTROLLER_IMAGE"
docker pull "$RUNTIME_IMAGE"
OCC_TEST_PRODUCTION_IMAGE="$CONTROLLER_IMAGE" OCC_TEST_RUNTIME_IMAGE="$RUNTIME_IMAGE" \
  node --test tests/integration/production-image-startup.test.mjs \
    tests/integration/runtime-image-startup.test.mjs \
    tests/integration/runtime-image-gateway-workspace.test.mjs \
    tests/integration/runtime-image-startup-probe.test.mjs \
    tests/integration/runtime-image-startup-termination.test.mjs \
    tests/integration/runtime-image-gateway-unclean-restart.test.mjs \
    tests/integration/runtime-image-gateway-retained-state.test.mjs \
    tests/integration/runtime-image-gateway-peer.test.mjs \
    tests/integration/runtime-image-native-worker.test.mjs \
    tests/integration/runtime-image-state-migration.test.mjs \
    tests/integration/runtime-image-managed-files.test.mjs \
    tests/integration/runtime-image-native-listener.test.mjs \
    tests/integration/repository-runtime-volume.test.mjs
```

All cases must pass without skips for the exact pair before installation. Repeat
for changed digests. An unset image selector skips its cases. Runtime checks need
`OCC_TEST_CODEX_SECCOMP_PROFILE` in CI and when the Docker default blocks the
Codex sandbox. The controller check expects an unreachable database; it does
not prove connectivity. Runtime checks do not prove a model turn or Slack delivery.

### Build images from the checkout

Build the [runtime image](../../deploy/runtime/README.md) and the controller
image using the [production prerequisites](../guides/deploy.md#production-prerequisites).
Set `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` to the local tags and run the image
suite above, omitting the `docker pull` commands.

### Render the Helm chart

With Helm and `yq` supporting `eval-all -o=json`:

```sh
node --test tests/integration/production-kubernetes-packaging.test.mjs
```

Missing Helm or `yq` skips cases. Rendering does not install the chart or prove
live admission or NetworkPolicy enforcement. `OCC_HELM_BIN` can select Helm.

## Development Compose packaging

With a Compose provider on `PATH`, run:

```sh
node --test tests/integration/development-packaging.test.mjs tests/integration/logging-packaging.test.mjs
```

The tests inspect configuration without starting containers. Missing Compose or
required `yq` fails the cases; the logging Helm checks also require Helm.

## Repository image-pair qualification

For fixture coverage, run `node --test tests/integration/production-image-qualification.test.mjs`.
For real image-pair compatibility, use Linux as UID 1000 and stage immutable
images for the native Docker architecture. Set `OCC_PROBE_CONTROLLER_IMAGE`,
`OCC_PROBE_BROKER_IMAGE`, `OCC_PROBE_OLD_CONTROLLER_IMAGE` and
`OCC_PROBE_OLD_BROKER_IMAGE`. Select an old controller without the admission
probe and an old broker without durable-admission capability. Then run:

```sh
umask 077
pair_state_dir=$(mktemp -d)
node scripts/ci/run-tests.mjs run image-pair-qualification \
  --state "$pair_state_dir/state.json" --results "$pair_state_dir/results.json"
```

The lane requires all four images and fails on skipped cases. It checks protocol
compatibility, not cluster behavior or a live Agent workflow.

## Runtime image startup test environment

The runtime suite above uses task-owned Docker containers. In CI it requires the
reviewed `OCC_TEST_CODEX_SECCOMP_PROFILE`. If running inside a container against
a host Docker daemon, mount the repository and fixture temporary directory at
the same absolute host paths and set `TMPDIR` to that shared directory.
`OCC_DOCKER_BIN` selects an alternate executable. For emulated startup, set
`OCC_TEST_IMAGE_TIMEOUT_MULTIPLIER` to an integer from 1 to 10. Some startup
waits are sized for 8 CPUs and grow on runners with fewer CPUs, because CI runs
image test files side by side.

## Repository runtime volume test environment

The runtime suite includes `repository-runtime-volume.test.mjs`, which requires
Docker `volume-subpath` support. It exercises the installed client and removes
its owned container and volume. It does not prove Kubernetes fsGroup or live
GitHub behavior.

## Verify installation image selections

Before a registry-backed installation, check the exact selected digests on each
native architecture as above. In the installation shell, compare them to the
prepared YAML. Stop if either comparison fails. For separate runtime images,
set the checked `GATEWAY_IMAGE` and `AGENT_IMAGE` digests explicitly:

```sh
: "${CONTROLLER_IMAGE:?Set the checked controller digest}"
export GATEWAY_IMAGE="${GATEWAY_IMAGE:-${RUNTIME_IMAGE:?Set the checked runtime digest}}"
export AGENT_IMAGE="${AGENT_IMAGE:-${RUNTIME_IMAGE:?Set the checked runtime digest}}"
yq e -e '.images.controller == strenv(CONTROLLER_IMAGE)' "$OCC_INPUT_DIRECTORY/values.yaml" && \
  yq e -e '.drivers.compute.configuration.images.gateway == strenv(GATEWAY_IMAGE) and .drivers.compute.configuration.images.agent == strenv(AGENT_IMAGE)' "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Repeat the image checks and comparisons when a digest changes. The local
Kubernetes import path uses generated YAML and skips this comparison.
