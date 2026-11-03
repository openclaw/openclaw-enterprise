---
tags: [human_verified, nolimit]
---

# Run a dedicated OpenShell Agent on EKS

Install OpenClaw Enterprise (OCE), configure browser access, and onboard a dedicated OpenShell Codex Agent on Amazon Elastic Kubernetes Service (EKS). Start in the matching OCE checkout on the operator’s laptop. Use Bash, AWS CLI, version-compatible kubectl, Helm, OpenSSL, jq, Node.js 24.22.1 or newer, Python 3, yq v4, PostgreSQL client tools and the [OCC CLI](../cli.md). Image selection needs Git and Docker; builds also need Buildx. Select compatible source, chart and image revisions.

[Create your first Agent](#5-create-the-configuration-and-agent) after installation. Git and plugins are optional.

## Before you start

### Prepare AWS infrastructure

Provision the following through your reviewed AWS infrastructure workflow. The OCE chart does not create the EKS cluster, VPC, IAM roles, database or storage add-ons.

Use an authorized AWS account and role. The Kubernetes operator needs permission to create namespaces, RBAC, Secrets and storage claims; Kubernetes access does not replace OCC IAM grants.

- An IPv4 EKS cluster running Kubernetes 1.35 or later, with private worker subnets and an API reachable by the operator and controller Pods. The chart uses exact IPv4 `/32` API and database egress rules; [IPv4 policies do not apply to IPv6 clusters](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html).
- Separate EC2 managed node groups labeled `oce-role=control` and `oce-role=agents`. OCC and Agent Gateways use the control group; Codex workloads use the Agent group. Reserve capacity for volume reattachment in each volume’s availability zone. Verify the [Codex node requirements](../../reference/drivers/kubernetes-compute.md#requirements), including the reviewed seccomp profile on replacement nodes. The EKS-managed Kubernetes control plane is separate from OCC’s Pods.
- NetworkPolicy enforcement, encrypted EBS storage and narrowly scoped IAM permissions for their add-ons, as described below.
- Private PostgreSQL with separate application and migrator roles. Permit traffic only from intended clients, using the security group of the actual source interface.
- Image registries reachable by every eligible node. Authorize builder pushes and node pulls separately. Provide approved NAT or endpoint access for image pulls and model requests. AWS IAM access does not grant model access.

The prior validated configuration used EKS 1.36, AL2023, kernel 6.18, VPC CNI 1.22.4, EBS CSI 1.67.2 and PostgreSQL 18.6. These are prior runtime results, not verification of this rewritten procedure. Check versions and NAT capacity in your selected region.

### Configure network enforcement and storage

Enable Amazon VPC CNI NetworkPolicy support with `NETWORK_POLICY_ENFORCING_MODE=strict` in the managed add-on configuration. Strict mode denies traffic while policies initialize. Prepare DNS and system-service policies first, then verify allowed and denied paths using [AWS’s setup procedure](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html). Enforcement can be unreliable for standalone Pods: if the bootstrap volume helper’s isolation cannot be verified, use the storage-administrator preparation path in [production installation](production-installation.md#provision-system-secrets-and-install).

Install the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html). Allow its controller to reach Kubernetes, DNS and regional EC2, STS and credential endpoints. The node plugin needs Kubernetes and DNS when instance metadata is unavailable. Keep workload access to instance metadata disabled. Require ready CSI Pods and topology labels on every eligible node before creating claims.

Create encrypted `encrypted-gp3` RWO filesystem storage with `WaitForFirstConsumer` for Gateway and bootstrap claims. Configure a default StorageClass that supports dedicated Agents’ `40Gi` RWO claims and UID/GID 1000; review other workloads before changing the default. Keep eligible capacity in the claim’s availability zone. Replacement stops the predecessor before disk reattachment, so allow downtime. Validate storage failover and node fencing separately. See the [storage contract](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).

### Enable Console workspace files

Private gateway routing is enabled by default. Prepare its controllers, CRDs, GatewayClass and service-key Secret before installing OCC; the Helm chart does not install these prerequisites.

Install cert-manager, Gateway API, Envoy Gateway and the matching Agent Sandbox controller on the control pool. Before rollout, prepare policies for controllers and certificate Jobs: DNS and API Service VIPs, API EndpointSlice addresses, API-server admission to webhooks and Envoy data-plane access to xDS. Match installed labels and ports on both sides. Include all private EKS control-plane interface addresses for webhook callers; one Service endpoint or public DNS answer may omit them. Require ready controllers before installing OCE.

The templates below enable private Envoy routing with a `ClusterIP` Service and a separate routing key. OCC checks Agent permissions; the browser connects to OCC’s HTTPS origin. The deployment helpers verify actual Envoy peers and apply Agent network policies. Preserve certificate/hostname verification, exact proxy CIDRs and the fixed native identity’s `operator.admin` grant. Keep model and channel credentials separate from routing credentials. See [private routing](workspace-routing.md#configure-private-routing) for the configuration contract and [existing-resource preparation](workspace-routing.md#enable-routing-for-existing-namespaces-and-agents) when updating an existing installation.

Use an OpenShell-compatible kernel, restricted tenant Pod Security and a `runc` RuntimeClass named `openshell-sandbox` pinned to the Agent group. Check Landlock, seccomp and no-new-privileges before enrolling credentials. For optional Slack support, configure [both required CONNECT proxies](../integrations/slack.md#configure-both-slack-proxies); NAT alone is insufficient.

## 1. Prepare the cluster and images

### Select the cluster

```bash
set -euo pipefail
set +x
umask 077
export AWS_REGION='<aws-region>'
export EKS_CLUSTER='<lowercase cluster name>'
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
```

For a private-only API, connect from the VPC or a connected network. If needed, prepare [private EKS access](eks-private-access.md#open-a-tunnel) with this kubeconfig before continuing.

```bash
kubectl version
kubectl get nodes -L oce-role
kubectl get storageclass encrypted-gp3
```

Confirm the account and role, then test Kubernetes TLS from the operator host. Successive connections through shared NAT can use different public IP addresses. For a public API allowlist change, authorize only the exact stable egress addresses or CIDRs listed for that host in the authoritative NAT inventory. A single observed IP address cannot establish or justify a broader prefix. Preserve existing allowlist entries, public and private endpoint settings, and AWS and Kubernetes authentication.

### Authenticate the image builder to ECR

For private ECR, create `openclaw-enterprise/controller` and `openclaw-enterprise/runtime` repositories, then authenticate the builder with [ECR’s authorization flow](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html):

```bash
export OCC_IMAGE_REGISTRY="<aws-account-id>.dkr.ecr.$AWS_REGION.amazonaws.com"
export OCC_IMAGE_REPOSITORY="$OCC_IMAGE_REGISTRY/openclaw-enterprise"
export OCC_IMAGE_PLATFORM=linux/amd64
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$OCC_IMAGE_REGISTRY"
```

Retain these values for image publication. Builder login does not authorize node pulls.

[Build the controller and runtime](production-installation.md#build-and-publish-production-images) from one release or [copy verified images](private-registry-images.md) into a registry the nodes can pull from. Set `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` to the resulting immutable references. The templates target AMD64 nodes, OpenShell 0.1.6 and Codex 0.164.0. Mirror the stock Gateway, supervisor and Sandbox runtime AMD64 manifests into the repository selected below, retaining their digests. Set `OPENSHELL_CHART` and `OCE_CHART` to the matching absolute chart archives or directories, `ENVOY_IMAGE` to the qualified proxy image, and `SANDBOX_REGISTRY`/`SANDBOX_REPOSITORY` to the stock-image mirror. Set `ADMIN_EMAIL`, `DATABASE_CIDRS` and `API_CIDRS` from the owner and network inventory. Create the system namespace before its policies and chart jobs. Use the source commit and image digests in the publication receipt.

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

<a id="configure-the-protected-copies-and-install"></a>

Confirm the database endpoint from your infrastructure outputs; EKS does not select RDS automatically. For RDS, obtain its [approved CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html). The templates use Secret `occ-database-ca`, key `ca.pem`, mounted at `/etc/openclaw/database-ca`. Both database URLs must use the database hostname and `sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem`. Use the provider’s verified CA for other PostgreSQL services. Keep exact database and API egress addresses current through failover; security groups do not replace NetworkPolicies.

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

## Verify workspace routing

After activation, check accepted/programmed Gateway and HTTPRoute status, ready certificates and an accepted API-key SecurityPolicy. Follow the [routing checks](workspace-routing.md#verify-routing-and-file-access) to verify invalid operator keys are rejected and dedicated Harnesses cannot bypass Envoy to reach the native Gateway.

In the Console **Workspace files** tab, read all four paths, save and reload a harmless change, then restore the original. Previously absent files should report `NOT_FOUND` with editable fields, not `DEPENDENCY_UNAVAILABLE`. A bound PVC or healthy OCC API alone does not prove routing. Across Pod replacement, compare PVC identities and existing session IDs to verify retained Gateway state. Record resource ownership, backups, credential renewal and recovery responsibilities using [production handoff](production-handoff.md).

For later upgrades, use [Upgrade production images](production-upgrade.md), its [checklist](upgrade-checklist.md) and [baseline](upgrade-baseline.md). Helm rollback does not undo committed migrations or restore Agent-volume data; use [upgrade recovery](production-upgrade-recovery.md) after a failure.

Continue to [Add Git](../repository-credentials/openshell-git-push.md) or [Add Plugin](../integrations/codex-plugins.md). To finish, [delete the Agent](quickstart-delete-agent.md), then clean up the installation with [Amazon EKS cleanup](eks-cleanup.md).
