# Deploy the database before replacing services

Follow the [production upgrade preparation](production-upgrade.md#prepare-the-release), including the backup and exclusive maintenance window.

By default Helm migrates, bootstraps and restores Deployments. To deploy the
database separately, set `database.upgradeMigration: separate` in the reviewed
candidate values. Use a candidate controller image that supports `--require-current`.
The helper exits **3** after both writers stop and before submitting Helm.

1. Keep the maintenance window active. Use the [maintenance Job](auth-maintenance.md#run-the-command)
   with the selected immutable candidate image, this database's migrator credential and CA,
   and args `["scripts/migrate-production.mjs"]`. Wait for the Job to finish.
2. If its outcome is uncertain, preserve its logs and confirm the Job and Pods are terminal.
   Check the same image and database with `["scripts/migrate-production.mjs","--require-current"]`.
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
