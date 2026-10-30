# Select local OpenShell candidate images

Use a fresh [local OpenShell development profile](local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
to validate a reviewed candidate. First build or obtain all three images in the
selected local Docker or Podman engine. Keep an independent build receipt that
maps the OpenShell source tree and full commit, build inputs, Linux platform, and
immutable image digests. The launcher does not build candidate OpenShell images.

Each image needs an engine-resolvable `name@sha256:...` manifest reference. For
Docker, inspect the local image's `RepoDigests`:

```bash
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' <image>
```

Use a returned reference; do not construct one from the image's `Id`. Docker's
classic image store may leave `RepoDigests` empty after a local build. In that
case, prepare the image through an engine that retains named manifest digests,
or publish and pull it through a registry you control before launching. The
launcher does not perform that registry step.

From the repository root, rebuild the CLI and replace every placeholder below
with the reviewed source commit and local image references:

```bash
go build -trimpath -o bin/occ ./cmd/occ
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION='<40 lowercase hex characters>'
export OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE='<gateway-name>@sha256:<64 lowercase hex characters>'
export OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE='<sandbox-name>@sha256:<64 lowercase hex characters>'
export OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE='<supervisor-name>@sha256:<64 lowercase hex characters>'
./scripts/dev-up
```

These selectors also work with the Compose control plane. Supplying any one,
even an empty value, requires all four. Image names may include a tag, but must
end in an exact SHA-256 digest. Before creating state or cluster resources, the
launcher rejects incomplete or malformed selections, unavailable local images,
and images whose `org.opencontainers.image.revision` label differs from the
selected OpenShell commit. That commit identifies OpenShell, not the OCE checkout.
Labels establish consistency, **not build provenance**; verify the build receipt
independently. Candidate images are never pulled or replaced with released
images. If one disappears before import, startup fails and attempts to roll back owned resources. Follow the printed
recovery instructions if rollback is incomplete.

Chart selection remains separate. An image selection does not change the pinned
charts; use the [paired chart overrides](local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
when the reviewed candidate needs matching charts. A chart override alone does
not select candidate images.

## Select the protected profile

The ordinary installer selects stock OpenShell 0.1.6 for the Gateway, supervisor,
sandbox runtime and both charts. No OpenShell candidate selectors are required.
Compute still verifies the current installation before [signing the workload release](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff).
Launching the profile prepares the pair for qualification.

For a fresh Kubernetes control plane, select protected egress explicitly:

```bash
export OCC_DEVELOPMENT_PROTECTED_EGRESS=1
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_DATABASE_NAME=openclaw_k8s_connected
./scripts/dev-up
```

The installer verifies the release source archive and pins all three image digests.
Overrides still require a complete image selection and paired charts.
Before creating the cluster, the launcher renders the chart and checks that the
Gateway configuration registers only `oce-authority`, uses the expected HTTPS
endpoint and audience, and mounts the authority's public CA read-only.
The native `gatewayConfig` registration requires `binding_policy = "allowlist"`
and `bindings = ["http_request_pre_credentials"]`. Missing, dynamic or response-only
registration is refused. The released Gateway and supervisor also reject a service
that does not advertise the required request binding. Runtime policy must attach
this middleware with `on_error: fail_closed`; registration alone does not authorize
or protect a destination. This does not replace repository scope or sender checks.
Compute still verifies the installed capabilities before releasing a workload.

The profile registers the authority, generates its server certificate, and uses
OpenShell's native PKI hook for Gateway server/client certificates and extension
signing keys. Only the API and worker receive the administrative mTLS client key.
The authority receives only the issuer public key.

The launcher installs the Gateway, then installs the OCE API with zero workers so
the Gateway can reach the authority during startup. After it applies tenant access
and network policies and the Gateway rollout succeeds, a Helm upgrade starts one
worker to reconcile the bootstrap Namespace. If a prerequisite fails, the launcher
returns that error and follows its owned-cluster rollback and retained-state recovery
path. A successful rollout does not guarantee that the first reconciliation succeeds.

`OCC_DEVELOPMENT_DATABASE_NAME` is optional. When selected it must match
`openclaw_k8s_[a-z0-9_]+` and be at most 63 characters. The launcher uses it for
database creation, readiness, migration, bootstrap, API and worker connections;
the application still uses the limited `occ_app` role. Unset it to retain the
default `openclaw_enterprise` database on a fresh launch.

This profile is off when `OCC_DEVELOPMENT_PROTECTED_EGRESS` is unset or `0`, and
requires both Kubernetes control plane and OpenShell when enabled. It does not
qualify a model turn or supply a provider fixture. Resolve the separate Agent
Gateway server-trust and fixture prerequisites in
[protected launch verification](../../testing/static-egress.md#protected-launch-packaging)
before running connected tests. If those tests use the native host alias, select
the verified owned private host IPv4 through
`OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP`; reachability and server-certificate
checks remain prerequisites.

## Verify imported identities

Keep the launcher's three `OpenShell <component> image: source=… containerd=…`
lines with the build receipt. The source digest identifies the selected engine
image; containerd may record a different manifest representation after archive
import. The launcher resolves and registers that containerd digest, then supplies
it to exactly `gateway.image`, `sandboxRuntime.image`, and `supervisor.image`
in Helm, with pull policy `Never`. Do not assume source and containerd digests
are equal.

Before runtime qualification, inspect the actual supervisor container's
`imageID` in the Agent-owned Pod using the printed kubeconfig and context.
Check both `status.containerStatuses` and `status.initContainerStatuses`, and
resolve the recorded identity through the node's containerd inventory to the
imported supervisor and build receipt. Helm values alone do not prove which
image ran. Launcher success does not prove a model turn or end-to-end Agent
execution; follow the [OpenShell verification procedures](../../testing/openshell.md).

For invalid or missing candidates, correct the selectors or prepare the missing
local images and retry. Follow any printed cleanup instruction if startup
retains state. To return to released defaults on the next fresh start, **unset**
all four candidate selectors; assigning empty values is an error.

## Trust an upstream CA on local k3d

On a network that intercepts HTTPS, OpenShell's separate supervisor needs the approved upstream CA to connect to GitHub and the model provider. On the Docker-backed Linux k3d profile, apply this change after installation and before deploying the first Agent. Keep the published OCE controller and runtime. Only the supervisor image changes.

Set `CA_BUNDLE` to a PEM file containing the usual public roots and the network's approved public root, without private keys. Use the generated kubeconfig, context, and release for this installation. Use the supervisor and chart from the selected release checkout. Run from its repository root:

```bash
set -euo pipefail
umask 077
# Use only the cluster recorded by this quickstart.
state=${OCC_DEVELOPMENT_STATE_DIRECTORY:?}
cluster=$(jq -er .cluster "$state/state.json")
context="k3d-$cluster"
ns=$(jq -er .platformNamespace "$state/state.json")
export KUBECONFIG="$state/kubeconfig"
test "$(kubectl config current-context)" = "$context"
# Build the supervisor with the approved public trust bundle in an otherwise empty directory.
dir=$(mktemp -d)
cp "${CA_BUNDLE:?Supply the approved public CA bundle}" "$dir/ca-certificates.crt"
# Read the upstream digest from the same checkout as the launcher.
supervisor=$(sed -nE 's/^[[:space:]]*openShellSupervisorImage[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' internal/occdev/openshell.go)
[[ $supervisor =~ ^ghcr.io/nvidia/openshell/supervisor:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[a-f0-9]{64}$ ]]
version=${BASH_REMATCH[1]}
cat > "$dir/Dockerfile" <<DOCKERFILE
FROM $supervisor
COPY --chmod=0644 ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
DOCKERFILE
repo=docker.io/openclaw-development/openshell-supervisor
tag="$repo:local-ca-$(date +%s)"
docker build -t "$tag" "$dir"
node="k3d-$cluster-server-0"
# Import the image and read back the manifest digest actually stored on this node.
docker save "$tag" | docker exec -i "$node" ctr -n k8s.io images import -
digest=$(docker exec "$node" ctr -n k8s.io images ls | awk -v tag="$tag" '$1==tag {print $3}')
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
docker exec "$node" ctr -n k8s.io images tag "$tag" "$repo@$digest"
# Reload only the OpenShell Gateway Helm release with the verified supervisor digest.
helm --kube-context "$context" -n "$ns" get values openshell-gateway -o json > "$dir/values.json"
helm --kube-context "$context" -n "$ns" upgrade openshell-gateway \
  "$state/openshell/chart/helm-chart-$version.tgz" -f "$dir/values.json" \
  --set-string supervisor.image.registry=docker.io \
  --set-string supervisor.image.repository=openclaw-development/openshell-supervisor \
  --set-string supervisor.image.digest="$digest" --wait
```

Check the supervisor Pod's image ID against the imported manifest. Keep the Sandbox's injected Git CA and TLS verification enabled.

If installation stalls while pulling the Agent Sandbox controller, check the `agent-sandbox-system` Pod events with the new cluster's kubeconfig. When the host can pull the required image but the node cannot, import that exact image from another terminal while the launcher waits:

```bash
# Use only the cluster recorded by this quickstart.
state=${OCC_DEVELOPMENT_STATE_DIRECTORY:?}
cluster=$(jq -er .cluster "$state/state.json")
node="k3d-$cluster-server-0"
image=$(kubectl --kubeconfig "$state/kubeconfig" --context "k3d-$cluster" \
  -n agent-sandbox-system get deployment agent-sandbox-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
docker pull "$image"
docker save "$image" | docker exec -i "$node" ctr -n k8s.io images import -
```
