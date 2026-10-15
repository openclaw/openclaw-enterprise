# OpenShell tests

## Overview

Use these tests to check OpenShell setup and real Agent execution. Run commands
from the repository root.

## Start a reusable development environment

The [local OpenShell profile](../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
starts a private k3d cluster, PostgreSQL, the OCE control plane, and the
OpenShell Gateway. It does not create an Agent or require a model credential.

```sh
pnpm cli:build
export OCC_DEVELOPMENT_STATE_DIRECTORY="$(mktemp -d)/state"
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

Keep the state directory and environment variables for later commands. Use a
separate state directory per checkout. The launcher prints its API URL,
kubeconfig, context, and service-key file. It does not change the default
kubeconfig or context. Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or
`podman` if engine selection is ambiguous.

To stop the environment, including after a partial startup, run:

```sh
./scripts/dev-down
```

This deletes the owned cluster and its database. It does not delete unrelated
clusters. For the Compose control-plane variant, set
`OCC_DEVELOPMENT_CONTROL_PLANE=compose` before startup.

## Test setup and cleanup

Stop the reusable environment before running these tests. Each creates and
removes its own disposable cluster. Install Docker or Podman, k3d, kubectl,
Helm, and the dependencies in the [testing prerequisites](README.md#requirements-and-credentials).
Build the local CLI first with `pnpm cli:build`.

```sh
# Kubernetes control plane
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs

# Compose control plane
OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

Each command selects one case and skips the other. These tests verify setup,
Workspace reconciliation, and cleanup. They use a synthetic credential and
do not create an Agent or make a model call. They default to Docker; set
`OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman` to use Podman.

## OpenShell Sandbox

The real Sandbox suite tests a dedicated Codex Agent, including authenticated
Gateway access, real model and tool turns, credential delivery, restricted
filesystem and network access, replacement, and cleanup. Local fixture tests
alone do not prove these outcomes. See [OpenShell coverage](openshell-coverage.md) for the individual checks.

The CI lane needs an existing authorized `CODEX_ACCESS_TOKEN` and an
`OCC_TEST_OPENAI_MODEL` that the token can use. Do not put the token in a command,
logs, or shell history. It also needs Docker, k3d, kubectl, Helm, `openssl`, and
network access to the pinned assets. The CI preparation creates a disposable
cluster, installs the OpenShell and Agent Sandbox prerequisites, imports
immutable images, and prepares PostgreSQL. A standard k3d cluster alone is not
sufficient. See the [CI lane guide](ci.md#manual-full-integration-lanes) for the hosted run.

To run the same lane locally, export the token and model through your approved
credential workflow. Preparation builds the controller unless
`OCC_TEST_PRODUCTION_CONTROLLER_IMAGE` selects an approved, immutable prebuilt
controller. For a local build, choose an approved digest-pinned Node 24 build
image for `NODE_BASE_IMAGE`. Hosted CI uses its configured
`CONTAINER_NODE_BASE_IMAGE`; local commands do not inherit that variable. Then run:

```sh
if [ -n "${OCC_TEST_PRODUCTION_CONTROLLER_IMAGE:-}" ]; then
  export OCC_TEST_PRODUCTION_CONTROLLER_IMAGE
else
  : "${NODE_BASE_IMAGE:?Set an approved digest-pinned Node 24 build image}"
  export NODE_BASE_IMAGE
fi
export OCC_OPENSHELL_TEST_ROOT="$(mktemp -d)"
node scripts/ci/prepare.mjs --lane openshell \
  --state "$OCC_OPENSHELL_TEST_ROOT/state.json"
node scripts/ci/run-tests.mjs run openshell \
  --state "$OCC_OPENSHELL_TEST_ROOT/state.json" \
  --results "$OCC_OPENSHELL_TEST_ROOT/results.json"
```

The lane includes both setup tests, the Sandbox test, and first-Agent tests for
both control-plane variants. It fails when selected prerequisites are missing.
Run cleanup even if preparation or a test fails:

```sh
node scripts/ci/cleanup.mjs --state "$OCC_OPENSHELL_TEST_ROOT/state.json"
```

The Codex case uses the production Driver path, but the test does not qualify a
production installation. The native OpenClaw case uses a test-only compatibility
bridge and is not a supported production path. Use the k3d helper below to run
that case. The [Sandbox Driver reference](../reference/drivers/openshell-sandbox.md#qualification-contract)
describes the remaining limits.

### Native OpenClaw with k3d

The [k3d helper](kubernetes.md#develop-with-local-containers-and-k3d) prepares
the native test and builds the sibling `../openclaw` checkout. Set
`OCC_K3D_OPENCLAW_SOURCE` to use another absolute checkout path.

```sh
./scripts/k3d test --harness openclaw
./scripts/k3d demo --harness openclaw
```

Both commands use the test-only bridge. `test` requires an authorized
`OPENAI_API_KEY`; `demo` prompts for one if it is not set. `demo` leaves the
proven environment running. Run `./scripts/k3d down --harness openclaw` to remove it.

## First-Agent proof

For a manual Compose-plus-k3d proof, start the development environment above
with `OCC_DEVELOPMENT_CONTROL_PLANE=compose`. Supply an existing authorized
`CODEX_ACCESS_TOKEN` or set `CODEX_ACCESS_TOKEN_FILE` to an absolute private file; set
only one. Then run:

```sh
node scripts/first-agent.mjs my-agent --harness codex --control-ui
```

A successful model turn prints `Model response verified:`. An active revision or
ready Sandbox alone is not a model proof. For an invalid key, rerun with
`--replace-key`. The starter disables tools. In this Compose/OpenShell profile, `--control-ui` prints both the OCE console and OpenClaw Control UI URLs. Trust the browser CA printed by startup before opening them. Run `./scripts/dev-down` with the same state
directory when finished.

## Troubleshooting

- If a Docker subnet overlaps, run `dev-down` for the owned partial setup and
  select an unused `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` before retrying. Do not
  remove unrelated networks or clusters.
- If setup times out, inspect the Pods and events in `openshell-system` and
  `agent-sandbox-system`, then clean up the owned environment before retrying.
- If the model turn fails, check that the key can access the selected model and
  that provider egress is available. Do not print Secrets, provider files, Pod
  environments, or complete process arguments.
- An inactive direct Agent Service is expected for the provider-owned endpoint;
  inspect the OpenShell-advertised route instead.
