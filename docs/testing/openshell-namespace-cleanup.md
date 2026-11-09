# Check OpenShell Namespace cleanup

Build `bin/occ` from this checkout, then select the owned development-profile
cases directly. They create private kubeconfigs and clusters and remove only
their own resources. The central-gateway case also requires the authorized Codex
account, model and browser prerequisites in [test setup](openshell.md#test-setup-and-cleanup).
Select the available engine explicitly:

```sh
CODEX_ACCESS_TOKEN_FILE=/secure/oce/codex-token OCC_TEST_OPENAI_MODEL="$MODEL" \
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman \
  node --test --test-concurrency=1 \
  --test-name-pattern='dev-up installs the pinned OpenShell profile in its owned k3d cluster' \
  tests/integration/dev-up-openshell-k3d-real.test.mjs
OCC_TEST_DEV_UP_OPENSHELL_LOCAL_ENDPOINT_REAL=1 OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman \
  node --test tests/integration/dev-up-openshell-local-endpoint-cleanup-real.test.ts
```

Leave controller and runtime image overrides unset to build this source. Explicit
overrides must be immutable paired references whose revision labels match the
tested checkout. A new CLI against an older controller image does not prove the
changed worker or Drivers.

The central-gateway case checks real Agent/browser/model behavior before its
seven cleanup scenarios remove authority. Those scenarios check worker/provider
cleanup after placement loss, external claim release, and reassignment refusal
across retry. The separate bare-service case creates no Agent and needs no model
credential: with no bound Namespaces, it uses the official chart's full-PKI reset
to add its alias DNS name, reloads mutual-TLS identities, and verifies the alias
before binding a target. It then removes that alias after provider confirmation
and checks retry without the endpoint. Cleanup evidence does not qualify production
TLS or model execution; the central case verifies its model behavior separately.
Selected cases fail when their prerequisites are unavailable.
