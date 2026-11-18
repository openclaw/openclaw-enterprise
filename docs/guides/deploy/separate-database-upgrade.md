# Deploy the database before replacing services

Follow the [production upgrade preparation](production-upgrade.md#prepare-the-release), including the backup and exclusive maintenance window.

By default Helm migrates, bootstraps and restores Deployments. To deploy the
database separately, set `database.upgradeMigration: separate` in the reviewed
candidate values. Use a candidate controller image that supports `--require-current`.
The helper exits **3** after both writers stop and before submitting Helm.

## Run a selected-image migration

For an image-only check, read the migration program from the reviewed chart and pass it to
the selected immutable controller image. The image declares its own production migration
entry point in `package.json`; the program accepts the supported JavaScript or TypeScript
entry point and loads it in the same Node process.

```sh
MIGRATION_PROGRAM="$(cat deploy/helm/openclaw-enterprise/files/migrate-selected-image.cjs)"
docker run --rm --env NODE_ENV=production --env OCC_MIGRATION_DATABASE_URL \
  "$CONTROLLER_IMAGE" -e "$MIGRATION_PROGRAM" -- --check
```

Supply the database CA and network access required by the selected connection. On Kubernetes,
use the [maintenance Job](auth-maintenance.md#run-the-command) with
`CONTROLLER_IMAGE` set to the selected image. Replace its `args` with the JSON produced by:

```sh
jq -nc --arg program "$MIGRATION_PROGRAM" '["-e",$program,"--","--check"]'
```

Keep the `--` before the migration option. A missing or extra separator fails before
migration. To apply authorized pending SQL, omit `--check`; to require a completed
history without applying SQL, replace it with `--require-current`.

## Deploy the database

1. Keep the maintenance window active. Use the [maintenance Job](auth-maintenance.md#run-the-command)
   with the selected immutable candidate image, this database's migrator credential and CA,
   and the selected-image arguments without a mode option. Wait for the Job to finish.
2. If its outcome is uncertain, preserve its logs and confirm the Job and Pods are terminal.
   Check the same image and database with the same arguments plus `--require-current`.
   Proceed only after exit zero and `migration.checked` with history `completed`.
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
