# Clean up the local Installation

Remove the disposable Installation when you finish the local quickstart. Use the saved operator session from Setup OCE. This deletes its k3d cluster, database, Agents and generated Kubernetes credentials. Before deletion, withdraw repository access and confirm retirement or expiry of any GitHub installation tokens. Keep the service-account PAT under its credential owner's control; deleting the cluster does not revoke external credentials.

Before deleting an Installation with Git access, follow [withdraw access](../repository-credentials/openshell-git-push.md#withdraw-access-after-the-exercise). Complete revocation checks while the database and worker still exist. Installation deletion is a terminal operation; closing the Console does not remove it.

Use the launcher’s printed cleanup command. For the OpenShell profile, the equivalent below requires the saved state directory and the cluster name from its installation record. Run it from the matching release checkout, using the CLI that created the installation.

```bash
source /path/to/private/run/session.sh
CLEANUP_STATE=$state
CLEANUP_CLUSTER=$(jq -er .cluster "$state/state.json")
: "${CLEANUP_STATE:?Set the saved state directory}" "${CLEANUP_CLUSTER:?Set the recorded cluster name}"
(
  set -euo pipefail
  # Check both records before deleting. A mismatch stops this block before dev down.
  test "$(jq -er .cluster "$CLEANUP_STATE/state.json")" = "$CLEANUP_CLUSTER"
  test "$(kubectl --kubeconfig "$CLEANUP_STATE/kubeconfig" config current-context)" = "k3d-$CLEANUP_CLUSTER"
  printf 'Removing selected installation %s (%s)\n' "$CLEANUP_CLUSTER" "$CLEANUP_STATE"
  env OCC_DEVELOPMENT_STATE_DIRECTORY="$CLEANUP_STATE" OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
    OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell ./bin/occ dev down
  test ! -e "$CLEANUP_STATE"
)
```

Expect `Stopped Kubernetes development stack <cluster>`. On failure, use the retained state and [cleanup guidance](local-kubernetes-development.md#stop-and-clean-up). Remove only private token or header copies owned by the retired run. For a fresh install, use a new `RUN_DIR` and let the launcher create a new state directory.

## Next steps

<Snippet file="../../assets/openshell-quickstart/next-steps.md" />
