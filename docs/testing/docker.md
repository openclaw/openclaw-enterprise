# Docker or Podman Compose tests

Docker and Podman Compose support control-plane startup and Namespace operations.
The Docker Compute Driver currently rejects Agent harness authentication bindings;
Agent deployment requires a binding. The retained real Agent suites therefore
cannot complete a model or TUI journey through the current OCC API. Neither an
exported `OPENAI_API_KEY` nor a runtime image restores that support.

Use [local Kubernetes runtime tests](kubernetes.md) for the supported authenticated
Agent path. Historical Docker and Podman model-turn results do not prove the
current binding contract.

## Verify Compose startup

Follow the [quickstart](../guides/quickstart.md) to prove database initialization,
API and worker readiness, and authenticated Installation access. The host/startup
integration cases can also be run with:

```sh
node --test tests/integration/dev-up.test.mjs
```

On macOS, follow the Podman prerequisite in the
[startup flow](../flows/docker-compose-development/startup.md).

This verification does not prove an Agent model turn. Follow the exact cleanup
command printed by `dev-up` to preserve the development database and credentials.

## Verify Compose cleanup

Run the cleanup case against a real engine and the shipped PostgreSQL image:

```sh
OCC_TEST_PODMAN_COMPUTE_REAL=1 \
  node --test --test-name-pattern='Compose cleanup preserves' \
  tests/integration/docker-compute-real.test.mjs
```

Requires Go, Podman, and `podman-compose`. On macOS, select a rootless or rootful
machine connection through `CONTAINER_CONNECTION` for this invocation; the test
does not change the default connection. For Docker Engine with Compose, replace
the selector with `OCC_TEST_DOCKER_COMPUTE_REAL=1`.

This case starts only the development PostgreSQL service to exercise cleanup
after partial startup. The compiled `occ dev down` must remove project containers
and networks while preserving the database volume, then delete the volume only
with `--volumes`. It uses disposable project resources and no model credentials
or Agent runtime image. Failure cleanup uses Compose directly without masking
the CLI failure. This proves the cleanup lifecycle, not Agent execution.

## Docker transport-token retry fixture

With Docker Engine available at `/var/run/docker.sock` and workspace dependencies
already installed, run from the repository root:

```sh
OCC_TEST_DOCKER_TOKEN_RETRY=1 NODE_BASE_IMAGE=node:24-bookworm \
  node --test tests/integration/docker-compute-token-retry.test.mjs
```

The fixture calls the real Docker Driver directly and runs its runtime entrypoints
in disposable containers. Minimal gateway and app-server binaries exercise
WebSocket authentication, including invalid and missing bearer rejection. Login
and model-probe responses are simulated solely to satisfy launcher startup. The
case checks both peer-loss directions, retained token reuse, token rotation,
replacement of a healthy gateway holding a stale token, and preservation of
foreign-owned same-name containers and their siblings.

This is Driver regression coverage without an Agent authentication binding. It
does not pass through current OCC Agent admission or prove genuine OpenClaw,
Codex, model calls, or the Compose control plane. The authentication support
boundary at the top of this page still applies.

The test builds an image from `NODE_BASE_IMAGE` (default `node:24-bookworm`)
and the installed WebSocket dependency, without installing packages. It uses an
inert fixture provider key and removes its own containers, network, and image.
A selected run fails on missing prerequisites or cleanup failure. CI selects
this case in the `images-packaging` lane.

## Verify Codex startup probe recovery

Use an existing immutable Node 24+ Linux image and a running Docker engine:

```sh
OCC_TEST_CODEX_PROBE_IMAGE=sha256:<local-image-id> \
  node --test tests/integration/codex-model-probe.test.mjs
```

The image selector also accepts a repository digest. The test never pulls an
image. It runs the generated dedicated Codex launcher in disposable containers
with networking disabled, a read-only root, and temporary writable state. A
fixture CLI supplies failures and success; no provider credentials are needed.
The `images-packaging` CI lane uses its selected Node base image for this test.

Expect timeout recovery, two-attempt exhaustion, nonretryable rejection, malformed
output, tool events, external `SIGKILL`, and termination during backoff to pass.
The tests exercise real 30-second subprocess deadlines and verify the readiness
file, HTTP runtime status, cleanup, and sanitized logs. They take about 95 seconds
and remove their own containers and temporary files. They do not establish real
Codex/provider compatibility or Kubernetes deployment success; use the
[Kubernetes runtime journey](kubernetes.md) for those checks.

## Docker Compose development test environment

`tests/integration/docker-compute-real.test.mjs` retains the Docker and Podman
model/TUI scenarios for future Driver work. `pnpm podman:test` selects its Podman
path. These commands currently fail at Agent admission when selected; an
unselected skipped suite is not passing model evidence. The existing test inputs
are listed here for contributors diagnosing that boundary, not as a runnable
supported deployment procedure.

The retained Docker and Podman journeys include interrupted dedicated
preparation: kill the test-owned worker after Codex starts but before gateway
creation, wait for the surviving container to become healthy, restart the
worker, and require revision activation with the same Codex container and
matching transport tokens. A provider response through the recovered gateway
is the intended authentication proof. Current admission prevents reaching
this scenario; its presence is not successful live recovery evidence. The
Podman test uses an init process in its PostgreSQL container to reap child
processes during interruption testing without changing deployed Compose
configuration.

| Variable                       | Requirement or default                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `OCC_TEST_DOCKER_COMPUTE_REAL` | Set to `1` to explicitly opt into the real Docker Compute proof.                        |
| `OCC_TEST_PODMAN_COMPUTE_REAL` | Set to `1` to select Podman and its embedded and dedicated real-runtime proof.          |
| `OCC_DOCKER_GATEWAY_IMAGE`     | Existing production-equivalent OpenClaw gateway image; defaults to the runtime image.   |
| `OCC_DOCKER_AGENT_IMAGE`       | Existing production-equivalent Codex Agent image; defaults to the runtime image.        |
| `OCC_DOCKER_RUNTIME_IMAGE`     | Optional shared image fallback for both gateway and Agent.                              |
| `OPENAI_API_KEY`               | Existing authorized provider credential for real embedded and dedicated model turns.    |
| `OCC_TEST_OPENAI_MODEL`        | Authorized provider model; defaults to exact API model ID `gpt-6-astra`.                |
| `PYTHON`                       | Optional host Python interpreter for `tests/helpers/tui-pty.py`; defaults to `python3`. |

## Related

- [Choose another test suite](README.md).
- [Docker Compute support boundary](../reference/drivers/docker-compute.md).
