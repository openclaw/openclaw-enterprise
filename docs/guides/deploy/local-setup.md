---
tags: [human_verified]
# Backfilled from the verification tag recorded in e22f558c0.
last_verified: "2026-11-02"
---

# Set up OCE locally with OpenShell and Codex

Install OpenClaw Enterprise (OCE) in a private k3d cluster.

## Before you start

- [Prepare your Linux host](local-kubernetes-tools.md). Check that your operator account can use Docker, pnpm and the Kubernetes tools.
- Use an operator account with permission to create Namespace Secrets, CredentialSources, Configurations, Agents, roles and bindings, and to update and operate the Agent.

## 1. Prepare the quickstart files and select a matching release

At the root of the OCE checkout, start a child Bash shell. Run the remaining blocks there. A failed command stops setup and returns you to your original terminal. Keep the printed run directory for recovery.

```bash
bash --noprofile --norc
```

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
install -m 600 docs/snippets/openshell-quickstart/plugin-network-policy.yaml "${RUN_DIR:?}/artifacts.yaml"
install -m 600 docs/snippets/openshell-quickstart/configure-installation.mjs "$RUN_DIR/configure-installation.mjs"
source docs/snippets/openshell-quickstart/stage-session.sh
```

Choose one image path before starting the cluster.

**Build from this checkout.** Clear any previous image selection. The launcher builds and imports both images from your checkout.

```bash
unset OCC_DEVELOPMENT_CONTROLLER_IMAGE OCC_KUBERNETES_RUNTIME_IMAGE
```

**Use published images.** Follow [published image selection](published-images.md) to verify the publication receipt and switch to its source commit. In the same shell, select the verified images:

```bash
export OCC_DEVELOPMENT_CONTROLLER_IMAGE="${CONTROLLER_IMAGE:?Select the published controller}"
export OCC_KUBERNETES_RUNTIME_IMAGE="${RUNTIME_IMAGE:?Select the published runtime}"
```

## 2. Start a new k3d installation

Choose unused local ports for the OCE API, HTTPS Console and Kubernetes API. The launcher creates `k3d-state` under the new run directory. To repeat the exercise on a host with a previous disposable installation, first [remove only that installation](local-cleanup.md).

If you build from source and your network inspects HTTPS, [configure the proxy CA for source builds](../operate/troubleshooting.md#source-build-fails-tls-certificate-verification) before running `occ dev up`.

The [plugin network policy](../../snippets/openshell-quickstart/plugin-network-policy.yaml), copied to `$RUN_DIR/artifacts.yaml`, grants the two pinned Codex binaries read-only HTTPS access to the listed package hosts.

```bash
# Select an isolated state directory and the Kubernetes-only OpenShell profile.
export OCC_DEVELOPMENT_STATE_DIRECTORY="$RUN_DIR/k3d-state"
export OPENCLAW_DEV_PORT=3012 OCC_DEVELOPMENT_BROWSER_PORT=8443 OCC_DEVELOPMENT_KUBERNETES_API_PORT=6455
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
# Static-inference enforcement is a separate, optional profile.
unset OCC_DEVELOPMENT_PROTECTED_EGRESS
# Build the CLI from the matching source and wait for k3d bootstrap.
pnpm install --frozen-lockfile
go build -trimpath -o bin/occ ./cmd/occ
./bin/occ dev up --sandbox-network-policy-file "$RUN_DIR/artifacts.yaml"
```

[pnpm reports a read-only store?](../operate/local-setup-troubleshooting.md#pnpm-reports-a-read-only-store)

The launcher enables Gateway TLS, mTLS and authentication before startup. Wait for `OpenClaw Enterprise development stack is ready`. Record the printed API URL, Kubernetes context and cleanup command. With the example ports the REST base is `http://127.0.0.1:3012`. Open the printed Console origin at `/console/`; its Agents page is `/console/agents`. [Trust the local Console CA](../operate/troubleshooting.md#the-local-console-reports-a-certificate-error). If your browser runs on another machine, [forward the Console port](../operate/troubleshooting.md#open-the-console-from-another-machine).

## 3. Configure Credential Gateway

Run this from the matching release checkout. The configuration script removes the generated `source-control` rule that gives Git uninspected access to `github.com:443`. It keeps the other rules and selects the curated Codex plugin catalog. Git access requires an explicit repository binding and its authorized installation profile.

The [configuration script](../../snippets/openshell-quickstart/configure-installation.mjs) checks that the generated rule matches the expected settings before changing it.

```bash
# Edit the fresh installation.yaml once, before provisioning Agents.
node "$RUN_DIR/configure-installation.mjs"
```

Step 4 reloads this edit through the authenticated operator session, preserving the
startup Secret and its Installation identity. Exclude other release and initialization writers
through rollout; see [update and recovery](quickstart-session.md#update-and-recover-the-installation).
Finish that step before provisioning an Agent.

[Helm warned that `api.trustedProxy` is unset?](../operate/local-setup-troubleshooting.md#helm-warns-that-apitrustedproxy-is-unset)

If your network intercepts HTTPS, [install its approved public CA in the OpenShell supervisor](local-openshell-images.md#trust-an-upstream-ca-on-local-k3d).

## 4. Prepare the operator session

Use the service key that the launcher generated for REST requests. The helper sends requests through the selected API Pod. Keep the key in the private run directory.

```bash
state=$OCC_DEVELOPMENT_STATE_DIRECTORY
export KUBECONFIG="$state/kubeconfig"
CONTEXT="k3d-$(jq -er .cluster "$state/state.json")"
PLATFORM_NS=$(jq -er .platformNamespace "$state/state.json")
test "$(kubectl config current-context)" = "$CONTEXT"
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
upgrade_installation
namespace=$(request GET /namespaces | jq -er '[.data[]|select(.name=="default" and .status=="ready")]|select(length==1)|first.id')
base="/namespaces/$namespace"
TENANT_NAMESPACE=$(kube get ns -l "openclaw.dev/namespace=$namespace" -o json |
  jq -er '[.items[]]|select(length==1)|first.metadata.name')
save_session
```

The [operator session reference](quickstart-session.md) defines these inputs and helpers. Keep tracing off. If a mutation times out, read back its state before retrying.

Continue in the same Bash shell to [Deploy your first Agent](deploy-first-agent.md).

To finish, [delete the Agent](quickstart-delete-agent.md), then [clean up this installation](local-cleanup.md).
