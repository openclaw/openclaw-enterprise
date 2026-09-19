# Deploy on standard Kubernetes

Prepare an existing Kubernetes cluster for OpenClaw Enterprise (OCE), then run
[the shared Helm installation](production-installation.md). For AWS managed
Kubernetes, use the [Amazon EKS guide](eks.md).

## Prepare the cluster

Use Kubernetes 1.35 or later with IPv4 connectivity for the chart's explicit
`/32` database and API egress rules, enforcing NetworkPolicies, and the tools in
[production prerequisites](../deploy.md#production-prerequisites). One cluster
can host OCC and Agent workloads: OCC runs in `openclaw-system`, and Compute
creates isolated tenant namespaces. Separate control and runtime node pools
provide placement boundaries within that cluster.

Have the cluster administrator provide a protected kubeconfig and node pools
labeled `oce-role=control` and `oce-role=agents`, or record the labels you will
use instead. Select the cluster explicitly:

```bash
umask 077
export OCC_INPUT_DIRECTORY='/secure/occ'
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
export CONTEXT='<approved-cluster-context>'
# Place the administrator-provided kubeconfig at KUBECONFIG_FILE first.
chmod 600 "$KUBECONFIG_FILE"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" version
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get nodes -L oce-role
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get storageclasses
```

Allow capacity for overlapping revisions. Dedicated Codex also needs a node
syscall policy compatible with its command sandbox; review the
[Compute requirements](../../reference/drivers/kubernetes-compute.md#requirements)
before selecting node images.

## Prepare storage, database, and network access

Provide these cluster services before installing OCC:

| Requirement               | Operator preparation                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Private gateway state     | An explicit block-backed filesystem StorageClass supporting `10Gi` RWO claims and reliable SQLite locking.         |
| Bootstrap output          | A fresh `1Gi` RWO claim using a protected StorageClass; prepare it during shared installation.                     |
| Dedicated Agent workspace | A default StorageClass supporting `40Gi` RWX claims. Embedded Agents do not need this shared claim.                |
| PostgreSQL                | An external database with separate application and migrator roles and verified TLS.                                |
| Container registry        | Push access for the image builder and pull access from every eligible node, including tenant workloads.            |
| Operator access           | An approved HTTPS origin and access path matching `auth.baseUrl`; the chart does not create public TLS or Ingress. |

Follow the [storage contract](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage)
when choosing disks. A NetworkPolicy object alone is not proof of enforcement:
verify allowed and denied traffic with your CNI before placing tenant workloads.
Record the DNS Pod selectors for both Helm `dns` and Installation Compute
`network.dns`, exact database destinations, and Kubernetes API
addresses and ports as observed from controller Pods. These become the shared
installation's network settings; do not substitute whole cluster or VPC ranges.
See [networking and isolation](../../reference/drivers/kubernetes-compute/networking-and-isolation.md).

## Configure the protected copies and install

Continue with [production installation](production-installation.md), retaining
this shell's context. At its **Configure the Installation** step, edit the copied
examples for your cluster:

- Set `controlPlane.nodeSelector` and
  `drivers.compute.configuration.runtime.nodeSelector` to the reviewed control
  and runtime labels.
- Replace the bootstrap and gateway StorageClass placeholders with the classes
  prepared above. The dedicated shared workspace uses the cluster default.
- Replace sample image references, CIDRs, DNS/client selectors, cluster name,
  administrator email, and HTTPS origin.
- The example sets `database.caSecretName: occ-rds-ca`. For a database whose CA
  is already trusted by the controller image, set it to `""`. For another private
  CA, choose your own Secret name and save its bundle as
  `/secure/occ/occ-database-ca.pem`; the shared procedure creates that Secret.
  Keep hostname-verifying TLS in both database URLs.

Complete bootstrap and `occ installation get`, then follow
[production Agent deployment](production-agents.md) and
[workload verification](production-agents.md#verify-production-workloads).
Verify a real model turn and persistence across gateway replacement before
handoff. Record operational ownership using [production handoff](production-handoff.md).
