# Docker or Podman Compose tests

Verify the development Compose stack with embedded OpenClaw and dedicated
Codex model turns on Docker, or the embedded OpenClaw model turn on Podman.
Prepare [credentials](README.md#requirements-and-credentials) and the
[runtime image](images.md) before selecting this suite.

## Docker Compose model turns

Requires Docker Engine, Compose, the built runtime image, host Python 3 with
PTY support, and an exported `OPENAI_API_KEY` or a private environment file
supplying it. The suite creates and migrates its own Compose database; the
separate [PostgreSQL setup](postgresql.md) is not required.

```sh
OCC_TEST_DOCKER_COMPUTE_REAL=1 \
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
OCC_TEST_OPENAI_MODEL=gpt-5.6-sol \
  node --test tests/integration/docker-compute-real.test.mjs
```

Both the embedded and dedicated paths must produce provider-backed responses.
The test also checks authentication, isolation, Agent deletion, invalid-token
TUI rejection, two same-session TUI replies, and Ctrl+D TUI exit while the
gateway remains ready. It generates its own Compose project, ports, network
range, and local administrator, then removes its project volumes and labelled
containers/networks.

An image selector also enables the suite without the opt-in flag. Missing
Docker, images, or the model credential then fails the run. Explicitly select
an image rather than relying on the test's historical local-image fallback.
See [Docker test settings](#docker-compose-development-test-environment)
for separate gateway and Agent images.

Run this suite after changing the Docker Driver or development startup. It
exercises authenticated API requests, PostgreSQL state, worker queues, network
and container provisioning, both Harness topologies, cleanup, and a fresh nonce
in the provider response. Requests may reach the gateway through its Namespace
network address or the driver-published loopback host port.

## Podman embedded model turn

The same integration file and journey helpers run the Podman proof; there is no
duplicated Podman test implementation. The test requires `podman-compose`, a
running Podman machine or service, the runtime image in Podman's image store,
and an exported `OPENAI_API_KEY`. The `dev-up` helper additionally requires
`yq` v4 to inspect the resolved Compose configuration.
The test pins the installed provider and reads the API socket from `podman info`;
no `docker` alias or manual socket variable is required.

```sh
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
OCC_TEST_OPENAI_MODEL=gpt-5.6-sol \
  pnpm podman:test
```

This first increment provisions isolated Namespaces, deploys one embedded
OpenClaw Agent, verifies the model credential reaches only its gateway/Harness
container, rejects a missing gateway token, requires a real provider response
containing a fresh nonce, and asserts exact test teardown. It does not select
the dedicated Codex, interactive TUI, or Fluentd/OTLP cases; those remain
Docker-only.

## Docker Compose development test environment

The Compose development integration exercises the supported local stack. It
requires the selected engine, a locally available runtime image, PostgreSQL,
the OCC API, the worker, and a real provider response. Set
`OCC_TEST_DOCKER_COMPUTE_REAL=1`, `OCC_TEST_PODMAN_COMPUTE_REAL=1`, or any
`OCC_DOCKER_*_IMAGE` variable to select the suite; once selected, missing
engine, image, bootstrap, worker, or model prerequisites fail instead of
skipping. Python and PTY support are required only by Docker's TUI case.

| Variable                       | Requirement or default                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `OCC_TEST_DOCKER_COMPUTE_REAL` | Set to `1` to explicitly opt into the real Docker Compute proof.                        |
| `OCC_TEST_PODMAN_COMPUTE_REAL` | Set to `1` to select Podman and its embedded-only real-runtime proof.                   |
| `OCC_DOCKER_GATEWAY_IMAGE`     | Existing production-equivalent OpenClaw gateway image; defaults to the runtime image.   |
| `OCC_DOCKER_AGENT_IMAGE`       | Existing production-equivalent Codex Agent image; defaults to the runtime image.        |
| `OCC_DOCKER_RUNTIME_IMAGE`     | Optional shared image fallback for both gateway and Agent.                              |
| `OPENAI_API_KEY`               | Existing authorized provider credential for real embedded and dedicated model turns.    |
| `OCC_TEST_OPENAI_MODEL`        | Authorized provider model; defaults to exact API model ID `gpt-5.6-sol`.                |
| `PYTHON`                       | Optional host Python interpreter for `tests/helpers/tui-pty.py`; defaults to `python3`. |

The selected model must support Codex custom tools as well as the embedded
OpenClaw path. `gpt-4.1` does not support the dedicated Codex request shape.
The test generates its own Compose bridge CIDR and Configuration Driver root;
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` and
`OCC_DEVELOPMENT_CONFIGURATION_ROOT` are not external test inputs.
The embedded Docker case also proves that a fresh TUI client with an invalid
gateway token is rejected, then uses one valid TUI process for two same-session
model-backed replies and exits that client with Ctrl+D while the gateway remains
ready.

Missing selected-engine access, runtime images, bootstrap, worker startup, or
model credentials fails the Compose integration. Missing host Python or PTY
support fails Docker's TUI helper before that proof can pass. Do not replace
this path with controller-only shortcuts, a mocked Docker-compatible API, or
readiness-only checks.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
