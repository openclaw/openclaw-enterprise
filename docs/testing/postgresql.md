# PostgreSQL tests

## Overview

Run database tests against disposable PostgreSQL databases. Use the migrator
role for migrations and the less-privileged application role for tests. Missing
URLs skip cases, so check the test results for skips.

<a id="revision-worker-tests" class="anchor-alias"></a>

## Version-worker tests

The application lane prepares isolated databases and removes its resources on
exit. Its PostgreSQL server is disposable, so preparation turns off `fsync`,
`synchronous_commit` and `full_page_writes` there; keep no data in it. Each run
needs its own state file. With Docker Compose available, run:

```sh
(
  set -eu
  umask 077
  PG_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oce-postgres.XXXXXX")"
  printf 'Run directory: %s\n' "$PG_RUN_DIR"
  trap 'status=$?; node scripts/ci/cleanup.mjs --state "$PG_RUN_DIR/state.json" || status=1; exit "$status"' EXIT
  node scripts/ci/prepare.mjs --lane postgres-application \
    --state "$PG_RUN_DIR/state.json" --github-env "$PG_RUN_DIR/owner.env"
  node scripts/ci/run-tests.mjs run postgres-application \
    --state "$PG_RUN_DIR/state.json" --results "$PG_RUN_DIR/results.json"
)
```

For one Agent revision worker file, replace the `run-tests` command above with:

```sh
node scripts/ci/prepare.mjs --lane postgres-application \
  --file tests/integration/postgres-worker-agent-revision.test.mjs \
  --state "$PG_RUN_DIR/state.json" --github-env "$PG_RUN_DIR/test.env"
env -u OCC_TEST_DATABASE_URL -u OPENCLAW_ENTERPRISE_CI_STATE \
  -u OPENCLAW_ENTERPRISE_CI_PREFIX node --env-file="$PG_RUN_DIR/test.env" --test \
  tests/integration/postgres-worker-agent-revision.test.mjs
```

Preparation must run first. Do not connect other clients to the prepared
file database: the suite copies it. The suite rejects a standalone
`OCC_TEST_DATABASE_URL` without prepared ownership. If interrupted, run
`node scripts/ci/cleanup.mjs --state /printed/run/directory/state.json` and
retain the state if cleanup fails. The `postgres`, `postgres-platform`, and
`postgres-auth` lanes use the same prepare, run, and cleanup pattern; see
[CI lanes](ci.md#manual-full-integration-lanes).

<a id="postgresql"></a>

## Other PostgreSQL suites

Use Docker Compose and fresh database names. The bootstrap suite needs a
separate, migrated database with no Installation. It creates an Installation;
do not rerun it against a previous bootstrap database. If a name exists,
choose another name instead of dropping it.

```sh
pnpm db:up
(
set -eu
for test_database in openclaw_test_local openclaw_bootstrap_local openclaw_k8s_local; do
  docker compose -f compose.postgres.yaml exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "CREATE DATABASE $test_database"
  docker compose -f compose.postgres.yaml exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$test_database" \
    -c "GRANT CREATE ON DATABASE $test_database TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
  OCC_MIGRATION_DATABASE_URL="postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/$test_database" pnpm db:migrate
done
)
```

```sh
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local \
OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_bootstrap_local \
  node --test --test-concurrency=1 tests/integration/postgres-platform-state.test.mjs \
  tests/integration/postgres-production-wireup.test.mjs \
  tests/integration/compute-singleton-worker-postgres.test.mjs
```

The bootstrap test uses passive Compute and test Drivers: it does not prove a
live gateway. Four optional Configuration cases also require
`OCC_TEST_KUBERNETES_CONFIGURATION=1` and a configured live Kubernetes Driver.
Broad `pnpm test`, `pnpm test:integration`, and `pnpm test:postgres` include
version-worker tests and therefore require prepared ownership.

## GitHub human sign-in

With a fresh migrated `OCC_TEST_DATABASE_URL` and the
[Playwright browser](local.md#console-browser-checks), run:

```sh
node --test tests/integration/postgres-github-sign-in.test.mjs
```

The database case skips without the URL and fails without the browser. Provider
responses are fixtures; a pass does not prove live GitHub registration or HTTPS
cookies. Password and other provider scenarios are in the `postgres-auth` lane.

## PostgreSQL test environment

Use `OCC_TEST_DATABASE_URL` for the application role and
`OCC_MIGRATION_DATABASE_URL` for setup. Production bootstrap needs its own
`OCC_PRODUCTION_WIREUP_DATABASE_URL`. Authentication maintenance also needs
`OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL` for the same database, with all other
clients disconnected. Bootstrap failure tests require a separate disposable
loopback database named `openclaw_failures_*` via
`OCC_BOOTSTRAP_FAILURE_DATABASE_URL`; their reset changes its tables. See
[the test](../../tests/integration/postgres-bootstrap-failures.test.mjs) for
its optional migration URL. Do not share that database with another process.

## Canonical migration compatibility

The `postgres` lane runs migration compatibility against its owned fixture. To
run the canonical cases against an existing disposable loopback PostgreSQL 18
container with the local test roles, select its container, port, and a new
database prefix:

```sh
OCC_MIGRATION_HISTORY_DATABASE_URL="postgresql://occ_migrator:occ-migrator-local@127.0.0.1:$TEST_POSTGRES_PORT/postgres" \
OCC_MIGRATION_HISTORY_CONTAINER="$TEST_POSTGRES_CONTAINER" \
OCC_MIGRATION_HISTORY_DATABASE_PREFIX=openclaw_migration_test_local \
  node --test --test-name-pattern=Canonical tests/integration/postgres-migration-compatibility.test.mjs
```

All three selectors are required. The prefix must start with `openclaw_`, use
only lowercase letters, digits, and underscores, and contain at most 50
characters. The test reads the container's administrator password with `docker inspect`,
connects through the selected port, and drops only databases it created.
See [migration recovery](../reference/settings/operations.md#migration-history).

## Azure workload-identity connections

The `postgres-azure-workload-identity` lane reads an existing authorized Azure
PostgreSQL database. It creates no database or identity. In a private file
outside the repository, set `OCC_TEST_AZURE_DATABASE_URL` to a password-free
application URL with verified TLS, plus `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
and `AZURE_FEDERATED_TOKEN_FILE`. See the
[connection requirements](../reference/settings/operations.md#postgresql-connection-authentication).

```sh
umask 077
TEST_ENV_FILE=/absolute/path/to/private/postgres-azure-test.env
chmod 600 "$TEST_ENV_FILE"
PG_AZURE_DIR="$(mktemp -d)"
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run postgres-azure-workload-identity \
  --state "$PG_AZURE_DIR/state.json" --results "$PG_AZURE_DIR/results.json"
```

The selected lane fails on missing inputs or skipped cases; direct test runs
skip when the URL is absent. It verifies fresh TLS connections, not token
rotation or an Azure deployment. Remove only the temporary result directory
when its evidence is no longer needed.

## Service-key persistence

With `OCC_TEST_DATABASE_URL` set as above, run
`node --test tests/integration/postgres-service-api-keys.test.mjs`. This verifies
persistence, not a deployed installation.

## Authentication binding

With a migrated disposable `OCC_TEST_DATABASE_URL`, run:

```sh
node --test --test-concurrency=1 tests/integration/postgres-auth-binding.test.mjs \
  tests/integration/postgres-auth-accounts.test.mjs tests/integration/postgres-service-api-keys.test.mjs
```

Missing database configuration skips these cases. See the
[binding reference](../reference/postgres-auth-binding.md) for ownership and
transaction boundaries.
