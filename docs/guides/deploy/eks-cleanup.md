---
tags: [human_verified]
# Backfilled from the verification tag recorded in a66a9cdfd.
last_verified: "2026-11-02"
---

# Clean up the Amazon EKS installation

Remove the quickstart installation, then retire its dedicated AWS resources through the provisioning workflow that created them. Keep the recorded AWS account, region and EKS cluster name from setup.

<Snippet file="../../snippets/openshell-quickstart/uninstall-cluster.md" />

## Retire dedicated AWS resources

Verify `aws sts get-caller-identity` and the saved `AWS_REGION` and `EKS_CLUSTER` before any cloud deletion. Use the owning infrastructure stack to remove only this quickstart's node groups and EKS cluster after its Kubernetes workloads and any load balancers are gone. Do not delete an EKS cluster shared with other installations.

Review retained EBS volumes and snapshots, the dedicated RDS database/instance and backups, ECR images, load balancers, NAT gateways and other dedicated network resources. Cluster deletion alone does not retire these resources. Remove them through their owning provisioning records, preserving required backups and shared resources. Confirm deletion or intentional retention in the AWS inventory; otherwise charges can continue.

Stop the laptop forward and remove its private CA from the browser trust store when no longer used. Keep only the required recovery/deletion records from `RUN_DIR`.

## Next steps

<Snippet file="../../snippets/openshell-quickstart/next-steps.md" />
