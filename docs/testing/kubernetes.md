# Kubernetes tests

## Overview

Run Kubernetes installation and runtime tests on a disposable local k3d cluster with enforcing NetworkPolicies. The fixture suite excludes a real gateway and model. The runtime suite includes them.

## Local Kubernetes installation

Install k3d, kubectl, Helm, `certutil`, and Chromium with sandbox support.
Use a disposable container engine with enough capacity to build images. The
Keycloak cases need free, bindable loopback port 443 and must not run beside
the standalone Keycloak lane. From the root of a trusted repository checkout,
install the dependencies and build the CLI before running:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm cli:build
OCC_TEST_DEV_UP_K3D_REAL=1 node --test tests/integration/dev-up-k3d-real.test.mjs
```

The tests cover installation, cleanup, workspace boundaries, NetworkPolicy,
sandboxing, and Keycloak. Model responses are fixtures. Failed cleanup retains
state for `occ dev down`. See [hosted execution](README.md#run-the-hosted-local-installation-lane).

## Kubernetes HTTP fixture

Install Docker, k3d and `kubectl`, and prepare the dedicated migrated database
in [PostgreSQL](postgresql.md#other-postgresql-suites). Use Kubernetes 1.35 or
later. Choose a new cluster name if `oce` exists. These commands do not change
the default kubeconfig or context.

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

All fixture cases must pass without skips. Missing all cluster selectors skips;
partial selectors fail. A missing database skips database cases. Run files
sequentially: they share a database. The suite checks API, worker, Driver, RBAC,
storage, lifecycle and network isolation, not live OAuth/models, cloud volume
detach or node fencing.

External OAuth credentials use OpenShell, not Kubernetes bootstrap Jobs or a
native OAuth store. A green fixture result does not prove live OAuth refresh: the
[OpenShell OAuth proof](openshell-oauth.md) and the credentialed
[OpenShell runtime lane](openshell.md) cover it, outside ordinary CI.

When finished, delete only the cluster you created:

```sh
k3d cluster delete oce
```

### Production workload network access

With the fixture cluster and image above, install Helm and `yq`, then run:

```sh
OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce \
OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local \
  node --test tests/integration/production-network-access.test.mjs
```

This needs no database or model credential. It checks the chart's actual
NetworkPolicies with reachable controls. It does not prove controller startup,
database authentication, provider behavior, or a production Helm installation.
Policies for other releases are outside the chart's selectors.

## Kubernetes model turns and Secrets

The real-runtime suite needs an authorized model credential, real gateway and
Codex images, a disposable cluster with enforcing NetworkPolicies, and a
migrated `openclaw_k8s_*` database. A fixture pass is not a model turn. Follow
[Codex sandbox setup](../guides/deploy/codex-sandbox.md) for seccomp prerequisites.

### Develop with local containers and k3d

Install k3d, `kubectl`, Helm, OpenSSL, and Docker Compose or `podman-compose`.
Start the engine's API socket and set `OPENAI_API_KEY` privately. The helper
builds the images and prepares its own cluster and database:

```sh
./scripts/k3d --model-id gpt-6-astra
```

The demo completes a model turn and serves Control UI at
`http://127.0.0.1:18888` and OCC at `http://127.0.0.1:18889`. It prints a
password-copy command. Keep the process running to use the interfaces. Without
`OPENAI_API_KEY`, the interactive demo prompts without echo; `test` requires
the variable. For a custom Codex Responses endpoint, use:

```sh
./scripts/k3d test --harness codex \
  --base-url https://openrouter.ai/api/v1 --model-id z-ai/glm-5.3-flash
```

Use `./scripts/k3d info` for connections and `./scripts/k3d reset` to reset
its test data. Run `./scripts/k3d down` to remove helper-owned resources,
including after a failed preparation. The helper leaves the default kubeconfig,
active context, and unrelated resources unchanged. `OCC_K3D_CONTAINER_ENGINE`
selects `docker` or `podman`; `OCC_K3D_STATE_DIR` overrides its state directory.
For image upgrades see [local k3d image upgrades](../guides/deploy/local-k3d-image-upgrade.md).

### Run the real-runtime suite directly

Import approved local gateway and Codex images into the fixture cluster and
register their immutable references in k3s:

```sh
k3d image import '<local-gateway-tag>' '<local-codex-tag>' -c oce
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-gateway-image>' '<gateway-image>@sha256:<digest>'
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-codex-image>' '<codex-image>@sha256:<digest>'
```

Create a private environment file, set `OPENAI_API_KEY` privately, and select
the actual API-server Pod-proxy source CIDR:

```dotenv
OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local
OCC_TEST_KUBERNETES_GATEWAY_IMAGE=<gateway-image>@sha256:<digest>
OCC_TEST_KUBERNETES_AGENT_IMAGE=<codex-image>@sha256:<digest>
OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS=<api-server-proxy-source>/32
OCC_TEST_OPENAI_MODEL=gpt-6-astra
```

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

All six non-Slack cases must pass: dedicated Codex, dedicated Skill source
uploads, embedded OpenClaw, Secret lifecycle, and startup-failure evidence with
plugins disabled and enabled. The Skill source case needs local `zip`. A
selected suite fails on missing prerequisites; an unselected suite skips. The
suite does not install OCC with Helm. Credentials belong only in the selected
runtime Pods, not controllers, logs, or shell history. For private workspace
routing, run the separate [gateway routing suite](#private-gateway-routing).

For custom provider and image settings see the test's
[source](../../tests/integration/harness-topology-k3d-real.test.mjs) and
[network setup](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).
Transcript persistence requires a runtime with SQLite transcripts. A version
number alone does not establish storage support.

Gateway and Harness resources use separate managed namespaces. Default fixture
placement does not prove production node-pool isolation. Use the separate
[Slack](slack.md) and [observability](local.md#kubernetes-observability-acceptance)
suites for those outcomes.

## Keycloak OIDC tests

The `keycloak-oidc` lane checks real browser sign-in, key rotation, rejection,
and sign-out against a disposable Keycloak server. It uses generated fixture
credentials and an in-process production API with PostgreSQL.

### Verified Keycloak flows

The [six cases](../../tests/integration/keycloak-oidc-sign-in.test.mjs) check:

| Case                               | Evidence                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and signing keys         | Configured endpoints match discovery; the published RS256 key has at least 2,048 bits.                                                                                      |
| Sign-in with `client_secret_post`  | An attached user receives an OCE session through the real browser and callback.                                                                                             |
| Sign-in with `client_secret_basic` | The same flow succeeds with HTTP Basic client authentication at the token endpoint.                                                                                         |
| Signing-key rotation               | A new key signs the next successful sign-in without a controller restart.                                                                                                   |
| Unattached user                    | Sign-in is rejected and audited; no OCE user or session is created.                                                                                                         |
| Sign-out and user disablement      | OCE sign-out ends its session; the surviving Keycloak session permits sign-in again. Disabling the user blocks the next sign-in but leaves the existing OCE session active. |

A skipped or missing case fails the lane.

### Run the Keycloak lane

You need Node.js 24, Docker, OpenSSL, [Chromium](local.md#console-browser-checks),
and a free, bindable `127.0.0.1:443`. Run only one Keycloak lane per host.

```sh
state="$PWD/.ci-state/keycloak-oidc.json"
node scripts/ci/prepare.mjs --lane keycloak-oidc --state "$state" &&
  node scripts/ci/run-tests.mjs run keycloak-oidc --state "$state" --results "$PWD/.ci-state/results.json"
node scripts/ci/cleanup.mjs --state "$state"
```

Preparation creates a private CA, fixture credentials and a Keycloak container.
It may add a tagged line to `/etc/hosts` using `sudo -n`; cleanup removes its
container, private files, and the line it added. If passwordless `sudo` is
unavailable, add this line yourself before preparation and remove it afterward:

```sh
echo '127.0.0.1 keycloak.oce.localhost' | sudo tee -a /etc/hosts
```

The hostname must resolve to exactly `127.0.0.1`; a resolver that returns `::1`
can cause failure. For preparation errors, check the named step: image pull,
port availability, placeholders, hosts resolution, or the printed Keycloak log
for readiness errors.

### Keycloak local launcher coverage

The [local installation test](#local-kubernetes-installation) checks sign-in,
recovery and rollback. It uses its own CA and does not edit `/etc/hosts`.

## Private gateway routing

This suite tests private workspace routing through real Envoy Gateway and
cert-manager in a disposable k3d cluster. It verifies file access, model
consumption after Gateway replacement, authentication denial, key rotation,
certificate renewal, and the dedicated node route. It does not prove a full
Helm installation or Harness node credential persistence.

### Run private gateway routing

Install the [k3d helper prerequisites](#develop-with-local-containers-and-k3d)
and provide an authorized `OPENAI_API_KEY` privately:

```sh
./scripts/k3d test
./scripts/k3d down
```

The helper prepares a cluster, database, images, Envoy Gateway, cert-manager,
and test CA. Direct execution also requires `OCC_TEST_GATEWAY_ROUTING_REAL=1`,
`OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_GATEWAY_CA_CERT_PATH`,
`OCC_TEST_GATEWAY_CA_KEY_PATH`, `NODE_EXTRA_CA_CERTS`, and the runtime setup above.
Keep the CA key private.

For CI-shaped setup, supply `OPENAI_API_KEY`, `OCC_TEST_OPENAI_MODEL`, and
`NODE_BASE_IMAGE` in the environment. In a GitHub Actions runner, execute:

```sh
node scripts/ci/prepare.mjs \
  --lane gateway-routing \
  --state "$RUNNER_TEMP/state/gateway-routing.json" \
  --github-env "$GITHUB_ENV" &&
node scripts/ci/run-tests.mjs run gateway-routing \
  --state "$RUNNER_TEMP/state/gateway-routing.json" \
  --results "$RUNNER_TEMP/results/gateway-routing.json"
```

Use `scripts/ci/cleanup.mjs --state "$RUNNER_TEMP/state/gateway-routing.json"`
to remove the lane's resources.

### Native workspace identity

Prepare native runtime and Envoy images, then set both `OCC_TEST_RUNTIME_IMAGE`
and `OCC_TEST_WORKSPACE_ENVOY_IMAGE`:

```sh
node --test tests/integration/workspace-files-native.test.mjs
```

This checks file access without model calls. It does not prove Kubernetes
routing policies, PostgreSQL or worker execution. Selecting only one image fails.

### Native Gateway sharing

Run the `gateway-routing` lane as shown above; it selects
`tests/integration/native-admin-k3d-real.test.mjs`. Its sharing case checks
Agent grants, denied access, model turns, and WebSocket revocation. It does not
qualify account enrollment, per-chat authority, Git, or OpenShell.

## Production TUI tests

This opt-in test installs the Helm chart on a disposable k3d cluster, uses the
production API and native TUI, and checks Agent revision cutover with a real
model. Allow at least 4 GiB per gateway container. A selected test fails when
prerequisites are missing; an unselected skip is not proof.

### Production TUI Helm test environment

In a [private environment file](README.md#requirements-and-credentials), set:

- `OCC_TEST_KUBERNETES_KUBECONFIG` and `OCC_TEST_KUBERNETES_CONTEXT`: a
  dedicated k3d kubeconfig and `k3d-*` context with a loopback HTTPS API.
- `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`,
  `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, and `OCC_TEST_PRODUCTION_NODE_IMAGE`:
  immutable references already imported into that cluster.
- `OPENAI_API_KEY`: existing authorized credential; optionally set
  `OCC_TEST_OPENAI_MODEL` (default `gpt-6-astra`).

The test normally uninstalls its release and deletes only its namespaces.
`OCC_TEST_PRODUCTION_TUI_KEEP=1` retains the owned setup and writes `attach.sh`
and `proof.json` for rehearsal. Do not treat an in-progress run as a pass.

### Run the production TUI suite

```sh
OCC_TEST_PRODUCTION_TUI_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/production-tui-k3d-real.test.mjs
```

Set both `OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE` and
`OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE` to immutable candidate digests to
check independent controller and runtime upgrades. Setting only one fails. With
neither, a pass does not prove an upgrade.

### Run an isolated upgrade qualification lane

In the private file, set the controller and runtime images to a compatible
prior release and both upgrade images to the reviewed candidate. Each candidate
must differ from its baseline; verify provenance separately. Also set the
PostgreSQL and Node images and the model credential and selection above. With
Docker, k3d, kubectl, Helm, yq, and the built OCC CLI:

```sh
run_dir="$(mktemp -d)"
node --env-file="$TEST_ENV_FILE" scripts/ci/prepare.mjs --lane production-tui --state "$run_dir/state.json" && \
  node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run production-tui \
    --state "$run_dir/state.json" --results "$run_dir/results.json"
```

After success or failure, save the private state if needed for the source-to-local
image mapping, then clean up:

```sh
install -m 600 "$run_dir/state.json" "$run_dir/state-before-cleanup.json"
node scripts/ci/cleanup.mjs --state "$run_dir/state.json"
```

Retain the state if cleanup fails. Do not publish the state or environment file.
Confirm evidence includes both upgrades and a fresh model reply. Imported local
references can differ from registry digests; this does not prove exact registry
reference deployment or live EKS behavior.

## Two-cluster validation

This experimental profile runs OCE and dedicated Codex Harnesses in separate
clusters. It excludes embedded execution, cloud provisioning and repository
credential delivery. Re-run it against current images before claiming acceptance.

### Prepare isolated infrastructure

Use two disposable k3d clusters with Kubernetes 1.35 or later, distinct Pod and
Service CIDRs, enforcing NetworkPolicies, and loopback kubeconfigs. Select an
existing disposable Linux VM through its Docker context. Do not change the
default Docker context or kubeconfig. Use unused names and ports:

```sh
umask 077
export OCE_DOCKER_CONTEXT='your-isolated-local-context'
export OCE_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oce-two-cluster.XXXXXX")"
OCE_DOCKER_SOCKET="$(docker context inspect "$OCE_DOCKER_CONTEXT" \
  --format '{{.Endpoints.docker.Host}}')"
case "$OCE_DOCKER_SOCKET" in unix://*) ;; *) exit 1 ;; esac
k3d_local() {
  env -u DOCKER_CONTEXT DOCKER_HOST="$OCE_DOCKER_SOCKET" k3d "$@"
}
OCE_K3S_IMAGE='rancher/k3s@sha256:59fe491fd3b73204e499e40b325240d85c42c7189c3ae50150d37b78243f3b32'
docker --context "$OCE_DOCKER_CONTEXT" network create oce-two-cluster-local
k3d_local cluster create openclaw-k8s-local-cp \
  --image "$OCE_K3S_IMAGE" --network oce-two-cluster-local \
  --api-port 127.0.0.1:56641 --servers 1 --agents 0 --no-lb \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --k3s-arg '--disable=traefik@server:*' \
  --k3s-arg '--cluster-cidr=10.70.0.0/16@server:*' \
  --k3s-arg '--service-cidr=10.71.0.0/16@server:*'
k3d_local cluster create openclaw-k8s-local-dp \
  --image "$OCE_K3S_IMAGE" --network oce-two-cluster-local \
  --api-port 127.0.0.1:56642 --servers 1 --agents 0 --no-lb \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --k3s-arg '--disable=traefik@server:*' \
  --k3s-arg '--cluster-cidr=10.72.0.0/16@server:*' \
  --k3s-arg '--service-cidr=10.73.0.0/16@server:*'
k3d_local kubeconfig get openclaw-k8s-local-cp > "$OCE_TEST_DIR/cp.kubeconfig"
k3d_local kubeconfig get openclaw-k8s-local-dp > "$OCE_TEST_DIR/dp.kubeconfig"
kubectl --kubeconfig "$OCE_TEST_DIR/cp.kubeconfig" label \
  node k3d-openclaw-k8s-local-cp-server-0 oce-role=control-plane
kubectl --kubeconfig "$OCE_TEST_DIR/dp.kubeconfig" label \
  node k3d-openclaw-k8s-local-dp-server-0 oce-role=agents
```

Keep the private kubeconfigs out of Git and runtime images. Install Envoy Gateway
in both clusters and cert-manager in the control plane (CP). Provide independent
RWO Gateway storage in CP and Harness storage in the execution cluster (DP).
Import approved immutable images and install the Codex seccomp profile on DP.

After CoreDNS installs, place `coredns.yaml.skip` under
`/var/lib/rancher/k3s/server/manifests/` on each owned test node to retain local
DNS settings across restarts. This is fixture setup, not production DNS setup.

### Configure the network and credentials

All cross-cluster traffic uses verified HTTPS. Set reachable DNS names,
certificates, observed CIDRs, and cluster API access. Do not use cluster-local
`.svc` addresses across clusters. CP API and worker use separate scoped DP
kubeconfigs; Gateway uses the exact-Agent transport token to reach the Harness,
and the workspace node uses its node-only identity to reach Gateway.

Create a DP TLS Secret and install `deploy/helm/openclaw-execution` with
`routing.hostname`, `gatewayClassName`, `tlsSecretName`, and
`controlPlaneCidrs`. Provision distinct DP API and worker kubeconfigs, then
store them in separate CP Secrets with a `kubeconfig` key. Administrators own
credential issuance, rotation, and tenant grants. The worker must not have
RoleBinding-write or impersonation permission.

Add this to the Installation Compute configuration:

```yaml
executionCluster:
  authentication:
    mode: kubeconfig
    kubeconfigPath: /etc/openclaw/execution/kubeconfig
    context: execution
  harnessRouting:
    hostname: harness.example.test
    gatewayName: oce-harnesses
    gatewayNamespace: openclaw-system
    envoyNamespace: envoy-gateway-system
  network:
    dns:
      namespace: kube-system
      podLabels: { k8s-app: kube-dns }
    harnessEndpointCidrs: ["<DP ingress destination CIDR>"]
    gatewayEndpointCidrs: ["<CP ingress destination CIDR>"]
    pluginStatusProxySourceCidrs: ["<DP API proxy source CIDR>"]
  caBundle: |
    <public DP certificate authority PEM, if privately issued>
```

Existing `authentication`, `network`, and `gatewayRouting` settings select CP.
Supply public CA certificates only. Enable the CP chart's
`executionCluster`, set `apiKubeconfigSecretName`,
`workerKubeconfigSecretName`, `apiCidrs`, and `apiPort`, and set
`gatewayRouting.remoteNodeCidrs` to the observed DP sources. Workloads do not
receive kubeconfigs. Canonical model, channel, and transport Secrets stay in CP;
selected model and transport material is delivered to data-plane Secrets for each Agent revision.

Use a `coredns-custom` ConfigMap with a separate `*.server` zone. Resolve the CP
Gateway hostname to its Service IP in CP and its reachable ingress address in DP,
with the same hostname and certificate identity. Restart CoreDNS and verify DNS
from controller and runtime Pods before creating Agents.

### Install and exercise the platform

Follow [production installation](../guides/deploy/production-installation.md)
for PostgreSQL, restricted roles, bootstrap and the CP Helm release. Prepare
bootstrap PVC ownership before initialization. If initialization fails, check
commit state and follow bootstrap recovery; do not reset the database or delete
protected output automatically.

Grant the DP tenant worker and API bindings and the three CP bindings in
[Agent preparation](../guides/deploy/production-agents.md#grant-tenant-rolebindings).
Wait for Namespace `ready` and deployment `succeeded`.

Create a private JSON fixture with `apiUrl` (loopback), `serviceKeyFile`,
`dockerContext` (an explicit local Unix-socket context), `agentConfiguration`
(the dedicated native Configuration create body), and `control` and `execution`
objects. Each object needs `kubeconfigPath`, `kubernetesContext`, `release`, and
`systemNamespace`. Set `harnessAuthMethod` to `api_key` (default) or `codex_pat`;
provide its credential through `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN`, not the
fixture. The pass covers only the selected method.

```sh
OCC_TEST_TWO_CLUSTER_CONFIG=/private/path/two-cluster.json \
  node --test tests/integration/kubernetes-two-cluster-real.test.mjs
```

The selected test fails on missing inputs. It checks real model turns, workspace
RPC, replacement and recovery. It stops and restores the selected DP node; do
not run other tests against it concurrently.
A failed run retains its Namespace. Delete its Agent, Configuration, Secret and
seeded Presets through the API before deleting the Namespace. The test does not
establish recovery after worker retry exhaustion or an aged node reconnect after
its pairing code expires. Remote Codex plugin installation needs a separate
ChatGPT-backed credential and proof.

When finished, remove only the clusters and network created above:

```sh
k3d_local cluster delete openclaw-k8s-local-cp openclaw-k8s-local-dp
docker --context "$OCE_DOCKER_CONTEXT" network rm oce-two-cluster-local
```

Remove the private test directory when you no longer need its kubeconfigs.

### Upgrade the execution chart

Upgrade the execution release before the control-plane image upgrade:

```bash
helm upgrade <execution-release> deploy/helm/openclaw-execution \
  --kube-context <execution-context> --namespace <execution-system-namespace> \
  -f <execution-values.yaml>
```

Pass the installation values; do not use `--reuse-values`. Keep
`agentRuntimeLogs.enabled` equal to the CP chart value. The control-plane
[upgrade preflight](../guides/deploy/production-upgrade.md) checks tenant grants
before stopping the old controller.
