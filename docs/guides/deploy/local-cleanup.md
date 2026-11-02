# Clean up the local Installation

Remove the disposable Installation when you finish the local quickstart. Use the saved operator session from Setup OCE. This deletes its k3d cluster, database, Agents and generated Kubernetes credentials. Before deletion, withdraw repository access and confirm retirement or expiry of any GitHub installation tokens. Keep the service-account PAT under its credential owner's control; deleting the cluster does not revoke external credentials.

## Stop the Agent and retire Git access

If you added Git, withdraw any [standing repository approval](../repository-credentials.md#keep-git-access-on-the-same-running-agent) first. Do not restore read-only access or redeploy during cleanup: the final read-only revision must also stop. Keep the API, worker, database, and GitHub connectivity available until retirement completes.

Load the saved session and stop the same Agent through the API. Save its current revision for diagnostics. If the stop request times out, read the Agent state before retrying it.

```bash
source /path/to/private/run/session.sh
request GET "$base/agents/$agent" > "$RUN_DIR/before-cleanup-agent"
request POST "$base/agents/$agent/stop" > "$RUN_DIR/cleanup-stop"
```

Define the following check in that shell. It requires the Agent to be stopped and all its Git credential families to have renewal disabled. Every issuance attempt must have confirmed revocation, recorded expiry, or a confirmed no-token result, with no retained sealed material. It checks all revisions, including the final read-only revision and revisions replaced when adding plugins. An Agent that never had Git access has no families or attempts to retire.

```bash
verify_retirement() {
  request GET "$base/agents/$agent" |
    jq -e '.data | .desiredRuntimeState=="stopped" and .activeRevisionId==null' || return 1
  local database retired
  database=$(jq -er .databaseName "$state/state.json") || return 1
  retired=$(kubectl --kubeconfig "$state/kubeconfig" --context "$context" -n "$ns" \
    exec -i statefulset/postgres -- env PGOPTIONS='-c default_transaction_read_only=on' \
    psql -XAt -v ON_ERROR_STOP=1 -U postgres -d "$database" \
    -v ns="$namespace" -v agent="$agent" <<'SQL'
WITH families AS (
  SELECT source_id, enabled
  FROM occ.prepared_github_families
  WHERE source #>> '{session,namespaceId}'=:'ns'
    AND source #>> '{session,agentId}'=:'agent'
)
SELECT NOT EXISTS (SELECT 1 FROM families WHERE enabled)
   AND NOT EXISTS (
     SELECT 1 FROM occ.prepared_github_attempts a
     JOIN families f ON f.source_id=a.source_id
     WHERE a.custody NOT IN ('revoked','expired','not_issued')
        OR a.sealed IS NOT NULL
   );
SQL
  ) || return 1
  test "$retired" = t
}
verify_retirement
```

If the check fails or returns `f`, **do not delete the Installation**. Repeat only `verify_retirement` while the worker completes retirement. Investigate unresolved issuance or revocation through the [Token Service lifecycle](../../reference/repository-credentials.md#token-service-lifecycle). Do not edit custody records or treat a stopped workload as proof of revocation.

## Remove the Installation

Run this only after retirement succeeds, in the same shell. Keep the Agent stopped; do not deploy or grant access between verification and deletion. Installation deletion is a terminal operation; closing the Console does not remove it.

Use the launcher’s printed cleanup command. For the OpenShell profile, the equivalent below requires the saved state directory and the cluster name from its installation record. Run it from the matching release checkout, using the CLI that created the installation.

```bash
CLEANUP_STATE=$state
CLEANUP_CLUSTER=$(jq -er .cluster "$state/state.json")
: "${CLEANUP_STATE:?Set the saved state directory}" "${CLEANUP_CLUSTER:?Set the recorded cluster name}"
(
  set -euo pipefail
  verify_retirement
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
