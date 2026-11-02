# Prepare PostgreSQL for production

Use PostgreSQL 18.6 for a production installation. It is the validated baseline
for OCE migrations, catalog checks, and logical restore. PostgreSQL 16 cannot
run the catalog checks. The same workflow checks also pass on PostgreSQL 17.11;
this does not establish compatibility with every release of 17 or later.

Before installing or upgrading the control plane:

1. Ask the database administrator to confirm the server version with
   `SHOW server_version;` on the intended database.
2. Provision separate `occ_migrator` and `occ_app` logins with the
   [required ownership and grants](../../reference/settings/operations.md#migration-history).
   Use verified TLS and keep both connection URLs in protected files, as described
   in [installation inputs](production-installation.md#shared-bootstrap-pvc-and-configuration-checks).
3. From the selected release checkout, set `OCC_MIGRATION_DATABASE_URL` privately
   and run `pnpm db:migrate:production --check`. Require exit 0 and
   `migration.checked`. A first installation needs `empty`; an upgrade needs a
   [recognized history](../../reference/settings/operations.md#migration-history).

`MIGRATION_SERVER_UNSUPPORTED` means the server is too old for the required
`MAINTAIN` privilege check. The command stops before reading migration catalogs
or changing schema or data. Preserve an existing database and its backup. Have
the database administrator prepare a compatible server, then repeat `--check`
with the selected OCE release before continuing. Do not delete migration receipts
or retry an upgrade with a different application credential.

See [migration diagnostics](../../reference/settings/operations.md#postgresql-server-compatibility)
for the distinction between server compatibility and migration-history failures.
