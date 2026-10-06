# Recover a partial production upgrade

Use this page when [Upgrade production images](production-upgrade.md) stops before the release is verified. It assumes the evidence directory, arguments and maintenance restrictions from that run.

Keep the evidence directory and maintenance restrictions.
Do not start another upgrade to recover: its frozen Agent
inventory and dispatch records are needed to avoid duplicate deployments. If
preparation did not finish, the helper stopped before mutation; use a new
evidence directory after resolving the failure. Otherwise, repeat the original
command with the same arguments, protected file paths, kubeconfig contents,
OCC URL, scripts, flow, and chart, adding `--resume`. The helper rechecks the
recorded image pair and eligible nodes. Include the original candidate
flags and keep their files semantically unchanged. The helper uses the recorded
candidate, reads the live Secret and Helm release, accepts only the recorded
baseline or candidate, and continues the recorded fleet. It rejects unrelated drift. The evidence includes
Secret contents and must remain private.

If a killed process leaves `.upgrade-lock`, first establish that no helper or
its child commands are still running, then remove that empty directory and
resume. This lock covers only processes sharing this evidence directory; it
cannot stop other operators or automation.

A Helm failure or disconnected response does not prove that the migration
rolled back. Read the current Helm status and history, inspect the initialization
Job and its Pods and logs, and inspect the retained database. The saved
`current-helm-status.json` is the last read and can predate the failed request.
A `pending-*` Helm release must be resolved separately before the helper can
continue. Do not start the old API or worker against a migrated database. If the
candidate Helm revision is deployed, the helper reads it back and continues
without rerunning Helm. Otherwise, wait
until the initialization Job and its Pods are terminal, then run the **candidate controller
image** with `node scripts/migrate-production.mjs --check` against the same
retained database, using its dedicated migrator credential and required database
CA in an authorized environment. Keep its exit-zero `migration.checked` output in
private evidence. Follow [migration history](../../reference/settings/operations.md#migration-history)
to interpret unsupported or uncertain state. Only after this check and review of
the Job outcome, repeat the command with `--resume --migration-history-checked`.
That flag records your attestation; it does not run the database check. The
helper keeps or returns OCC to zero replicas before retrying the candidate Helm
release. Prefer a reviewed forward fix; neither Helm rollback nor the helper
reverses committed migrations.

For an unknown Agent dispatch, the helper saves an Agent readback and stops
without replaying it. Inspect the exact Agent's authorized revision history,
deployment status, and audit records, and allow any in-flight request to finish.
An unchanged active revision alone does not prove rejection, and a filtered
revision list does not prove absence. If you can identify the accepted revision,
record a private `dispatch/<same-prefix-as-intent>.json` containing its `id`;
the helper checks that exact deployment's status on resume. If evidence proves
the request was not accepted, deploy that Agent once with the ordinary OCC CLI
and save its successful JSON response under that name. Preserve the `.intent`,
error, and readback evidence. If the result is still uncertain, stop and
investigate rather than submitting another request. For a known failed revision,
inspect its failure and explicitly deploy an authorized replacement before
recording that replacement's response; preserve the original response separately.
Each deployment snapshots current drafts.

For an accepted revision, set `OCC_NAMESPACE` and `OCC_AGENT` to the exact
Agent IDs, `DISPATCH_PREFIX` to the matching evidence path without `.intent` or
`.json`, and `REVISION_ID` to the independently confirmed revision. Verify the exact Agent and deployment before recording it:

```bash
if test -z "$REVISION_ID"; then
  printf '%s\n' 'Set REVISION_ID to the confirmed revision; do not resume.' >&2
elif test -e "$DISPATCH_PREFIX.json"; then
  if jq -e --arg id "$REVISION_ID" '.id == $id' "$DISPATCH_PREFIX.json" > /dev/null; then
    printf '%s\n' "Deployment $REVISION_ID is already recorded in $DISPATCH_PREFIX.json."
  else
    printf '%s\n' "$DISPATCH_PREFIX.json does not record $REVISION_ID; inspect it and do not resume." >&2
  fi
elif occ --output json --namespace "$OCC_NAMESPACE" agent deployment-status "$OCC_AGENT" "$REVISION_ID" > "$DISPATCH_PREFIX.confirmed-status.json" &&
  jq -e --arg namespace "$OCC_NAMESPACE" --arg agent "$OCC_AGENT" --arg revision "$REVISION_ID" \
    '.namespaceId == $namespace and .agentId == $agent and .deploymentId == $revision' "$DISPATCH_PREFIX.confirmed-status.json" &&
  jq -n --arg id "$REVISION_ID" '{id: $id}' > "$DISPATCH_PREFIX.json.tmp"; then
  mv "$DISPATCH_PREFIX.json.tmp" "$DISPATCH_PREFIX.json"
else
  printf '%s\n' 'Deployment could not be confirmed; do not resume.' >&2
fi
```

Keep the shell's `umask 077`. If the status read is denied or does not identify
the confirmed deployment, do not create the response file. The block never
overwrites an existing response file: a rerun reports it when it records the
same ID, and otherwise says to inspect it. The helper
rechecks its status on resume; it does not verify how you identified an
accepted request.

If the candidate API and worker refuse to start because of
[split-layout Gateway storage](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations),
`--resume` cannot succeed. Keep both namespaces and their storage, and return to
the previous controller image after the check below.

Before selecting an older controller or runtime image, verify it can read all
state written by the candidate and restore compatible data if required. Never
delete Agents, revisions, PVCs, or the bootstrap volume to force recovery.

## Roll back across human sign-in

Migration `0037` adds the human sign-in state. `helm rollback` skips the
pre-upgrade migration Job, so it never reverses that migration.

Before GitHub sign-in is activated, scale `deployment/openclaw-enterprise-api` to
zero and wait for its Pods to disappear, run `helm rollback`, then verify password
sign-in before reopening ingress.

After activation, do not roll back; fix forward. The database refuses sessions
that the previous controller issues without a human sign-in binding, so it
cannot sign anyone in, and existing sessions expire within 8 hours. Never run
the previous and current controllers together.
To roll back anyway, first return to password-only sign-in with
[stopped maintenance](auth-maintenance.md#deactivate-external-sign-in).
