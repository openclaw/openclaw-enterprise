# Run a dedicated Codex Agent in OpenSandbox

Deploy a dedicated Agent on disposable k3d. Send a message and check that
a workspace file survives replacement. The example Sandbox Driver creates
one `BatchSandbox` per revision. The OpenSandbox operator starts its Codex
Harness Pod. Kubernetes Compute manages the Gateway, routing, and workspace claim.

**Use only the local model fixture.** The Harness can read its API-key
Secret. Supply the fixture's temporary bearer. This development example
rejects protected credentials, repository bindings, and initial workspace files.

## Install the operator on a disposable cluster

Follow the [k3d fixture setup](../../../docs/testing/kubernetes.md#kubernetes-http-fixture).
Use one node, a loopback API address, a separate kubeconfig, enforcing
NetworkPolicies, and a fresh PostgreSQL database. [Import the runtime image](../../../docs/testing/kubernetes.md#run-the-real-runtime-suite-directly)
by digest.

The operator has cluster-wide workload permissions. Keep other workloads
off the cluster. The OpenClaw Enterprise (OCE) fixture requires Kubernetes
1.35 or later. [OpenSandbox 1.3.0-rc.3](https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.3.0-rc.3)
lists versions 1.22 through 1.34. The pilot ran on 1.35.8+k3s1, outside
that range.

Set `opensandbox_source` to a clean OpenSandbox checkout, `trial_kubeconfig`
to the private kubeconfig, and `trial_context` to its disposable context.
Render the pinned charts with Helm.

```bash
set -e
umask 077
render_dir="$(mktemp -d)"
controller_pin=release-1.3.0-rc.3@sha256:ad0ed9ded0fa7ba6da5ddb17f3dcddb87ace4f2f70eabef4a57669eff781ba51
committer_pin=docker.io/opensandbox/image-committer@sha256:42ff0af145743946eef5eac13d4a90e3c6f4f27845ce56d860c164c5f226f758

test "$(git -C "$opensandbox_source" rev-parse HEAD)" = d098823411816e73381cfedc7d10429e55bf5b31
test -z "$(git -C "$opensandbox_source" status --porcelain)"
KUBECONFIG=/dev/null helm template opensandbox-base "$opensandbox_source/manifests/charts/base" \
  --namespace opensandbox-system --set crds.keep=false --set rbac.create=false \
  --set fastSandbox.crds.install=false --set fastSandbox.namespaces.create=false \
  --set fastSandbox.namespaces.createSystem=false --set fastSandbox.rbac.create=false \
  > "$render_dir/crds.yaml"
KUBECONFIG=/dev/null helm template opensandbox-controller \
  "$opensandbox_source/manifests/charts/controller" --namespace opensandbox-system \
  --set-string controller.image.repository=docker.io/opensandbox/controller \
  --set-string "controller.image.tag=$controller_pin" \
  --set-string "controller.snapshot.imageCommitterImage=$committer_pin" \
  > "$render_dir/controller.yaml"
```

Review both manifests. Stop if rendering fails. The node must pull the pinned
controller image or have the same digest imported and registered in k3s.

```bash
trial_kubectl() {
  kubectl --kubeconfig "$trial_kubeconfig" --context "$trial_context" "$@"
}
trial_kubectl create namespace opensandbox-system
trial_kubectl apply -f "$render_dir/crds.yaml"
trial_kubectl wait --for=condition=Established --timeout=60s -f "$render_dir/crds.yaml"
trial_kubectl apply -f "$render_dir/controller.yaml"
trial_kubectl -n opensandbox-system rollout status \
  deployment/opensandbox-controller-manager --timeout=120s
```

Verify the running image digest before continuing.

## Build and stage the local Driver package

Build from a trusted OCE checkout. The API and worker load the Driver in
process. Link the same control plane and utility packages so they recognize
Driver errors.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --project deploy/examples/opensandbox/driver/tsconfig.json

umask 077
package_root="$(mktemp -d)"
scope="$package_root/node_modules/@openclaw-enterprise"
package="$scope/opensandbox-driver"
mkdir -p "$package"
printf '%s\n' '{"type":"module","dependencies":{"@openclaw-enterprise/opensandbox-driver":"0.1.0"}}' \
  > "$package_root/package.json"
cp deploy/examples/opensandbox/driver/package.json "$package/"
cp -R deploy/examples/opensandbox/driver/dist "$package/"
ln -s "$PWD/packages/occ" "$scope/occ"
ln -s "$PWD/packages/utils" "$scope/utils"
```

The test selects the staged package in the [Installation settings](../../../docs/reference/drivers/selection.md).

```yaml
drivers:
  sandbox:
    id: opensandbox
    package: "@openclaw-enterprise/opensandbox-driver"
    configuration: {}
```

The test sets `modelSenderCaPem` to the fixture's public CA certificate.
Keep its private key on the host. Before running workspace-write tools,
[check the Codex sandbox](../../../docs/guides/deploy/codex-sandbox.md).
The pilot node failed with both the default and the optional node-local
`codexSeccompProfile`. Keep Pod Security set to `restricted`.

The test uses the disposable kubeconfig. It does not test an installed
worker's permissions. The [example Role and RoleBinding](tenant-worker.yaml)
add tenant access to get, list, create, and delete `BatchSandbox` resources.
Set `TENANT_NAMESPACE` and `INSTALLATION_NAMESPACE` to the tenant and worker
namespaces before applying them alongside the tenant worker role.

## Run the Agent integration test

Set up [private Gateway routing](../../../docs/guides/deploy/workspace-routing.md#requirements).
The host worker and tenant Harness must reach the Gateway. Check its TLS
port, proxy source CIDRs, and public CA. Scope any DNS override to the test
process and Gateway hostname.

In a second terminal, start the [local model fixture](../../../tests/fixtures/opensandbox-model.ts)
from the OCE repository root. It requires Node.js 24 and OpenSSL. Set
`trial_bridge_ip` to an RFC 1918 IPv4 address on the host bridge that the
Harness can reach. Restrict access to the test cluster. Set `trial_model`
to the Harness model ID without a provider prefix.

```bash
env -i PATH="$PATH" node tests/fixtures/opensandbox-model.ts \
  --bind-host "$trial_bridge_ip" --model "$trial_model"
```

In the first terminal, set `model_env` to the path the fixture prints.
Keep the file private. It contains the temporary bearer and connection
settings. The fixture stops after 15 minutes.

The Driver permits the selected Pod to reach the fixture's IP address and
TCP port, plus cluster DNS for enrollment. NetworkPolicies are additive.
Keep default deny and restrict writes to policies, Pod labels, ownership
records, and Service selectors.

Set `trial_env` to a trusted mode-600 shell file with these settings.

| Setting                                                         | Value                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_KUBERNETES_KUBECONFIG`, `OCC_TEST_KUBERNETES_CONTEXT` | The disposable cluster kubeconfig and explicit context.                                                                                                                                                    |
| `OCC_TEST_DATABASE_URL`                                         | A fresh migrated `openclaw_k8s_*` database using the application role.                                                                                                                                     |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`                             | The imported OCE runtime image with its digest.                                                                                                                                                            |
| `OCC_TEST_OPENSANDBOX_PACKAGE_ROOT`                             | The staged `package_root` directory.                                                                                                                                                                       |
| `OCC_TEST_OPENSANDBOX_ROUTING_FILE`                             | A JSON file with `gatewayRouting` and `gatewayTrustedProxyCidrs`. Include `gatewayName`, `gatewayNamespace`, `envoyNamespace`, `hostname`, `endpointPort`, and `envoyHttpsTargetPort` in `gatewayRouting`. |
| `OCC_GATEWAY_API_KEY_PATH`, `NODE_EXTRA_CA_CERTS`               | The private Gateway service-key file and public Gateway CA file.                                                                                                                                           |
| `OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE`                     | Optional verified node-local Codex profile.                                                                                                                                                                |

Run from the OCE repository root. Node reads the Gateway CA at startup.

```bash
(
  set -a
  source "$trial_env"
  source "$model_env"
  set +a
  unset OPENAI_API_KEY GITHUB_TOKEN GH_TOKEN
  OCC_TEST_OPENSANDBOX_K3D_REAL=1 node --test tests/integration/opensandbox-k3d-real.test.ts
)
```

Require one pass and zero skips. Check the following results.

- After the first create reply is lost, the Driver finds the original
  `BatchSandbox`. Compute refuses to finish activation when the Ready Pod's
  controller changes. The worker recovers after the original owner returns.
- Codex refuses missing or incorrect transport credentials. The Agent
  replies through the local fixture. The Harness cannot connect to the
  test listener.
- After a lost delete reply, replacement waits for the old Pod to disappear.
  The same workspace file survives replacement and a stop and redeploy.
- Agent deletion removes the workspace claim and leaves an unrelated
  `BatchSandbox` intact. Repeated Namespace cleanup leaves a replacement
  untouched if the allocation record lacks the original controller UID.

If creation stops before the Driver records that UID, cleanup cannot establish
ownership. Reconcile the original deployment so the Driver can verify the
admitted template. If that is impossible, inspect the workload and allocation
record before removing the disposable cluster. Never assign a UID by hand.

On success or failure, press Ctrl+C in the fixture terminal. The fixture
removes its settings and certificate files. Follow the cleanup steps for
your database and cluster. Confirm the resources and listeners are gone
before removing the private files, `package_root`, and `render_dir`.
