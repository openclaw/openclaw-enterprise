---
tags: [human_verified]
last_verified: "2026-11-18"
---

# Worker, Compose, and PostgreSQL settings

## PostgreSQL connection authentication

Both PostgreSQL API modes, the worker, shared Installation bootstrap, and
migration commands use the same connection pool factory.
`OCC_DATABASE_AUTH` defaults to `password`, preserving PostgreSQL URL
credentials. Its other mode is `azure-workload-identity`; unknown
modes fail before opening a pool.

Explicit pool options override URL query parameters. Unspecified values retain
URL, environment, and client defaults.

| Variable                     | Requirement in Azure workload-identity mode                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `OCC_DATABASE_AUTH`          | Set to `azure-workload-identity` in each connecting process.         |
| `AZURE_TENANT_ID`            | Tenant for the process's workload identity.                          |
| `AZURE_CLIENT_ID`            | Client ID for the process's workload identity.                       |
| `AZURE_FEDERATED_TOKEN_FILE` | Readable projected federation-token file, renewed by the deployment. |

This mode requires a password-free database URL with certificate and hostname
verification, such as
`postgresql://occ_app@database.example/occ?sslmode=verify-full`.
The factory rejects nested connection strings, URL passwords, missing TLS, and
parsed TLS options that disable certificate or hostname checks. Keep the
application and migrator database roles separate: API, worker, and bootstrap
use `OCC_DATABASE_URL`; migrations use `OCC_MIGRATION_DATABASE_URL` with the
migrator identity.

Each new pool connection requests an Azure SDK `WorkloadIdentityCredential` token
for `https://ossrdbms-aad.database.windows.net/.default`. The SDK handles caching
and renewal; OCC does not persist tokens or fall back to a developer login.
Use `pnpm db:migrate` or `pnpm db:migrate:production` in this mode.

See [operator setup](../../guides/deploy/azure-postgresql.md)
for deployment-owned identity inputs and chart limits, and
[PostgreSQL testing](../../testing/postgresql.md#azure-workload-identity-connections)
for the available connection proof and its limits.

## PostgreSQL server compatibility

PostgreSQL 18.6 is validated; migration, catalog, and restore checks also pass
on 17.11. Other versions remain unqualified. Servers before 17 lack `MAINTAIN` and
fail with `MIGRATION_SERVER_UNSUPPORTED` before catalog checks or writes.
Preserve the database, use a compatible server, then rerun `--check`.
Other database errors remain redacted as `MIGRATION_FAILED`.

## Migration history

Set `OCC_MIGRATION_DATABASE_URL` privately for `occ_migrator`. `occ_app` is the
application login. Neither may be a superuser, create roles or databases,
replicate, or bypass row security. The migrator needs database `CREATE` and owns
`occ` and `drizzle`; `occ_app` must neither inherit it nor have database/schema `CREATE`.

From the release checkout, inspect history without applying SQL:

```sh
pnpm db:migrate --check
```

Exit 0 and `migration.checked` identify `empty`, a stage below, or `completed`.
History stages end at these migrations (stage, receipt count when specified):

- `prePresetsMain`: `0023_runtime_failure_timestamp_validation`; `main`: `0024_agent_presets`.
- `repositoryCredentials`: `0025_repository_credentials` and `0026_privileged_function_search_paths`; `repositoryRetention`, `workspaceSetup`, and `agentProvisioning`: through `0029_agent_provisioning_work`.
- `backendCompleted` and `providerCompleted`: 31 receipts before compatibility; `backendTerminology`: 32, through `0031_backend_terminology_compatibility`.
- `prePluginApprovers`: 33, `0032_credential_sources`; `preBrokerReceipts`: 34, `0033_agent_plugin_approvers`; `preAgentDeletion`: 35, `0034_repository_broker_receipts`.
- `preDeploymentProgress`: 36, `0035_agent_deletion_repository_session_evidence`; `preHumanAuthentication`: 37, `0036_deployment_progress`; `preAgentDeletionTakeover`: 38, `0037_human_authentication`.
- `preNamespaceDeletionTakeover`: 39, `0038_agent_deletion_takeover`; `preRepositoryAccess`: 40, `0039_namespace_deletion_takeover`; `preRestrictionReadLogs`: 41, `0040_repository_access`.
- `preOAuth`: 42, `0041_restriction_read_logs`; `preCredentialWithdrawals`: 43, `0042_oauth_harness_auth`; `preBrokerReceiptFence`: 44, `0043_credential_withdrawals`.
- `preModelProbeFailureCause`: 45, `0045_repository_broker_receipt_fence`; `preProvisioningConfigurationRelease`: 46, `0046_model_probe_failure_cause`; `preAdministratorCredentialSourceGrants`: 47, `0047_provisioning_configuration_release`.
- `preCodexPatSources`: 48, `0048_administrator_credential_source_grants`; `preAgentCredentialSources`: 49, `0049_codex_pat_sources`; `preCredentialWithdrawalRequester`: 50, `0050_agent_credential_sources`.
- Later `pre*` stages add one receipt each, up to one receipt below `completed`; 60 and 61 have no stage. `catalogAtMigrationCount` in [`scripts/migration-history.mjs`](../../../scripts/migration-history.mjs) lists every stage with its receipt count.

Rerun `--check` after migration and require `completed` from the same release.

SIGINT or SIGTERM uses a second migrator connection to terminate the command's session. Reserve connection capacity. On connection failure, `migration.cancellation-failed` is reported while migration continues. Check history before retry.

The [canonical manifest](../../../migrations/meta/_canonical-history.json) records
accepted source and catalog hashes. Never delete or relabel unsupported preview
receipts. Empty schemas may be absent or owner-only, with no objects or
unexpected default privileges. An empty Drizzle ledger after a rolled-back
first migration is also supported.

For a [logical restore](../../guides/deploy/upgrade-baseline.md#record-the-database),
the manifest pairs the PostgreSQL 18.6 restored catalog with its exact native
digest. For the next schema, qualify both upgrading that restore and restoring
the new schema. A match cannot establish backup completeness or provenance.

Confirm target and authorization before running `pnpm db:migrate` or
`pnpm db:migrate:production`. Under one advisory lock, both verify source,
roles, receipts, definitions and grants. Drizzle applies pending SQL and receipts
transactionally.

The chart runs the [selected image's migration](../../guides/deploy/separate-database-upgrade.md#run-a-selected-image-migration) in one Node process.

Production `--check` inspects recognized history. [Separate service deployment](../../guides/deploy/separate-database-upgrade.md)
uses `--require-current`: pending history returns `MIGRATION_HISTORY_PENDING`,
drift returns `MIGRATION_HISTORY_UNSUPPORTED`. Neither check applies SQL or authorizes a retry.

Helm installs with `--expect-empty`. `MIGRATION_HISTORY_NOT_EMPTY` means recognized
history already exists. Inspect the original attempt and target. `empty` describes OCE
schemas only. Older controllers reject unknown options.

Compatibility appends a receipt without rewriting either published 31-receipt
history. On Provider terminology databases, it renames owned relational columns,
admitted harness and repository bindings, preset templates, retained repository
cleanup contexts, accepted provisioning plans, validation functions, and triggers
to Backend terminology. It preserves unrelated Provider terms: Better Auth `account.provider_id`,
model Provider catalogs, gateway authentication providers, repository grant
`providerInstanceId`, and historical audit payloads. Terminal provisioning rows
keep `request_fingerprint` as historical idempotency evidence while accepted
plan JSON changes `providerId` to `backendId`. Replaying an old Provider-shaped
request against the renamed API is a distinct request with a distinct fingerprint.
Preflight and migration refuse persisted objects with both keys at an owned path.

`MIGRATION_HISTORY_UNSUPPORTED` means the command refused before migration DDL.
Mixed Provider/Backend histories, partial manual edits, and the development
history that installed repository credentials at index 24 without Agent presets
remain unsupported even if their migrations completed. Renaming or rewriting
receipts cannot convert them. Do not edit the ledger, bypass the check with
Drizzle, or restore an old schema over the canonical one. A failed or disconnected
migration does not prove rollback: reconnect, run `--check`, and inspect the
retained database before considering another attempt.

### Clear legacy managed PAT bindings before `0049`

Migration `0049_codex_pat_sources` fails with `Unsupported legacy managed PAT
authentication: recreate development Agents, revisions, and provisioning
requests before migrating` when an Agent draft, any AgentRevision, or a
provisioning plan still holds a retired `chatgpt_service_account` binding.
An authorized operator can clear a draft-only binding if the installed
controller supports it. No API deletes individual Agent revisions or provisioning
requests. If the binding cannot be cleared, [deleting the Agent](../agents.md#deletion)
removes its revisions and associated requests. Recreate it after upgrading.

A provisioning request that never created an Agent survives Agent deletion.
Let queued or running requests finish. Then, as the migration role, list the
remaining ones and delete those that failed or were cancelled. Deleting the
`occ.controller_work` row removes its request row, as Agent deletion does:

```sql
SELECT work_id, status FROM occ.agent_provisioning_work
WHERE agent_id IS NULL
  AND plan #>> '{harnessAuth,method}' = 'chatgpt_service_account';

DELETE FROM occ.controller_work
WHERE work_kind = 'provisioning'
  AND idempotency_key IN (
    SELECT work_id FROM occ.agent_provisioning_work
    WHERE agent_id IS NULL AND status IN ('failed', 'cancelled')
      AND plan #>> '{harnessAuth,method}' = 'chatgpt_service_account');
```

Alternatively, [recreate the disposable installation](#recreate-an-unsupported-disposable-development-installation).
In-place conversion is unsupported.

### Recreate an unsupported disposable development installation

First match the target to the startup output: container engine and connection,
Compute profile, Compose project/files or Kubernetes state directory, database
host/port/name, and Installation ID. The database-only
`compose.postgres.yaml` helper and the full development stack have different
default project names. `pnpm db:down` stops only its selected database-only
project and retains its volume.

For unsupported premerge history, retain the old installation and separately
configure a fresh one, or discard that specific disposable installation. Preserve
needed database/storage archives and protected bootstrap inputs first. Archives
are not supported imports into canonical history; whole-database restore also
restores the unsupported ledger. No general reset, conversion, or reseed exists.
Recreate selected business data through its owning supported API or import
procedure. Account for Agent resources and credential cleanup before disposal:
removing control-plane storage does not retire external resources or grants.

For Docker or Podman, copy the exact `Cleanup` command printed by the original
startup. Add `--volumes` before its `--` only when intentionally deleting that
installation's PostgreSQL and Configuration volumes. Preserve its
engine connection, environment, project, Compose files, and overrides. For
example, after setting `DEV_COMPOSE_PROJECT` to your own recorded project:

```sh
export OCC_DEVELOPMENT_COMPUTE_DRIVER=docker
./bin/occ dev down --volumes -- -p "$DEV_COMPOSE_PROJECT" -f compose.yaml
./bin/occ dev up --key-output /absolute/private/new-installation-key.json -- \
  -p "$DEV_COMPOSE_PROJECT" -f compose.yaml
```

The recorded Kubernetes cleanup is already destructive: it removes that
profile's cluster and Compose volumes, then removes its private state. Use its
exact printed command and state directory:

```sh
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
OCC_DEVELOPMENT_STATE_DIRECTORY="$DEV_STATE_DIRECTORY" ./bin/occ dev down
```

Start the chosen fresh profile from the canonical source using a new protected
key-output path. `occ dev up` applies migrations, bootstraps the initial
administrators/Installation/default Namespace, and checks authenticated
Installation access using locally prepared CLI key JSON. Repeating bootstrap
verifies the existing Installation without reading inputs or issuing keys.

Use the startup's printed authenticated-check command, or privately select
`OCC_URL` and `OCC_SERVICE_KEY_FILE` and run:

```sh
./bin/occ installation get --output json
```

The authenticated response supplies the server-owned Installation ID; locally
prepared bootstrap key JSON has no Installation metadata. Stop on unexpected IDs,
missing credentials, failed migration,
uncertain bootstrap outcome, or incomplete cleanup. This proves control-plane
access; qualify worker, Agent, repository, and provider behavior separately.

## Controller worker environment

The [controller worker](../controller.md) uses a bootstrapped Installation and
the API's migrated PostgreSQL database, not its listener or authentication settings.

| Variable                            | Requirement or default         | Behavior                                                                                                                                                                         |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                          | `development` or `production`. | Both modes process Namespace and selected AgentRevision work through the selected Compute Driver.                                                                                |
| `OCC_DATABASE_URL`                  | Required application-role URL. | Must use a `postgresql:` or `postgres:` connection to the API's PostgreSQL database.                                                                                             |
| `OCC_CONFIG_PATH`                   | Required in production.        | Absolute startup YAML shared with the API; development omits it to use the Docker Compute default or sets it to explicitly select another trusted Driver set.                    |
| `OCC_WORKER_POLL_INTERVAL_MS`       | `250`.                         | Positive integer controlling the delay between idle polling attempts; at most `2147483647`.                                                                                      |
| `OCC_WORKER_LEASE_DURATION_MS`      | `5000`.                        | Positive integer controlling the claim lease in milliseconds; at most `2147483647`.                                                                                              |
| `OCC_WORKER_MAX_ATTEMPTS`           | `5`.                           | Positive safe integer limiting attempts before permanent failure.                                                                                                                |
| `OCC_WORKER_CONVERGENCE_TIMEOUT_MS` | `900000`.                      | Positive safe integer for [Namespace, Agent and live SandboxPolicy convergence](../controller/reconciliation.md#deferred-namespace-and-agent-convergence), including queue time. |
| `OCC_WORKER_DATABASE_TIMEOUT_MS`    | `60000`.                       | Client-side bound on each worker query and connection; a silent connection is dropped and retried, and longer lock waits fail the pass as an attempt; at most `2147483647`.      |
| `OCC_WORKER_READINESS_PATH`         | Optional absolute path.        | Writes a private freshness marker after real queue-health observations; required by packaged worker probes.                                                                      |
| `OCC_WORKER_LIVENESS_PATH`          | Optional absolute path.        | Writes a private marker as the run loop makes progress, even through database outages; the packaged liveness probe restarts a worker whose marker is stale.                      |

Packaged worker probes require regular marker files and refuse directory paths.

The run loop writes the liveness marker at startup, at the start of every pass
and on every claim renewal. A database outage keeps it moving; the packaged
liveness probe fails only when it is older than
`max(120 s, 240 polls, 6 leases, 2 database timeouts)`.

Start the worker only after the controller is healthy and the Installation exists:

```bash
NODE_ENV=development \
OCC_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_enterprise \
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart \
OPENAI_API_KEY=${OPENAI_API_KEY:?set OPENAI_API_KEY} \
node apps/controller/src/worker.mjs
```

For production, set the shared PostgreSQL connection and absolute Installation
startup YAML path first, then start the API and worker as separate processes:

```bash
NODE_ENV=production node apps/controller/src/server.mjs
NODE_ENV=production node apps/controller/src/worker.mjs
```

The worker never handles controller API sessions. In production it claims,
recovers, and counts Namespace work plus embedded OpenClaw and dedicated Codex
AgentRevision work. Each Agent has its own selected version; the worker does not
impose a Namespace-wide Agent limit.

## Local Compose and PostgreSQL configuration

The root Compose development stack starts PostgreSQL 18.6, migrations,
bootstrap, API, and worker. `occ dev up` starts the supported development
profile; the checkout-local `scripts/dev-up` entry point uses the same path.
Startup prepares private credential files outside the checkout, validates
Compose configuration, waits for services, and proves authenticated access with
the locally prepared CLI key file. `OCC_DEVELOPMENT_COMPUTE_DRIVER` selects Docker Compute or Kubernetes
Compute. Kubernetes Compute can use a Compose control plane or the
[Kubernetes-only profile](../../guides/deploy/local-kubernetes-development.md).
The helper prefers a usable Docker Engine and otherwise selects Podman directly,
even when no `docker` compatibility alias exists. Podman requires the standalone
`podman-compose` provider; Docker Compute also requires `yq` v4. The helper
pins that provider for consistent behavior. Docker Compute mounts the selected engine socket into its
worker. That socket-owning worker disables SELinux process labeling because the
host engine socket must not be relabeled; all other services retain SELinux
confinement. Direct `docker compose` commands remain supported. The Podman
override supplies the reported Podman socket and is not used with Docker Engine.
[`compose.postgres.yaml`](../../../compose.postgres.yaml) remains the focused
database-only helper for tests and manual PostgreSQL debugging.

[`compose.logging.yaml`](../../../compose.logging.yaml) enables Docker development collection
and mounts [`deploy/logging/occ.yaml`](../../../deploy/logging/occ.yaml) as
`/etc/openclaw/occ.yaml` in OCC services. Follow the
[Docker observability procedure](../../guides/observability.md#docker-compose)
for receiver/exporter setup, persistent queue storage, and verification. Podman
development rejects this override because the supported Podman runtime does not
provide Docker's Fluentd logging driver and options.

Development logging override variables:

| Variable                           | Default or requirement                         | Behavior                                                                                                         |
| ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Required when `compose.logging.yaml` is used.  | Passed only to the Collector exporter; use HTTPS for real backends and HTTP only for local test receivers.       |
| `OTEL_COLLECTOR_PORT`              | `24224`.                                       | Publishes the Collector Fluent Forward receiver on `127.0.0.1:<port>`.                                           |
| `OTEL_COLLECTOR_METRICS_PORT`      | `8888`.                                        | Publishes Collector self-metrics on `127.0.0.1:<port>`.                                                          |
| `OCC_DOCKER_LOGGING_ADDRESS`       | `127.0.0.1:24224` when the override is active. | Tells Docker Compute where the Engine should forward managed gateway and Codex container logs; keep it loopback. |

Both Compose files bind PostgreSQL to loopback:

| Variable            | Default | Behavior                                                                                              |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `OCC_POSTGRES_PORT` | `55432` | Maps `127.0.0.1:<port>` to container port `5432`. Update every PostgreSQL connection URL to match it. |

The fixed bridge CIDR must not overlap another local container network. For a
second isolated Compose project, select an unused value through
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR`; the same value configures the controller's
explicitly trusted development bridge.

The Compose service fixes `POSTGRES_DB=openclaw_enterprise`,
`POSTGRES_USER=postgres`, and `POSTGRES_PASSWORD=openclaw-local-admin`. These
values describe a local-only disposable service; they are not controller
environment variables or production credentials.

[`migrations/init-local.sql`](../../../migrations/init-local.sql) creates separate
least-privilege local roles:

| Role           | Local-only password    | Purpose                                                                                     |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `occ_app`      | `occ-app-local`        | Controller runtime and application-role integration tests.                                  |
| `occ_migrator` | `occ-migrator-local`   | Reviewed Drizzle migrations and migration-history ownership.                                |
| `postgres`     | `openclaw-local-admin` | Local Compose administration only; do not use this role as the controller application role. |

Never give the controller the migrator or administrator URL. The application
role cannot create schema objects, modify migration history, or rewrite
immutable audit and Agent revision records.

For database-only debugging, start PostgreSQL and apply migrations using its
dedicated role:

```bash
docker compose -f compose.postgres.yaml up -d --wait

export OCC_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_enterprise
pnpm db:migrate
```

Add the application connection URL to the [required development controller environment](development.md#required-development-controller-environment), then initialize before starting the same server manually. Use an
private input directory outside the checkout. Follow the
[input contract](../authentication.md#installation-and-account-ownership) and
[credential generation example](../../guides/deploy/production-installation-preparation.md#shared-credential-and-configuration-checks).
Retain the files; reinitialization does not reissue keys. For host-process debugging:

```bash
export OCC_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_enterprise
export OCC_DATABASE_POOL_MAX=10
export OCC_DEVELOPMENT_CONFIGURATION_ROOT="$(pwd)/.development/configurations"
export OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE='/absolute/private-directory/admin-password'
export OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE='/absolute/private-directory/admin-service-key'
NODE_ENV=development node scripts/bootstrap-installation.mjs
NODE_ENV=development node apps/controller/src/server.mjs
```

Installation, Namespace, Agent, native IAM, audit, and controller-work state
survive restart in both Compose and database-only modes. The full Compose path
also starts the worker and selects Docker Compute by default.

Compose keeps relational OCC metadata in the `occ_postgres_data` named volume
and native development Configuration documents in the `occ_configuration_data`
named volume. The configuration volume is mounted only into the controller at
`/app/.development/configurations`; it is not mounted into the worker or
runtime containers. Bootstrap alone receives the two input files as Compose
secrets at `/run/secrets/admin-password` and `/run/secrets/admin-service-key`;
migration, API, and worker do not receive them. For Docker Compute, the printed
cleanup command retains both named volumes and uses the selected container engine. Podman cleanup retains
the caller's `CONTAINER_CONNECTION` or `CONTAINER_HOST` selection.
Add `--volumes` before any `--` separator only when
intentionally deleting those volumes. Private credential files are separate.
[Kubernetes development cleanup](../../guides/deploy/local-kubernetes-development.md#stop-and-clean-up)
always deletes the selected profile's volumes.

### Migration environment

| Variable                     | Required by                      | Behavior                                                                                                     |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `OCC_MIGRATION_DATABASE_URL` | Drizzle configuration and tools. | Must contain the dedicated `occ_migrator` connection URL. Drizzle commands fail when the variable is absent. |

[`drizzle.config.ts`](../../../drizzle.config.ts) fixes the PostgreSQL dialect,
[`packages/occ/src/state/postgres-schema.ts`](../../../packages/occ/src/state/postgres-schema.ts)
as the relational schema, [`migrations/`](../../../migrations) as the migration
directory, the `occ` application schema, and
`drizzle.__drizzle_migrations` as the migration-history table. `strict` and
`verbose` are enabled. There are no environment overrides for these settings.
