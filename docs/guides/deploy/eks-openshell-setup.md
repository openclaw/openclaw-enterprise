---
tags: [human_verified]
# Backfilled from the verification tag recorded in a66a9cdfd.
last_verified: "2026-11-02"
---

# Set up OCE on Amazon EKS

Prepare Amazon Elastic Kubernetes Service (EKS) for OpenClaw Enterprise (OCE). Start in the matching OCE checkout on the operator’s laptop. Use Bash, AWS CLI, version-compatible kubectl, Helm, OpenSSL, jq, Node.js satisfying `engines.node` in the selected release checkout's `package.json`, Python 3, yq v4, PostgreSQL client tools and the [OCC CLI](../cli.md). Image selection needs Git and Docker; builds also need Buildx. Select compatible source, chart and image revisions.

This OpenShell workflow supports development and evaluation.
[OpenShell production qualification remains incomplete](../../reference/drivers/openshell-sandbox.md#remaining-qualification-work).

After preparation, [install OCE](eks-openshell-installation.md) in the same protected Bash session. Then [deploy your first Agent](deploy-first-agent.md). Git and plugins are optional.

## Before you start

### Prepare AWS infrastructure

Provision the following through your reviewed AWS infrastructure workflow. The OCE chart does not create the EKS cluster, VPC, IAM roles, database or storage add-ons.

Use an authorized AWS account and role. The Kubernetes operator needs permission to create namespaces, RBAC, Secrets and storage claims; Kubernetes access does not replace OCC IAM grants.

Choose a cluster whose workloads can trust the OpenShell Gateway with its
[cluster-wide Kubernetes authority](../../reference/drivers/openshell-sandbox.md#gateway-kubernetes-authority).
For stock OpenShell v0.1.8 operator mode, namespace selectors do not restrict
that authority. Use a dedicated evaluation cluster when other tenants must
remain outside this trust boundary.

- An IPv4 EKS cluster running Kubernetes 1.35 or later, with private worker subnets and an API reachable by the operator and controller Pods. The chart uses exact IPv4 `/32` API and database egress rules; [IPv4 policies do not apply to IPv6 clusters](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html).
- Separate EC2 managed node groups labeled `oce-role=control` and `oce-role=agents`. OCC and Agent Gateways use the control group; Codex workloads use the Agent group. Reserve capacity for volume reattachment in each volume’s availability zone. Verify the [Codex node requirements](../../reference/drivers/kubernetes-compute.md#requirements), including the reviewed seccomp profile on replacement nodes. The EKS-managed Kubernetes control plane is separate from OCC’s Pods.
- NetworkPolicy enforcement, encrypted EBS storage and narrowly scoped IAM permissions for their add-ons, as described below.
- Private PostgreSQL with separate application and migrator roles. Permit traffic only from intended clients, using the security group of the actual source interface.
- Image registries reachable by every eligible node. Authorize builder pushes and node pulls separately. Provide approved NAT or endpoint access for image pulls and model requests. AWS IAM access does not grant model access.

The prior validated configuration used EKS 1.36, AL2023, kernel 6.18, VPC CNI 1.22.4, EBS CSI 1.67.2 and PostgreSQL 18.6. These are prior runtime results, not verification of this rewritten procedure. Check versions and NAT capacity in your selected region.

### Configure network enforcement and storage

Enable Amazon VPC CNI NetworkPolicy support with `NETWORK_POLICY_ENFORCING_MODE=strict` in the managed add-on configuration. Strict mode denies traffic while policies initialize. Prepare DNS and system-service policies first, then verify allowed and denied paths using [AWS’s setup procedure](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html).

[Enforcement can be unreliable for standalone Pods without controller ownership](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html). Use controller-owned Jobs for temporary maintenance and upgrade clients that mount database or recovery credentials; matching policy labels alone is insufficient. See [sign-in maintenance](auth-maintenance.md#run-the-command). If the bootstrap volume helper’s isolation cannot be verified, use the storage-administrator preparation path in [production installation](production-installation.md#provision-system-secrets-and-install).

Install the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html). Allow its controller to reach Kubernetes, DNS and regional EC2, STS and credential endpoints. The node plugin needs Kubernetes and DNS when instance metadata is unavailable. Keep workload access to instance metadata disabled. Require ready CSI Pods and topology labels on every eligible node before creating claims.

Create encrypted `encrypted-gp3` RWO filesystem storage with `WaitForFirstConsumer` for Gateway and bootstrap claims. Configure a default StorageClass that supports dedicated Agents’ `40Gi` RWO claims and UID/GID 1000; review other workloads before changing the default. Keep eligible capacity in the claim’s availability zone. Replacement stops the predecessor before disk reattachment, so allow downtime. Validate storage failover and node fencing separately. See the [storage contract](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).

Before binding a PersistentVolume to an existing EBS volume, check the
[tag conditions of the CSI controller's selected IAM policy](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html#iam-permissions-recommendations-when-using-the-amazon-ebs-csi-driver)
for both the volume and the target node. For
`AmazonEBSCSIDriverEKSClusterScopedPolicy`, the volume's
`ebs.csi.aws.com/cluster-name` tag must match the principal's `eks-cluster-name`
tag. For `AmazonEBSCSIDriverPolicyV2`, a new manually created volume needs
`ebs.csi.aws.com/cluster=true`.

A `Bound` claim confirms PV binding. For attachment timeouts, match the
`VolumeAttachment` to the PV and node. If the attachment status or Pod events
only show a timeout, check the leader EBS CSI controller's `ebs-plugin` logs
for the volume and time of the failed attach.

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

If either node group lacks Ready workers, ask the infrastructure owner to inspect
that group's health issues and provisioning events using
[AWS's node troubleshooting guide](https://docs.aws.amazon.com/eks/latest/userguide/troubleshooting.html).
An offered instance type does not guarantee launch capacity:
[`InsufficientInstanceCapacity`](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/troubleshooting-launch.html#troubleshooting-launch-capacity)
means AWS cannot currently fulfill the launch. Keep retries and rollback in the
owning infrastructure workflow. After a failed replacement, verify the previous
group's health, template and scaling, and cleanup of attempted resources before
retrying. Preserve the volume-zone constraints above.

Confirm the account and role, then test Kubernetes TLS from the operator host. Successive connections through shared NAT can use different public IP addresses. For a public API allowlist change, authorize only the exact stable egress addresses or CIDRs listed for that host in the authoritative NAT inventory. A single observed IP address cannot establish or justify a broader prefix. Preserve existing allowlist entries, public and private endpoint settings, and AWS and Kubernetes authentication.

### Refresh API network policies after the node groups join

EKS control-plane addresses can change after initial setup. Once both node groups are ready, collect the current addresses below. Repeat this check immediately before installing or upgrading OCC, and when webhook admission times out.

```bash
# API clients can reach the Service IP or a backing endpoint.
api_service=$(kubectl --context "$CONTEXT" -n default get service kubernetes -o json |
  jq -er '.spec.clusterIP')
API_CIDRS=$(kubectl --context "$CONTEXT" -n default get endpointslices \
  -l kubernetes.io/service-name=kubernetes -o json |
  jq -ce --arg svc "$api_service" '[.items[] | select(.addressType=="IPv4") |
    .endpoints[].addresses[]] | select(length > 0) | . + [$svc] | unique | map(. + "/32")')
export API_CIDRS

# Webhook callers can use any control-plane interface for this cluster.
vpc_config=$(aws eks describe-cluster --region "$AWS_REGION" --name "$EKS_CLUSTER" \
  --query cluster.resourcesVpcConfig --output json)
vpc_id=$(jq -er .vpcId <<<"$vpc_config")
cluster_sg=$(jq -er .clusterSecurityGroupId <<<"$vpc_config")
webhook_cidrs=$(aws ec2 describe-network-interfaces --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$vpc_id" "Name=group-id,Values=$cluster_sg" \
  "Name=description,Values=Amazon EKS $EKS_CLUSTER" --output json |
  jq -ce '[.NetworkInterfaces[].PrivateIpAddresses[].PrivateIpAddress] |
    select(length > 0) | unique | map(. + "/32")')
printf 'API egress: %s\nWebhook ingress: %s\n' "$API_CIDRS" "$webhook_cidrs"
```

Update and apply the affected prerequisite NetworkPolicies through the infrastructure workflow. Use the API CIDRs for clients that need Kubernetes API egress, including controllers, certificate Jobs and storage components. Allow the verified control-plane interface CIDRs to reach every installed prerequisite webhook, including the AWS Load Balancer Controller when used. Match each webhook's actual port and Pod labels. Use the refreshed `API_CIDRS` when rendering OCC values.

Before changing OCC workloads, verify real API-server admission through every installed prerequisite webhook using its owning infrastructure procedure. Controller readiness alone does not prove webhook connectivity. For cert-manager, also confirm that a certificate request produces a Ready certificate under strict NetworkPolicy. The production upgrade command checks server-side admission for rendered Certificates before stopping the controllers.

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

[Build the controller and runtime](production-installation.md#build-and-publish-production-images) from one release or [copy verified images](private-registry-images.md) into a registry the nodes can pull from. Set `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` to the resulting immutable references. The templates target AMD64 nodes, OpenShell 0.1.8 and Codex 0.164.0. Mirror the stock Gateway, supervisor and Sandbox runtime AMD64 manifests into the repository selected below, retaining their digests. Set `OPENSHELL_CHART` and `OCE_CHART` to the matching absolute chart archives or directories, `ENVOY_IMAGE` to the qualified proxy image, and `SANDBOX_REGISTRY`/`SANDBOX_REPOSITORY` to the stock-image mirror. Set `ADMIN_EMAIL`, `DATABASE_CIDRS` and `API_CIDRS` from the owner and network inventory. Create the system namespace before its policies and chart jobs. Use the source commit and image digests in the publication receipt.

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

### Check the prepared resources

Run [prerequisite diagnosis](prerequisite-diagnosis.md) after preparing the target
namespace and controllers. Save its plan as `$RUN_DIR/prerequisites.json`, using
`$KUBECONFIG`, `$CONTEXT`, `$PLATFORM_NS`, the installed controller names, and the
reviewed API/webhook CIDRs above. Set `peakAdditional` from the candidate chart
and put the intended cluster ARN in `eks.clusterArn`.

```bash
node scripts/diagnose-kubernetes-prerequisites.ts --config "$RUN_DIR/prerequisites.json"
```

Resolve failed and unknown checks before installing. Matching address inventory
does not prove that deployed NetworkPolicies or admission webhooks work; retain
the network and certificate checks above.

<a id="configure-the-protected-copies-and-install"></a>

[Configure protected database inputs](eks-openshell-installation.md#configure-the-protected-copies-and-install) in the installation guide.

<a id="2.-install-openshell-and-bootstrap-occ"></a>
<a id="2-install-openshell-and-bootstrap-occ"></a>

[Install OpenShell and bootstrap OCC](eks-openshell-installation.md#2-install-openshell-and-bootstrap-occ) in the installation guide.

<a id="set-the-production-browser-origins-before-installing-occ"></a>

[Set browser origins before installing OCC](eks-openshell-installation.md#set-the-production-browser-origins-before-installing-occ) in the installation guide.

<a id="configure-browser-access"></a>

[Configure browser access](eks-openshell-installation.md#configure-browser-access) in the installation guide.

<a id="read-the-protected-initial-owner-files"></a>

[Read the protected initial owner files](eks-openshell-installation.md#read-the-protected-initial-owner-files) in the installation guide.

<a id="install-the-loopback-tls-listener"></a>

[Install the loopback TLS listener](eks-openshell-installation.md#install-the-loopback-tls-listener) in the installation guide.

<a id="3.-authenticate-and-prepare-the-namespace"></a>
<a id="3-authenticate-and-prepare-the-namespace"></a>

[Authenticate and prepare the Namespace](eks-openshell-installation.md#3-authenticate-and-prepare-the-namespace) in the installation guide.

<a id="4-enroll-linear-and-protected-git"></a>
<a id="5-deploy-and-open-the-owners-agent"></a>
<a id="4.-prepare-the-operator-session"></a>
<a id="4-prepare-the-operator-session"></a>

[Prepare the operator session](eks-openshell-installation.md#4-prepare-the-operator-session) in the installation guide.

<a id="verify-workspace-routing"></a>

[Verify workspace routing](eks-openshell-installation.md#verify-workspace-routing) in the installation guide.
