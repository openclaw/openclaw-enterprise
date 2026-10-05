# Worker, Compose, and PostgreSQL settings

This reference owns worker, compose, and postgresql settings. Start with the
[settings reference](../settings.md) for startup configuration and precedence.

## PostgreSQL connection authentication

Both PostgreSQL API modes, the worker, shared Installation bootstrap, and
both migration commands use the same connection pool factory.
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
Use `pnpm db:migrate` or `pnpm db:migrate:production` for migrations in this mode.

See [operator setup](../../guides/deploy/production-installation.md#azure-postgresql-workload-identity)
for deployment-owned identity inputs and chart limits, and
[PostgreSQL testing](../../testing/postgresql.md#azure-workload-identity-connections)
for the available connection proof and its limits.

## Migration history

Set `OCC_MIGRATION_DATABASE_URL` privately to the intended database's dedicated
`occ_migrator` login. The application login is `occ_app`; neither role may be a
superuser, create roles or databases, replicate, or bypass row security. The
migrator needs database `CREATE` and owns the `occ` and `drizzle` schemas. The
application role must not inherit the migrator or have database/schema `CREATE`.

Classify a database without applying migrations:

```sh
pnpm db:migrate --check
```

An exit-0 `migration.checked` record reports one reviewed history shape:
`empty`, `prePresetsMain`, `main`, `repositoryCredentials`,
`repositoryRetention`, `workspaceSetup`, `agentProvisioning`,
`backendCompleted`, `providerCompleted`, `backendTerminology`, `prePluginApprovers`,
`preBrokerReceipts`, `preAgentDeletion`, `preDeploymentProgress`,
`preHumanAuthentication`, `preAgentDeletionTakeover`,
`preNamespaceDeletionTakeover`, `preRepositoryAccess`, `preRestrictionReadLogs`,
`preOAuth`, `preCredentialWithdrawals`, `preBrokerReceiptFence`,
`preModelProbeFailureCause`, or `completed`.
`prePresetsMain` means
the exact canonical history through `0023_runtime_failure_timestamp_validation`;
`main` also includes `0024_agent_presets`. `repositoryCredentials` adds
`0025_repository_credentials` and `0026_privileged_function_search_paths`.
`repositoryRetention`, `workspaceSetup`, and `agentProvisioning` add migrations
through `0029_agent_provisioning_work`. `backendCompleted` is the exact
31-receipt Backend terminology history published before the compatibility
migration. `providerCompleted` is the exact 31-receipt Provider terminology
history published before the rename. `backendTerminology` has the 32 receipts
through `0031_backend_terminology_compatibility`; `prePluginApprovers` adds
`0032_credential_sources` for 33 receipts. `preBrokerReceipts` has 34 receipts
through `0033_agent_plugin_approvers`; `preAgentDeletion` has 35 through
`0034_repository_broker_receipts`; `preDeploymentProgress` has 36 through
`0035_agent_deletion_repository_session_evidence`. `preHumanAuthentication` has
the 37 receipts through `0036_deployment_progress`; `preAgentDeletionTakeover`
has 38 through `0037_human_authentication`; `preNamespaceDeletionTakeover` has
39 through `0038_agent_deletion_takeover`; `preRepositoryAccess` has 40 through
`0039_namespace_deletion_takeover`; `preRestrictionReadLogs` has 41 through
`0040_repository_access`; `preOAuth` has 42 through
`0041_restriction_read_logs`; `preCredentialWithdrawals` has 43 through
`0042_oauth_harness_auth`; `preBrokerReceiptFence` has 44 through
`0043_credential_withdrawals`; `preModelProbeFailureCause` has 45 through
`0045_repository_broker_receipt_fence`; `preProvisioningConfigurationRelease`
has 46 through `0046_model_probe_failure_cause`;
`preAdministratorCredentialSourceGrants` has 47 through
`0047_provisioning_configuration_release`. `completed` is the current canonical
history with all receipts, including `0048_administrator_credential_source_grants`.
The source manifest is
[`migrations/meta/canonical-history.json`](../../../migrations/meta/canonical-history.json).
Empty schemas may be absent or have only their owner's ordinary `CREATE` and
`USAGE` privileges, with no objects or unexpected default privileges. An empty
stock Drizzle ledger left by a rolled-back first migration is also supported.

Run `pnpm db:migrate` for development or `pnpm db:migrate:production` for
production after a successful check. Both commands validate source hashes,
receipts, catalog definitions, effective application privileges, and role
separation under one PostgreSQL advisory lock. Drizzle applies the pending SQL
and receipts in its normal transaction on that same connection. Existing
canonical receipts remain unchanged. `--check` is also accepted by the
production command.

The compatibility migration appends a new receipt instead of rewriting either
published 31-receipt history. On a Provider terminology database it renames the
owned relational columns, admitted harness and repository bindings, preset
templates, retained repository cleanup contexts, accepted provisioning plans,
validation functions, and trigger definitions to Backend terminology. It
preserves unrelated Provider terms such as Better Auth `account.provider_id`,
model Provider catalogs, gateway authentication providers, repository grant
`providerInstanceId`, and historical audit payloads. Existing terminal
provisioning rows keep their `request_fingerprint` as historical idempotency
evidence while the accepted plan JSON is rewritten from `providerId` to
`backendId`. Replaying the old public Provider-shaped request against the
renamed API is a distinct request and receives a distinct fingerprint. The
preflight and migration both refuse a persisted object that contains both old
and new keys at one of these owned paths.

`MIGRATION_HISTORY_UNSUPPORTED` means the command refused before migration DDL.
Mixed Provider and Backend receipt histories, partial manual edits, and the
earlier development history that installed repository credentials at index 24
without Agent presets are unsupported, even if all of their own migrations
completed. They cannot be converted by renaming or rewriting applied receipts.
Do not edit the ledger, run Drizzle directly to bypass the check, or restore an
old schema over the canonical one. A failed or disconnected migration is not
proof of rollback: reconnect, run `--check`, and inspect the retained database
before deciding whether another attempt is appropriate.

### Recreate an unsupported disposable development installation

First match the target to the startup output: container engine and connection,
Compute profile, Compose project/files or Kubernetes state directory, database
host/port/name, and Installation ID. The database-only
`compose.postgres.yaml` helper and the full development stack have different
default project names. `pnpm db:down` stops only its selected database-only
project and retains its volume.

For an unsupported premerge history, choose either to retain the old
installation and start a separately configured fresh one, or to discard that
specific disposable installation. Preserve any needed database/storage archive
and protected bootstrap output first. An archive is not a supported import into
the canonical history; a whole-database restore would restore the unsupported
ledger too. There is no general reset, conversion, or reseed command. Recreate
selected business data through its owning supported API or import procedure.
Account for outstanding Agent resources and credential cleanup before disposal;
removing control-plane storage does not retire external resources or grants.

For Docker or Podman, copy the exact `Cleanup` command printed by the original
startup. Add `--volumes` before its `--` only when intentionally deleting that
installation's PostgreSQL, Configuration, and bootstrap volumes. Preserve its
engine connection, environment, project, Compose files, and overrides. For
example, after setting `DEV_COMPOSE_PROJECT` to your own recorded project:

```sh
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
Installation access. Fresh bootstrap refuses existing output files; an old
bootstrap volume or key file is not valid output for the new database. Repeating
bootstrap against an existing Installation verifies it and issues no new key.

Use the startup's printed authenticated-check command, or privately select
`OCC_URL` and `OCC_SERVICE_KEY_FILE` and run:

```sh
./bin/occ installation get --output json
```

Its Installation ID must match the protected key response's
`meta.installationId`. Stop on mismatches, missing output, failed migration,
uncertain bootstrap outcome, or incomplete cleanup. This proves control-plane
access; qualify worker, Agent, repository, and provider behavior separately.

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
| `OCC_WORKER_DATABASE_TIMEOUT_MS`    | `60000`.                       | Client-side bound on each worker query and connection; a silent connection is dropped and retried, and longer lock waits fail the pass as an attempt.         |
| `OCC_WORKER_READINESS_PATH`         | Optional absolute path.        | Writes a private freshness marker after real queue-health observations; required by packaged worker probes.                                                   |
| `OCC_WORKER_LIVENESS_PATH`          | Optional absolute path.        | Writes a private marker as the run loop makes progress, even through database outages; the packaged liveness probe restarts a worker whose marker is stale.   |

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
AgentRevision work. Each Agent has its own active revision; the worker does not
impose a Namespace-wide Agent limit.

## Local Compose and PostgreSQL configuration

The root Compose development stack starts PostgreSQL 18.6, migrations,
bootstrap, API, and worker. `occ dev up` starts the supported development
profile; the checkout-local `scripts/dev-up` entry point uses the same path.
Startup validates Compose configuration, waits for services, copies
the bootstrap service-key response to a private file, and proves authenticated
access. `OCC_DEVELOPMENT_COMPUTE_DRIVER` selects Docker Compute or Kubernetes
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
worker do not mount it. For Docker Compute, the printed cleanup command retains
all three volumes and uses the selected container engine. Podman cleanup retains
the caller's `CONTAINER_CONNECTION` or `CONTAINER_HOST` selection.
Add `--volumes` before any `--` separator only when
intentionally deleting them, including the initial credential delivery copy.
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
