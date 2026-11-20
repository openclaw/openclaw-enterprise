---
tags: [human_verified]
# Backfilled from the verification tag recorded in a66a9cdfd.
last_verified: "2026-11-02"
---

# Clean up the Kubernetes installation

Remove the quickstart installation from the Kubernetes cluster selected during setup. This does not delete the cluster or shared infrastructure.

<Snippet file="../../snippets/openshell-quickstart/uninstall-cluster.md" />

## Verify removal

Confirm the OCE and OpenShell releases no longer appear in `helm list` for the saved context and namespace. Check that their workloads and the private listener are gone. Reconcile any retained claims or database resources with the installation record before deleting the private session directory.

## Next steps

<Snippet file="../../snippets/openshell-quickstart/next-steps.md" />
