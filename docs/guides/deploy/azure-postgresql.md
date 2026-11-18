# Configure Azure PostgreSQL workload identity

Use this page only when the OCE database uses Azure workload-identity
authentication. It is optional for [Kubernetes installation](production-installation.md).
The Helm chart does not configure identity federation or token projections.

## Requirements

- The shared [Kubernetes requirements](production-installation.md#requirements).
- Separate application and migrator workload identities, federation, and database grants; keep migrator privileges confined to migration.
- Password-free database URLs with certificate and hostname verification.
- Identity environment variables and a readable, renewed federation-token projection for migration, bootstrap, API, and worker processes.

## Prepare each database client

1. Prepare the protected application and migration URL files used by
   [system Secret provisioning](production-installation.md#provision-system-secrets-and-install).
   Use the application identity for bootstrap, API, and worker; use the migrator
   identity only for migration.
2. Configure each process with `OCC_DATABASE_AUTH=azure-workload-identity` and its
   [identity inputs](../../reference/settings/operations.md#postgresql-connection-authentication).
   The deployment must renew each projected federation-token file.
3. Use the [selected-image migration command](separate-database-upgrade.md#run-a-selected-image-migration)
   with the migrator identity when preparing the database.

## Helm boundary

Migration and bootstrap share an initialization Pod and service account.
The operator must supply their distinct identity inputs; changing the database
URL Secrets alone does not enable Azure mode. The stock chart does not provide
this identity configuration.

Resume [control plane installation](production-installation.md) only after the
deployment supplies the required identity inputs to each database client.
See [connection behavior](../../reference/settings/operations.md#postgresql-connection-authentication)
for token renewal and rejected configurations.
