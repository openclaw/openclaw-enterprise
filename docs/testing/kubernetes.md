# Kubernetes tests

Prepare [shared prerequisites](README.md#requirements-and-credentials) for
Kubernetes HTTP fixtures or real-runtime gateway, Codex, model, and Secret tests.

## Kubernetes HTTP fixture

Requires Docker, k3d, `kubectl`, and the migrated `openclaw_k8s_local` database
from [PostgreSQL](postgresql.md#postgresql). Create a new disposable cluster; if `oce` already
exists, use a new name consistently throughout these commands.

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
  node --test tests/integration/kubernetes-compute-real.test.mjs
```

All four fixture cases must run: Driver lifecycle/isolation, externally managed
namespace preservation, provisioning handoff, and PostgreSQL API-plus-worker
reconciliation. No model
key is needed. Missing all cluster selectors skips the suite; partial selectors
fail, and a missing database skips the API-plus-worker case.

Set `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` to an imported immutable runtime image
reference to extend the API-plus-worker case through real runtime credential
Secret and private-state claim deletion. The case uses nonfunctional fixture
credentials and performs no model turn.

The tests require an explicit loopback `k3d-*` context and enforcing
NetworkPolicies. They create scoped RBAC and resources and use the stock
local-path provisioner for RWO Harness workspaces. The API-plus-worker case
verifies that replacement retains the PVC UID and a file written by the old
Harness. The HTTP fixture can fail native readiness using a workspace marker;
a later deployment must retain both earlier files and writes from the failed
candidate. This proves serial replacement on local storage, not cloud CSI detach,
node fencing, or data movement between nodes. Use a disposable cluster.

### Fixture images and security controls

The disposable `tests/fixtures/kubernetes` image runs as nonroot and uses the
Compute Driver's generated Namespace labels, ResourceQuota, LimitRange,
NetworkPolicies, Pod and container security settings, and bounded resources.
Its local mutable tag and unpinned `docker.io/library/node:24-bookworm` base are limited to this
disposable fixture; production images still require the documented pinning and
review.

The suite checks tenant isolation, resource bounds, nonroot execution, seccomp,
dropped capabilities, and a read-only root filesystem. Skipped cases prove no
enforcement. API-plus-worker coverage uses synthetic Secrets for binding admission
and gateway projection; genuine channel runtime needs the images and credentials below.

Live Configuration ConfigMap CRUD and least-privilege RBAC cases require the
selected disposable cluster and tenant credentials. Without those inputs, they
skip explicitly. Schema, controller, and SDK fixtures do not exercise that live
cluster behavior.

The plugin-status fixture tests wait for Driver readiness, a ready gateway Pod,
and its plugin status before asserting startup or restart results. A later Pod
status read does not establish that an earlier Driver observation was ready.
CI preparation first waits up to 120 seconds for the server's route to the worker
Pod CIDR to use `flannel.1`, then admits that route's source `/32` for API-server
Pod proxy requests. Node readiness alone can precede this route; selecting the
container network's default-route source would leave ready Pods unreachable
through the proxy. An absent overlay route fails preparation before it publishes
the test environment.

## Kubernetes model turns and Secrets

Follow [Codex sandbox setup](../guides/deploy/codex-sandbox.md) for seccomp
prerequisites. CI checks workspace writes and outside-write denial; the native
workspace case additionally requires tool-history evidence with `approvalPolicy: never`.
Credentialed repository access requires separate proof.

### Develop with local containers and k3d

The helper prepares disposable k3d, isolated PostgreSQL, and gateway/Codex images.
Start Docker or Podman's API socket (Podman Machine on macOS), then run:

```sh
export OCC_TEST_OPENAI_MODEL=gpt-6-astra
./scripts/k3d
```

When `OPENAI_API_KEY` is not already set, the interactive `demo` command prompts
for it without echoing the value. `test` requires the variable explicitly;
`reset` does not require it. A prompted value exists only in the helper process
and its children; the helper does not write it to preparation or demo state
files.

The helper requires k3d, `kubectl`, Helm, and OpenSSL, plus either Docker with
Docker Compose or Podman with `podman-compose`. It uses a running Podman API
socket when both engines are available unless `DOCKER_HOST` already selects an
engine. Set `OCC_K3D_CONTAINER_ENGINE=podman` or `docker` to override detection.

Preparation state is private to the selected engine under
`${XDG_STATE_HOME:-$HOME/.local/state}/openclaw-enterprise/k3d-<engine>-codex`.
Set `OCC_K3D_STATE_DIR` to an absolute path to override that location. Later
runs reuse the prepared cluster, database, images, Envoy Gateway, cert-manager,
and the disposable private-routing CA. The helper builds the current checkout
and ignores Kubernetes image selectors inherited from an earlier test shell.
State prepared by an older version without workspace routing must be removed
with `./scripts/k3d down` before starting the updated demo.

To clear an interrupted test or rerun against a fresh database while preserving
the PostgreSQL service, cluster, and imported images:

```sh
./scripts/k3d reset
```

Reset deletes only `oce-production-*`, `oce-ns-*`, and
`openclaw-ci-seccomp-*` Namespaces from the helper-owned cluster. It drops and
recreates only the database recorded in the helper's private state.

The default command starts the OCC API inside Kubernetes, creates one dedicated
Codex Agent, and performs a real model turn before serving the OpenClaw Control UI on
`http://127.0.0.1:18888` and the OCC console on
`http://127.0.0.1:18889`. It prints the temporary OCC username and a command to
copy the OCC password from the mode-`0600` `demo.json` state file; it does not
print either password.
The demo uses the same development login as `scripts/dev-up`:
`admin@openclaw.local` with
`openclaw-development-password`. Set `OPENCLAW_DEV_EMAIL` or
`OPENCLAW_DEV_PASSWORD` to override those defaults for both workflows. The
prepared database retains that account between demo runs. If you change its
password, run `./scripts/k3d reset` before starting the demo again.
Print the Control UI URL with `./scripts/k3d get openclaw-control-ui`. Copy the
password with `./scripts/k3d copy openclaw-password` and paste it into the Control UI's
**Gateway secret** field. The separate password preserves direct loopback access
while the gateway uses trusted-proxy authentication for OCC workspace files.
Keep the command running while using either interface. Press Ctrl-C to stop the
local controller and worker, close the port-forwards, remove the private state
file, and remove the demo's Kubernetes Namespaces. The prepared cluster, images,
routing controllers, and PostgreSQL service remain available. Run
`./scripts/k3d` again to create fresh demo resources and restore the
port-forwards; there are no surviving demo services for a separate forwarding
command to reconnect.

Inspect the current demo and cluster details without parsing the private state
files directly:

```sh
./scripts/k3d info
./scripts/k3d copy openclaw-password
./scripts/k3d copy occ-password
```

`info` reports the selected engine, state directory, preparation status, demo
status, non-secret connection values, password copy commands, and the live
host/container processes outside Kubernetes. `get` prints only a selected
non-sensitive value for shell composition; run
`./scripts/k3d help` for its available fields. `copy` sends
`openclaw-password` or `occ-password` directly to the clipboard with `pbcopy`,
`wl-copy`, or `xclip` and prints only a confirmation; it never writes the
selected value to standard output. The OCC console's Workspace files panel uses
the same private Envoy route exercised by the focused gateway-routing
integration. Demo fields become available after the foreground command reports
readiness. Cluster fields remain available while its prepared state exists.

To run the dedicated Codex gateway-routing integration instead:

```sh
./scripts/k3d test
```

The test proves real model turns, OCC workspace access through Envoy, routing
credential enforcement and rotation, certificate renewal, Pod replacement, and
retained workspace behavior. It does not prove the broader Kubernetes suite's
credential-recovery or embedded OpenClaw cases.

Remove only resources recorded in the helper's owned state when finished:

```sh
./scripts/k3d down
```

If preparation fails, run the same cleanup command before retrying. The helper
does not use or modify the default kubeconfig, active context, the development
database on port 55432, or unrelated container-engine resources.

Use the disposable cluster and `openclaw_k8s_*` database above, an exported
`OPENAI_API_KEY`, and approved real gateway/Codex images. Import local image
tags, then register their corresponding immutable references inside k3s.
Replace the placeholders with the exact tags and digest references for your
images:

```sh
k3d image import '<local-gateway-tag>' '<local-codex-tag>' -c oce
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-gateway-image>' '<gateway-image>@sha256:<digest>'
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-codex-image>' '<codex-image>@sha256:<digest>'
```

Prepare a private runtime environment file with the model key and these
nonsecret settings, using the actual digest references:

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
and controller restart. This proves retained startup evidence, not live health.
Set the private status proxy CIDRs to the actual API-server Pod-proxy source;
CI preparation supplies them. For manual clusters, follow the
[networking setup](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).

Private workspace-file routing has a separate [gateway-routing suite](gateway-routing.md) with additional Envoy Gateway, cert-manager, and test-CA setup.

Run the ordinary runtime cases independently of Slack:

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

Three non-Slack runtime cases must pass: dedicated Codex, embedded OpenClaw,
and the extended Secret lifecycle case. Both topologies use OCC Secret-backed
Agent `harnessAuth` bindings. The Secret API case verifies native SecretRefs, exact grants and denial,
shared Secrets, rotation, and redeployment. It prepares those Secrets and grants
itself. Routing, Slack and OTLP cases live in separate files, so this invocation
contains only its three required runtime cases.

The ordinary suite uses the real production API and worker in the Node test
process. The gateway-routing suite runs the API as a Kubernetes Deployment so
it reaches Envoy through the normal ClusterIP Service endpoint; its worker and
test coordinator remain in the Node test process. Neither suite installs the
controller with Helm. Missing selected-suite
prerequisites fail; an unselected suite skips. Default Codex version expectation
is `0.156.0`; see [runtime settings](#kubernetes-real-runtime-test-environment)
for version assertions and alternate image variables.

### Transcript persistence

Both Harness topologies require a gateway image that stores transcripts in
SQLite. The persistence cases query the test conversation through
`session_nodes` and `transcript_events`, then verify its history and media after
gateway Pod replacement. An older image that writes JSONL transcripts cannot
exercise this storage path, even if it uses SQLite for authentication or memory.
Setting `OCC_TEST_KUBERNETES_OPENCLAW_VERSION` alone does not verify transcript
storage behavior.

For Secret changes, run the API and PostgreSQL suites as well as the real
Kubernetes runtime cases. Route/schema checks and documentation checks alone do
not verify Kubernetes Secret storage and delivery. These suites exercise the
selected disposable resources; deployments need their own runtime verification.

## Kubernetes fixture test environment

Real-cluster integration is opt-in for ordinary development and required when
explicitly requested or validating the production-capable Kubernetes driver for
release. Set all three Kubernetes variables to enable it; setting only some
fails rather than silently skipping. The test harness requires a dedicated
loopback-only k3d context, and all three HTTP fixture cases have been
verified against a k3d-managed cluster. The driver itself also supports verified
remote HTTPS API servers and in-cluster ServiceAccount authentication. These
variables do not configure `server.mjs`, `worker.mjs`, the normal controller, or
its default Compute Driver.

CI selects the Kubernetes 1.35 family so the fixture proves the supported
minimum line; a manually selected server must be 1.35 or later. The test
exercises the real version endpoint through its scoped controller identity
before creating tenant resources.

| Variable                            | Requirement                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OCC_TEST_KUBERNETES_KUBECONFIG`    | Absolute path to the dedicated disposable local-cluster kubeconfig.                                |
| `OCC_TEST_KUBERNETES_CONTEXT`       | Explicit context whose HTTPS API server is loopback-only with an explicit port.                    |
| `OCC_TEST_KUBERNETES_IMAGE`         | Locally available fixture image already imported into the selected cluster.                        |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` | Optional immutable runtime image for credential Secret and private-state teardown proof.           |
| `OCC_TEST_DATABASE_URL`             | Required for API-and-worker coverage; must select a dedicated, migrated `openclaw_k8s_*` database. |

Follow the canonical
[Kubernetes HTTP fixture testing guide](#kubernetes-http-fixture)
for disposable `k3d` setup, fixture image import, and PostgreSQL-backed
coverage. Kubernetes API-and-worker coverage rejects the ordinary
`openclaw_enterprise` development database. The real-cluster suite uses an HTTP
fixture and does not establish a real gateway, authenticated Codex connection,
or model turn. The [real-runtime suite](#kubernetes-model-turns-and-secrets) provides model-turn proof.

CI keeps the project-pinned k3d 5.8.3 binary and passes `--image +v1.35` when it
creates ordinary disposable clusters. k3d resolves the K3s `v1.35` release
channel at cluster creation, so these lanes follow the current Kubernetes
1.35.z patch rather than one immutable node image. Preparation rejects a server
outside the 1.35 family. The CI `kubectl` client is pinned to 1.35.0. The
separately prepared OpenShell lane retains its own pinned K3s and `kubectl`
versions.

## Kubernetes real-runtime test environment

[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
is independently opt-in. Set `OCC_TEST_HARNESS_K3D_REAL=1` or explicitly select
a real runtime image to enable the ordinary runtime suite. Once selected,
missing cluster, image, database, credential, or NetworkPolicy prerequisites
fail instead of skipping. The ordinary suite verifies dedicated Codex, embedded
OpenClaw with a persisted provider credential, and embedded OpenClaw with the
Secret API through real Enterprise gateways on an explicitly selected disposable
k3d cluster. It does not prove Agent workspace-file private routing until
Compute HTTPRoutes, real Envoy Gateway, cert-manager, OCC, and the native Agent
runtime are tested together. The default is `gpt-6-astra`; for dedicated Codex
coverage, any `OCC_TEST_OPENAI_MODEL` override must be authorized and support
Codex custom tools.

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
| `OCC_TEST_KUBERNETES_CODEX_VERSION`         | Optional Codex image version expectation; defaults to `0.156.0`.                                                                                                                                           |
| `OCC_TEST_DATABASE_URL`                     | Migrated disposable loopback database named `openclaw_k8s_*`; the ordinary development database fails.                                                                                                     |
| `OPENAI_API_KEY`                            | Existing authorized provider credential for real embedded and dedicated model turns.                                                                                                                       |
| `OCC_TEST_OPENAI_MODEL`                     | Authorized provider model; defaults to `gpt-6-astra`.                                                                                                                                                      |

The separate [`harness-topology-k3d-routing-real.test.mjs`](../../tests/integration/harness-topology-k3d-routing-real.test.mjs) requires
`OCC_TEST_GATEWAY_ROUTING_REAL=1` and the same runtime prerequisites. It also
requires ready Envoy Gateway and cert-manager controllers,
`OCC_TEST_GATEWAY_CA_CERT_PATH`, `OCC_TEST_GATEWAY_CA_KEY_PATH`,
`NODE_EXTRA_CA_CERTS`, and an imported `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`.
The suite starts the OCC API in Kubernetes and uses the Envoy ClusterIP Service
on its standard HTTPS port; no host Envoy port is published.
Controller namespace overrides are `OCC_TEST_ENVOY_GATEWAY_NAMESPACE` (default
`envoy-gateway-system`) and `OCC_TEST_CERT_MANAGER_NAMESPACE` (default
`cert-manager`). See the
[focused routing proof](gateway-routing.md#setup-and-execution) for
the disposable CA and command. The CA private key is test setup only; the
production OCC API mounts only a public trust bundle.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).

## Dedicated Gateway placement

Dedicated Gateway resources now live in the logical Namespace's managed Gateway
runtime namespace. Fixture bootstrap must grant the worker scoped access there
as well as in the Harness namespace before waiting for Namespace readiness.
Runtime helper results expose `gatewayPlacement` separately from `placement`.
Use the former for Gateway Pods, routes, private PVCs and port-forwards; use the
latter for Harness execution, model credentials and workspace storage.

Disposable runtime helpers accept `OCC_TEST_KUBERNETES_GATEWAY_NODE_SELECTOR` as
a JSON selector and default to Linux nodes. The default tests namespace and
credential separation; it does not prove production node-pool isolation. Configure
separate reviewed node pools for that proof. Current tests must still pass with
the actual supported Gateway/Codex images and authenticated node reconnect;
fixture readiness is not a substitute for model-backed acceptance.

## Production observability

See [smoke tests and model-log validation](metrics.md#kubernetes-observability-acceptance).
