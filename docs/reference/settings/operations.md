# Worker, Compose, and PostgreSQL settings

This reference owns worker, compose, and postgresql settings. Start with the
[settings reference](../settings.md) for startup configuration and precedence.

## PostgreSQL connection authentication

Both PostgreSQL API modes, the worker, shared Installation bootstrap, and
`node scripts/migrate-production.mjs` use the same connection pool factory.
`OCC_DATABASE_AUTH` defaults to `password`, which preserves PostgreSQL URL
credentials. The other supported mode is `azure-workload-identity`; unknown
modes fail before opening a pool.

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

Each new pool connection requests an access token through the Azure SDK's
`WorkloadIdentityCredential` for
`https://ossrdbms-aad.database.windows.net/.default`. The SDK owns token caching
and renewal; OCC does not persist tokens or fall back to a developer login.
Use `node scripts/migrate-production.mjs` for migrations in this mode. The
development Drizzle CLI migration command does not use the shared factory.

See [operator setup](../../guides/deploy/production-installation.md#azure-postgresql-workload-identity)
for deployment-owned identity inputs and chart limits, and
[PostgreSQL testing](../../testing/postgresql.md#azure-workload-identity-connections)
for the available connection proof and its limits.

## Controller worker environment

The [controller worker](../controller.md) runs separately from the HTTP API. It
requires a bootstrapped Installation and the same migrated PostgreSQL database;
it does not use the API's listener or authentication settings.

| Variable                            | Requirement or default         | Behavior                                                                                                                                                      |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                          | `development` or `production`. | Both modes process Namespace and selected AgentRevision work through the selected Compute Driver.                                                             |
| `OCC_DATABASE_URL`                  | Required application-role URL. | Must use a `postgresql:` or `postgres:` connection to the API's PostgreSQL database.                                                                          |
| `OCC_CONFIG_PATH`                   | Required in production.        | Absolute startup YAML shared with the API; development omits it to use the Docker Compute default or sets it to explicitly select another trusted Driver set. |
| `OCC_WORKER_POLL_INTERVAL_MS`       | `250`.                         | Positive safe integer controlling the delay between idle polling attempts.                                                                                    |
| `OCC_WORKER_LEASE_DURATION_MS`      | `5000`.                        | Positive safe integer controlling the claim lease in milliseconds.                                                                                            |
| `OCC_WORKER_MAX_ATTEMPTS`           | `5`.                           | Positive safe integer limiting attempts before permanent failure.                                                                                             |
| `OCC_WORKER_CONVERGENCE_TIMEOUT_MS` | `900000`.                      | Positive safe integer bounding Namespace convergence from operation creation.                                                                                 |
| `OCC_WORKER_READINESS_PATH`         | Optional absolute path.        | Writes a private freshness marker after real queue-health observations; required by packaged worker probes.                                                   |

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
AgentRevision work. Each Agent has its own active revision; the worker does not
impose a Namespace-wide Agent limit.

## Local Compose and PostgreSQL configuration

The root Compose development stack starts PostgreSQL 18.6, migrations,
bootstrap, API, and worker. `scripts/dev-up` is the recommended wrapper for the
full stack because it validates Compose configuration, waits for startup, copies
the bootstrap service-key response to a private file, and proves authenticated
access. The helper prefers a usable Docker Engine and otherwise selects Podman
directly, even when no `docker` compatibility alias exists. Podman requires the
standalone `podman-compose` provider and `yq` v4; the helper pins that provider
for consistent behavior. Its helper-owned override mounts the reported API
socket into the worker and disables SELinux labeling only for that socket-owning
service. Direct `docker compose` commands remain supported. The Podman override
is helper-owned; do not apply it to Docker Engine.
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

Both Compose files bind the PostgreSQL host port to loopback only. The following
value controls Compose port substitution:

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
immutable audit and revision records.

For database-only debugging, start PostgreSQL and apply migrations using its
dedicated role:

```bash
docker compose -f compose.postgres.yaml up -d --wait

export OCC_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_enterprise
node_modules/.bin/drizzle-kit migrate
```

Add the application connection URL to the [required development controller environment](development.md#required-development-controller-environment), then initialize before starting the same server manually. Use an
existing private output directory and an unused absolute filename for fresh
setup. Retain that directory for credential recovery; subsequent initialization
does not reissue a key. This path is only for intentional host-process debugging:

```bash
export OCC_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_enterprise
export OCC_DATABASE_POOL_MAX=10
export OCC_DEVELOPMENT_CONFIGURATION_ROOT="$(pwd)/.development/configurations"
export OCC_BOOTSTRAP_SERVICE_KEY_FILE='/absolute/private-directory/initial-admin-service-key.json'
NODE_ENV=development node scripts/bootstrap-installation.mjs
NODE_ENV=development node apps/controller/src/server.mjs
```

Installation, Namespace, Agent, native IAM, audit, and controller-work state
survive restart in both Compose and database-only modes. The full Compose path
also starts the worker and selects Docker Compute-backed Namespace and
AgentRevision execution by default.

Compose keeps relational OCC metadata in the `occ_postgres_data` named volume
and native development Configuration documents in the `occ_configuration_data`
named volume. The configuration volume is mounted only into the controller at
`/app/.development/configurations`; it is not mounted into the worker or
runtime containers. Initial service-key output uses a third bootstrap-only
volume, `occ_bootstrap_data`, at `/var/lib/openclaw/bootstrap`; the API and
worker do not mount it. The cleanup command printed by `dev-up` retains all
three volumes. Add `--volumes` only when intentionally deleting them, including
the initial credential delivery copy.

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
