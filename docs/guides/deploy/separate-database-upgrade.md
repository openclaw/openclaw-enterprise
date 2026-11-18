# Deploy the database before replacing services

Follow the [production upgrade preparation](production-upgrade.md#prepare-the-release), including the backup and exclusive maintenance window.

By default Helm migrates, bootstraps and restores Deployments. To deploy the
database separately, set `database.upgradeMigration: separate` in the reviewed
candidate values. Use a candidate controller image that supports `--require-current`.
The helper exits **3** after both writers stop and before submitting Helm.

## Run a selected-image migration

Read the migration program from the reviewed chart. From the reviewed release checkout root:

```sh
MIGRATION_PROGRAM="$(cat deploy/helm/openclaw-enterprise/files/migrate-selected-image.cjs && printf .)"
MIGRATION_PROGRAM="${MIGRATION_PROGRAM%.}"
```

Without a checkout, set `CHART_ARCHIVE` to the reviewed packaged chart and read the same file:

```sh
MIGRATION_PROGRAM="$(tar -xOf "$CHART_ARCHIVE" openclaw-enterprise/files/migrate-selected-image.cjs && printf .)"
MIGRATION_PROGRAM="${MIGRATION_PROGRAM%.}"
```

The final assignment preserves the program's trailing newline. Set `CONTROLLER_IMAGE`
to the selected immutable controller image and export `OCC_MIGRATION_DATABASE_URL`
with its migrator credential. To check the image directly:

```sh
docker run --rm --env NODE_ENV=production --env OCC_MIGRATION_DATABASE_URL \
  "$CONTROLLER_IMAGE" -e "$MIGRATION_PROGRAM" -- --check
```

Supply the database CA and network access required by the selected connection. The program
reads the image's production migration entry from `package.json`, accepts the supported
JavaScript or TypeScript entry, and loads it in the same Node process.

For Kubernetes, choose one mode before creating the
[maintenance Job](auth-maintenance.md#run-the-command). To inspect recognized history without applying SQL:

```sh
MIGRATION_ARGS="$(jq -nc --arg program "$MIGRATION_PROGRAM" '["-e",$program,"--","--check"]')"
```

To apply authorized pending SQL:

```sh
MIGRATION_ARGS="$(jq -nc --arg program "$MIGRATION_PROGRAM" '["-e",$program,"--"]')"
```

To require completed history without applying SQL:

```sh
MIGRATION_ARGS="$(jq -nc --arg program "$MIGRATION_PROGRAM" '["-e",$program,"--","--require-current"]')"
```

In the Job's original unquoted `<<EOF` heredoc, replace its `args:` line with
this literal YAML line:

```yaml
args: $MIGRATION_ARGS
```

Keep the heredoc unquoted so `RELEASE`, `DATABASE_CA_SECRET`, `CONTROLLER_IMAGE`,
and `MIGRATION_ARGS` expand. Do not paste the generated JSON directly into the
heredoc: Bash would change the program's escapes. Keep `--` so the arguments
match the chart invocation, including for apply. For a check mode, a missing or
extra separator fails before migration.

## Deploy the database

1. Keep the maintenance window active and both writers stopped. Assign `MIGRATION_ARGS`
   for apply, then create the maintenance Job with the selected immutable candidate image,
   this database's migrator credential and CA, and `args: $MIGRATION_ARGS`. Wait for
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
