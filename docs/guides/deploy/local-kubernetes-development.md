# Local Kubernetes development

Run OpenClaw Enterprise (OCE) against a disposable, loopback-only k3d cluster.
Start with the Kubernetes-only profile below, which runs PostgreSQL, the
OpenClaw Control Plane (OCC), and Agent workloads in the owned cluster. The
Compose alternative has fewer configured capabilities.

## Start the profile

Install Node.js 24 or newer, the repository-pinned pnpm, the Go version from
`go.mod`, k3d, kubectl, Helm, and either Docker or Podman. In Kubernetes-only
mode, the container engine hosts k3d and builds or imports images without
running OCE application services.

K3s requires the `cpuset` cgroup controller, which systemd does not delegate to
a rootless session. On Podman, run as root, delegate `cpuset` to your user
session, or use a rootful Podman machine. On macOS:

```bash
podman machine stop
podman machine set --rootful
podman machine start
```

Rootful describes the virtual machine; keep running `podman` as your normal
host user. Rootful and rootless keep separate container storage, so the first
start after switching rebuilds the images.

On Linux without root, use a rootful machine for the Kubernetes-only profile.
It needs `/dev/kvm`, `gvproxy`, and `virtiofsd`. List a helper directory outside
Podman's defaults, plus those defaults, in `[engine] helper_binaries_dir` of a
`CONTAINERS_CONF_OVERRIDE` file exported for startup and cleanup:

```bash
podman machine init oce-dev --rootful --cpus 8 --memory 16384
podman machine start oce-dev
export CONTAINER_CONNECTION=oce-dev-root
```

The machine shares only `$HOME` by default, so set
`OCC_DEVELOPMENT_STATE_DIRECTORY` beneath it.

Docker inside a containerized development host also needs `cpuset` delegated
by the outer host. If node logs show `failed to find cpuset cgroup (v2)`, inspect
`/sys/fs/cgroup/cgroup.controllers` inside the k3d server. A running Docker daemon
does not prove this prerequisite. If delegation changes fail, check the host
management service and its documented delegation procedure before concluding
that an outer-host change is required. Restore any paused management service
and verify its health before continuing; do not disable the K3s check.

Startup resolves the engine's host API socket itself. Do not export
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

This profile uses the pinned K3s image and installs PostgreSQL and OCE in
`oce-system`. It writes a generated administrator password and service key to
the private state directory. It does not install OpenShell.

Before bootstrapping, startup checks the dedicated Codex sandbox with the exact
imported runtime image and the supported Codex `0.158.0` version. If the node's
`RuntimeDefault` blocks it, the launcher
derives the [reviewed compatibility profile](codex-sandbox.md) from that node's
actual policy, installs it only on the owned k3d node, and verifies workspace
and outside-write boundaries and missing-profile failure. Only dedicated Codex
containers select the profile. The private state directory records its hashes and
node provenance in `codex-seccomp-provenance.json`. If the policy, runtime, or
verification is unsupported, startup fails and rolls back the owned cluster;
check the reported failure and host user-namespace restrictions before retrying.
The sandbox check applies to that node and image at startup; repeat it after a
runtime, kernel, or image change by recreating the local installation.

To enable GitHub repository credentials during a fresh start, prepare the
[local repository inputs](local-repository-credentials.md) before running the
launcher. This requires an approved App key, repository policy, and egress CIDRs.

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
cleanup. This profile does not configure the Kubernetes-only browser endpoint,
private workspace routing or repository service. It includes both default Presets,
the Codex Plugin Driver, and the same Codex seccomp preparation. Dedicated Codex
requires [hybrid private routing](local-compose-kubernetes.md) before deployment.
Follow that procedure before creating Agent Namespaces; it also describes the
Compose repository and Slack service connections.

If the default K3s channel lookup times out, set
`OCC_DEVELOPMENT_K3S_IMAGE` to an approved explicit Kubernetes 1.35-or-newer
image before retrying. After a failed creation, run `./scripts/dev-down` with
the same state directory first. See [profile settings](../../reference/settings/development.md).

### Start the OpenShell fail-closed profile

For an OpenShell environment, use the owned launcher:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

The checkout-local CLI creates one k3d cluster and then:

1. installs the pinned Agent Sandbox controller and OpenShell
   `v0.1.0` assets;
2. imports digest-resolved OpenShell, OCE controller, Agent runtime, and
   PostgreSQL images;
3. creates `oce-system` and installs PostgreSQL, OpenShell Gateway, and the OCE
   Helm release there;
4. exposes a labeled development proxy through a loopback-only k3d port map;
5. waits for the bootstrap Namespace and its OpenShell Workspace to become
   ready; and
6. writes the kubeconfig and initial administrator service-key file beneath a
   private state directory.

OpenShell's Agent Sandbox controller remains in its upstream
`agent-sandbox-system` Namespace. Tenant Workspaces, Sandbox resources, and
Agent Pods live in the OCC-owned `oce-*` Namespaces.

The first start requires network access. To use reviewed local assets
instead, set both `OCC_DEVELOPMENT_OPENSHELL_HELM_CHART` and
`OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART`, plus
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

State and credentials are written to the private
`/tmp/openclaw-development` directory by default. Set the absolute
`OCC_DEVELOPMENT_STATE_DIRECTORY` before both startup and cleanup to use
another location. `OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS` bounds k3d readiness as well as each
subsequent startup wait. A cluster timeout triggers owned-resource rollback;
follow the printed cleanup instruction if state is retained.
Startup refuses an existing state directory or cluster. To pick up source changes, [rebuild the running services](#rebuild-after-a-source-edit);
cleanup is for discarding the Installation. The state directory remains mode
`0700`; the generated files
mounted into the non-root controller and worker are container-readable but
remain inaccessible to other host users through that private directory. The
helper does not modify the default kubeconfig or current kubectl context.

For separate stacks, select distinct state directories, cluster names, bridge
subnets and published ports. Compose also needs a distinct `OCC_POSTGRES_PORT`;
changing the API port alone leaves PostgreSQL on port 55432. Generated runtime workloads have a 2 GiB memory limit
each; size the local engine VM for OCC plus the Agents you run. Keep each
stack's resources under the helper's lifecycle until cleanup.

## Require both proxies before enabling Slack

For a Slack-enabled local installation, complete [both Slack proxy paths](../integrations/slack.md#configure-both-slack-proxies)
before creating or deploying the Agent. The launcher does not provision these
proxies or configure their URLs automatically.

Provision the reviewed proxy on the owned k3d container network, or another
private address reachable from the API and dedicated gateway Pods. Do not use
host loopback as the proxy address: `127.0.0.1` inside a Pod is that Pod. For a
proxy container on the k3d network, no host-published listener is needed. Restrict
its source access to the actual traffic from this cluster, accounting for node
source NAT.

Back up both generated files in the private state directory, then update them:

- `installation.yaml`: set `drivers.compute.configuration.runtime.channels.proxyUrl`
  for gateway Slack messaging.
- `helm-values.json`: set `api.channelDirectoryProxyUrl` for Console user and
  channel lookup. Kubernetes-only mode runs the production API, where lookup
  stays disabled without this setting.

Apply the edits to the existing development release with the commands below.
Use the chart source matching the installed controller, retain its image
references and other protected inputs, and plan a maintenance window if Agents
are running. Confirm the release and namespace; the values below are the
launcher defaults. The checksum rolls the API and worker even when only the
Installation document changed.

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
NODE

kubectl --kubeconfig "$OCC_SLACK_STATE/kubeconfig" --context "$OCC_SLACK_CONTEXT" \
  -n "$OCC_SLACK_NAMESPACE" create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_SLACK_STATE/installation.yaml" \
  --dry-run=client -o yaml | \
  kubectl --kubeconfig "$OCC_SLACK_STATE/kubeconfig" --context "$OCC_SLACK_CONTEXT" \
    -n "$OCC_SLACK_NAMESPACE" apply -f -

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
public browser CA. Import that CA as described in
[Local Setup](../quickstart.md#open-the-platform-console). The browser session
cookie uses a per-installation parent domain; its matching subdomains are part of
the [shared session boundary](../../reference/agent-native-admin.md#shared-session-boundary).
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
publication. The published Service selects a dedicated in-cluster proxy whose
exact Namespace and Pod labels are admitted by the OCE Helm NetworkPolicy. The
OCE API itself remains a ClusterIP Service. OCE's worker authenticates to
Kubernetes in-cluster. When OpenShell is selected, the API, which registers
credential sources, and the worker reach OpenShell Gateway through a narrow
development NetworkPolicy in `oce-system`.

The OpenShell profile declares an `openshell` Backend for the Gateway
endpoint and selects both the OpenShell Sandbox and the
[OpenShell Credential Gateway](../../reference/drivers/openshell-credential-gateway.md),
bound to the runtime image's native Codex executable. Agents in this profile
must authenticate through a [credential source](../../reference/credential-sources.md).
To register a key and bind it to an Agent in this profile, follow
[Use a credential source on the local OpenShell profile](openshell-credential-sources.md).

The OpenShell Gateway uses an unauthenticated development setting. Tenant
egress selects only OpenShell supervisor Pods for Gateway callbacks; do not use
this profile on a shared cluster or container network.

Because this cluster is disposable and owned by one development profile, the
helper binds the chart's tenant worker, configuration, and Secret ClusterRoles
to the OCE service accounts cluster-wide. Production and shared clusters must
use the tenant-local RoleBindings in the production deployment guide.

To verify a fresh Kubernetes-only installation without OpenShell, use the
[real local installation test](../../testing/kubernetes.md#local-kubernetes-installation).

To prove the OpenShell setup and cleanup path in a separate fresh cluster, first
stop the reusable environment and run:

```bash
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The selected real test must pass without a skip. It verifies the Helm-installed
OCE control plane and PostgreSQL Pods, bootstrap and new Namespace Workspace
reconciliation, immutable image registration, and owned-cluster cleanup. It does
not create an Agent or perform a model turn.
Follow the [Kubernetes model-turn procedure](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets)
for that separate credentialed proof.

## Configure workspace storage on single-node k3d

Dedicated Agents use a `40Gi` RWO workspace claim on stock k3d `local-path`
storage. Gateway state uses a separate RWO claim. The worker stops the previous
revision before starting its replacement; expect a downtime window during
deployment.
See [storage ownership and recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).

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

Keep the node's `/var/lib/rancher/k3s` volume (workspace files and K3s state).
Restarts keep it; deleting the cluster, volume, or profile destroys it.
Local-path storage is node-bound; use a portable StorageClass for workloads that
move between nodes.

PostgreSQL is a StatefulSet, and a launcher NetworkPolicy allows egress by its
Pod label and the k3d subnet, so the profile survives `k3d cluster stop`/`start`.

The `local-path` reclaim policy is `Delete`: deleting a claim may delete its
backing directory. PostgreSQL lives in the owned cluster; this does not back up
Agent workspaces. Long-lived demos need a durable private state directory, not
`/tmp`.

## Rebuild after a source edit

The environment registers immutable image digests, so running containers do not
silently pick up source edits. Recreate it after controller, runtime, migration,
Helm, or OpenShell integration changes. Unless an existing controller or runtime
image was selected explicitly, startup rebuilds both images from the current
checkout:

```bash
./scripts/dev-down
./scripts/dev-up
```

This cleanup path discards the owned Installation; it is not an in-place
upgrade. If repository access was enabled, check the
[credential cleanup limitation](local-repository-credentials.md) before
removing the cluster. For a persistent Helm-installed k3d environment, complete the
[upgrade migration checklist](upgrade-checklist.md) and then follow the
[local k3d image upgrade procedure](local-k3d-image-upgrade.md).

## Resolve node DNS failures

If the k3d node cannot resolve image registries, identify a DNS server reachable
from the container engine's node network. Set its IPv4 address for a fresh
startup:

```bash
OCC_DEVELOPMENT_K3D_DNS_RESOLVER='<reachable-dns-ip>' ./scripts/dev-up
```

The launcher uses this resolver inside its owned node and disables k3d's DNS
rewriting for that node. It does not change the host resolver. Leave the setting
unset when the default node resolver works.

## Stop and clean up

If repository access was enabled, first follow the
[credential cleanup guidance](local-repository-credentials.md). The launcher
does not verify repository credential disposal before removing the cluster.
Then remove only the cluster and private state recorded by the launcher:

```bash
./scripts/dev-down
```

Cleanup reads the recorded engine endpoint and cluster name. If cluster deletion
fails, it preserves the state directory so the same command can retry without
discovering or deleting an unrelated cluster.

## Limits

Both local k3d profiles use K3s legacy iptables mode. Kubernetes-only startup
without OpenShell checks policy traffic before configuring gateway proxy trust and again
against the initial Gateway Namespace. These checks establish only the tested
single-node traffic at startup; they do not monitor later policy failures.

Development startup readiness does not prove Agent deployment, model execution,
provider authentication, or dedicated Codex WebSocket execution. OpenShell
startup deliberately proves only its infrastructure and fail-closed boundary.
The [Kubernetes testing guide](../../testing/kubernetes.md) covers those
credentialed real-cluster checks.

## Gateway placement boundary

Dedicated Gateways use a managed Gateway runtime namespace, separate from the
Harness namespace. The local development profile selects its single k3d server
for Gateway scheduling. This exercises namespace separation on one disposable
node; it does not prove production node isolation. Production must configure
`runtime.gatewayNodeSelector` and `runtime.nodeSelector` for disjoint trusted and
data-plane pools. See [production Namespace preparation](production-agents.md#prepare-each-namespace)
for both scoped RoleBindings.

- This is a development environment, not a production deployment recipe.
- The OpenShell profile installs one central Gateway per cluster. OCC runs in
  the cluster and creates tenant resources in separate `oce-*` Namespaces.
- Stock OpenShell `v0.1.0` remains fail-closed for unsupported Secret and
  workload-identity projections. Workspace readiness does not prove that an
  Agent Sandbox can start or complete a model turn.
- OpenShell Gateway permits unauthenticated users only inside this disposable,
  loopback-owned cluster. Do not carry that setting into a shared cluster or
  container network.
- The development-only cluster-wide tenant bindings are not a production RBAC
  pattern. Production admission must supply the tenant-local RoleBindings
  described by the deployment guide.
