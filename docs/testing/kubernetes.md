# Kubernetes tests

Prepare [shared prerequisites](README.md#requirements-and-credentials) for
Kubernetes HTTP fixtures or real-runtime gateway, Codex, model, and Secret tests.

## Local Kubernetes installation

Build the CLI and run the selected real test to create and clean up a separate
k3d cluster:

```sh
pnpm cli:build
OCC_TEST_DEV_UP_K3D_REAL=1 node --test tests/integration/dev-up-k3d-real.test.mjs
```

The Kubernetes-only case checks authenticated readiness, presets, plugin discovery,
and a dedicated Codex Agent’s sandbox using a synthetic credential. The Compose
case checks the launcher’s generated image and seccomp profile in a real Pod. Both
verify workspace writes succeed and outside writes fail; neither proves model
execution, and the Compose case does not prove Agent routing. Failed cleanup
preserves state for `occ dev down`.

See [two-cluster validation](two-cluster-local.md).

## Kubernetes HTTP fixture

Requires Docker, k3d, `kubectl`, and the migrated `openclaw_k8s_local` database
from [PostgreSQL](postgresql.md#other-postgresql-suites). Create a new disposable cluster; if `oce` already exists,
use a new name throughout these commands.

```sh
mkdir -m 700 -p /tmp/oce-k3d
k3d cluster create oce \
  --image +v1.35 \
  --api-port 127.0.0.1:6443 \
  --kubeconfig-update-default=false \
  --kubeconfig-switch-context=false
k3d kubeconfig get oce > /tmp/oce-k3d/kubeconfig
chmod 600 /tmp/oce-k3d/kubeconfig

docker build --pull=false -t oce-fixture:local tests/fixtures/kubernetes
k3d image import oce-fixture:local -c oce

OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce \
OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local \
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local \
  node --test --test-concurrency=1 tests/integration/kubernetes-compute-real.test.mjs \
    tests/integration/kubernetes-compute-provisioning-real.test.mjs \
    tests/integration/kubernetes-compute-driver-real.test.mjs
```

All four fixture cases must run: Driver lifecycle/isolation (in the
`kubernetes-compute-driver-real` file, which CI runs in `k3d-fixture-plugins`),
externally managed namespace preservation and provisioning handoff (in
`kubernetes-compute-provisioning-real`, run in `k3d-fixture-state`), and PostgreSQL
API-plus-worker reconciliation. The files share
`tests/helpers/kubernetes-compute-real.mjs`. No model key is needed. Missing all
cluster selectors skips the suite; partial selectors fail, and a missing
database skips the provisioning handoff and API-plus-worker cases. The two
PostgreSQL-backed files share one database here, so run them one at a time
(`--test-concurrency=1`); CI gives each file its own database.

An imported immutable `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` extends the
API-plus-worker case through real runtime credential Secret and private-state
claim deletion. The case uses synthetic, nonfunctional
fixture credentials and performs no model turn. Channel runtime needs the
real-runtime images and credentials below.

The tests require an explicit loopback `k3d-*` context and enforcing
NetworkPolicies. They create scoped RBAC and resources and use the stock
local-path provisioner for RWO Harness workspaces. The API-plus-worker case
verifies that replacement retains the PVC UID and a file written by the old
Harness. The HTTP fixture can fail native readiness using a workspace marker;
a later deployment must retain both earlier files and writes from the failed
candidate. This proves serial replacement on local storage, not cloud CSI detach,
node fencing, or data movement between nodes.

### Fixture images and security controls

The nonroot `tests/fixtures/kubernetes` image uses generated Namespace labels,
ResourceQuota, LimitRange, NetworkPolicies, and container security settings.
The suite verifies tenant isolation, resource bounds, seccomp, dropped
capabilities, and a read-only root filesystem. Its mutable tag and unpinned
`docker.io/library/node:24-bookworm-slim` base are fixture-only; production images
require pinning and review.

The API-plus-worker case checks UDP/TCP 5353 DNS from embedded Agents, dedicated
Harnesses, and gateways. An unselected CoreDNS peer, port 5354, and a cloned
workload Pod whose network profile was removed, emptied, or changed must be
denied between successful controls; an unrestricted Pod verifies listener
availability. Readiness gates exclude fixtures from cluster DNS endpoints. This proves k3d
enforcement, not OpenShift.

A denial counts only when the probe exits 42 with `{"denied":true}`. A dropped
exec stream is retried; any other probe error fails the check.

Live Configuration ConfigMap CRUD and least-privilege RBAC cases require the
selected disposable cluster and tenant credentials and skip explicitly without
them. Schema, controller, and SDK fixtures do not exercise that live behavior.

The plugin-status fixture tests wait for Driver readiness, a ready gateway Pod,
and its plugin status before asserting startup or restart results. A later Pod
status read does not establish that an earlier Driver observation was ready.
CI preparation waits up to 120 seconds for the server's route to the worker Pod
CIDR to use `flannel.1`, then admits that route's source `/32` for API-server Pod
proxy requests. Node readiness can precede this route, and the container
network's default-route source would leave ready Pods unreachable through the
proxy. An absent overlay route fails preparation before it publishes the test
environment.

## Kubernetes model turns and Secrets

Follow [Codex sandbox setup](../guides/deploy/codex-sandbox.md) for seccomp
prerequisites. CI checks workspace writes and outside-write denial; the native
workspace case additionally requires tool-history evidence with `approvalPolicy: never`.
Credentialed repository access requires separate proof.

### Develop with local containers and k3d

The helper prepares disposable k3d, isolated PostgreSQL, and gateway/Codex images.
Start Docker or Podman's API socket (Podman Machine on macOS), then run:

```sh
./scripts/k3d --model-id gpt-6-astra
```

For a custom Codex Responses endpoint, use `--base-url` and the native
`--model-id` on either `test` or the default demo command:

```sh
./scripts/k3d test --harness codex \
  --base-url https://openrouter.ai/api/v1 --model-id z-ai/glm-5.3-flash
./scripts/k3d --base-url https://openrouter.ai/api/v1 --model-id z-ai/glm-5.3-flash
```

Set `OPENAI_API_KEY` privately. Flags override `OCC_TEST_CODEX_OPENAI_BASE_URL` and
`OCC_TEST_OPENAI_MODEL`, including prepared records; environment-only input and
complete model namespaces remain supported. These flags require Codex without
OpenShell, not inspection/cleanup commands. Use fresh state after source changes
to rebuild both images.

When `OPENAI_API_KEY` is unset, the interactive `demo` command prompts for it
without echoing the value; `test` requires the variable and `reset` does not. A
prompted value exists only in the helper process and its children, never in
state files.

The helper requires k3d, `kubectl`, Helm, OpenSSL, and Docker Compose or
`podman-compose`. It prefers a running Podman API socket unless `DOCKER_HOST`
selects an engine. Set `OCC_K3D_CONTAINER_ENGINE=podman` or `docker` to override detection.

Engine-private state lives under
`${XDG_STATE_HOME:-$HOME/.local/state}/openclaw-enterprise/k3d-<engine>-codex`;
`OCC_K3D_STATE_DIR` overrides it with an absolute path. Reuse retains the cluster,
database, images, Envoy, cert-manager, and disposable routing CA. Initial builds
use the current checkout, ignoring inherited Kubernetes image selectors.
There is no helper image-upgrade command; see [Helm image upgrades](../guides/deploy/local-k3d-image-upgrade.md).
Run `./scripts/k3d down` before reusing state lacking workspace routing.

To clear an interrupted test or rerun against a fresh database while preserving
the PostgreSQL service, cluster, and imported images:

```sh
./scripts/k3d reset
```

Reset deletes only helper test Namespaces, such as `oce-production-*`,
`oce-openshell-*`, and `oce-ns-*`, from the helper-owned cluster. It drops and
recreates only the database recorded in the helper's private state.

The default command starts Kubernetes OCC and a dedicated Codex Agent, completes
a model turn, and serves Control UI at `http://127.0.0.1:18888` and OCC at
`http://127.0.0.1:18889`. It prints the temporary username and a password-copy
command for mode-`0600` `demo.json`, never the password.

Pass `--harness openclaw` for the verification-only
[native OpenClaw Harness](openshell.md#native-openclaw-with-k3d).

The development login is `admin@openclaw.local` with
`openclaw-development-password`. Override it with `OPENCLAW_DEV_EMAIL` or
`OPENCLAW_DEV_PASSWORD`; the database retains the account, so reset before
restarting the demo after changing its password. `./scripts/k3d get
openclaw-control-ui` prints the Control UI URL; `./scripts/k3d copy
openclaw-password` copies its **Gateway secret**. This separate
password preserves direct loopback access while OCC workspace files use
trusted-proxy authentication.

Keep the command running while using either interface. Ctrl-C stops the local
controller and worker, closes port-forwards, and removes the private state file
and demo Namespaces. The prepared cluster, images, routing controllers, and
PostgreSQL remain; rerun `./scripts/k3d` to recreate demo resources.

Inspect demo and cluster details without parsing the private state files:

```sh
./scripts/k3d info
./scripts/k3d copy openclaw-password
./scripts/k3d copy occ-password
```

`info` reports the engine, state directory, status, connection values, password
copy commands, and host/container processes. `get` prints a selected
non-sensitive value; run `./scripts/k3d help` for fields. `copy` sends either
password to the clipboard with `pbcopy`, `wl-copy`, or `xclip`, never to
standard output. Demo fields appear once the foreground command reports
readiness; cluster fields remain while prepared state exists. The OCC console's
Workspace files panel uses the private Envoy route that the gateway-routing
integration exercises.

To run the dedicated Codex gateway-routing integration instead:

```sh
./scripts/k3d test
```

The test runs the [focused routing proof](gateway-routing.md#setup-and-execution) but
does not cover credential recovery or embedded OpenClaw.

Remove only resources recorded in the helper's owned state when finished:

```sh
./scripts/k3d down
```

If preparation fails, run the same cleanup command before retrying. The helper
does not use or modify the default kubeconfig, active context, the development
database on port 55432, or unrelated container-engine resources.

Use the disposable cluster and `openclaw_k8s_*` database above, an exported
`OPENAI_API_KEY`, and approved real gateway/Codex images. Import local image
tags, then register their immutable references inside k3s, replacing the
placeholders with your exact tags and digests:

```sh
k3d image import '<local-gateway-tag>' '<local-codex-tag>' -c oce
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-gateway-image>' '<gateway-image>@sha256:<digest>'
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-codex-image>' '<codex-image>@sha256:<digest>'
```

Prepare a private runtime environment file with the model key and these
nonsecret settings:

```dotenv
OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local
OCC_TEST_KUBERNETES_GATEWAY_IMAGE=<gateway-image>@sha256:<digest>
OCC_TEST_KUBERNETES_AGENT_IMAGE=<codex-image>@sha256:<digest>
OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS=<api-server-proxy-source>/32
OCC_TEST_OPENAI_MODEL=gpt-6-astra
```

The startup failure cases use dedicated Codex with plugins enabled and disabled.
They assert the saved failure through deployment GET after failed Pod deletion
and controller restart, proving retained startup evidence, not live health.
Set the private status proxy CIDRs to the actual API-server Pod-proxy source;
CI preparation supplies them. For manual clusters, follow the
[networking setup](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).

The ordinary suite does not prove private workspace-file routing; the separate
[gateway-routing suite](gateway-routing.md#setup-and-execution) tests it with
real Envoy Gateway, cert-manager, and a test CA.

Run the ordinary runtime cases independently of Slack:

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

Five non-Slack runtime cases must pass: dedicated Codex, embedded OpenClaw,
the extended Secret lifecycle case, and durable startup-failure status with
plugins disabled and enabled. Both topologies use Secret-backed Agent `harnessAuth`. The Secret API case prepares
its grants and tests native SecretRefs, denial, sharing and rotation. Pod recreation
retains the admitted projection; OCE redeployment refreshes canonical values.
Routing, Slack and OTLP suites live in separate files.

Embedded cases run the production API and worker in the Node test process.
Dedicated and routing cases run both as Kubernetes Deployments with separate
identities; the coordinator stays in Node. These suites do not install OCC with
Helm. Missing prerequisites fail selected suites; unselected suites skip.
The default Codex version is `0.160.0`; see
[runtime settings](#kubernetes-real-runtime-test-environment) for alternate images.

### Candidate Skill source lifecycle

Use candidate images supporting paired-node Skill uploads and local `zip`:

```sh
OCC_TEST_SKILL_SOURCE_LIFECYCLE=1 node --env-file="$TEST_ENV_FILE" --test \
  --test-name-pattern='candidate dedicated Skill source' \
  tests/integration/harness-topology-k3d-real.test.mjs
```

Tests source replacement, denied writes preserving bytes/lockfiles and redeploy
recovery. Unsupported images fail.

### Transcript persistence

With `OCC_TEST_CODEX_OPENAI_BASE_URL`, Gateway model turns and retained threads
after Gateway replacement verify Codex's native provider and complete model ID:
new-thread, resume, and subsequent-turn resolution. Use a namespaced
`OCC_TEST_OPENAI_MODEL`. Pod-loopback turns do not prove Gateway translation.

Both Harness topologies require SQLite transcripts. Persistence cases query
`session_nodes` and `transcript_events`, then verify conversation history and media
after gateway Pod replacement. Images with JSONL transcripts cannot exercise
this path, even with SQLite authentication or memory.
`OCC_TEST_KUBERNETES_OPENCLAW_VERSION` alone does not verify transcript storage.

For Secret changes, run the API, PostgreSQL, and real Kubernetes runtime suites;
route, schema, and documentation checks alone do not verify Kubernetes Secret
storage and delivery. These suites exercise the selected disposable resources;
deployments need their own runtime verification.

## Kubernetes fixture test environment

Real-cluster integration is opt-in for ordinary development and required when
explicitly requested or validating the production-capable Kubernetes driver for
release. Unlike the driver's
[authentication modes](../reference/drivers/kubernetes-compute.md#authentication),
the harness accepts only a dedicated loopback k3d context.
These variables do not configure `server.mjs`, `worker.mjs`, the normal
controller, or its default Compute Driver.

CI selects the Kubernetes 1.35 family so the fixture proves the supported
minimum line, and preparation rejects a server outside it; a manually selected
server must be 1.35 or later. The test exercises the real version endpoint
through its scoped controller identity before creating tenant resources.

| Variable                            | Requirement                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OCC_TEST_KUBERNETES_KUBECONFIG`    | Absolute path to the dedicated disposable local-cluster kubeconfig.                                |
| `OCC_TEST_KUBERNETES_CONTEXT`       | Explicit context whose HTTPS API server is loopback-only with an explicit port.                    |
| `OCC_TEST_KUBERNETES_IMAGE`         | Locally available fixture image already imported into the selected cluster.                        |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` | Optional immutable runtime image for credential Secret and private-state teardown proof.           |
| `OCC_TEST_DATABASE_URL`             | Required for API-and-worker coverage; must select a dedicated, migrated `openclaw_k8s_*` database. |

The API-and-worker case rejects the ordinary `openclaw_enterprise` database. The
[HTTP fixture](#kubernetes-http-fixture) does not prove a real gateway, authenticated Codex connection, or model
turn; use the [real-runtime suite](#kubernetes-model-turns-and-secrets) for that.

CI uses the project-pinned k3d 5.8.3 binary and a digest-pinned K3s 1.35 node
image (`defaultK3sImage` in `scripts/ci/prepare.mjs`) for ordinary disposable
clusters, so creation never depends on k3d's online release-channel lookup.
Moving to a newer 1.35.z patch is a deliberate bump of that constant. The CI
`kubectl` client is pinned to 1.35.0. The OpenShell lane keeps its own pinned K3s and `kubectl`
versions.

## Kubernetes real-runtime test environment

[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
is independently opt-in. Set `OCC_TEST_HARNESS_K3D_REAL=1` or explicitly select
a real runtime image to enable the ordinary runtime suite. Selected suites fail on missing cluster, image,
database, credential, or NetworkPolicy prerequisites; unselected suites skip.
For dedicated Codex coverage, a model override must support Codex custom tools.

| Variable                                    | Requirement or default                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_HARNESS_K3D_REAL`                 | Set to `1` to explicitly opt into the real-runtime Kubernetes suite.                                                                                                                                       |
| `OCC_TEST_GATEWAY_ROUTING_REAL`             | Set to `1` to explicitly opt into the separate Envoy/OCC workspace-routing suite.                                                                                                                          |
| `OCC_TEST_KUBERNETES_KUBECONFIG`            | Absolute path to the dedicated disposable k3d kubeconfig.                                                                                                                                                  |
| `OCC_TEST_KUBERNETES_CONTEXT`               | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                                                                                                               |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`         | Imported real OpenClaw gateway image pinned with an immutable SHA-256 digest.                                                                                                                              |
| `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`      | Imported controller image pinned with an immutable SHA-256 digest; required by the gateway-routing suite's in-cluster OCC API.                                                                             |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`           | Imported real pinned Codex runtime image with an immutable SHA-256 digest.                                                                                                                                 |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`         | Optional shared image fallback for both gateway and Agent when it contains both real runtimes.                                                                                                             |
| `OCC_TEST_KUBERNETES_CODEX_IMAGE`           | Optional legacy fallback for the Agent image when the explicit Agent image is absent.                                                                                                                      |
| `OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE` | Optional CI-published kubelet Localhost seccomp profile path for dedicated Codex Agents; generated from each selected k3d node's effective `RuntimeDefault` profile and installed only on run-owned nodes. |
| `OCC_TEST_KUBERNETES_OPENCLAW_VERSION`      | Optional exact OpenClaw version expectation for the selected real gateway image.                                                                                                                           |
| `OCC_TEST_KUBERNETES_CODEX_VERSION`         | Expected Codex version; defaults to `OPENAI_CODEX_VERSION` in `deploy/runtime/Dockerfile`.                                                                                                                 |
| `OCC_TEST_DATABASE_URL`                     | Migrated disposable loopback database named `openclaw_k8s_*`; the ordinary development database fails.                                                                                                     |
| `OPENAI_API_KEY`                            | Existing authorized provider credential for real embedded and dedicated model turns.                                                                                                                       |
| `OCC_TEST_OPENAI_MODEL`                     | Authorized provider model; defaults to `gpt-6-astra`.                                                                                                                                                      |
| `OCC_TEST_CODEX_OPENAI_BASE_URL`            | Optional HTTPS Responses endpoint for dedicated Codex API-key tests; applied through `runtime.codexModelBaseUrl`. Keep the native Codex provider at its fail-closed loopback URL.                          |

The separate
[`harness-topology-k3d-routing-real.test.mjs`](../../tests/integration/harness-topology-k3d-routing-real.test.mjs)
requires `OCC_TEST_GATEWAY_ROUTING_REAL=1`, the same runtime prerequisites,
ready Envoy Gateway and cert-manager controllers,
`OCC_TEST_GATEWAY_CA_CERT_PATH`, `OCC_TEST_GATEWAY_CA_KEY_PATH`,
and `NODE_EXTRA_CA_CERTS`. The suite runs the OCC API and worker in Kubernetes,
without the controller Helm release, and uses the Envoy ClusterIP Service on its
standard HTTPS port; no host Envoy port is published. Controller namespace
overrides are `OCC_TEST_ENVOY_GATEWAY_NAMESPACE` (default `envoy-gateway-system`)
and `OCC_TEST_CERT_MANAGER_NAMESPACE` (default `cert-manager`). See the
[focused routing proof](gateway-routing.md#setup-and-execution) for the
disposable CA and command. The CA private key is test setup only; the
production OCC API mounts only a public trust bundle.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
- [Network access](production-network-access.md).

## Dedicated Gateway placement

Dedicated gateway resources live in the logical Namespace's managed gateway
runtime namespace. Fixture bootstrap must grant the worker scoped access there
and in the Harness namespace before waiting for Namespace readiness. Runtime
helper results expose `gatewayPlacement` for gateway Pods, routes, private PVCs
and port-forwards, and `placement` for Harness execution, model credentials and
workspace storage.

Disposable runtime helpers accept `OCC_TEST_KUBERNETES_GATEWAY_NODE_SELECTOR` as
a JSON selector and default to Linux nodes. The default tests namespace and
credential separation, not production node-pool isolation; that proof needs
separate reviewed node pools. Tests must still pass with the actual supported
gateway/Codex images and authenticated node reconnect; fixture readiness is not
a substitute for model-backed acceptance.

## Production observability

See [smoke tests and model-log validation](metrics.md#kubernetes-observability-acceptance).
