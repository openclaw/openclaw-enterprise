# Local Kubernetes installation tests

Run the launcher installation cases against a disposable local k3d cluster.
Prepare [shared prerequisites](README.md#requirements-and-credentials) first.

Install k3d, kubectl, Helm, `certutil`, and Chromium with sandbox support.
Use a disposable container engine with enough capacity to build images. The
Keycloak cases need free, bindable loopback port 443 and must not run beside
the standalone Keycloak lane. Build the CLI before running:

```sh
pnpm exec playwright install chromium
pnpm cli:build
OCC_TEST_DEV_UP_K3D_REAL=1 node --test tests/integration/dev-up-k3d-real.test.mjs
```

The Docker cases cover installation, cleanup, workspace boundaries, NetworkPolicy,
sandboxing, and Keycloak with fixture model responses. Failed cleanup retains
state for `occ dev down`. See [hosted execution](README.md#run-the-hosted-local-installation-lane).

For the rootful Podman installation case, supply an absolute, private (0600)
single-token key file for the configured native Codex provider. The model defaults
to `gpt-6-astra`. Select another authorized model with `OCC_TEST_OPENAI_MODEL`
(a plain model ID without a provider prefix). Optionally set
`OCC_TEST_DEV_UP_THINKING_DEFAULT` to configure the Agent's OpenClaw thinking level:

```sh
OCC_TEST_DEV_UP_MODEL_KEY_FILE=/absolute/private/model-key \
OCC_TEST_OPENAI_MODEL=gpt-6-luna OCC_TEST_DEV_UP_THINKING_DEFAULT=max \
OCC_TEST_DEV_UP_K3D_REAL=1 OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman \
  node --test --test-concurrency=1 --test-name-pattern='dev-up (refuses|installs)' \
  tests/integration/dev-up-k3d-real.test.mjs
```

The successful Podman case contacts that provider during startup. A key file does
not select a custom gateway. The startup authentication probe selects the model
but does not apply the Agent's thinking setting. A configured `max` therefore does
not prove a model turn at that effort; a normal Gateway turn must verify the
effective effort against the native model catalog. Refusal cases read no model
key. The key file stays unchanged; provisioning sends its value only through the
Secret API. If cleanup fails, the retained cluster can contain that Secret until
`occ dev down`.

Select the engine socket where the cluster's loopback ports are reachable. Leave
image selectors unset to exercise tagged-image imports; immutable selections
exercise digest staging. The test checks containerd and Agent Pod image identity,
original Podman tags, archive cleanup, and in-Pod sandbox boundaries. Record and
restore quickstart tag identities if the launcher rebuilds them.
