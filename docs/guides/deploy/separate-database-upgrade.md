# Deploy the database before replacing services

Follow the [production upgrade preparation](production-upgrade.md#prepare-the-release), including the backup and exclusive maintenance window.

The [preprovisioned Namespace](../../reference/drivers/kubernetes-compute/preprovisioned-namespace.md#what-the-chart-changes) profile omits the initialization Job and requires a separately migrated database and bootstrapped Installation.
The upgrade helper refuses this profile, so stop before using this procedure with it.

By default Helm migrates, bootstraps and restores Deployments. To deploy the
database separately, set `database.upgradeMigration: separate` in the reviewed
candidate values. Use a controller image that supports `--check-for-installation`,
`--apply-for-installation`, `--require-current-for-installation`, and
`--require-current`. Grant the upgrade operator `get` on the exact migrator
Secret and any database CA Secret referenced by the chart. Before
`--check-for-installation`, the helper records those Secrets' UIDs and resource
versions. It rechecks them after cleanup and before stopping writers. Keep the
database endpoint and these Secrets unchanged from preflight through resume.
The Jobs reference Secrets by name. Each identity check observes a point in
time, so exclude concurrent Secret edits while any Job is running.

The helper exits **3** after stopping both writers and before submitting Helm.
Before maintenance, use the
[migration compatibility check](production-upgrade-command.md#check-database-migration-compatibility)
to check the selected image against the deployed release's migration history.

## Apply and verify the prepared migration

After exit **3**, keep the maintenance window active. Use the same profile,
checkout, evidence directory, and candidate options as the original upgrade.

```sh
occ installation upgrade migration apply /secure/occ/upgrade-1 \
  --profile /secure/occ/upgrade.json \
  -- --candidate-values /secure/occ/candidate-values.yaml
```

Review the original run before approving. This command can commit irreversible
SQL. Type `yes` at a terminal or pass `--auto-approve` before `--`.

Keep other writers, autoscalers and Helm changes under exclusive maintenance
control until resume finishes. The helper checks the recorded Secret identities
before creating each Job and after verification. If a check finds a change,
preserve both evidence locations, keep writers stopped and reconcile the database
target before continuing.

The apply Job checks that the database has recognized history and belongs to
the recorded Installation before running SQL. A separate verification Job
checks the same Installation and requires completed history. Use a candidate
image that supports both guarded commands.

Wait for **Database migration verified and its Jobs and Pods are gone**. Then
resume the original upgrade with the same options and `--migration-history-checked`.

```sh
occ installation upgrade resume /secure/occ/upgrade-1 \
  --profile /secure/occ/upgrade.json \
  -- --candidate-values /secure/occ/candidate-values.yaml --migration-history-checked
```

The command rechecks the recorded migrator and CA Secret identities before
Helm writes, including recovery.

Keep `<evidence-directory>.migration-state.json` beside the original evidence
in a directory that protects it from removal by other users. Keep the journal
outside backups that you restore over the evidence. After interruption, settle the
original local processes using [upgrade recovery](production-upgrade-recovery.md).
Repeat `migration apply` with the same inputs to read the original Job and Pod
after a log-read failure or to confirm cleanup. If a create is unknown, the apply
Job fails, or cleanup is unresolved, keep writers stopped and reconcile the
original Job, Pod, and database history. Preserve both evidence locations,
including the lock and any retained kubeconfig snapshot.
After a failed verification Job has ended and its cleanup is confirmed, address
the failure and run the same command to retry verification.

## Run a selected-image migration

Read the migration program from the reviewed chart. From the reviewed release checkout root:

```sh
unset MIGRATION_ARGS
MIGRATION_PROGRAM="$(
  program="$(cat deploy/helm/openclaw-enterprise/files/migrate-selected-image.cjs && printf .)" || exit
  test "$program" != . || exit 1
  printf '%s' "$program"
)" && MIGRATION_PROGRAM="${MIGRATION_PROGRAM%.}"
```

Without a checkout, set `CHART_ARCHIVE` to the reviewed packaged chart and read the same file:

```sh
unset MIGRATION_ARGS
MIGRATION_PROGRAM="$(
  program="$(tar -xOf "$CHART_ARCHIVE" openclaw-enterprise/files/migrate-selected-image.cjs && printf .)" || exit
  test "$program" != . || exit 1
  printf '%s' "$program"
)" && MIGRATION_PROGRAM="${MIGRATION_PROGRAM%.}"
```

Stop if extraction fails or the file is empty. These commands preserve the program's
trailing newline and clear any previously selected migration arguments. Set `CONTROLLER_IMAGE`
to the selected immutable controller image and export `OCC_MIGRATION_DATABASE_URL`
with its migrator credential. To check the image directly:

```sh
docker run --rm --env NODE_ENV=production --env OCC_MIGRATION_DATABASE_URL \
  "$CONTROLLER_IMAGE" -e "${MIGRATION_PROGRAM:?Extract the migration program first}" -- --check
```

Require exit zero and a `migration.checked` event. Stop if either is missing.
Supply the database CA and network access required by the selected connection. The program
reads the image's production migration entry from `package.json`, accepts the supported
JavaScript or TypeScript entry, and loads it in the same Node process.
Mode arguments require the production-prefixed `db:migrate:production` command.
If the loader refuses an older image before migration, select an image that
supports the required mode.

For a first Helm install with an initialization Job, leave the database history empty. The chart’s
initialization Job applies migrations with `--expect-empty`, even when
`database.upgradeMigration` is `separate`. Do not apply SQL manually before that Job.

For Kubernetes, choose one mode before creating the
[maintenance Job](auth-maintenance.md#run-the-command). To inspect recognized history without applying SQL:

```sh
MIGRATION_ARGS="$(jq -nc \
  --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
  '["-e",$program,"--","--check"]')" || { unset MIGRATION_ARGS; false; }
```

Use `--require-current` for a read-only check that requires completed history
without checking the Installation ID.

```sh
MIGRATION_ARGS="$(jq -nc \
  --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
  '["-e",$program,"--","--require-current"]')" || { unset MIGRATION_ARGS; false; }
```

For an existing Installation, confirm [manual migration eligibility](#deploy-the-database)
before applying SQL. Set `UPGRADE_EVIDENCE` to the original protected evidence directory.
Stop if either argument selection fails. Both modes check the saved Installation ID
under the migration lock. Select the guarded apply arguments.

```sh
unset MIGRATION_ARGS
MIGRATION_ARGS="$(
  id="$(cat -- "${UPGRADE_EVIDENCE:?Select the original protected evidence directory}/installation-id")" || exit 1
  jq -nc --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
    --arg id "${id:?Missing saved Installation ID}" \
    '["-e",$program,"--","--apply-for-installation",$id]'
)" || { unset MIGRATION_ARGS; false; }
```

Select the guarded verification arguments.

```sh
unset MIGRATION_ARGS
MIGRATION_ARGS="$(
  id="$(cat -- "${UPGRADE_EVIDENCE:?Select the original protected evidence directory}/installation-id")" || exit 1
  jq -nc --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
    --arg id "${id:?Missing saved Installation ID}" \
    '["-e",$program,"--","--require-current-for-installation",$id]'
)" || { unset MIGRATION_ARGS; false; }
```

In the Job's original unquoted `<<EOF` heredoc, replace its `args:` line with
this literal YAML line:

```yaml
args: ${MIGRATION_ARGS:?Select migration arguments first}
```

Keep the heredoc unquoted so `RELEASE`, `DATABASE_CA_SECRET`, `CONTROLLER_IMAGE`,
and `MIGRATION_ARGS` expand. Do not paste the generated JSON directly into the
heredoc: Bash would change the program's escapes. Keep `--` so the arguments
match the chart invocation, including for apply. For a check mode, a missing or
extra separator fails before migration.

## Deploy the database

Use this manual procedure only after the original separate upgrade exits **3**.
Require its intact protected evidence, including `database-migration-handoff.json` and
`installation-id`. Confirm that no managed migration attempt occurred and no manual
apply remains unresolved. Stop if evidence is missing.

If an earlier attempt has uncertain effects, stop. Preserve its logs and evidence,
confirm its Job and Pods are terminal, and reconcile the outcome with the database
history. Do not replay SQL.

If manual apply already succeeded, finish any outstanding log capture and cleanup
in step 1 for the original Job and its Pods. Then continue with step 2.

1. Keep the maintenance window active and both writers stopped. Assign `MIGRATION_ARGS`
   for `--apply-for-installation`, then create the maintenance Job with the selected
   immutable candidate image, this database's migrator credential and CA, and the guarded
   `args:` line above. After confirmed completion, save the logs, delete the Job, and wait
   for its Pods to stop.
2. Assign `MIGRATION_ARGS` for `--require-current-for-installation` and create a new Job
   against the same image and database. Proceed only after exit zero and `migration.checked`
   with history `completed`. Delete the check Job and
   wait for its Pods to stop. Use these migration checks, not the sign-in procedure's
   `status` command, and keep writers stopped.
3. Resume through the original entry point with the original evidence directory and
   candidate options. For the CLI, use the
   [`occ installation upgrade resume` example](#apply-and-verify-the-prepared-migration)
   with the original profile. For `scripts/upgrade-production`, use its `resume` operation
   with the original `--profile`, `--evidence-dir` and candidate options, and pass
   `--migration-history-checked` after `--`. For `scripts/upgrade-production-images`,
   repeat the original command with `--resume --migration-history-checked`. The helper
   rechecks both stopped Deployments’ UIDs, generations and replica counts. Investigate
   any change. The Helm hook verifies the full candidate history before bootstrap and
   service replacement. The helper verifies rollout and OCC access.

The migration advisory lock serializes migrators. Until resume finishes, keep other
writers, autoscalers and deployment clients stopped. Keep the database target, migrator
Secret and any database CA Secret unchanged throughout. A Helm rollback cannot
reverse committed SQL. Keep the old services stopped after migration unless a separately
qualified recovery restores their matching database. The selected mode persists in Helm
values until a reviewed candidate selects `hook`.
