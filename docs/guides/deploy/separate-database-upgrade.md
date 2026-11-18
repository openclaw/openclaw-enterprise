# Deploy the database before replacing services

Follow the [production upgrade preparation](production-upgrade.md#prepare-the-release), including the backup and exclusive maintenance window.

By default Helm migrates, bootstraps and restores Deployments. To deploy the
database separately, set `database.upgradeMigration: separate` in the reviewed
candidate values. Use a candidate controller image that supports `--require-current`.
The helper exits **3** after both writers stop and before submitting Helm.

Before maintenance, use the
[migration compatibility check](production-upgrade-command.md#check-database-migration-compatibility)
to check the selected image against the deployed release's migration history.

## Apply and verify the prepared migration

After exit **3**, keep the maintenance window active. Use the same profile,
checkout, evidence directory, and candidate options as the original upgrade.

```sh
occ installation upgrade migration apply \
  --profile /secure/occ/upgrade.json \
  --evidence-dir /secure/occ/upgrade-1 \
  -- --candidate-values /secure/occ/candidate-values.yaml
```

Grant the upgrade operator read access to the exact migrator Secret and any
database CA Secret referenced by the chart. The command records their UIDs and
resource versions. Keep the database endpoint, those Secrets, other writers,
autoscalers, and Helm changes under exclusive maintenance control until resume
finishes. These checks observe the Secrets separately from the Pods that mount them.

The apply Job checks that the database has recognized history and belongs to
the recorded Installation before running SQL. A separate verification Job
checks the same Installation and requires completed history. Use a candidate
image that supports both guarded commands.

Wait for **Database migration verified and its Jobs and Pods are gone**. Then
resume the original upgrade with the same options and `--migration-history-checked`.
The command rechecks the recorded migrator and CA Secret identities before
Helm writes, including recovery.

Keep `<evidence-directory>.migration-state.json` beside the original evidence
in a directory that protects it from removal by other users. Keep the journal
outside backups that you restore over the evidence. After interruption, settle the
original local processes using [upgrade recovery](production-upgrade-recovery.md).
Repeat `migration apply` with the same inputs to read the original Job and Pod
after a log-read failure or to confirm cleanup. If a create is unknown, the apply
Job fails, or cleanup is unresolved, keep writers stopped and reconcile the
original Job, Pod, and database history. Preserve both evidence locations.
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

For Kubernetes, choose one mode before creating the
[maintenance Job](auth-maintenance.md#run-the-command). To inspect recognized history without applying SQL:

```sh
MIGRATION_ARGS="$(jq -nc \
  --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
  '["-e",$program,"--","--check"]')" || { unset MIGRATION_ARGS; false; }
```

To apply authorized pending SQL:

```sh
MIGRATION_ARGS="$(jq -nc \
  --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
  '["-e",$program,"--"]')" || { unset MIGRATION_ARGS; false; }
```

To require completed history without applying SQL:

```sh
MIGRATION_ARGS="$(jq -nc \
  --arg program "${MIGRATION_PROGRAM:?Extract the migration program first}" \
  '["-e",$program,"--","--require-current"]')" || { unset MIGRATION_ARGS; false; }
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

Use this procedure for a handoff with no tool-managed migration Job journal.

1. Keep the maintenance window active and both writers stopped. Assign `MIGRATION_ARGS`
   for apply, then create the maintenance Job with the selected immutable candidate image,
   this database's migrator credential and CA, and the guarded `args:` line above. Wait for
   completion, save the logs, delete the Job, and wait for its Pods to stop. If the
   outcome is uncertain, retain those logs and confirm the Job and Pods are terminal.
2. Assign `MIGRATION_ARGS` for `--require-current` and create a new Job against the
   same image and database. Proceed only after exit zero and `migration.checked`
   with history `completed`. Delete the check Job and
   wait for its Pods to stop. Use these migration checks, not the sign-in procedure's
   `status` command, and keep writers stopped.
3. Repeat the upgrade command with `--resume --migration-history-checked` and the original
   evidence directory. The helper rechecks both stopped Deployments’ UIDs, generations and
   replica counts. Investigate any change. The Helm hook verifies the full candidate history
   before bootstrap and service replacement. The helper verifies rollout and OCC access.

The migration advisory lock serializes migrators. The operator keeps other writers,
autoscalers and deployment clients stopped across both steps. Freeze the target database
and its connection Secret through verification. A Helm rollback cannot
reverse committed SQL. Keep the old services stopped after migration unless a separately
qualified recovery restores their matching database. The selected mode persists in Helm
values until a reviewed candidate selects `hook`.
