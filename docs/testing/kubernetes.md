# Kubernetes tests

Verify Kubernetes resources with an HTTP fixture, then select real-runtime
tests for gateway, Codex, model, and Secret behavior. Prepare the
[shared requirements](README.md#requirements-and-credentials) first.

## Kubernetes HTTP fixture

Requires Docker, k3d, `kubectl`, and the migrated `openclaw_k8s_local` database
from [PostgreSQL](postgresql.md#postgresql). Create a new disposable cluster; if `oce` already
exists, use a new name consistently throughout these commands.

```sh
mkdir -m 700 -p /tmp/oce-k3d
k3d cluster create oce \
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

All three fixture cases must run: Driver lifecycle/isolation, externally managed
namespace preservation, and PostgreSQL API-plus-worker reconciliation. No model
key is needed. Missing all cluster selectors skips the suite; partial selectors
fail, and a missing database skips the API-plus-worker case.

The tests require an explicit loopback `k3d-*` context and enforcing
NetworkPolicies. They create scoped RBAC and resources, and configure the
selected cluster's local-path provisioner for shared filesystem tests. Because
that changes cluster-wide storage configuration, use a disposable cluster.

### Fixture images and security controls

The disposable `tests/fixtures/kubernetes` image runs as nonroot and uses the
Compute Driver's generated Namespace labels, ResourceQuota, LimitRange,
NetworkPolicies, Pod and container security settings, and bounded resources.
Its local mutable tag and unpinned `docker.io/library/node:24-bookworm` base are limited to this
disposable fixture; production images still require the documented pinning and
review.

The suite inspects restricted tenant labels, quotas and limits, NetworkPolicies,
nonroot execution, `RuntimeDefault` seccomp, dropped capabilities, denied
privilege escalation, a read-only root filesystem, and resource bounds. A
skipped cluster case does not verify enforcement. The HTTP fixture exercises
infrastructure; real Agent turns require the runtime images and credentials
below.

Live Configuration ConfigMap CRUD and least-privilege RBAC cases require the
selected disposable cluster and tenant credentials. Without those inputs, they
skip explicitly. Schema, controller, and SDK fixtures do not exercise that live
cluster behavior.

## Kubernetes model turns and Secrets

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
OCC_TEST_OPENAI_MODEL=gpt-5.1
```

Private workspace-file routing has a separate [gateway-routing suite](gateway-routing.md) with additional Envoy Gateway, cert-manager, and test-CA setup.

Run the ordinary runtime cases independently of Slack:

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

Three non-Slack runtime cases must pass: dedicated Codex, embedded OpenClaw with
a persisted service-account credential, and embedded OpenClaw using the Secret
API. The Secret API case verifies native SecretRefs, exact grants and denial,
shared Secrets, rotation, and redeployment. It prepares those Secrets and grants
itself. Routing, Slack and OTLP cases live in separate files, so this invocation
contains only its three required runtime cases.

This suite uses the real production API and worker in the Node test process.
It does not install the controller with Helm. Missing selected-suite
prerequisites fail; an unselected suite skips. Default Codex version expectation
is `0.152.1`; see [runtime settings](#kubernetes-real-runtime-test-environment)
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

| Variable                         | Requirement                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OCC_TEST_KUBERNETES_KUBECONFIG` | Absolute path to the dedicated disposable local-cluster kubeconfig.                                |
| `OCC_TEST_KUBERNETES_CONTEXT`    | Explicit context whose HTTPS API server is loopback-only with an explicit port.                    |
| `OCC_TEST_KUBERNETES_IMAGE`      | Locally available fixture image already imported into the selected cluster.                        |
| `OCC_TEST_DATABASE_URL`          | Required for API-and-worker coverage; must select a dedicated, migrated `openclaw_k8s_*` database. |

Follow the canonical
[Kubernetes HTTP fixture testing guide](#kubernetes-http-fixture)
for disposable `k3d` setup, fixture image import, and PostgreSQL-backed
coverage. Kubernetes API-and-worker coverage rejects the ordinary
`openclaw_enterprise` development database. The real-cluster suite uses an HTTP
fixture and does not establish a real gateway, authenticated Codex connection,
or model turn. The [real-runtime suite](#kubernetes-model-turns-and-secrets) provides model-turn proof.

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
runtime are tested together. For dedicated Codex coverage, set `OCC_TEST_OPENAI_MODEL` to an
authorized model that supports Codex custom tools, such as `gpt-5.1`; the source
default remains `gpt-4.1`.

| Variable                                    | Requirement or default                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_HARNESS_K3D_REAL`                 | Set to `1` to explicitly opt into the real-runtime Kubernetes suite.                                                                                                                                       |
| `OCC_TEST_KUBERNETES_KUBECONFIG`            | Absolute path to the dedicated disposable k3d kubeconfig.                                                                                                                                                  |
| `OCC_TEST_KUBERNETES_CONTEXT`               | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                                                                                                               |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`         | Imported real OpenClaw gateway image pinned with an immutable SHA-256 digest.                                                                                                                              |
| `OCC_TEST_KUBERNETES_GATEWAY_DOCKER_IMAGE`  | Docker-local image ID used only by the Envoy routing host TCP publisher; CI derives it from the prepared gateway source image before k3d import.                                                           |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`           | Imported real pinned Codex runtime image with an immutable SHA-256 digest.                                                                                                                                 |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`         | Optional shared image fallback for both gateway and Agent when it contains both real runtimes.                                                                                                             |
| `OCC_TEST_KUBERNETES_CODEX_IMAGE`           | Optional legacy fallback for the Agent image when the explicit Agent image is absent.                                                                                                                      |
| `OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE` | Optional CI-published kubelet Localhost seccomp profile path for dedicated Codex Agents; generated from each selected k3d node's effective `RuntimeDefault` profile and installed only on run-owned nodes. |
| `OCC_TEST_KUBERNETES_OPENCLAW_VERSION`      | Optional exact OpenClaw version expectation for the selected real gateway image.                                                                                                                           |
| `OCC_TEST_KUBERNETES_CODEX_VERSION`         | Optional Codex image version expectation; defaults to `0.152.1`.                                                                                                                                           |
| `OCC_TEST_DATABASE_URL`                     | Migrated disposable loopback database named `openclaw_k8s_*`; the ordinary development database fails.                                                                                                     |
| `OPENAI_API_KEY`                            | Existing authorized provider credential for real embedded and dedicated model turns.                                                                                                                       |
| `OCC_TEST_OPENAI_MODEL`                     | Authorized provider model; defaults to `gpt-4.1`.                                                                                                                                                          |

The separate [`harness-topology-k3d-routing-real.test.mjs`](../../tests/integration/harness-topology-k3d-routing-real.test.mjs) requires
`OCC_TEST_GATEWAY_ROUTING_REAL=1` and the same runtime prerequisites. It also
requires ready Envoy Gateway and cert-manager controllers, free local port
443, `OCC_TEST_GATEWAY_CA_CERT_PATH`, `OCC_TEST_GATEWAY_CA_KEY_PATH`, and
`NODE_EXTRA_CA_CERTS` set before Node starts. The host TCP publisher also
requires CI-generated `OCC_TEST_KUBERNETES_GATEWAY_DOCKER_IMAGE`; do not replace
it with the k3d-only `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` runtime reference.
Controller namespace overrides are `OCC_TEST_ENVOY_GATEWAY_NAMESPACE` (default
`envoy-gateway-system`) and `OCC_TEST_CERT_MANAGER_NAMESPACE` (default
`cert-manager`). See the
[focused routing proof](gateway-routing.md#setup-and-execution) for
the disposable CA and command. The CA private key is test setup only; the
production OCC API mounts only a public trust bundle.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
