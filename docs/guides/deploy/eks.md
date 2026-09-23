# Deploy on Amazon EKS

Prepare Amazon Elastic Kubernetes Service (EKS) for OpenClaw Enterprise (OCE),
then run [the shared Helm installation](production-installation.md). This guide
uses Linux EC2 managed node groups and IPv4 networking. Provision AWS
infrastructure separately: the OCE chart does not create an EKS cluster, VPC,
IAM roles, database, or Container Storage Interface (CSI) add-ons.

One EKS cluster can host the OpenClaw Control Plane (OCC) and Agent workloads.
Use separate node groups for OCC and Agents, along with namespace,
role-based access control (RBAC), and network policies. The EKS-managed
Kubernetes control plane is distinct from
OCC, which runs as application Pods on your nodes. For Agent model
authentication, follow [production Agent deployment](production-agents.md).
Console workspace files also require [private gateway routing](#enable-console-workspace-files).

## Prepare AWS infrastructure

Provision these resources through your reviewed infrastructure workflow before
installing OCE:

1. An IPv4 EKS cluster running Kubernetes 1.35 or later, private worker subnets, and
   an API endpoint reachable by the operator and controller Pods. Configure
   operator access to the Kubernetes API.
2. EC2 managed node groups labeled `oce-role=control` and `oce-role=agents`.
   Reserve capacity for overlapping Agent revisions. Check the
   [Codex node requirements](../../reference/drivers/kubernetes-compute.md#requirements)
   when choosing the node image and syscall policy.
3. NetworkPolicy enforcement, storage add-ons, and their narrowly scoped IAM
   permissions, as described below.
4. External PostgreSQL, such as private RDS PostgreSQL, with separate application
   and migrator roles. Permit database traffic only from the intended clients.
5. A registry accessible to every eligible node. For ECR, provision repositories
   for controller and runtime images and authorize image push and node pull.
   Publish images for the node architecture and use their immutable digests.
6. Outbound access for required image pulls and model calls through the approved
   NAT or endpoint design, plus an operator-managed HTTPS origin for OCC.

The current OCE chart requires IPv4 `/32` database and Kubernetes API egress
rules. Use an IPv4 cluster for this procedure; AWS notes that IPv4 policies are
ignored on IPv6 clusters in its
[network policy considerations](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html).

## Select the cluster

Use AWS CLI credentials for the approved account and region. Create a dedicated
kubeconfig so these steps preserve the default kubeconfig:

```bash
umask 077
export AWS_REGION='<aws-region>'
export EKS_CLUSTER='<eks-cluster-name>'
export OCC_INPUT_DIRECTORY='/secure/occ'
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
export CONTEXT="oce-$EKS_CLUSTER"
install -d -m 700 "$OCC_INPUT_DIRECTORY"
aws eks update-kubeconfig --region "$AWS_REGION" --name "$EKS_CLUSTER" \
  --alias "$CONTEXT" --kubeconfig "$KUBECONFIG_FILE"
chmod 600 "$KUBECONFIG_FILE"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" version
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get nodes -L oce-role
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get storageclasses
```

## Authenticate the image builder to ECR

If using private Amazon Elastic Container Registry (ECR), replace the account
placeholder below. Create repositories
named `openclaw-enterprise/controller` and `openclaw-enterprise/runtime` first,
then authenticate the builder using
[ECR's authorization flow](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html):

```bash
export OCC_IMAGE_REGISTRY="<aws-account-id>.dkr.ecr.$AWS_REGION.amazonaws.com"
export OCC_IMAGE_REPOSITORY="$OCC_IMAGE_REGISTRY/openclaw-enterprise"
export OCC_IMAGE_PLATFORM='linux/amd64' # Use linux/arm64 for ARM nodes.
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$OCC_IMAGE_REGISTRY"
```

Retain these exports for the shared image-build procedure. Configure node pull
permissions separately; builder login does not authorize EKS nodes.

## Configure network enforcement and storage

For Amazon VPC CNI, enable NetworkPolicy support and configure
`NETWORK_POLICY_ENFORCING_MODE=strict` through the managed add-on configuration.
Strict mode denies traffic while Pod policies initialize; prepare required DNS
and system-service policies as well. Follow AWS's
[NetworkPolicy setup](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html)
and verify both allowed and denied paths before deploying tenants. AWS also
notes that enforcement can be unreliable for standalone Pods. The bootstrap
volume helper creates such a Pod; if its isolation cannot be verified, use the
storage-administrator preparation path in the shared installation guide.

Use the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)
for private gateway and bootstrap block volumes. Configure encrypted filesystem
StorageClasses and appropriate topology binding, such as `WaitForFirstConsumer`.
EBS-backed volumes must be usable in the scheduled Pod's availability zone.
Keep sufficient eligible node capacity in that zone for gateway replacement.
Use the explicit gateway class for SQLite state; see the
[storage contract](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).

For dedicated Agents, provision an EFS filesystem, mount targets reachable from
runtime nodes, and the
[EFS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/efs-csi.html)
with its required IAM permissions. Configure an EFS access-point StorageClass
as the cluster default for the driver's `40Gi` RWX workspace claims. Review
other workloads before changing a shared cluster's default class. Keep gateway
and bootstrap claims explicitly on EBS; EFS is for the shared workspace.
Use a separate access-point directory for each claim and verify read/write access
from OCE's non-root UID/GID 1000 workloads. Review the driver's
[access-point identity and directory parameters](https://github.com/kubernetes-sigs/aws-efs-csi-driver/blob/master/docs/parameters.md)
instead of assuming filesystem permissions from a successful PVC bind.

## Enable Console workspace files

EFS provides workspace storage. For Console access, the browser sends HTTPS
requests to OCC API, which opens service-key-authenticated WSS connections
through private Envoy to the Agent gateway.

OCC checks the caller's Agent permission. Envoy authenticates the separate
Installation service key and forwards a fixed native identity. Keep Envoy's
Service as `ClusterIP`; the browser uses OCC's HTTPS origin, not a public Agent
listener or a port-forward to the native gateway.

Complete [private workspace routing](workspace-routing.md#configure-private-routing)
before provisioning Namespaces and Agents:

1. Install the guide's Envoy Gateway, Gateway API CRDs, cert-manager, and an
   accepted GatewayClass. These are operator-owned prerequisites; the OCE chart
   does not install their controllers. Place the controllers on your control
   node group and verify capacity for the Envoy data plane.
2. Under VPC CNI strict mode, prepare policies for the prerequisite controllers
   and certificate-generation Jobs before starting them. Permit DNS and the
   actual Kubernetes API destinations; permit API-server admission traffic to
   the controllers' webhook ports and Envoy data-plane traffic to the
   controller's xDS port. Match the installed manifests' labels and ports,
   including both sides' policies. OCE's chart owns the separate API-to-Envoy
   and Envoy-to-Agent rules; those rules do not provide controller bootstrap
   access. Require ready controllers before applying OCE's routing resources.
3. Create the dedicated service-key Secret and set matching `gatewayRouting`
   values in Helm and `drivers.compute.configuration` in the Installation YAML.
   Remove Compute `network.gatewayClients` when routing is enabled. Keep the
   default derived private Service hostname unless you operate custom DNS.
4. Configure the Installation's verified [proxy source CIDRs](workspace-routing.md#configure-native-gateway-authentication); Kubernetes Compute renders each Agent's native trusted-proxy authentication.
   Use the actual Envoy source CIDRs from your Pod network; account for custom
   networking or source translation rather than assuming a node subnet. Keep
   `allowRealIpFallback: true` and the fixed identity's `operator.admin` grant.
   Do not use an unrestricted CIDR or retain native token/password fields.

The shared guide owns YAML and Secret commands. Keep model,
Harness, and channel credentials separate from the routing key. Automatic CA
setup projects only the public root certificate into OCC API; retain certificate
and hostname verification. A rebuilt runtime is needed only if the installed
native version lacks the required authentication fields.

For an existing installation, follow the
[existing Namespace and Agent procedure](workspace-routing.md#enable-routing-for-existing-namespaces-and-agents).
Restarting OCC and deploying an Agent alone do not update a ready Namespace's
route-attachment label or old direct-API ingress rule.

## Configure the protected copies and install

Follow [production installation](production-installation.md) in the same shell.
At **Configure the Installation**, apply these choices to the copied examples:

| Input                                                                     | EKS setting                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `values.yaml`: `controlPlane.nodeSelector`                                | Labels on the OCC managed node group.                                                                                         |
| `installation.yaml`: `drivers.compute.configuration.runtime.nodeSelector` | Labels on the Agent managed node group.                                                                                       |
| `runtime.gatewayStorageClassName`                                         | The EBS-backed gateway class.                                                                                                 |
| `bootstrap-pvc.yaml`: `spec.storageClassName`                             | The protected EBS-backed bootstrap class.                                                                                     |
| `values.yaml`: `database.cidrs`, `cluster.cidrs`                          | Exact database and API destination addresses observed from Pods, with reviewed ports in the corresponding values.             |
| `installation.yaml`: Compute `network`                                    | Actual DNS selectors; omit gateway clients with routing enabled. Keep API proxy sources when plugin status reporting is used. |
| Controller and runtime image references                                   | Published registry digests matching the node architecture.                                                                    |

EKS endpoint and RDS addresses can change. Maintain these exact egress rules
through infrastructure updates and failover; VPC security groups do not replace
the chart's NetworkPolicies. The
[networking reference](../../reference/drivers/kubernetes-compute/networking-and-isolation.md)
owns plugin proxy source and workload egress requirements.

Select the database setup from your infrastructure outputs. EKS does not
select RDS automatically: confirm the PostgreSQL resource and endpoint your
application and migration URLs will use. `database.caSecretName` only selects a
CA Secret; it does not enable RDS or detect the database provider.

When using RDS, obtain the applicable AWS CA bundle using the
[RDS PostgreSQL TLS instructions](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)
and save it as `/secure/occ/occ-database-ca.pem`. Keep the example
`database.caSecretName: occ-rds-ca` and CA mount settings. Both protected database
URLs must use the RDS hostname and
`sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem`.
For another PostgreSQL provider, use its verified TLS settings and CA instead.

Finish the shared procedure to create Secrets, prepare the fresh bootstrap PVC,
install Helm, and authenticate with `occ installation get`. Then complete
[production Agent deployment](production-agents.md), including tenant grants,
exact-Agent model credentials, and a real model turn. Check PVC binding and
persistent gateway state across Pod replacement. Use
[production handoff](production-handoff.md) to record AWS resource owners,
backups, credential renewal, and recovery responsibilities.

## Verify workspace routing

Follow the [routing and file checks](workspace-routing.md#verify-routing-and-file-access)
after Agent activation. Require accepted/programmed Gateway and HTTPRoute
status, ready certificates, and an accepted API-key SecurityPolicy. Verify
missing/invalid keys are rejected, and ordinary Agent workloads cannot connect
to Envoy or the native gateway directly, even when Service DNS resolves.

Open the Agent's **Workspace files** tab in the signed-in Console. Read all four
paths, save and reload a harmless temporary change, then restore the original
state. Files absent before deployment should report `NOT_FOUND` with editable
fields, not `DEPENDENCY_UNAVAILABLE`. Compare PVC identities and existing session
IDs after cutover; a bound EFS claim or healthy OCC API alone does not prove
workspace routing. Check configured channel health without sending messages
unless message delivery is part of your approved verification.
