# Local Kubernetes development

Run OpenClaw Enterprise (OCE) in a disposable, loopback-only k3d cluster. The
Kubernetes-only profile runs PostgreSQL, the OpenClaw Control Plane (OCC), and Agents.

## Start the profile

[Install Linux tools](local-kubernetes-tools.md): Node.js satisfying `engines.node` in `package.json`, repository-pinned pnpm, the Go version from `go.mod`, k3d,
kubectl, Helm, yq v4, and Docker or Podman. Kubernetes-only mode uses the engine for
k3d and images, not OCE services.

K3s requires the `cpuset` cgroup controller, which systemd does not delegate to
a rootless session. On Podman, run as root or use a rootful Podman machine;
native rootless Podman cannot start this profile even with `cpuset` delegated.
On macOS:

```bash
podman machine stop
podman machine set --rootful
podman machine start
```

Rootful describes the virtual machine; run `podman` as your normal host user. Rootful and rootless keep separate container storage, so the first
start after switching rebuilds the images.

On Linux without root, use a rootful machine, which needs `/dev/kvm`,
`gvproxy`, and `virtiofsd`. List a helper directory outside
Podman's defaults, plus those defaults, in `[engine] helper_binaries_dir` of a
`CONTAINERS_CONF_OVERRIDE` file exported for startup and cleanup:

```bash
podman machine init oce-dev --rootful --cpus 8 --memory 16384
podman machine start oce-dev
export CONTAINER_CONNECTION=oce-dev-root
```

The machine shares only `$HOME` by default, so set
`OCC_DEVELOPMENT_STATE_DIRECTORY` beneath it.

For `failed to find cpuset cgroup (v2)`, including Docker inside a
containerized development host, follow
[local cgroup troubleshooting](../operate/troubleshooting.md#local-k3s-cannot-find-the-cpuset-controller).

Startup resolves the engine's host API socket. Do not export
`DOCKER_HOST` or `CONTAINER_HOST` from the path `podman info` reports: on a
machine-backed installation that path exists only inside the virtual machine.

Build the CLI and start the Kubernetes-only profile, which needs no selection:

```bash
go build -trimpath -o bin/occ ./cmd/occ
./scripts/dev-up
```

The launcher installs PostgreSQL and OCE, without OpenShell, on pinned K3s in
`oce-system` and writes the administrator password and service key to private state.
It prepares [routing prerequisites](workspace-routing.md#requirements)
and matching Helm/Installation settings before bootstrap.

Before bootstrapping, startup checks the Codex `0.164.0` sandbox with
its exact imported runtime image. If the node's `RuntimeDefault` blocks it, the
launcher derives a [reviewed profile](codex-sandbox.md) from the node's actual
policy and installs it only on the owned k3d node. Only dedicated Codex
containers select it. Startup verifies workspace-write and outside-write
boundaries and missing-profile failure. Private `codex-seccomp-provenance.json`
records hashes and node provenance. Unsupported policy, runtime, or verification
fails startup and rolls back the owned cluster. Ubuntu 24.04: see
[troubleshooting](../operate/troubleshooting.md#local-codex-sandbox-check-fails).
Recreate the installation after runtime, kernel, or image changes.

To enable GitHub repository credentials during a fresh start, prepare the
[approved local repository inputs](local-repository-credentials.md#prepare-the-approved-inputs)
before running the launcher.

### Select another profile

Set `OCC_DEVELOPMENT_CONTROL_PLANE=compose` for
[Compose OCC](#run-occ-in-compose-with-kubernetes-compute), or
`OCC_DEVELOPMENT_COMPUTE_DRIVER=docker` for the Docker Compute preview, which
cannot deploy Agents. See the [profile table](../../reference/cli/local-development.md#select-a-profile).

### Sign in through Keycloak

Set `OCC_DEVELOPMENT_SIGN_IN=keycloak` for Keycloak sign-in. The engine
must bind free host port `127.0.0.1:443` and make it reachable from the host;
other published ports must differ. k3d publishes ports at creation; changes
require `dev-down` and fresh `dev-up`.

The persistent realm attaches `alice` to the existing administrator through
[OIDC](oidc-sign-in.md), makes passwords recovery-only, and keeps
[Agent native administration](../../reference/agent-native-admin.md) enabled.
OpenShell
is unsupported; password-only remains the default.

Import `browser-ca.crt` and `gateway-ca.crt` into your browser; add the printed
`/etc/hosts` entry. In Console, choose **Continue with Keycloak**; use `alice`
with `keycloak-alice-password`. Keep the administrator password for recovery.

`dev-down` destroys the realm volume and cluster. If cleanup retains state,
repair the reported access problem and retry with the same profile and directory.
Remove host entries and imported CAs separately. The
[Keycloak lifecycle](../../flows/docker-compose-development/keycloak.md) covers
Helm, recovery, installation-only drift checks and certificate copying.

### Run OCC in Compose with Kubernetes compute

To select the hybrid profile on a fresh state directory:

```bash
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=compose
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./scripts/dev-up
```

Expect `Control plane: Compose` and `Compute Driver: Kubernetes`. PostgreSQL,
OCC, and its worker run in Compose; Agents run in k3d. This profile includes both default Presets, the Codex Plugin Driver,
and the same Codex seccomp preparation, but not the Kubernetes-only browser
endpoint, private workspace routing, or repository service. Dedicated Codex
requires [hybrid private routing](local-compose-kubernetes.md), configured
before creating Agent Namespaces. That page also covers Compose repository
connections. Channel egress is unavailable in this hybrid profile because Compose
OCC has no API Pod grant. Use the Kubernetes-only profile for
[Slack channel egress](../integrations/slack.md#configure-managed-channel-egress).

If the K3s channel lookup fails or times out, follow
[local image-lookup troubleshooting](../operate/troubleshooting.md#local-k3s-image-lookup-fails).

### Start the OpenShell fail-closed profile

```bash
go build -trimpath -o bin/occ ./cmd/occ
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

The CLI creates one k3d cluster with pinned OpenShell `v0.1.9`, Agent Sandbox,
cert-manager, and Envoy Gateway assets. PostgreSQL, the central OpenShell Gateway,
and OCE run in `oce-system`; Agent Sandbox runs in `agent-sandbox-system`.
Tenant Workspaces, Sandboxes, and Agent Pods use OCC-owned `oce-*` Namespaces.
Startup exposes loopback, waits for Namespace/Workspace readiness,
and privately writes kubeconfig and an administrator key.

Agent Sandbox reuses verified native content from cached children or indexes; cache
misses pull on the host. Custom manifests retain image/pull policy.

Preload failures report the host import error before controller creation. Rollout
failures capture controller status, image IDs and Warning reasons when available,
excluding messages, environment values and logs.

Set `OCC_DEVELOPMENT_CONTROL_PLANE=compose` to run PostgreSQL, OCC, and its
Kubernetes worker in Compose. Startup installs private Envoy routing in k3d,
mounts its service key and public CA only into the controller and
`worker-kubernetes`, and records the node hostname and Envoy NodePort in the
Installation. It enables OCC native administration, publishes loopback HTTPS
for console and Agent hosts, and prints the browser CA path.
`OCC_DEVELOPMENT_BROWSER_PORT` must differ from Compose and k3d API ports.
Skip manual hybrid routing.

Runtime changes need [explicit source verification](../../../deploy/runtime/README.md#verify-runtime-source).

Image preparation requires [host registry access](../operate/troubleshooting.md#local-agent-sandbox-controller-image-pull-fails).
For reviewed local charts and manifests, set
`OCC_DEVELOPMENT_OPENSHELL_HELM_CHART`,
`OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART`, and
`OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST` to absolute paths.
To test a candidate release, [select its OpenShell images by digest](local-openshell-images.md).

See [startup network policy](local-sandbox-network-policy.md) for binary/endpoint rules.

Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=podman` or `docker` to select the host
engine. Kubernetes-only startup rejects Compose arguments.

Startup prints its private [state directory](../../reference/settings/development.md#required-development-controller-environment)
containing kubeconfig and credentials. Its default is `openclaw-development`
under the temporary directory (macOS: `/private/var/folders/<id>/T`). Set absolute
`OCC_DEVELOPMENT_STATE_DIRECTORY` for startup and cleanup to override it; parent
paths cannot contain symlinks (macOS: use `/private/tmp/...`, not `/tmp/...`).
`OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS` bounds cluster readiness and later waits.
Failures roll back owned resources; retained state includes cleanup instructions.
Failed exclusive key writes remove partial outputs, never existing files, and
report removal errors alongside write errors.

Startup refuses existing state or clusters. For source edits,
[rebuild services](#rebuild-after-a-source-edit); cleanup discards the Installation.
State stays mode `0700`; generated mounts are container-readable but inaccessible
to other host users. The default kubeconfig and context stay unchanged.

For separate stacks, select distinct state directories, cluster names, bridge
subnets and published ports. Compose also needs a distinct `OCC_POSTGRES_PORT`;
changing the API port alone leaves PostgreSQL on port 55432. Each Agent Gateway
requests 2560 MiB with a 4 GiB limit, and each dedicated Codex Harness requests
768 MiB with a 6 GiB limit, so a dedicated Codex Agent reserves 3.25 GiB, or
5 GiB with initial workspace files; size the local engine VM for OCC plus the Agents you run
([measurements](installation-profiles.md)). Keep each stack's resources under the helper's lifecycle until cleanup.

<a id="require-both-proxies-before-enabling-slack"></a>

## Configure Slack channel egress

Fresh Kubernetes-only startup checks dependencies and configures
[channel egress](channel-egress.md#local-development) for either sandbox before Helm installation.

Existing releases need [current inputs](local-k3d-image-upgrade.md#apply-installation-changes),
the original backup and installed images. Before retrying or deploying Agents,
reconcile Helm status, history and values, the decoded live Installation key's
SHA-256, and API and worker rollout checksums and readiness against the intended
revision. Fresh profiles may lack checksum annotations. Keep Secret contents private.
Do not rerun `dev-up`, recreate bootstrap storage or delete the cluster.

For legacy chart-managed proxies, follow
[Envoy channel egress](one-off-upgrades.md#envoy-channel-egress). If the upgrade
is interrupted, reconcile the original operation journal against actual cluster
state before resuming with [Recover and verify](one-off-upgrades.md#recover-and-verify).
Do not automatically repeat an operation with an unknown outcome. The upgrade
deploys the recorded Agents. After it succeeds, verify
[Console directory lookup and Gateway Socket Mode](../integrations/slack.md#configure-managed-channel-egress)
without another deployment.

For a separate Installation change, follow
[Installation recovery](production-installation-changes.md) if the outcome is
uncertain. If the change leaves affected running Slack Agents on their previous
configuration, deploy new versions to update the Gateway proxy and network policy.
Verify Slack afterward.

## Verify the local boundary

Use the printed API and kubeconfig paths:

```bash
export KUBECONFIG="<Kubeconfig path printed by scripts/dev-up>"
kubectl get pods -A

export OCC_URL="<API URL printed by scripts/dev-up>"
export OCC_SERVICE_KEY_FILE="<Service key file printed by scripts/dev-up>"
./bin/occ installation get
```

In Kubernetes-only mode, the API is reachable only through the loopback k3d
publication, whose Service selects a dedicated in-cluster proxy admitted by
exact Namespace and Pod labels in the OCE Helm NetworkPolicy. The OCE API itself
remains a ClusterIP Service, and the worker authenticates to Kubernetes
in-cluster. With OpenShell, the API (which registers credential sources), the
worker, and dedicated Agent Gateways reach OpenShell Gateway through a narrow
development NetworkPolicy in `oce-system`.

The launcher sets
[`network.pluginStatusProxySourceCidrs`](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking)
to the k3d node's Pod bridge address, enabling plugin status and diagnostics and
letting a dedicated Codex Gateway start once on a first deploy. The two-minute
bridge-route wait also bounds each container-engine lookup.

The OpenShell profile declares an `openshell` Backend for the Gateway
endpoint and selects both the OpenShell Sandbox and the
[OpenShell Credential Gateway](../../reference/drivers/openshell-credential-gateway.md),
bound to the runtime image's native Codex executable. Agents in this profile
must authenticate through a [credential source](../../reference/credential-sources.md);
to register a key and bind it to an Agent, follow
[Use a credential source on the local OpenShell profile](openshell-credential-sources.md).

The profile supports [managed Codex plugins](../../reference/agent-plugins.md).

The Kubernetes-only OpenShell Gateway requires TLS, mTLS and authentication.
Static-inference enforcement is separate and off by default; it is not required
for model access or protected Git. The Compose-backed profile still permits
unauthenticated Gateway users inside its disposable, loopback-owned cluster.
Do not carry that setting into a shared cluster or container network.

In disposable single-profile development, worker, configuration and Secret bindings
remain cluster-wide. `occ dev up` binds the automation observer only in the
verified bootstrap backing namespace. Additional Namespaces require an
[operator binding](production-agents.md#grant-automation-observation). Production
and shared clusters require tenant-local bindings for every role.

To verify a fresh Kubernetes-only installation without OpenShell, use the
[real local installation test](../../testing/kubernetes.md#local-kubernetes-installation).

To pause a reusable Kubernetes-only stack, verify ownership and the cluster name
on the recorded engine endpoint. Use `k3d cluster stop <name>` and later
`k3d cluster start <name>` on that endpoint to
[preserve storage across restarts](#preserve-storage-across-restarts). `dev-down`
deletes the cluster, local storage and private state.

Use a separate disposable cluster with authorized OpenAI model access, sandboxed
Chromium and certutil. Follow [OpenShell test setup and cleanup](../../testing/openshell.md#test-setup-and-cleanup)
from the trusted repository root. The helper-owned Kubernetes-only test inherits
your environment and selects fresh state, a unique cluster name and free ports.
Keep the separate-stack requirements above. Do not assume pausing releases the
bridge subnet or stops Compose.

The selected real test must pass without a skip. It verifies the Helm-installed
OCE control plane and PostgreSQL Pods, bootstrap and new Namespace Workspace
reconciliation, immutable image registration and owned-cluster cleanup. It also
creates an Agent and checks a real model reply using an OIDC fixture. The fixture
does not qualify a live OIDC provider.

## Configure workspace storage on single-node k3d

Dedicated Agents use separate RWO workspace and Gateway claims on `local-path`
storage. Deployment stops the previous version, causing downtime; see
[storage ownership and recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).

Check the Agent namespace with the printed kubeconfig and context:

```bash
kubectl --kubeconfig '<profile-kubeconfig>' --context '<profile-context>' \
  -n '<agent-kubernetes-namespace>' get pvc,pods
```

Expect a `Bound` RWO claim, then a running Harness Pod. With
`WaitForFirstConsumer`, claims remain pending until Pod creation. RWX claims are unsupported.
Do not change a PVC's access mode in place.

### Preserve storage across restarts

The node's `/var/lib/rancher/k3s` volume holds workspace files and K3s state.
Restarts keep it; deleting the cluster, volume, or profile destroys it.
Local-path storage is node-bound; cross-node workloads need a portable
StorageClass.

PostgreSQL is a StatefulSet, and a launcher NetworkPolicy allows egress by its
Pod label and the k3d subnet, so the profile survives `k3d cluster stop`/`start`.

The `local-path` reclaim policy is `Delete`: deleting a claim may delete its
backing directory. Nothing here backs up Agent workspaces. Long-lived demos need
a durable private state directory, not `/tmp`.

## Rebuild after a source edit

Controller builds record Git `HEAD`; read it with **Debug mode** in Console
Settings. See [controller image builds](../../contributing/local-development.md#build-a-controller-image)
for standalone builds and source metadata limits.

The environment registers immutable image digests, so running containers do not
pick up source edits. Recreate it after controller, runtime, migration, Helm, or
OpenShell integration changes; startup rebuilds both images from the current
checkout unless an existing controller or runtime image was selected explicitly:

```bash
./scripts/dev-down
./scripts/dev-up
```

This discards the owned Installation; it is not an in-place upgrade. If
repository access was enabled, check the
[credential cleanup limitation](local-repository-credentials.md) before removing
the cluster. For a persistent Helm-installed k3d environment, complete the
[upgrade migration checklist](upgrade-checklist.md), then the
[local k3d image upgrade procedure](local-k3d-image-upgrade.md).

## Resolve node DNS failures

On Linux Docker, the launcher gives its k3d node the host's first non-loopback
IPv4 upstream resolver, because k3d's default refuses queries on iptables-nft
hosts. If the node still cannot resolve image registries, set a DNS server
reachable from the node network for a fresh startup:

```bash
OCC_DEVELOPMENT_K3D_DNS_RESOLVER='<reachable-dns-ip>' ./scripts/dev-up
```

The host resolver is unchanged; the
[setting reference](../../reference/settings/development.md#required-development-controller-environment)
covers its node effect and the `k3d` value.

## Stop and clean up

If repository access was enabled, first follow the
[credential cleanup guidance](local-repository-credentials.md); the launcher
does not verify credential disposal before removing the cluster.
Then remove only the cluster and private state the launcher recorded:

```bash
./scripts/dev-down
```

Cleanup uses the recorded engine endpoint and cluster name. If deletion fails, it
keeps the state directory so a retry never discovers or deletes an unrelated
cluster.

## Limits

Both local k3d profiles use K3s legacy iptables mode. Kubernetes-only startup
without OpenShell checks policy traffic before configuring gateway proxy trust and
again against the initial Gateway Namespace. These startup checks cover only the
tested single-node traffic and do not monitor later policy failures.

Startup readiness does not prove Agent deployment, model execution, provider
authentication, or dedicated Codex WebSocket execution; OpenShell startup proves
only its infrastructure and fail-closed boundary. The
[Kubernetes testing guide](../../testing/kubernetes.md) covers those
credentialed real-cluster checks.

## Gateway placement boundary

Dedicated Gateways and Harnesses share one tenant namespace but retain separate
Pods, ServiceAccounts, credentials and storage. The local profile schedules
Gateways on its single k3d server, which does not prove production node isolation. Production must configure
`runtime.gatewayNodeSelector` and `runtime.nodeSelector` for disjoint trusted and
data-plane pools. See [production Namespace preparation](production-agents.md#prepare-each-namespace)
for the scoped RoleBindings.

- This is a development environment, not a production deployment recipe.
- The OpenShell development profile remains fail-closed for unsupported Secret and
  workload-identity projections, so Workspace readiness does not prove that an
  Agent Sandbox can start or complete a model turn.
