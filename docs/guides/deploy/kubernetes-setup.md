---
tags: [human_verified, nolimit]
---

# Set up an OpenShell Codex Agent on Kubernetes

Install OpenClaw Enterprise (OCE) and onboard a dedicated OpenShell Codex Agent on an existing Kubernetes cluster.

[Create your first Agent](#5-create-the-configuration-and-agent) after installation.

## Before you start

<Snippet file="../../snippets/kubernetes-prerequisites.md" />

Label separate pools `oce-role=control` and `oce-role=agents`. Use encrypted RWO storage with `WaitForFirstConsumer`.

Install the matching Agent Sandbox controller and a `runc` RuntimeClass named `openshell-sandbox`. Verify the [OpenShell kernel and isolation requirements](../../reference/drivers/openshell-sandbox.md#qualification-contract) and restricted tenant Pod Security.

Use a fresh database and keep credential files private.

## 1. Prepare the cluster and images

From the matching checkout, [select images](published-images.md) as `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`.

```bash
set -euo pipefail
set +x
umask 077
run_root=${XDG_STATE_HOME:-$HOME/.local/state}/oce
install -d -m 700 "$run_root"
RUN_DIR=$(mktemp -d "$run_root/kubernetes.XXXXXXXX")
source docs/snippets/openshell-quickstart/stage-session.sh
cp -R docs/snippets/openshell-quickstart/kubernetes "$RUN_DIR/kubernetes"
install -m 600 docs/snippets/openshell-quickstart/platform-kubernetes.sh "$RUN_DIR/platform.sh"
PLATFORM=kubernetes
RELEASE=oce
export PLATFORM_NS=oce-system
export CLUSTER_NAME='<lowercase cluster name>'
export STORAGE_CLASS='<encrypted RWO StorageClass>'
export KUBECONFIG="$RUN_DIR/kubeconfig"
export CONTEXT='<approved cluster context>'
# Copy your administrator-provided kubeconfig, not the default kubeconfig.
install -m 600 /secure/oce/kubeconfig "$KUBECONFIG"
# Select the context only in this private copy.
kubectl --kubeconfig "$KUBECONFIG" config use-context "$CONTEXT"
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" get nodes -L oce-role
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" get storageclass "$STORAGE_CLASS"
```

Set `OCE_CHART` to the matching absolute chart directory/archive and `OPENSHELL_CHART` to stock OpenShell 0.1.6. Set `SANDBOX_REGISTRY` and `SANDBOX_REPOSITORY` to the registry holding its stock AMD64 Gateway, supervisor and runtime manifests. Verify compatibility with the templates’ OpenShell 0.1.6 and Codex 0.164.0.

Set `ENVOY_IMAGE` to the qualified immutable proxy image and `ADMIN_EMAIL` to the owner’s email. Set `DATABASE_CIDRS` and `API_CIDRS` to approved IPv4 JSON arrays, including the API Service VIP and endpoint /32s.

Create `oce-system`. Allow system Pods’ required DNS, control and Service VIP paths before rollout. Register or verify the GatewayClass:

```bash
class_json=$(kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" get gatewayclass eg --ignore-not-found -o json)
if [[ -z $class_json ]]; then
  kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" create -f - <<'YAML'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
YAML
fi
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" get gatewayclass eg -o json |
  jq -e '.spec.controllerName=="gateway.envoyproxy.io/gatewayclass-controller"'
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" wait gatewayclass/eg --for=condition=Accepted --timeout=3m
```

<Snippet file="../../snippets/openshell-quickstart/cluster-installation.md" />

## 4. Connect to the API and register the model credential

Set `CODEX_TOKEN_FILE` to the private service-account PAT file and `MODEL` to the authorized native model ID. A Linear connection and GitHub App are not needed for installation setup. See the [operator session](quickstart-session.md).

```bash
export CODEX_TOKEN_FILE=/secure/oce/codex-token
export MODEL=gpt-5.4
test -r "$CODEX_TOKEN_FILE" && test -s "$CODEX_TOKEN_FILE"
```

<Snippet file="../../snippets/openshell-quickstart/agent-setup.md" />

Continue to [Add Git](../repository-credentials/openshell-git-push.md) or [Add Plugin](../integrations/codex-plugins.md). To finish, [delete the Agent](quickstart-delete-agent.md), then clean up the installation with [Kubernetes cleanup](kubernetes-cleanup.md).
