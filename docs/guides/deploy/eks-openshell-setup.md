---
tags: [human_verified]
---

# Run a dedicated OpenShell Agent on EKS

Install OpenClaw Enterprise (OCE) with OpenShell, deploy a dedicated Codex Agent and complete onboarding in its Control UI. Start on the owner’s laptop in a checkout containing this guide and its assets. Select images, chart and installation schema from compatible recorded source revisions. Keep the records from each step in an owner-only directory.

[Create your first Agent](#5-create-the-configuration-and-agent) after installation.

## 1. Prepare the cluster and images

Follow [Kubernetes prerequisites](kubernetes.md#prepare-the-cluster) and [EKS infrastructure preparation](eks.md#prepare-aws-infrastructure). Select an IPv4 cluster, two private EC2 node groups labeled `oce-role=control` and `oce-role=agents`, strict VPC CNI NetworkPolicy enforcement, encrypted gp3 RWO storage with `WaitForFirstConsumer`, and private PostgreSQL with separate application and migration roles and verified TLS. The validated configuration used EKS 1.36, AL2023, kernel 6.18, VPC CNI 1.22.4, EBS CSI 1.67.2 and PostgreSQL 18.6. Check versions and NAT capacity in your chosen region.

Install cert-manager, Gateway API, Envoy Gateway and the matching Agent Sandbox controller. Under strict CNI, prepare component policies before rollout. Include DNS and API Service VIPs alongside the intended Pod peers and API EndpointSlice addresses. Verify EBS CSI reaches its regional EC2 and STS endpoints. For RDS, authorize the security group of the actual source interface. Verify both database roles with `sslmode=verify-full`. [EKS network and storage](eks.md#configure-network-enforcement-and-storage)

```bash
set -euo pipefail
set +x
umask 077
run_root=${XDG_STATE_HOME:-$HOME/.local/state}/oce
install -d -m 700 "$run_root"
RUN_DIR=$(mktemp -d "$run_root/eks.XXXXXXXX")
source docs/snippets/openshell-quickstart/stage-session.sh
cp -R docs/snippets/openshell-quickstart/kubernetes "$RUN_DIR/kubernetes"
install -m 600 docs/snippets/openshell-quickstart/platform-kubernetes.sh "$RUN_DIR/platform.sh"
PLATFORM=eks
CLUSTER_NAME="${EKS_CLUSTER:?Set the target cluster name}"
STORAGE_CLASS=encrypted-gp3
export CLUSTER_NAME STORAGE_CLASS
printf 'Keep this session directory: %s\n' "$RUN_DIR"
export KUBECONFIG="$RUN_DIR/kubeconfig"
export PLATFORM_NS=oce-system
RELEASE=oce
export CONTEXT="oce-${EKS_CLUSTER:?Set the target cluster name}"
[[ $EKS_CLUSTER =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo "Use a lowercase DNS-label cluster name" >&2; exit 1; }
aws sts get-caller-identity --query '[Account,Arn]'
aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "${AWS_REGION:?}" \
  --alias "$CONTEXT" --kubeconfig "$KUBECONFIG"
kubectl get nodes -L oce-role
kubectl get storageclass encrypted-gp3
```

Confirm the account and role, then test Kubernetes TLS from the operator host. Successive connections through shared NAT can use different public IP addresses. For a public API allowlist change, authorize only the exact stable egress addresses or CIDRs listed for that host in the authoritative NAT inventory. A single observed IP address cannot establish or justify a broader prefix. Preserve existing allowlist entries, public and private endpoint settings, and AWS and Kubernetes authentication.

[Build the controller and runtime](production-installation.md#build-and-publish-production-images) from one release or [copy verified images](private-registry-images.md) into a registry the nodes can pull from. Set `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` to the resulting immutable references. The templates target AMD64 nodes, OpenShell 0.1.6 and Codex 0.164.0. Mirror the stock Gateway, supervisor and Sandbox runtime AMD64 manifests into the repository selected below, retaining their digests. Set `OPENSHELL_CHART` and `OCE_CHART` to the matching absolute chart archives or directories, `ENVOY_IMAGE` to the qualified proxy image, and `SANDBOX_REGISTRY`/`SANDBOX_REPOSITORY` to the stock-image mirror. Set `ADMIN_EMAIL`, `DATABASE_CIDRS` and `API_CIDRS` from the owner and network inventory. Create the system namespace before its policies and chart jobs. Use the source commit and image digests in the publication receipt. Use an OpenShell-compatible kernel, a restricted workload Namespace and a `runc` RuntimeClass named `openshell-sandbox` pinned to the Agent node group. Check Landlock, seccomp and no-new-privileges on that pool before enrolling credentials.

Register the GatewayClass before installing OCC. Installing the Envoy Gateway controller does not create a class named `eg`. On a fresh cluster, create the class only when absent. Stop if an existing class belongs to another controller.

```bash
class_json=$(kubectl --context "$CONTEXT" get gatewayclass eg --ignore-not-found -o json)
if [[ -z $class_json ]]; then
  kubectl --context "$CONTEXT" create -f - <<'YAML'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
YAML
fi
kubectl --context "$CONTEXT" get gatewayclass eg -o json |
  jq -e '.spec.controllerName=="gateway.envoyproxy.io/gatewayclass-controller"'
kubectl --context "$CONTEXT" wait gatewayclass/eg --for=condition=Accepted --timeout=3m
```

<Snippet file="../../snippets/openshell-quickstart/cluster-installation.md" />

<a id="4-enroll-linear-and-protected-git"></a>
<a id="5-deploy-and-open-the-owners-agent"></a>

## 4. Connect to the API and register the model credential

Set `CODEX_TOKEN_FILE` to the private service-account PAT file and `MODEL` to the authorized native model ID. A Linear connection and GitHub App are not needed for installation setup. The [operator session reference](quickstart-session.md) defines the shared inputs and helpers.

```bash
export CODEX_TOKEN_FILE=/secure/oce/codex-token
export MODEL=gpt-5.4
test -r "$CODEX_TOKEN_FILE" && test -s "$CODEX_TOKEN_FILE"
```

<Snippet file="../../snippets/openshell-quickstart/agent-setup.md" />

Continue to [Add Git](../repository-credentials/openshell-git-push.md) or [Add Plugin](../integrations/codex-plugins.md). To finish, [delete the Agent](quickstart-delete-agent.md), then clean up the installation with [Amazon EKS cleanup](eks-cleanup.md).
