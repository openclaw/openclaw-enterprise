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

Use a reviewed Kubernetes Compute and OpenShell candidate pair. The bundled
OpenShell release cannot enforce this profile. In the candidate, Compute verifies
the current installation before [signing the workload release](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff).
Launching the profile prepares the pair for qualification.

For a fresh Kubernetes control plane with a matching protected-inference
candidate, set the image selectors above without starting the stack, then add:

```bash
export OCC_DEVELOPMENT_PROTECTED_EGRESS=1
export OCC_DEVELOPMENT_CONTROLLER_IMAGE='<reviewed-controller-image>'
export OCC_KUBERNETES_RUNTIME_IMAGE='<reviewed-runtime-image>'
export OCC_DEVELOPMENT_OPENSHELL_HELM_CHART='<absolute-gateway-chart-directory>'
export OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART='<absolute-workspace-chart-directory>'
export OCC_DEVELOPMENT_DATABASE_NAME=openclaw_k8s_connected
./scripts/dev-up
```

OpenShell can version its runtime and Gateway chart separately. Pin both reviewed
revisions. A chart can accept `supervisor.middleware` values and silently ignore them.
Before creating the cluster, the launcher renders the selected chart and checks that
the Gateway configuration registers only `oce-authority`, uses the expected HTTPS
endpoint and audience, and mounts the authority's public CA read-only.
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
