# PostgreSQL tests

Verify persistence, authentication, queue behavior, and bootstrap against
disposable PostgreSQL databases. Start with the [shared requirements](README.md#requirements-and-credentials).

## PostgreSQL

Requires Docker Compose. Use disposable databases: tests can initialize or
change singleton platform state. The production bootstrap database must be
migrated and contain no Installation.

The following creates three new databases: general tests, production bootstrap,
and Kubernetes. If any name already exists, choose a new test name and update
the corresponding URL; do not drop an existing database to make setup pass.

```sh
pnpm db:up

(
  set -eu
  for test_database in openclaw_test_local openclaw_bootstrap_local openclaw_k8s_local; do
    docker compose -f compose.postgres.yaml exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "CREATE DATABASE $test_database"
    docker compose -f compose.postgres.yaml exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d "$test_database" \
      -c "GRANT CREATE ON DATABASE $test_database TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
    OCC_MIGRATION_DATABASE_URL="postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/$test_database" \
      pnpm db:migrate
  done
)
```

Compose provisions the local `occ_migrator` and `occ_app` roles. Run migrations
as `occ_migrator` and the tests as the less-privileged `occ_app`. Queue coverage
uses `OCC_TEST_DATABASE_URL` with the other `pg.Pool`-backed PostgreSQL tests;
production bootstrap still needs its own URL:

```sh
(
  export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local
  export OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_bootstrap_local
  pnpm test:postgres
  node --test tests/integration/compute-singleton-worker-postgres.test.mjs
)
```

The two PostgreSQL URLs select different coverage. Omitting the general URL
skips most persistence tests, including queue coverage; omitting
`OCC_PRODUCTION_WIREUP_DATABASE_URL` skips production bootstrap. `test:postgres`
does not include the singleton-worker file, hence the second command.

Four optional live Configuration cases additionally require
`OCC_TEST_KUBERNETES_CONFIGURATION=1` and an already configured live Kubernetes
Configuration Driver in the subprocess startup environment. The flag alone
does not configure that Driver. A pre-bootstrap case also skips if its database
already has an Installation. See [PostgreSQL settings](#postgresql-test-environment).

For a repeat of production bootstrap, prepare a fresh migrated database and
change its URL. Keep the general and bootstrap databases separate.

## PostgreSQL test environment

| Variable                                       | Required by                                | Behavior                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OCC_TEST_DATABASE_URL`                        | Real PostgreSQL integration tests.         | Must use an initialized application-role database. General PostgreSQL and queue cases are skipped when absent.                                                                             |
| `OCC_MIGRATION_DATABASE_URL`                   | `db:migrate` setup before tests.           | Uses the separate migrator role for schema and migration-history ownership; the test process should use application-role URLs.                                                             |
| `OCC_PRODUCTION_WIREUP_DATABASE_URL`           | Production bootstrap integration.          | Uses a separately migrated, disposable, initially empty application-role database; the production bootstrap skips when absent.                                                             |
| `OCC_BOOTSTRAP_FAILURE_DATABASE_URL`           | Bootstrap race and uncertain-commit tests. | Application-role URL for a migrated, disposable loopback database named `openclaw_failures_*`. The suite resets its tables; skipped when absent.                                           |
| `OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL` | Bootstrap failure fixture setup/reset.     | Optional for the local `occ_app` fixture, which uses `occ_migrator` and its local test password; otherwise required. Must target the same host, port, and database as the application URL. |
| `OCC_TEST_KUBERNETES_CONFIGURATION`            | Optional live Configuration coverage.      | Set to `1` only when the PostgreSQL integration also has an explicitly configured live Kubernetes Configuration Driver.                                                                    |

The bootstrap integration creates its own exact Installation and administrators;
do not rerun it against a previous bootstrap database or point it at an
existing development Installation. Use a dedicated disposable database for any
other case when existing local platform state must be preserved.

The [bootstrap failure suite](../../tests/integration/postgres-bootstrap-failures.test.mjs)
requires a separate migrated `openclaw_failures_*` database on loopback. Its
migration-role fixture installs a temporary delay trigger and resets tables
between cases; run it without any other process using that database. Both
initializer modes run with the application role.
After preparing that disposable database using the existing PostgreSQL setup:

```bash
OCC_BOOTSTRAP_FAILURE_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_failures_local \
  node --test tests/integration/postgres-bootstrap-failures.test.mjs
```

## Service-key persistence

`tests/integration/postgres-service-api-keys.test.mjs` covers stored hashing,
foreign-Installation rejection, cross-instance revocation, and deletion during
concurrent verification. These checks complement the
[local HTTP authorization tests](local.md#authentication-and-authorization-coverage);
neither suite verifies a deployed installation.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
