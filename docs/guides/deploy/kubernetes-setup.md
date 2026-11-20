---
tags: [human_verified]
# Backfilled from the verification tag recorded in a66a9cdfd.
last_verified: "2026-11-02"
---

# Set up OCE on Kubernetes

Install OpenClaw Enterprise (OCE) with OpenShell on an existing Kubernetes cluster for development and evaluation. [OpenShell production qualification remains incomplete](../../reference/drivers/openshell-sandbox.md#remaining-qualification-work).

## Before you start

<Snippet file="../../snippets/kubernetes-prerequisites.md" />

Use separate pools (`oce-role=control`, `oce-role=agents`) and encrypted RWO storage with `WaitForFirstConsumer`.

Install Agent Sandbox; verify [kernel/isolation requirements](../../reference/drivers/openshell-sandbox.md#qualification-contract) and restricted tenant Pod Security. OCE configures no RuntimeClass or admission exemption.

Use a fresh application database.

## 1. Prepare the cluster and images

[Select `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`](published-images.md) from the matching checkout.

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

| Input                                    | Value                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `OCE_CHART`                              | Matching absolute chart directory/archive.                                     |
| `OPENSHELL_CHART`                        | Stock 0.1.9.                                                                   |
| `SANDBOX_REGISTRY`, `SANDBOX_REPOSITORY` | Registry/repository for stock AMD64 Gateway, supervisor and runtime manifests. |
| `ENVOY_IMAGE`                            | Qualified immutable proxy image.                                               |
| `ADMIN_EMAIL`                            | Owner’s email.                                                                 |
| `DATABASE_CIDRS`, `API_CIDRS`            | Approved IPv4 JSON arrays, including API Service VIP and endpoint /32s.        |

Match templates: OpenShell 0.1.9, Codex 0.164.0.

<a id="openshell-gateway-upgrade-recovery"></a>

**Before upgrading an OpenShell Gateway from 0.1.8 to 0.1.9, stop Gateway writes and back up its database.** For the default encrypted database credential store, also secure a backup of its key-encryption key. [Credential storage](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/deploy/helm/openshell/README.md#credential-storage)

Version 0.1.9 applies migration 10. The 0.1.8 Gateway refuses to open the migrated database. To return to 0.1.8, stop the 0.1.9 Gateway, restore the pre-upgrade database and its matching key if used, then start 0.1.8. Restoration discards Gateway database writes made after the backup. [SQLite migration](https://github.com/NVIDIA/OpenShell/blob/v0.1.9/crates/openshell-server/migrations/sqlite/010_add_mutation_admission_expiry_index.sql) · [PostgreSQL migration](https://github.com/NVIDIA/OpenShell/blob/v0.1.9/crates/openshell-server/migrations/postgres/010_add_mutation_admission_expiry_index.sql)

Create `oce-system`; allow system Pods’ required DNS, control and Service VIP paths before rollout. Register or verify GatewayClass:

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

## 4. Prepare the operator session

In the same Bash shell, [deploy your first Agent](deploy-first-agent.md).

When finished, [delete the Agent](quickstart-delete-agent.md), then [clean up the installation](kubernetes-cleanup.md).
