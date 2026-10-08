# Local Kubernetes development

Run OpenClaw Enterprise (OCE) against a disposable, loopback-only k3d cluster.
Start with the Kubernetes-only profile below, which runs PostgreSQL, the
OpenClaw Control Plane (OCC), and Agent workloads in the owned cluster.

## Start the profile

Install Node.js 24+, repository-pinned pnpm, the Go version from `go.mod`, k3d,
kubectl, Helm, and Docker or Podman. Kubernetes-only mode uses the engine for
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

Build the CLI and start the Kubernetes profile:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./scripts/dev-up
```

This profile uses the pinned K3s image, installs PostgreSQL and OCE (not
OpenShell) in `oce-system`, and writes a generated administrator password and
service key to the private state directory.

Before bootstrapping, startup checks the dedicated Codex sandbox with the exact
imported runtime image and Codex `0.160.0`. If the node's `RuntimeDefault`
blocks it, the launcher derives the
[reviewed compatibility profile](codex-sandbox.md) from that node's actual
policy, installs it only on the owned k3d node, and verifies workspace and
outside-write boundaries and missing-profile failure. Only dedicated Codex
containers select the profile; `codex-seccomp-provenance.json` in the private
state directory records its hashes and node provenance. If the policy, runtime,
or verification is unsupported, startup fails and rolls back the owned cluster.
On Ubuntu 24.04, follow
[local Codex sandbox troubleshooting](../operate/troubleshooting.md#local-codex-sandbox-check-fails).
The check covers that node and image at startup; after a runtime, kernel, or
image change, recreate the local installation to repeat it.

To enable GitHub repository credentials during a fresh start, prepare the
[approved local repository inputs](local-repository-credentials.md#prepare-the-approved-inputs)
before running the launcher.

### Run OCC in Compose with Kubernetes compute

To select the hybrid profile on a fresh state directory:

```bash
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=compose
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./scripts/dev-up
```

Expect `Control plane: Compose` and `Compute Driver: Kubernetes`. PostgreSQL,
OCC, and its worker run in Compose; Agents run in k3d. Keep these exports for
cleanup. This profile includes both default Presets, the Codex Plugin Driver,
and the same Codex seccomp preparation, but not the Kubernetes-only browser
endpoint, private workspace routing, or repository service. Dedicated Codex
requires [hybrid private routing](local-compose-kubernetes.md), configured
before creating Agent Namespaces; that page also covers Compose repository and
Slack service connections.

If the K3s channel lookup times out, follow
[local image-lookup troubleshooting](../operate/troubleshooting.md#local-k3s-image-lookup-times-out).

### Start the OpenShell fail-closed profile

For OpenShell, use the owned launcher:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

The checkout-local CLI creates one k3d cluster, then:

1. installs the pinned Agent Sandbox controller and OpenShell
   `v0.1.3-pre.2` assets, then the pinned cert-manager and Envoy Gateway
   controllers for private Agent Gateway routing;
2. imports digest-resolved OpenShell, OCE controller, Agent runtime, and
   PostgreSQL images;
3. creates `oce-system` and installs PostgreSQL, one central OpenShell Gateway
   for the cluster, and the OCE Helm release there;
4. exposes a labeled development proxy through a loopback-only k3d port map;
5. waits for the bootstrap Namespace and its OpenShell Workspace to become
   ready; and
6. writes kubeconfig and the administrator service key to private state.

OpenShell's Agent Sandbox controller remains in its upstream
`agent-sandbox-system` Namespace. OCC runs in the cluster and creates tenant
Workspaces, Sandbox resources, and Agent Pods in separate OCC-owned `oce-*`
Namespaces.

To keep PostgreSQL, the OCC API, and the Kubernetes worker in Compose, set
`OCC_DEVELOPMENT_CONTROL_PLANE=compose` with the same OpenShell selection. This
profile also installs the pinned private Envoy route in k3d. It mounts the
route's service key and public CA only into the Compose controller and
`worker-kubernetes`, then records the k3d node hostname and Envoy NodePort in
the Installation. Do not run the separate manual hybrid-routing procedure for
this OpenShell profile.

The first start requires network access. To use reviewed local assets instead,
set
`OCC_DEVELOPMENT_OPENSHELL_HELM_CHART`,
`OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART`, and
`OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST` to absolute paths.

To choose the host engine explicitly:

```bash
export OCC_DEVELOPMENT_CONTAINER_ENGINE=podman
./scripts/dev-up
```

Use `docker` instead for Docker Engine. The Kubernetes-only profile does not
require Docker Compose or `podman-compose` and rejects Compose arguments. Keep
the profile exports for startup and cleanup. Without profile selections,
startup uses the Compose control-plane preview with Docker Compute.

State, the kubeconfig, and credentials, including the initial administrator
service key, are written to a private
[state directory](../../reference/settings/development.md#required-development-controller-environment)
that startup prints. By default it is `openclaw-development` in the temporary
directory, which on macOS is a per-user `/private/var/folders/<id>/T` path.
Set the absolute `OCC_DEVELOPMENT_STATE_DIRECTORY` before both startup and
cleanup to use another location. Its parent must not contain symlinks; on macOS,
use `/private/tmp/...` instead of `/tmp/...`.
`OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS` bounds k3d
readiness and each later startup wait. A cluster timeout triggers owned-resource
rollback; follow the printed cleanup instruction if state is retained. Startup
refuses an existing state directory or cluster. To pick up source changes,
[rebuild the running services](#rebuild-after-a-source-edit); cleanup is for
discarding the Installation. The state directory remains mode `0700`; generated
files mounted into the non-root controller and worker are container-readable but
inaccessible to other host users through that directory. The helper does not
modify the default kubeconfig or current kubectl context.

For separate stacks, select distinct state directories, cluster names, bridge
subnets and published ports. Compose also needs a distinct `OCC_POSTGRES_PORT`;
changing the API port alone leaves PostgreSQL on port 55432. Each Agent Gateway
requests 1792 MiB with a 3 GiB limit, and each dedicated Codex Harness requests
768 MiB with a 6 GiB limit, so a dedicated Codex Agent reserves 2.5 GiB; size
the local engine VM for OCC plus the Agents you run
([measurements](installation-profiles.md)). Keep each stack's resources under the helper's lifecycle until cleanup.

## Require both proxies before enabling Slack

For a Slack-enabled local installation, complete [both Slack proxy paths](../integrations/slack.md#configure-both-slack-proxies)
before creating or deploying the Agent. The launcher neither provisions these
proxies nor configures their URLs.

Provision the reviewed proxy on the owned k3d container network (no
host-published listener needed) or at another private address reachable from the
API and dedicated gateway Pods. Do not use host loopback: `127.0.0.1` inside a
Pod is that Pod. Restrict its source access to this cluster's actual traffic,
accounting for node source NAT.

Back up both generated files in the private state directory, then update them:

- `installation.yaml`: set `drivers.compute.configuration.runtime.channels.proxyUrl`
  for gateway Slack messaging.
- `helm-values.json`: set `api.channelDirectoryProxyUrl` for Console user and
  channel lookup. Kubernetes-only mode runs the production API, where lookup
  stays disabled without this setting.

Apply the edits to the existing release as shown below. Use the chart
source matching the installed controller, retain its image references and other
protected inputs, and plan a maintenance window if Agents are running. Confirm
the release and namespace; the values below are launcher defaults. The checksum
rolls the API and worker even when only the Installation document changed. After
an [in-place image upgrade](local-k3d-image-upgrade.md#apply-installation-changes),
`helm-values.json` still names the bring-up images: make both edits in that
page's recovered `INSTALLATION` and `VALUES` and apply them with
[apply other Installation changes](production-upgrade.md#apply-other-installation-changes) instead.

```bash
set -euo pipefail
umask 077
export OCC_SLACK_STATE='<existing private state directory>'
export OCC_SLACK_CONTEXT='<context printed by scripts/dev-up>'
export OCC_SLACK_NAMESPACE='oce-system'
export OCC_SLACK_RELEASE='openclaw-enterprise'

node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.OCC_SLACK_STATE;
const path = join(root, 'helm-values.json');
const values = JSON.parse(readFileSync(path, 'utf8'));
values.controlPlane ??= {};
values.controlPlane.installationChecksum = createHash('sha256')
  .update(readFileSync(join(root, 'installation.yaml'))).digest('hex');
writeFileSync(path, JSON.stringify(values, null, 2) + '\n');
const document = readFileSync(join(root, 'installation.yaml')).toString('base64');
writeFileSync(join(root, 'installation-secret-patch.json'),
  JSON.stringify({ data: { 'installation.yaml': document } }));
NODE

kubectl --kubeconfig "$OCC_SLACK_STATE/kubeconfig" --context "$OCC_SLACK_CONTEXT" \
  -n "$OCC_SLACK_NAMESPACE" patch secret occ-installation-startup \
  --type merge --patch-file "$OCC_SLACK_STATE/installation-secret-patch.json"
rm "$OCC_SLACK_STATE/installation-secret-patch.json"

helm upgrade "$OCC_SLACK_RELEASE" deploy/helm/openclaw-enterprise \
  --kubeconfig "$OCC_SLACK_STATE/kubeconfig" --kube-context "$OCC_SLACK_CONTEXT" \
  --namespace "$OCC_SLACK_NAMESPACE" -f "$OCC_SLACK_STATE/helm-values.json" \
  --wait --timeout 5m
```

Do not rerun `dev-up`, recreate bootstrap storage, or delete the cluster to apply
this configuration. After OCC recovers, deploy a new revision for each affected
running Slack Agent so its gateway receives the new proxy and network policy.
Verify directory search and gateway Socket Mode using the
[Slack checks](../integrations/slack.md#configure-both-slack-proxies).

## Verify the local boundary

Startup prints the API URL, kubeconfig, Kubernetes context, and service-key file.
With Sandbox Driver `none`, it also prints an HTTPS browser console URL and a
public browser CA to import as described in
[Local Setup](../quickstart.md#open-the-platform-console). The session cookie's
per-installation parent domain and matching subdomains form the
[shared session boundary](../../reference/agent-native-admin.md#shared-session-boundary).
The OpenShell profile does not configure that browser endpoint.

Use the printed paths with other tools:

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

The OpenShell Gateway permits unauthenticated users, a development setting safe
only inside this disposable, loopback-owned cluster. Tenant egress selects only
OpenShell supervisor Pods for Gateway callbacks. Do not use this profile, or
carry that setting, into a shared cluster or container network.

Because this cluster is disposable and single-profile, the helper binds the chart's tenant worker, configuration, and Secret ClusterRoles
to the OCE service accounts cluster-wide. This is not a production RBAC pattern:
production and shared clusters must use the tenant-local RoleBindings in the
production deployment guide.

To verify a fresh Kubernetes-only installation without OpenShell, use the
[real local installation test](../../testing/kubernetes.md#local-kubernetes-installation).

To prove OpenShell setup and cleanup in a separate fresh cluster, stop the
reusable environment and run:

```bash
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The selected real test must pass without a skip. It verifies the Helm-installed
OCE control plane and PostgreSQL Pods, bootstrap and new Namespace Workspace
reconciliation, immutable image registration, and owned-cluster cleanup, but
creates no Agent and performs no model turn; for that credentialed proof, follow
the [Kubernetes model-turn procedure](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets).

## Configure workspace storage on single-node k3d

Dedicated Agents use separate RWO workspace and Gateway claims on stock k3d
`local-path` storage. Each deployment has a downtime window while the worker
stops the previous revision; see
[storage ownership and recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).

Check the Agent namespace with the printed kubeconfig and context:

```bash
kubectl --kubeconfig '<profile-kubeconfig>' --context '<profile-context>' \
  -n '<agent-kubernetes-namespace>' get pvc,pods
```

Expect the workspace to become `Bound` with access mode `RWO`, followed by a
running Harness Pod. With `WaitForFirstConsumer`, a pending claim before Pod
creation is normal. Legacy RWX claims are unsupported; before upgrading an older
installation, follow the [storage transition prerequisite](upgrade-checklist.md#remove-legacy-rwx-workspaces).
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

The host resolver is unchanged. The
[setting reference](../../reference/settings/development.md#required-development-controller-environment)
describes its node effect and the `k3d` value.

## Stop and clean up

If repository access was enabled, first follow the
[credential cleanup guidance](local-repository-credentials.md). The launcher
does not verify repository credential disposal before removing the cluster.
Then remove only the cluster and private state the launcher recorded:

```bash
./scripts/dev-down
```

Cleanup reads the recorded engine endpoint and cluster name. If cluster deletion
fails, it preserves the state directory so the same command can retry without
discovering or deleting an unrelated cluster.

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
Pods, ServiceAccounts, credentials and storage. The local development profile
selects its single k3d server for Gateway scheduling; this does not prove
production node isolation. Production must configure
`runtime.gatewayNodeSelector` and `runtime.nodeSelector` for disjoint trusted and
data-plane pools. See [production Namespace preparation](production-agents.md#prepare-each-namespace)
for the scoped RoleBindings.

- This is a development environment, not a production deployment recipe.
- Stock OpenShell `v0.1.3-pre.2` remains fail-closed for unsupported Secret and
  workload-identity projections, so Workspace readiness does not prove that an
  Agent Sandbox can start or complete a model turn.
