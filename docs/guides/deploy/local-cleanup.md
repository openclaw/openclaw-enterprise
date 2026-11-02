# Clean up the local Installation

Delete the Agent, then remove the disposable Installation when you finish the local quickstart. Use the saved operator session from Setup OCE. Removing the Installation deletes its k3d cluster, database and generated Kubernetes credentials.

Immediate teardown can leave previously issued GitHub tokens valid until they expire because the worker can no longer revoke them. Deleting the Installation does not revoke the service-account PAT.

<a id="stop-the-agent-and-retire-git-access"></a>

## Delete the Agent

Load the saved session and delete the same Agent through the API. Deletion stops its execution and removes its workspace and version history. You do not need to stop it separately or wait for repository credential cleanup.

```bash
source /path/to/private/run/session.sh
request DELETE "$base/agents/$agent"
```

Expect HTTP `202` with the Agent in `deleting` status. Wait for deletion to finish by repeating this read:

```bash
request GET "$base/agents/$agent"
```

HTTP `404` means the Agent is gone. HTTP `200` with `status: deleting` means deletion is still in progress. Authentication or connection errors do not confirm deletion. If deletion fails, follow [Agent deletion recovery](../../reference/agents.md#deletion). If the DELETE request times out, read the Agent state before retrying it.

## Remove the Installation

After Agent deletion finishes, remove the disposable Installation from the same shell.

Use the launcher’s printed cleanup command. For the OpenShell profile, the equivalent below requires the saved state directory and the cluster name from its installation record. Run it from the matching release checkout, using the CLI that created the installation.

```bash
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

<Snippet file="../../snippets/openshell-quickstart/next-steps.md" />
