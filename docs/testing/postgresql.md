# PostgreSQL tests

Verify persistence, authentication, queue behavior, and bootstrap against
disposable PostgreSQL databases. Start with the [shared requirements](README.md#requirements-and-credentials).

## Revision-worker tests

The revision-worker suite allocates disposable databases under its run's
owner so another test cannot consume its queue. Four cross-Namespace cases explicitly share
a database within their test. Tests connect as `occ_app`; preparation
uses the existing administrator and migrator paths. The suite rejects a standalone
`OCC_TEST_DATABASE_URL` without prepared ownership before changing that database.
Other suites keep the application-role URL setup below.

From the repository root, run the complete application lane:

```sh
(
  set -eu
  umask 077
  PG_APPLICATION_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oce-postgres-application.XXXXXX")"
  printf 'PostgreSQL run directory: %s\n' "$PG_APPLICATION_RUN_DIR"
  trap 'pg_run_status=$?; node scripts/ci/cleanup.mjs --state "$PG_APPLICATION_RUN_DIR/state.json" || pg_run_status=1; exit "$pg_run_status"' EXIT

  node scripts/ci/prepare.mjs --lane postgres-application \
    --state "$PG_APPLICATION_RUN_DIR/state.json" \
    --github-env "$PG_APPLICATION_RUN_DIR/owner.env"
  node scripts/ci/run-tests.mjs run postgres-application \
    --state "$PG_APPLICATION_RUN_DIR/state.json" \
    --results "$PG_APPLICATION_RUN_DIR/results.json"
)
```

For only the revision-worker file, use a fresh run directory:

```sh
(
  set -eu
  umask 077
  PG_WORKER_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oce-postgres-worker.XXXXXX")"
  printf 'PostgreSQL run directory: %s\n' "$PG_WORKER_RUN_DIR"
  trap 'pg_run_status=$?; node scripts/ci/cleanup.mjs --state "$PG_WORKER_RUN_DIR/state.json" || pg_run_status=1; exit "$pg_run_status"' EXIT

  node scripts/ci/prepare.mjs --lane postgres-application \
    --state "$PG_WORKER_RUN_DIR/state.json" \
    --github-env "$PG_WORKER_RUN_DIR/owner.env"
  node scripts/ci/prepare.mjs --lane postgres-application \
    --file tests/integration/postgres-worker-agent-revision.test.mjs \
    --state "$PG_WORKER_RUN_DIR/state.json" \
    --github-env "$PG_WORKER_RUN_DIR/test.env"
  env -u OCC_TEST_DATABASE_URL -u OPENCLAW_ENTERPRISE_CI_STATE \
    -u OPENCLAW_ENTERPRISE_CI_PREFIX \
    node --env-file="$PG_WORKER_RUN_DIR/test.env" --test \
    tests/integration/postgres-worker-agent-revision.test.mjs
)
```

Each invocation needs its own state file; do not run two commands against the
same prepared state concurrently. The commands remove that run's databases
and Compose server on exit, including after a test failure. The
application lane writes its result JSON in the printed run directory. If
interrupted before cleanup completes, rerun
`node scripts/ci/cleanup.mjs --state /printed/run/directory/state.json`.
Retain failed-run output and result JSON while investigating.

<a id="postgresql"></a>

## Other PostgreSQL suites

Requires Docker Compose. Use disposable databases: tests can initialize or
change singleton platform state. The production bootstrap database must be
migrated, separate from the general database, and contain no Installation; the
bootstrap creates its own Installation and administrators, so never rerun it
against a previous bootstrap database.

This creates three new databases: general tests, production bootstrap,
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
shares `OCC_TEST_DATABASE_URL` with the other `pg.Pool`-backed tests; production
bootstrap needs its own URL:

```sh
(
  export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local
  export OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_bootstrap_local
  node --test --test-concurrency=1 \
    tests/integration/postgres-platform-state.test.mjs \
    tests/integration/postgres-production-wireup.test.mjs \
    tests/integration/compute-singleton-worker-postgres.test.mjs
)
```

Omitting the general URL skips most persistence and
queue cases. Use the prepared `postgres-application` lane above for its complete
file selection. Broad `test:postgres`, `test:integration`, and `test` commands
include the revision-worker suite and its
[prepared-ownership requirement](#revision-worker-tests).

Production bootstrap also exercises existing-person Agent sharing through
real cookie-authenticated HTTP, native IAM and restricted PostgreSQL State. It
checks initial denial, exact Namespace/Agent grants, sibling and Configuration
denial, persisted sessions and policy after application restart, and selective
revocation while another person retains access. The fixture seeds an existing
Installation-reader Role; account creation and password sign-in use ordinary APIs.
This is not atomic-enrollment proof. Its passive Compute and test Configuration/Secret
Drivers do not establish native Gateway execution or closure of open streams.

Four optional live Configuration cases additionally require
`OCC_TEST_KUBERNETES_CONFIGURATION=1` and an already configured live Kubernetes
Configuration Driver in the subprocess startup environment; the flag alone
does not configure it. A pre-bootstrap case also skips if its database
already has an Installation.

## GitHub human sign-in

`tests/integration/postgres-github-sign-in.test.mjs` exercises ordinary PostgreSQL
development composition, real controller routes across a stopped maintenance restart,
and a Playwright browser using the Console. Point the application-role
`OCC_TEST_DATABASE_URL` at a fresh, migrator-prepared disposable database.
The test provisions its own Installation and local recovery administrator.
Prepare a browser as for [Console browser checks](local.md#console-browser-checks):

```sh
node --test tests/integration/postgres-github-sign-in.test.mjs
```

The suite checks existing-account enrollment, unchanged Principals and grants,
the one-use attempt receipt exchange and `x-occ-session-key` narrowing, password parity, rejection of older unbound sessions, one-use callback handling,
account-wide revocation, protected recovery, and browser access to an already
permitted Namespace and existing Agent detail. It checks actual listener stop, admitted-request drain, activation and restart in the loopback composition; installed ingress and deployment controls remain a separate qualification. Provider exchange/profile HTTP responses are controlled
fixtures for deterministic optional-email and rejected-identity cases;
they do not establish live GitHub registration, provider availability, or deployed
HTTPS cookie behavior. Missing database configuration skips the case, so a
green command or memory-backed suite does not prove it ran; a missing browser
fails it.

The same PostgreSQL lane also runs
`tests/integration/postgres-human-authentication.test.mjs` for the original State
transaction, account/method currentness, recovery protections, and concurrent
issuance/revocation, actor-session revocation races, account-version conflicts,
attachment invalidation, State deadlines and persisted attempt bounds.
`tests/integration/postgres-github-cookie-commit.test.mjs` checks audit rollback
and lost COMMIT acknowledgements through the controller. It drops a real
PostgreSQL COMMIT response through the loopback protocol proxy and verifies
persisted state, withheld cookies, and no replay. It also checks the ordinary
HTTP cookie boundary for login and logout, unknown administrative completion,
and a guarded present-state read. Password sign-in runs without a browser
Origin header; a headerless sign-out is rejected with `403` and leaves the
session current, and the other sign-outs send the configured Origin. No live
provider credential
is needed for these cases. Hosted PostgreSQL CI prepares Chromium after the
frozen workspace dependencies.

## Password-default sign-in

GitHub sign-in is optional; these suites prove the default. Each needs a fresh
`OCC_TEST_DATABASE_URL` and composes the production API from the settings the
example Helm values render, after the real production bootstrap:

- `postgres-password-default.test.mjs`: GitHub unconfigured. Administrator
  onboarding, account creation, Origin-checked sign-out, refused GitHub routes,
  and wrong passwords that never lock the administrator out.
- `postgres-password-default-activation.test.mjs`: the GitHub upgrade enrols
  earlier password accounts, logs skipped ones, and keeps account creation.
- `postgres-github-outage.test.mjs`: a fixture provider that errors, then stalls
  past the ten-second deadline. GitHub sign-in fails closed, passwords keep
  working, and the recovery administrator signs in while the shared lane is full.

The same composition covers the GitHub profile against the fixture provider:

- `postgres-github-admin-attach.test.mjs`: administrators attach, detach and
  re-attach GitHub identities, and disable and enable accounts. A session without
  Installation `administer` gets `403` on every account and recovery route, and two
  administrators attaching one GitHub identity at once get one `200` and one `409`.
- `postgres-github-admin-scope.test.mjs`: a created administrator cannot attach
  an identity to, or revoke, the broader bootstrap administrator's account, or
  take its recovery designation.
- `postgres-github-tab-binding.test.mjs`, `postgres-oidc-tab-binding.test.mjs`:
  Playwright over the HTTPS Origin. A tab signed in with GitHub, or OIDC alone, signs
  out after another tab's password sign-in; the login receipt is one-use and needs the
  exact Origin.
- `postgres-github-recovery-replacement.test.mjs`: online recovery replacement
  moves the reserved password lane and survives a restart with the original seed.
- `postgres-google-sign-in.test.mjs`: Google sign-in against a fixture OpenID
  Connect provider (`fakeGoogle` in `tests/helpers/production-sign-in.mjs`) that
  signs RS256 ID tokens with a local key. It covers attached-only admission, bad
  ID-token claims, state and binding-cookie replay, password fallback, detach,
  disablement, and GitHub plus Google together. No real Google client is used;
  `oidc-id-token` covers the shared ID-token verifier, `google-id-token` Google's
  issuers, hosted domains and nonce, and `google-login-transport` the transport.
- `postgres-break-glass-auth-maintain.test.mjs`: also needs
  `OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL`. With the API stopped,
  `auth:maintain` resets the recovery password and deactivates GitHub sign-in.

`tests/integration/sign-in-chart-parity.test.mjs` (Images and Packaging lane, Helm and yq) checks
that the chart renders exactly those settings, and that the API entrypoint
accepts them for every trusted-proxy preset, with and without
GitHub, and refuses what the chart refuses. Accepted settings stop at the
PostgreSQL connection, which the suite points at an unreachable address, so it
does not prove that the API starts with every preset; the PostgreSQL scenarios
above start it with their own settings.

## Authentication maintenance

`tests/integration/auth-maintain.test.mjs` runs the real `scripts/auth-maintain.mjs`
command against a fresh database: `OCC_TEST_DATABASE_URL` as `occ_app` and
`OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL` as `occ_migrator` for the same database.
It covers activation, enrolment repair, recovery password reset, session purge,
and deactivation back to the legacy profile, including the disabled-account
refusal. The suite closes its own connections before each command; any other
client on the database makes the commands exit 2, which it also checks. It does not exercise a Kubernetes Job or a scaled-down API.

## Canonical migration compatibility

The mandatory native `postgres` lane runs
`tests/integration/postgres-migration-compatibility.test.mjs` against its
recorded fixture. Its canonical-history cases create new owned databases,
install historical prefixes with stock Drizzle, and invoke the real development
and production migration commands. They cover fresh and populated-main
installation, unchanged receipts/data, repeat/concurrent runners, transaction
rollback/retry, unsupported-history and initial-ACL refusal, added empty default
ACLs on installed histories, and the actual `occ_app` temporary-domain attack
against inherited privileged functions.

For an already-owned loopback PostgreSQL 18 fixture with the repository's local
test roles, explicitly select the running container, its mapped port, and a
unique database prefix. The suite validates the mapping, creates only new names
under that prefix, and drops only databases it created:

```sh
OCC_MIGRATION_HISTORY_DATABASE_URL="postgresql://occ_migrator:occ-migrator-local@127.0.0.1:$TEST_POSTGRES_PORT/postgres" \
OCC_MIGRATION_HISTORY_CONTAINER="$TEST_POSTGRES_CONTAINER" \
OCC_MIGRATION_HISTORY_DATABASE_PREFIX=openclaw_migration_test_local \
  node --test --test-name-pattern=Canonical tests/integration/postgres-migration-compatibility.test.mjs
```

The database prefix must start with `openclaw_`, contain only lowercase letters,
digits, and underscores, and have at most 50 characters. All three selectors
are required together. This mode reuses the selected server and roles; it does
not provision or repair them. The database-local administrator fixture uses
`docker exec` for database creation, failure injection, and cleanup. These tests prove SQL and entrypoint
behavior, not installed State/API, Agent deletion, credential custody, or live
provider operation. Developer recovery is documented under
[migration history](../reference/settings/operations.md#migration-history).

## PostgreSQL test environment

| Variable                                       | Required by                                | Behavior                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OCC_TEST_DATABASE_URL`                        | Real PostgreSQL integration tests.         | Must use an initialized application-role database. Skipped when absent; [revision-worker tests](#revision-worker-tests) additionally require prepared ownership.                           |
| `OCC_MIGRATION_DATABASE_URL`                   | `db:migrate` setup before tests.           | Migrator role for schema and migration-history ownership.                                                                                                                                  |
| `OCC_PRODUCTION_WIREUP_DATABASE_URL`           | Production bootstrap integration.          | Separately migrated, disposable, initially empty application-role database; skipped when absent.                                                                                           |
| `OCC_BOOTSTRAP_FAILURE_DATABASE_URL`           | Bootstrap race and uncertain-commit tests. | Application-role URL for a separate, migrated, disposable loopback database named `openclaw_failures_*`. The suite resets its tables between cases; skipped when absent.                   |
| `OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL` | Bootstrap failure fixture setup/reset.     | Optional for the local `occ_app` fixture, which uses `occ_migrator` and its local test password; otherwise required. Must target the same host, port, and database as the application URL. |
| `OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL`     | Authentication maintenance integration.    | Migrator-role URL for the same fresh database as `OCC_TEST_DATABASE_URL`; skipped when absent.                                                                                             |
| `OCC_TEST_KUBERNETES_CONFIGURATION`            | Optional live Configuration coverage.      | Set to `1` only with an explicitly configured live Kubernetes Configuration Driver.                                                                                                        |

The [bootstrap failure suite](../../tests/integration/postgres-bootstrap-failures.test.mjs)
needs the database the table describes, prepared with the setup above. Its migration-role fixture installs
a temporary delay trigger; run it without any other process using that
database. Both initializer modes run with the application role:

```bash
OCC_BOOTSTRAP_FAILURE_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_failures_local \
  node --test tests/integration/postgres-bootstrap-failures.test.mjs
```

## Azure workload-identity connections

Select the `postgres-azure-workload-identity` lane to run
[postgres-azure-workload-identity.test.mjs](../../tests/integration/postgres-azure-workload-identity.test.mjs)
against an existing authorized Azure PostgreSQL database. This lane has no
GitHub workflow entrypoint and provisions no database or identity resources.
The ordinary constructor, security-rejection, real password-authentication,
and terminated-idle-connection cases stay in
[postgres-connection-auth.test.mjs](../../tests/integration/postgres-connection-auth.test.mjs)
in the mandatory `postgres` lane.

Prepare a private environment file outside the repository with these inputs:

| Variable                      | Required value                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| `OCC_TEST_AZURE_DATABASE_URL` | Password-free application-role URL using verified TLS.             |
| `AZURE_TENANT_ID`             | Tenant for the selected workload identity.                         |
| `AZURE_CLIENT_ID`             | Client ID for the selected workload identity with database access. |
| `AZURE_FEDERATED_TOKEN_FILE`  | Readable projected federation-token file for that identity.        |

Follow the [connection authentication contract](../reference/settings/operations.md#postgresql-connection-authentication)
for TLS and identity requirements. Keep these inputs scoped to the selected
test process, which selects Azure authentication explicitly:

```sh
umask 077
TEST_ENV_FILE=/absolute/path/to/private/postgres-azure-test.env
chmod 600 "$TEST_ENV_FILE"
POSTGRES_AZURE_RESULTS_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/oce-postgres-azure.XXXXXX")"
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run postgres-azure-workload-identity \
  --state "$POSTGRES_AZURE_RESULTS_DIRECTORY/state.json" \
  --results "$POSTGRES_AZURE_RESULTS_DIRECTORY/results.json"
```

The fresh state path needs no preparation command for this lane. Missing
required inputs fail the selected lane, as do failed, skipped, or missing test
results. Broad direct test runs skip the Azure case when its URL is absent.
Retain the result JSON as connection evidence, then remove only this run's
temporary result directory.

The read-only test opens two fresh, immediate connections through the shared
pool; each must return an authenticated username and report TLS in
`pg_stat_ssl`. It does not wait for token expiry or prove token rotation,
outage recovery, or an Azure deployment. For connection failures, check the
projected token file, federation configuration, database grants, and verified
TLS endpoint without printing credentials or tokens.

## Service-key persistence

`tests/integration/postgres-service-api-keys.test.mjs` covers stored hashing,
foreign-Installation rejection, cross-instance revocation, and deletion during
concurrent verification. These checks complement the
[local HTTP authorization tests](local.md#authentication-and-authorization-coverage);
neither suite verifies a deployed installation.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).

## Transaction outcome protocol

The PostgreSQL owner retains client transport errors through release and discards
failed connections. Lost COMMIT acknowledgments report
`PostgresCommitOutcomeUnknownError` and remain possibly committed, even when a
later ROLLBACK responds; a socket failure does not prove rollback. Callers must
make an independent exact readback of retained state before retrying or
reconciling an effect.

`tests/conformance/postgres-transaction-commit.test.mjs` exercises the actual outer
transaction owner with a transport protocol fixture. It covers definite server
rejection, ambiguous SQLSTATEs, exact COMMIT/ROLLBACK command acknowledgment,
and cleanup errors. A deadlock (`40P01`) or serialization failure (`40001`) is a
definite rollback and maps to retryable `DependencyUnavailableError` (`503`).
The fixture supplies no database or persistence proof.

The COMMIT fault fixture follows the installed PostgreSQL driver's effective
host and port, including URL query overrides, and routes the test connection
through its loopback proxy. It rejects nonloopback targets and TLS connections
before mutation: inspecting encrypted protocol completion is unsupported, and
TLS intent is never silently downgraded. Use the disposable non-TLS loopback
setup above.

## Authentication binding

With matching dependencies, check construction, public type contracts, and sanitized failures:

```sh
node --test tests/conformance/postgres-auth-binding.test.mjs tests/conformance/postgres-controller-auth-binding.test.mjs tests/conformance/schema-auth-boundary-v1.test.mjs
```

These checks do not prove SQL persistence. `pnpm typecheck` checks Controller composition.
With a migrated disposable database and `OCC_TEST_DATABASE_URL` (setup above), run:

```sh
node --test --test-concurrency=1 tests/integration/postgres-auth-binding.test.mjs tests/integration/postgres-auth-accounts.test.mjs tests/integration/postgres-service-api-keys.test.mjs
```

These cover isolation, rollback, pool reuse, account provisioning, and service-key
persistence. Fresh bootstrap requires no Installation; missing database
configuration skips PostgreSQL coverage.

For construction errors, check OCC/Drizzle dependencies. Construction does not
establish connectivity: for later errors, check connectivity and
application-role permissions. See the
[binding reference](../reference/postgres-auth-binding.md) for ownership and transaction boundaries.
