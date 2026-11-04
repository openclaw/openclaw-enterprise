---
tags: [human_verified]
---

# Set up OCE locally with OpenShell and Codex

Install OpenClaw Enterprise (OCE) in a private k3d cluster.

After installation, [deploy your first Agent](deploy-first-agent.md).

## Before you start

- Install the [local Kubernetes tools on Linux](local-kubernetes-tools.md). Use Bash, curl and jq.
- Use the generated OCE service key for REST and the [private Gateway routing key and CA](workspace-routing.md) for WebSocket access. Keep credential files outside the checkout with owner-only permissions.
- The operator needs permission to create Namespace Secrets, CredentialSources, Configurations, Agents, roles and bindings, and to update and operate the Agent.

Set the model ID your credential can use. Choose the credential when you deploy the Agent.

```bash
export MODEL=gpt-5.4
```

## 1. Prepare the quickstart files and select a matching release

Start in Bash at the root of the checkout containing this guide. Copy the files to a private directory before switching to the matching release checkout. The [WebSocket client](../../assets/openshell-quickstart/chat.mjs) supports capability verification after browser onboarding.

```bash
set -euo pipefail
set +x
umask 077

# Keep this run's files, credentials and kubeconfig separate from earlier installations.
run_root=${XDG_STATE_HOME:-$HOME/.local/state}/oce
install -d -m 700 "$run_root"
RUN_DIR=$(mktemp -d "$run_root/openshell.XXXXXXXX")
printf 'Private session directory: %s\n' "$RUN_DIR"

# Stage the network policy for cluster startup and the configuration script for the Helm reload.
install -m 600 docs/snippets/openshell-quickstart/plugin-network-policy.yaml "$RUN_DIR/artifacts.yaml"
install -m 600 docs/snippets/openshell-quickstart/configure-installation.mjs "$RUN_DIR/configure-installation.mjs"

source docs/snippets/openshell-quickstart/stage-session.sh
```

For published images, select a matching channel pair:

```bash
export OCE_IMAGE_CHANNEL=stable
docker pull ghcr.io/openclaw/openclaw-enterprise-controller:stable
docker pull ghcr.io/openclaw/openclaw-enterprise-runtime:stable
```

For repository bindings, verify that the pair's publication receipt identifies source with `deploy/examples/repository-credentials/openshell.registry.json` and OpenShell 0.1.6. A channel tag alone does not prove support. For a source build, use the [matched image build procedure](production-installation.md#build-and-publish-production-images) and supply both immutable references.

For published images, complete [published image selection](published-images.md), export `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`, and switch to the matching source. For local source development, leave both variables and both image selectors unset; the launcher builds the pair from the checkout. Retain its imported digests and source commit. Check the pinned Codex paths and package hosts for the selected release.

## 2. Start a new k3d installation

Choose unused local ports for the OCE API, HTTPS Console and Kubernetes API. The launcher creates `k3d-state` under the new run directory. To repeat the exercise on a host with a previous disposable installation, first [remove only that installation](local-cleanup.md).

The [plugin network policy](../../snippets/openshell-quickstart/plugin-network-policy.yaml), copied to `$RUN_DIR/artifacts.yaml`, grants the two pinned Codex binaries read-only HTTPS access to the listed package hosts.

<Snippet file="../../snippets/openshell-quickstart/plugin-network-policy.yaml" lang="yaml" />

```bash
# Select an isolated state directory and the Kubernetes-only OpenShell profile.
export OCC_DEVELOPMENT_STATE_DIRECTORY="$RUN_DIR/k3d-state"
export OPENCLAW_DEV_PORT=3012 OCC_DEVELOPMENT_BROWSER_PORT=8443 OCC_DEVELOPMENT_KUBERNETES_API_PORT=6455
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
# Static-inference enforcement is a separate, optional profile.
unset OCC_DEVELOPMENT_PROTECTED_EGRESS
# Select both published images, or let the launcher build both from source.
if [[ -n ${CONTROLLER_IMAGE:-} || -n ${RUNTIME_IMAGE:-} ]]; then
  export OCC_DEVELOPMENT_CONTROLLER_IMAGE="${CONTROLLER_IMAGE:?}"
  export OCC_KUBERNETES_RUNTIME_IMAGE="${RUNTIME_IMAGE:?}"
else
  unset OCC_DEVELOPMENT_CONTROLLER_IMAGE OCC_KUBERNETES_RUNTIME_IMAGE
fi

# If the configured pnpm store is read-only, first select a private writable store:
# export pnpm_config_store_dir="$RUN_DIR/pnpm-store"
# Build the CLI from the matching source and wait for k3d bootstrap.
pnpm install --frozen-lockfile
go build -trimpath -o bin/occ ./cmd/occ
./bin/occ dev up --sandbox-network-policy-file "$RUN_DIR/artifacts.yaml"
```

The launcher enables Gateway TLS, mTLS and authentication before startup. Wait for `OpenClaw Enterprise development stack is ready`. Record the printed API URL, Kubernetes context and cleanup command. With the example ports the REST base is `http://127.0.0.1:3012`. Open the printed Console origin at `/console/`; its Agents page is `/console/agents`. For HTTPS, [trust its browser CA and forward its port](../operate/troubleshooting.md#open-the-console-from-another-machine).

## 3. Configure Credential Gateway

Run this from the matching release checkout. The configuration script removes the generated `source-control` rule that gives Git uninspected access to `github.com:443`. It keeps the other rules and selects the curated Codex plugin catalog. Git access requires an explicit repository binding and its authorized installation profile.

Initialize the shell variables for this installation:

```bash
state=$OCC_DEVELOPMENT_STATE_DIRECTORY
export KUBECONFIG="$state/kubeconfig"
CONTEXT="k3d-$(jq -er .cluster "$state/state.json")"
PLATFORM_NS=$(jq -er .platformNamespace "$state/state.json")
test "$(kubectl config current-context)" = "$CONTEXT"
```

The configuration script selects the plugin catalog and package network policy, but does not enable a plugin on the Agent. Do that in Add Plugin.

The [configuration script](../../snippets/openshell-quickstart/configure-installation.mjs) checks that the generated rule matches the expected settings before changing it.

<Snippet file="../../snippets/openshell-quickstart/configure-installation.mjs" lang="javascript" />

```bash
# Edit the fresh installation.yaml once, before provisioning Agents.
node "$RUN_DIR/configure-installation.mjs"
```

Reload the edited file through Helm. Use a new Secret name for each change. Helm rolls the API and worker when the referenced name changes. Wait for both deployments before provisioning the Agent.

```bash
# Verify the generated kubeconfig targets this run before changing the release.
state=$OCC_DEVELOPMENT_STATE_DIRECTORY
export KUBECONFIG="$state/kubeconfig"
CONTEXT="k3d-$(jq -er .cluster "$state/state.json")"
PLATFORM_NS=$(jq -er .platformNamespace "$state/state.json")
test "$(kubectl config current-context)" = "$CONTEXT"

# Point Helm at a new, versioned Secret so that the API and worker reload the changes.
secret="oce-openshell-codex-$(date +%s)"
kubectl --context "$CONTEXT" -n "$PLATFORM_NS" create secret generic "$secret" \
  --from-file="installation.yaml=$state/installation.yaml"
helm --kube-context "$CONTEXT" upgrade openclaw-enterprise deploy/helm/openclaw-enterprise \
  -n "$PLATFORM_NS" -f "$state/helm-values.json" --set-string installation.secretName="$secret" --wait
```

If your network intercepts HTTPS, [install its approved public CA in the OpenShell supervisor](local-openshell-images.md#trust-an-upstream-ca-on-local-k3d).

## 4. Prepare the operator session

Set the common operator session inputs. REST paths are relative to the API root; the helper sends authenticated requests through the selected API Pod. It does not use the browser URL for API authentication.

```bash
PLATFORM=local-k3d
RELEASE=openclaw-enterprise
OCE_CHART="$(pwd)/deploy/helm/openclaw-enterprise"
INSTALLATION_FILE="$RUN_DIR/installation.yaml"
install -m 600 "$state/installation.yaml" "$INSTALLATION_FILE"
VALUES_FILE="$RUN_DIR/values.json"
helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" \
  get values "$RELEASE" -o json > "$VALUES_FILE"
OCC_SERVICE_KEY_FILE="$RUN_DIR/service-key.json"
install -m 600 "$(jq -er .keyPath "$state/state.json")" "$OCC_SERVICE_KEY_FILE"
CONSOLE_ORIGIN=$(jq -er .browserOrigin "$state/state.json")
NATIVE_ADMIN_DOMAIN=$(jq -er .nativeAdminDomain "$state/state.json")
# The local launcher supplies the cluster policies. No extra CNI service rules are needed.
cat > "$RUN_DIR/platform.sh" <<'SH'
deployment_preflight() { :; }
deployment_network() { :; }
repository_network() { :; }
SH
source "$RUN_DIR/operator-session.sh"
source "$RUN_DIR/platform.sh"
namespace=$(request GET /namespaces | jq -er '[.data[]|select(.name=="default" and .status=="ready")]|select(length==1)|first.id')
base="/namespaces/$namespace"
TENANT_NAMESPACE=$(kube get ns -l "openclaw.dev/namespace=$namespace" -o json |
  jq -er '[.items[]]|select(length==1)|first.metadata.name')
```

The [operator session reference](quickstart-session.md) defines these inputs and helpers. Keep tracing off. If a mutation times out, read back its state before retrying.

Continue in the same Bash shell to [Deploy your first Agent](deploy-first-agent.md).

To finish, [delete the Agent](quickstart-delete-agent.md), then [clean up this installation](local-cleanup.md).
