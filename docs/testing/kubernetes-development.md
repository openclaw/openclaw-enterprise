# Test the Kubernetes development CLI lifecycle

The `k3d-fixture-configuration` lane runs
`tests/integration/dev-kubernetes-real.test.mjs` through the compiled checkout's
`occ dev up/down`. A second disposable profile must authenticate Installation
access, report a Ready node and healthy controller/worker, and import the runtime
digest. Shutdown must remove its resources, state and claims while preserving
the lane's first cluster, unrelated resources, claims and host configuration.

For standalone execution, provide Docker/Compose, Go from `go.mod`, k3d 5.9.0
and kubectl on PATH. Build an exact-source image with `deploy/runtime/Dockerfile`
and select an approved immutable Node 24 base in `NODE_BASE_IMAGE`:

```sh
OCC_TEST_DEV_KUBERNETES_REAL=1 \
OCC_TEST_DEV_RUNTIME_IMAGE=your-exact-source-runtime:local \
  node --test tests/integration/dev-kubernetes-real.test.mjs
```

The case chooses free ports, a nonoverlapping subnet and unique names. Selection
makes missing prerequisites fail; otherwise it skips. The
[operator guide](../guides/deploy/local-kubernetes-development.md) describes
optional immutable K3s selection. No provider or model credential is passed;
this case does not prove Agent or model execution.

CI registers `OCC_TEST_DEV_DIRECTORY`, `OCC_TEST_DEV_RUNTIME_IMAGE` and
`OCC_TEST_DEV_APP_IMAGE`. Parent cleanup delegates to the CLI and retains uncertain
state. Follow the operator's recovery procedure before retrying an interrupted
profile. The harness removes its temporary image tags; shared caches remain.
Optional `OCC_TEST_DEV_RECEIPT` writes observations to a private path;
`OCC_TEST_DEV_NAME_PREFIX` selects an `occ-dev-` run label with a random suffix.
