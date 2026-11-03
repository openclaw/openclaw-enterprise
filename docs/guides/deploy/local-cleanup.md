---
tags: [human_verified]
---

# Clean up the local Installation

Delete the Agent, then remove the disposable Installation when you finish the local quickstart. Use the saved operator session from installation setup. Removing the Installation deletes its k3d cluster, database and generated Kubernetes credentials.

Immediate teardown can leave previously issued GitHub tokens valid until they expire because the worker can no longer revoke them. Deleting the Installation does not revoke the service-account PAT.

<a id="stop-the-agent-and-retire-git-access"></a>

## Delete the Agent

Complete [Delete Agent](quickstart-delete-agent.md) first. It uses the saved session and waits for HTTP `404`; it does not require Git credential retirement.

## Remove the Installation

After Agent deletion finishes, remove the disposable Installation from the same shell.

Use the launcher’s printed cleanup command. For the OpenShell profile, the equivalent below requires the saved state directory and the cluster name from its installation record. Run it from the matching release checkout, using the CLI that created the installation.

```bash
source /path/to/private/run/session.sh
CLEANUP_STATE=${OCC_DEVELOPMENT_STATE_DIRECTORY:?}
CLEANUP_CLUSTER=$(jq -er .cluster "$CLEANUP_STATE/state.json")
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
