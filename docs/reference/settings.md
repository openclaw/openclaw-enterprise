# Settings reference

Configure the OpenClaw Enterprise Docker Compose development stack,
internal-only production controller, PostgreSQL database, database migrations,
and integration tests. Development retains local admission and uses PostgreSQL
plus bundled Docker Compute and filesystem Configuration Drivers by default.
Production reads Installation settings and selected Driver options from
trusted startup YAML and requires durable state, the singleton Installation,
and Better Auth session authentication. Both development and production
support reviewed bundled and installed IAM, Compute, Sandbox, and Configuration
Drivers. Production and explicit `OCC_CONFIG_PATH` Kubernetes startup
configurations select the bundled Secret Driver for Namespace-owned Secret storage.
Default Compose/PostgreSQL development without trusted startup YAML does not
enable Namespace-owned Secret storage.
PostgreSQL-backed Installations may additionally select the bundled ChatGPT
Service Account Driver.

For packaged Kubernetes deployment, immutable image inputs, operator-provisioned
Secrets, dedicated migration credentials, and exact network selectors, see
[Production Kubernetes deployment](../guides/deploy.md).

For a public Docker-only runtime image recipe used by the quickstart and
real-runtime tests, see [`deploy/runtime`](../../deploy/runtime/README.md).

The controller reads environment variables directly from its process. It does
not automatically load `.env` or [`.env.example`](../../.env.example). Export values
in your shell, pass them inline, or explicitly use Node's `--env-file` option.
The checked-in example documents local Compose and PostgreSQL variables, but the
controller still reads only values passed into its process.

If an ignored local `.env` file contains the complete required configuration,
load it explicitly:

```bash
node --env-file=.env apps/controller/src/server.mjs
```

`OCC_CONFIG_PATH` separately selects the trusted Installation startup YAML. The
path must be absolute and is required in production; development can omit it
to use its existing local defaults. Both processes read the same closed-schema
document containing `occ` and required Configuration, IAM, Compute, and Secret
Driver selections. Development without this YAML does not select the Secret
Driver or create Namespace-owned Secret storage. PostgreSQL-backed Installations
can also configure the optional
[ChatGPT Provider and its ServiceAccount Driver](providers.md#installation-configuration);
only the API reads its admin Secret. See
[Installation startup configuration](configuration.md#installation-startup-configuration)
for the complete document shape. OCC resolves its singleton Installation internally.

When a production or explicit Kubernetes startup YAML is used, the required
`drivers.secret` selection currently supports the bundled
[Kubernetes Secret Driver](drivers/kubernetes-secret.md). It is loaded from the
same startup YAML, stores Namespace-owned Secret values in the backing
Kubernetes namespace, and exposes only metadata through OCC. Secret value updates
do not restart workloads; explicitly redeploy or restart each consuming Agent to
consume the current value. The selected Secret Driver is not a CredentialGateway, SecretBroker,
rotation service, or credential issuer.

The optional `drivers.sandbox` selection currently supports the bundled
[OpenShell SandboxDriver](drivers/openshell-sandbox.md) with the bundled Kubernetes
Compute Driver. It is loaded from the same startup YAML, injected into the
Kubernetes Compute Driver before workers reconcile revisions, and fails startup
when paired with an installed Compute Driver. OpenShell-selected Agents must use
dedicated Codex execution; embedded OpenClaw remains unsupported for this
SandboxDriver.

## Deployment and startup

The [quickstart](../guides/quickstart.md) owns the default local
`./scripts/dev-up` path and authenticated first request. The
[deployment guide](../guides/deploy.md) owns production preparation, Helm
installation, Agent/TUI recipes, and recovery procedures. The tables below
define supported settings; helper scripts and examples do not override their
defaults, precedence, or security requirements.

## Required development controller environment

The table includes Compose inputs for its separate processes. `OPENCLAW_DEV_EMAIL`,
`OPENCLAW_DEV_PASSWORD`, `OPENCLAW_DEV_INSTALLATION_NAME`, and
`OCC_BOOTSTRAP_SERVICE_KEY_FILE` belong only to the initializer; the API and
worker require initialized state and do not read those credentials or output.

| Variable                              | Required value or format                                                     | Behavior                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | Exactly `development`.                                                       | Selects local development admission; production has separate required inputs below.                                                                                                                               |
| `OCC_HOST`                            | Host-process development: exactly `127.0.0.1` or `::1`; Compose: `0.0.0.0`.  | Host-process development must bind loopback. Compose may bind `0.0.0.0` inside its private bridge only because the published host port remains `127.0.0.1` and `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` is explicit. |
| `OCC_PORT`                            | Decimal integer from `1` through `65535`.                                    | Selects the controller TCP port; no default is supplied.                                                                                                                                                          |
| `OCC_AUTH_SECRET`                     | High-entropy secret string.                                                  | Signs and verifies Better Auth session material; do not reuse across installations.                                                                                                                               |
| `OCC_AUTH_BASE_URL`                   | Absolute controller base URL.                                                | Defines the Better Auth base URL and cookie origin for backend auth endpoints.                                                                                                                                    |
| `OPENCLAW_DEV_EMAIL`                  | Email address.                                                               | Initializer input selecting the development administrator sign-in email; defaults to `admin@openclaw.local`.                                                                                                      |
| `OPENCLAW_DEV_INSTALLATION_NAME`      | `OpenClaw Local Development`.                                                | Development-only Installation name used by the initializer when the database is fresh.                                                                                                                            |
| `OPENCLAW_DEV_PASSWORD`               | String from `12` through `128` characters.                                   | Initializer input selecting the development administrator sign-in password; defaults to `openclaw-development-password`.                                                                                          |
| `OCC_DOCKER_GATEWAY_IMAGE`            | Image reference.                                                             | Existing OpenClaw gateway image with Node 24.15+, `/app/openclaw.mjs`, bundled skills, and the Codex plugin. Required unless `OCC_DOCKER_RUNTIME_IMAGE` supplies both runtimes.                                   |
| `OCC_DOCKER_AGENT_IMAGE`              | Image reference.                                                             | Existing Codex Agent image with Node 24.15+, `codex` on `PATH`, and `codex app-server`. Required unless `OCC_DOCKER_RUNTIME_IMAGE` supplies both runtimes.                                                        |
| `OCC_DOCKER_RUNTIME_IMAGE`            | Image reference.                                                             | Optional shared image used for both gateway and Agent runtimes when it contains both entrypoints; `scripts/dev-up` selects `openclaw-enterprise-runtime:quickstart` for its default invocation.                   |
| `OPENCLAW_DEV_PORT`                   | TCP port; defaults to `3000`.                                                | Publishes the controller on host `127.0.0.1:<port>`.                                                                                                                                                              |
| `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` | CIDR block.                                                                  | Explicit Compose bridge range admitted as local development traffic while keeping forwarded headers rejected.                                                                                                     |
| `OCC_DEVELOPMENT_CONFIGURATION_ROOT`  | Absolute path.                                                               | Development filesystem Configuration Driver root. Compose sets `/app/.development/configurations` from the controller-only `occ_configuration_data` volume.                                                       |
| `OCC_BOOTSTRAP_SERVICE_KEY_FILE`      | Required private absolute output path; written only on fresh initialization. | Compose supplies `/var/lib/openclaw/bootstrap/initial-admin-service-key.json` on its bootstrap-only volume. Existing Installations do not issue or replace output.                                                |
| `OPENAI_API_KEY`                      | Existing authorized provider credential.                                     | Used only by the Agent-owned combined embedded container or dedicated Codex container for real model turns; never print or commit it.                                                                             |

Generate `OCC_AUTH_SECRET` with `openssl rand -hex 32`; do not commit it, log
it, or reuse another installation's secret. Local `.env` files are ignored by
Git. Docker Compose reads them through native Compose precedence; do not source
`.env` as shell.

Caller-supplied identity headers, forwarded requests, trusted proxies, bearer
credentials, and non-loopback clients are rejected. The Compose bridge CIDR is
trusted only for the development stack's internal controller and worker path;
workload containers do not receive the Docker socket, controller credentials,
the configuration volume, or sibling Namespace network access.

## Required production controller environment

The production API is internal-only. Operators must provision an internal
Kubernetes `ClusterIP` Service and a default-deny ingress `NetworkPolicy` that
allows only explicitly approved internal namespace and Pod selectors. The
cluster must enforce NetworkPolicies. Do not expose the listener through an
Ingress, Gateway API route, `NodePort`, `LoadBalancer`, `hostNetwork`, or public
endpoint.

| Variable            | Required value or format                            | Behavior                                                              |
| ------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `NODE_ENV`          | Exactly `production`.                               | Enables durable production controller composition.                    |
| `OCC_HOST`          | One explicit Pod interface IP address.              | Wildcard addresses and implicit hostnames are rejected.               |
| `OCC_PORT`          | Decimal integer from `1` through `65535`.           | Selects the internal listener port exposed by the operator's Service. |
| `OCC_DATABASE_URL`  | Explicit PostgreSQL application-role URL.           | Must connect to the already migrated controller database.             |
| `OCC_CONFIG_PATH`   | Absolute path to trusted Installation startup YAML. | Selects Configuration, IAM, Compute, and optional account Drivers.    |
| `OCC_AUTH_SECRET`   | Mounted high-entropy Better Auth secret.            | Signs and verifies session material without logging it.               |
| `OCC_AUTH_BASE_URL` | Absolute controller base URL.                       | Defines the production Better Auth base URL and cookie origin.        |

The API and worker load the same trusted startup YAML; only the API initializes
the optional [Provider client](providers.md). Both validate Provider membership
and stored ownership before accepting work. When the bundled Kubernetes Compute
Driver is selected, its `drivers.compute.configuration` section contains the
`KubernetesComputeDriverOptions` shape described in the
[Kubernetes Compute Driver guide](drivers/kubernetes-compute.md#configuration).
Production use of that Driver requires `images.requireImmutableDigest: true`,
digest-pinned gateway and Agent image references, and exactly one in-cluster
identity or explicitly named kubeconfig/context. The processes then verify
authenticated, TLS-checked, read-only Kubernetes Namespace access before serving
requests or claiming work. Installed Drivers validate their own reviewed
configuration and implementation-specific prerequisites.

Missing, invalid, expired, or revoked sessions or service keys return `401`; an
authenticated Principal or ServicePrincipal without the exact existing IAM grant
receives `403`. Neither credential grants rights without IAM. See
[Authentication](authentication.md#service-api-keys) for service-key issuance,
scope, and revocation, and the [deployment guide](../guides/deploy.md#service-api-keys-for-automation)
for the procedure. Normal issuance and verification require no additional
settings; initial-key delivery uses the bootstrap settings below.
Auth-secret rotation takes effect after
replacing the mounted Secret and restarting the process.

### Production Installation bootstrap environment

Both environments run `node scripts/bootstrap-installation.mjs` after migration.
`NODE_ENV` selects `development` or `production`; no other mode is accepted.
The initializer uses the application-role database and Better Auth settings.
Development consumes the `OPENCLAW_DEV_*` defaults above and only the private
service-key output path; it never writes a password file. API/worker startup
requires the resulting Installation and does not create credentials.

The packaged Helm initialization Job creates the singleton Installation and
human and service administrators before starting the API or worker. Its separate migration
init container receives only `OCC_MIGRATION_DATABASE_URL`; the bootstrap
container receives the application-role `OCC_DATABASE_URL`, Better Auth
settings, and the following bootstrap settings. The Job sets `backoffLimit: 0`;
failed initialization requires [manual repair](../guides/deploy.md#recover-an-incomplete-bootstrap)
before another attempt.

| Variable                          | Required value or format                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OCC_AUTH_SECRET`                 | Same mounted Better Auth secret used by the API.                                                        |
| `OCC_AUTH_BASE_URL`               | Same absolute Better Auth base URL used by the API.                                                     |
| `OCC_BOOTSTRAP_ADMIN_EMAIL`       | Email address for the first administrator account.                                                      |
| `OCC_BOOTSTRAP_PASSWORD_FILE`     | New file path on protected operator-owned storage for the generated password.                           |
| `OCC_BOOTSTRAP_INSTALLATION_NAME` | Nonempty display name used when creating the Installation.                                              |
| `OCC_BOOTSTRAP_SERVICE_KEY_FILE`  | New private absolute JSON path; on fresh production bootstrap, a distinct sibling of the password file. |

Repeated bootstrap preserves the existing Installation only when the exact
administrator account and IAM identity still match; a mismatch fails closed.
On fresh bootstrap, both files are created exclusively with mode `0600`; their
parent directory must be private and neither destination may already exist.
Helm sets the key path from `bootstrap.password.mountPath` and
`bootstrap.serviceKey.fileName` (default `initial-admin-service-key.json`). The
key filename must be a simple basename distinct from `bootstrap.password.fileName`.
Both use the existing `bootstrap.password.claimName` PVC. Reruns do not inspect,
replace, or regenerate output; see [recovery](../guides/deploy.md#recover-an-incomplete-bootstrap).

## Optional controller environment

| Variable                | Default or behavior when omitted                                                                     | Validation and scope                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `OCC_DATABASE_URL`      | Compose supplies PostgreSQL. Manual host-process debugging should also set the application-role URL. | Must use a `postgresql:` or `postgres:` URL and the application role for the supported development path.      |
| `OCC_CONFIG_PATH`       | Optional in development; required in production.                                                     | Must be an absolute path to trusted, closed-schema Installation startup YAML whenever present.                |
| `OCC_DATABASE_POOL_MAX` | The installed PostgreSQL client's default: `10`.                                                     | Must be a positive safe integer. Applies to the PostgreSQL connection pool; it is validated whenever present. |

OCC resolves the one persisted Installation internally; no startup environment
variable or YAML field supplies its identifier. The stable ID remains visible
through `GET /installation` and is retained at server admission,
exported-audit, and external deployment boundaries. Ordinary Namespace and Agent
API resources, internal IAM records, repository calls, controller-work
objects, and Compute lifecycle observations inherit the singleton Installation
implicitly; `namespaceId` remains their exact tenant boundary.

## Controller worker environment

The [controller worker](controller.md) runs separately from the HTTP API. It
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
access. Direct `docker compose` commands remain supported.
[`compose.postgres.yaml`](../../compose.postgres.yaml) remains the focused
database-only helper for tests and manual PostgreSQL debugging. Both bind the
PostgreSQL host port to loopback only. The following value controls Docker
Compose port substitution:

| Variable            | Default | Behavior                                                                                              |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `OCC_POSTGRES_PORT` | `55432` | Maps `127.0.0.1:<port>` to container port `5432`. Update every PostgreSQL connection URL to match it. |

The Compose service fixes `POSTGRES_DB=openclaw_enterprise`,
`POSTGRES_USER=postgres`, and `POSTGRES_PASSWORD=openclaw-local-admin`. These
values describe a local-only disposable service; they are not controller
environment variables or production credentials.

[`migrations/init-local.sql`](../../migrations/init-local.sql) creates separate
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

Add the application connection URL to the required controller environment shown
above, then initialize before starting the same server manually. Use an
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
also starts the worker and selects Docker-backed Namespace and AgentRevision
execution by default.

Compose keeps relational OCC metadata in the `occ_postgres_data` named volume
and native development Configuration documents in the `occ_configuration_data`
named volume. The configuration volume is mounted only into the controller at
`/app/.development/configurations`; it is not mounted into the worker or
runtime containers. Initial service-key output uses a third bootstrap-only
volume, `occ_bootstrap_data`, at `/var/lib/openclaw/bootstrap`; the API and
worker do not mount it.
`docker compose down` retains all three volumes; `docker compose down --volumes`
deletes them, including the initial credential delivery copy.

### Migration environment

| Variable                     | Required by                      | Behavior                                                                                                     |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `OCC_MIGRATION_DATABASE_URL` | Drizzle configuration and tools. | Must contain the dedicated `occ_migrator` connection URL. Drizzle commands fail when the variable is absent. |

[`drizzle.config.ts`](../../drizzle.config.ts) fixes the PostgreSQL dialect,
[`packages/occ/src/state/postgres-schema.ts`](../../packages/occ/src/state/postgres-schema.ts)
as the relational schema, [`migrations/`](../../migrations) as the migration
directory, the `occ` application schema, and
`drizzle.__drizzle_migrations` as the migration-history table. `strict` and
`verbose` are enabled. There are no environment overrides for these settings.

### PostgreSQL test environment

| Variable                                       | Required by                                | Behavior                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OCC_TEST_DATABASE_URL`                        | Real PostgreSQL integration tests.         | Must use an initialized application-role database. General PostgreSQL and queue cases are skipped when absent.                                                                             |
| `OCC_MIGRATION_DATABASE_URL`                   | `db:migrate` setup before tests.           | Uses the separate migrator role for schema and migration-history ownership; the test process should use application-role URLs.                                                             |
| `OCC_PRODUCTION_WIREUP_DATABASE_URL`           | Production bootstrap integration.          | Uses a separately migrated, disposable, initially empty application-role database; the production bootstrap skips when absent.                                                             |
| `OCC_BOOTSTRAP_FAILURE_DATABASE_URL`           | Bootstrap race and uncertain-commit tests. | Application-role URL for a migrated, disposable loopback database named `openclaw_failures_*`. The suite resets its tables; skipped when absent.                                           |
| `OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL` | Bootstrap failure fixture setup/reset.     | Optional for the local `occ_app` fixture, which uses `occ_migrator` and its local test password; otherwise required. Must target the same host, port, and database as the application URL. |
| `OCC_TEST_KUBERNETES_CONFIGURATION`            | Optional live Configuration coverage.      | Set to `1` only when the PostgreSQL integration also has an explicitly configured live Kubernetes Configuration Driver.                                                                    |

The production-bootstrap integration must use a separately migrated,
disposable database without an existing Installation. Once both required
databases are ready, run the real-database suite with their application-role
connections:

```bash
export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_enterprise
export OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_production_bootstrap

node --test --test-concurrency=1 \
  tests/integration/postgres-*.test.mjs
```

The production queue coverage now uses `OCC_TEST_DATABASE_URL` with the other
PostgreSQL tests. The bootstrap database can be prepared with the Compose
PostgreSQL service, then migrated with `OCC_MIGRATION_DATABASE_URL` pointed at
that disposable database. See the
[PostgreSQL testing guide](../testing.md#postgresql) for the full setup sequence.

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

### Production image startup test environment

[`production-image-startup.test.mjs`](../../tests/integration/production-image-startup.test.mjs)
verifies a locally built production controller image before Helm installation.
It runs the image with no network, deliberately points it at an unreachable
database, checks that startup reaches that expected database boundary without
missing bundled production modules, and verifies that the OpenShell gRPC proto
asset is present.

| Variable                    | Requirement or default                                      |
| --------------------------- | ----------------------------------------------------------- |
| `OCC_TEST_PRODUCTION_IMAGE` | Locally built production controller image tag; unset skips. |
| `OCC_DOCKER_BIN`            | Optional Docker executable path; defaults to `docker`.      |

This check does not prove PostgreSQL connectivity, Helm rendering, Kubernetes
reconciliation, runtime image execution, or a model turn.

### Runtime image startup test environment

[`runtime-image-startup.test.mjs`](../../tests/integration/runtime-image-startup.test.mjs)
verifies a locally built OpenClaw runtime image before Docker Compose or
Kubernetes execution. It starts task-owned containers with the Docker Compute
Driver gateway entrypoint, UID `1000:1000`, a read-only root filesystem, and
tmpfs-backed `/home/node` and `/tmp`. Host Node.js 24+ is required to run the
test.

| Variable                 | Requirement or default                                 |
| ------------------------ | ------------------------------------------------------ |
| `OCC_TEST_RUNTIME_IMAGE` | Locally built OpenClaw runtime image tag; unset skips. |
| `OCC_DOCKER_BIN`         | Optional Docker executable path; defaults to `docker`. |

This check proves an embedded OpenClaw gateway reaches `/readyz` from a fresh
runtime home and the bundled Codex plugin can be discovered without missing
package dependencies. It does not prove Docker Compose orchestration,
Kubernetes reconciliation, model credentials, or a model turn.

### Docker Compose development test environment

The Docker Compose development integration exercises the supported local stack.
It requires Docker Engine, a locally available runtime image, PostgreSQL, the
OCC API, the worker, host Python 3 with PTY support for the TUI helper, and a
real provider response. Set `OCC_TEST_DOCKER_COMPUTE_REAL=1` or any
`OCC_DOCKER_*_IMAGE` variable to select the suite; once selected, missing
Docker, image, bootstrap, worker, Python, or model prerequisites fail instead
of skipping.

| Variable                       | Requirement or default                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `OCC_TEST_DOCKER_COMPUTE_REAL` | Set to `1` to explicitly opt into the real Docker Compute proof.                        |
| `OCC_DOCKER_GATEWAY_IMAGE`     | Existing production-equivalent OpenClaw gateway image; defaults to the runtime image.   |
| `OCC_DOCKER_AGENT_IMAGE`       | Existing production-equivalent Codex Agent image; defaults to the runtime image.        |
| `OCC_DOCKER_RUNTIME_IMAGE`     | Optional shared image fallback for both gateway and Agent.                              |
| `OPENAI_API_KEY`               | Existing authorized provider credential for real embedded and dedicated model turns.    |
| `OCC_TEST_OPENAI_MODEL`        | Authorized provider model; defaults to exact API model ID `gpt-5.6-sol`.                |
| `PYTHON`                       | Optional host Python interpreter for `tests/helpers/tui-pty.py`; defaults to `python3`. |

The selected model must support Codex custom tools as well as the embedded
OpenClaw path. `gpt-4.1` does not support the dedicated Codex request shape.
The test generates its own Compose bridge CIDR and Configuration Driver root;
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` and
`OCC_DEVELOPMENT_CONFIGURATION_ROOT` are not external test inputs.
The embedded Docker case also proves that a fresh TUI client with an invalid
gateway token is rejected, then uses one valid TUI process for two same-session
model-backed replies and exits that client with Ctrl+D while the gateway remains
ready.

Missing Docker Engine access, runtime images, bootstrap, worker startup, or
model credentials fails the Compose integration. Missing host Python or PTY
support fails the TUI helper before that embedded proof can pass. Do not replace
this path with controller-only shortcuts, a mocked Docker API, or readiness-only
checks.

### Kubernetes fixture test environment

Real-cluster integration is opt-in for ordinary development and required when
explicitly requested or validating the production-capable Kubernetes driver for
release. Set all three Kubernetes variables to enable it; setting only some
fails rather than silently skipping. The test harness requires a dedicated
loopback-only k3d context, and all three HTTP fixture cases have been
verified against a k3d-managed cluster. The driver itself also supports verified
remote HTTPS API servers and in-cluster ServiceAccount authentication. These
variables do not configure `server.mjs`, `worker.mjs`, the normal controller, or
its default Compute Driver.

| Variable                         | Requirement                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OCC_TEST_KUBERNETES_KUBECONFIG` | Absolute path to the dedicated disposable local-cluster kubeconfig.                                |
| `OCC_TEST_KUBERNETES_CONTEXT`    | Explicit context whose HTTPS API server is loopback-only with an explicit port.                    |
| `OCC_TEST_KUBERNETES_IMAGE`      | Locally available fixture image already imported into the selected cluster.                        |
| `OCC_TEST_DATABASE_URL`          | Required for API-and-worker coverage; must select a dedicated, migrated `openclaw_k8s_*` database. |

Follow the canonical
[Kubernetes HTTP fixture testing guide](../testing.md#kubernetes-http-fixture)
for disposable `k3d` setup, fixture image import, and PostgreSQL-backed
coverage. Kubernetes API-and-worker coverage rejects the ordinary
`openclaw_enterprise` development database. The real-cluster suite uses an HTTP
fixture and does not establish a real gateway, authenticated Codex connection,
or model turn. A separate real-runtime lane below provides model-turn proof.

### Kubernetes real-runtime test environment

[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
is independently opt-in. Set `OCC_TEST_HARNESS_K3D_REAL=1` or explicitly select
a real runtime image to enable the ordinary three-case suite. Once selected,
missing cluster, image, database, credential, or NetworkPolicy prerequisites
fail instead of skipping. The ordinary suite verifies dedicated Codex, embedded
OpenClaw with a persisted provider credential, and embedded OpenClaw with the
Secret API through real Enterprise gateways on an explicitly selected disposable
k3d cluster. For dedicated Codex coverage, set `OCC_TEST_OPENAI_MODEL` to an
authorized model that supports Codex custom tools, such as `gpt-5.1`; the source
default remains `gpt-4.1`.

| Variable                               | Requirement or default                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OCC_TEST_HARNESS_K3D_REAL`            | Set to `1` to explicitly opt into the real-runtime Kubernetes suite.                                   |
| `OCC_TEST_KUBERNETES_KUBECONFIG`       | Absolute path to the dedicated disposable k3d kubeconfig.                                              |
| `OCC_TEST_KUBERNETES_CONTEXT`          | Explicit `k3d-*` context with a verified loopback HTTPS API.                                           |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`    | Imported real OpenClaw gateway image pinned with an immutable SHA-256 digest.                          |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`      | Imported real pinned Codex runtime image with an immutable SHA-256 digest.                             |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`    | Optional shared image fallback for both gateway and Agent when it contains both real runtimes.         |
| `OCC_TEST_KUBERNETES_CODEX_IMAGE`      | Optional legacy fallback for the Agent image when the explicit Agent image is absent.                  |
| `OCC_TEST_KUBERNETES_OPENCLAW_VERSION` | Optional exact OpenClaw version expectation for the selected real gateway image.                       |
| `OCC_TEST_KUBERNETES_CODEX_VERSION`    | Optional Codex image version expectation; defaults to `0.147.0`.                                       |
| `OCC_TEST_DATABASE_URL`                | Migrated disposable loopback database named `openclaw_k8s_*`; the ordinary development database fails. |
| `OPENAI_API_KEY`                       | Existing authorized provider credential for real embedded and dedicated model turns.                   |
| `OCC_TEST_OPENAI_MODEL`                | Authorized provider model; defaults to `gpt-4.1`.                                                      |

### Slack test environment

`OCC_TEST_SLACK_LIVE=1` selects the separate live Slack case and suppresses the
ordinary three-case suite. The Slack case uses the same production k3d,
PostgreSQL, image, and model-turn prerequisites, then posts a real message and
waits for a gateway-authored reply. It does not delete the Slack messages it
creates.

| Variable                          | Requirement                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `OCC_TEST_SLACK_LIVE`             | Set to `1` to run the selected live Slack case instead of the ordinary real-runtime cases. |
| `OCC_TEST_SLACK_PROXY_URL`        | Approved exact literal-IP proxy URL with an explicit port for channel egress.              |
| `OCC_TEST_SLACK_CHANNEL_ID`       | Shared test channel joined by the gateway bot and the sender bot.                          |
| `SLACK_APP_TOKEN`                 | Gateway Socket Mode token; must start with `xapp-`.                                        |
| `SLACK_BOT_TOKEN`                 | Gateway bot token; must start with `xoxb-`.                                                |
| `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Distinct sender bot token in the same Slack workspace; must start with `xoxb-`.            |

See the [Slack testing guide](../testing.md#slack) for setup and cleanup
expectations before selecting the live case.

### OpenShell test environment

[`sandbox-driver-openshell-k3d-real.test.mjs`](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
is selected by `OCC_TEST_OPENSHELL_K3D_REAL=1` or by setting any Kubernetes,
image, database, or OpenShell-specific prerequisite. If any of those variables
is present while the flag is not `1`, prerequisite validation still fails; use a
scoped environment file for this suite.

| Variable                              | Requirement or default                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_OPENSHELL_K3D_REAL`         | Set to `1` to explicitly opt into the real OpenShell integration.                                                |
| `OPENAI_API_KEY`                      | Existing authorized provider credential for the required real model turn.                                        |
| `OCC_TEST_OPENAI_MODEL`               | Authorized provider model; defaults to `gpt-5.6-sol`.                                                            |
| `OCC_TEST_KUBERNETES_KUBECONFIG`      | Absolute kubeconfig path for the dedicated disposable k3d cluster.                                               |
| `OCC_TEST_KUBERNETES_CONTEXT`         | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                     |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`   | Imported immutable real OpenClaw gateway image; `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` is accepted as a fallback.   |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`     | Imported immutable real Codex image; `OCC_TEST_KUBERNETES_CODEX_IMAGE` and runtime image fallbacks are accepted. |
| `OCC_TEST_DATABASE_URL`               | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                                         |
| `OCC_TEST_OPENSHELL_CLI`              | Official OpenShell CLI binary.                                                                                   |
| `OCC_TEST_OPENSHELL_HELM`             | Helm binary used to install the namespace-scoped OpenShell gateway.                                              |
| `OCC_TEST_OPENSHELL_HELM_CHART`       | OpenShell Helm chart path or chart archive.                                                                      |
| `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`    | Imported immutable OpenShell gateway image pinned by SHA-256 digest.                                             |
| `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE` | Imported immutable OpenShell supervisor image pinned by SHA-256 digest.                                          |
| `OCC_TEST_OPENSHELL_CHART_VERSION`    | Optional OpenShell chart version; defaults to `0.0.113`.                                                         |
| `OCC_TEST_OPENSHELL_RUNTIME_CLASS`    | Existing RuntimeClass used by Agent Sandbox Pods; defaults to `openshell-sandbox`.                               |

The selected cluster must already expose the Agent Sandbox CRD and a ready Agent
Sandbox controller. See the
[OpenShell SandboxDriver testing guide](../testing.md#openshell-sandbox) for
the required cluster, image, database, RuntimeClass, and chart setup.

### Production TUI Helm test environment

[`production-tui-k3d-real.test.mjs`](../../tests/integration/production-tui-k3d-real.test.mjs)
is the opt-in end-to-end production TUI proof. It installs the actual Helm
chart into the selected disposable k3d cluster, starts task-owned PostgreSQL and
HTTPS operator proxy Pods, provisions a Namespace and embedded OpenClaw Agent
through the production API, drives the native TUI with a PTY, verifies revision
cutover, and records nonsecret evidence as it progresses. The test sets
`agents.defaults.skipBootstrap` to `true` in the disposable demo Agent
Configuration so fresh-workspace `BOOTSTRAP.md` onboarding does not replace the
nonce reply; existing workspaces with bootstrap files are unaffected. Missing
prerequisites fail the selected test instead of skipping.

| Variable                               | Requirement or default                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_PRODUCTION_TUI_REAL`         | Set to `1` to explicitly opt into the Helm-backed production TUI suite.                                                 |
| `OCC_TEST_KUBERNETES_KUBECONFIG`       | Absolute path to the dedicated disposable k3d kubeconfig.                                                               |
| `OCC_TEST_KUBERNETES_CONTEXT`          | Explicit `k3d-*` context with a verified loopback HTTPS Kubernetes API.                                                 |
| `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE` | Imported immutable controller image reference used by the Helm chart.                                                   |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`    | Imported immutable runtime image reference used for the embedded OpenClaw gateway.                                      |
| `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`   | Imported immutable PostgreSQL image reference for the task-owned database Pod.                                          |
| `OCC_TEST_PRODUCTION_NODE_IMAGE`       | Imported immutable Node image reference for the operator HTTPS proxy and network probes.                                |
| `OPENAI_API_KEY`                       | Existing authorized provider credential used only by the Agent-owned embedded gateway path.                             |
| `OCC_TEST_OPENAI_MODEL`                | Authorized provider model; defaults to `gpt-5.1`.                                                                       |
| `OCC_TEST_PRODUCTION_TUI_KEEP`         | Optional `1` retains the owned Helm release, namespaces, final gateway, `attach.sh`, and `proof.json` rehearsal output. |

Use the production TUI suite only with image references that already exist in
the selected cluster, including the Node, PostgreSQL, controller, and runtime
digests. Default cleanup uninstalls the Helm release and deletes only the
task-owned namespaces. `OCC_TEST_PRODUCTION_TUI_KEEP=1` changes that finalizer
for operator rehearsal: it keeps the owned setup running, leaves an executable
`attach.sh` for the final gateway TUI session, and writes `proof.json` with the
cluster, image, Namespace, Agent, revision, Pod, and nonce-response evidence.
Do not treat an in-progress run as passing live proof until the test completes.

### ChatGPT service-account integration test environment

[`service-account-driver-real.test.mjs`](../../tests/integration/service-account-driver-real.test.mjs)
creates an actual ChatGPT service account, issues its credential, deploys the
associated dedicated Codex Agent, and requires one genuine provider-backed
model turn. Set `OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1` to opt in; missing
prerequisites then fail rather than skip.

| Variable                                | Requirement                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL` | Set to `1` to enable the real provider-backed account and model-turn test.               |
| `OCC_TEST_CHATGPT_ADMIN_KEY`            | Explicit admin key; takes precedence over the path when set.                             |
| `OCC_TEST_CHATGPT_ADMIN_KEY_PATH`       | Protected `0600` admin-key file read only when `OCC_TEST_CHATGPT_ADMIN_KEY` is unset.    |
| `OCC_TEST_CHATGPT_WORKSPACE_ID`         | ChatGPT workspace authorized for account and credential creation.                        |
| `OCC_TEST_KUBERNETES_KUBECONFIG`        | Absolute kubeconfig path for the dedicated disposable local cluster.                     |
| `OCC_TEST_KUBERNETES_CONTEXT`           | Explicit `k3d-*` context with a verified loopback HTTPS API.                             |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`     | Imported immutable real OpenClaw gateway image.                                          |
| `OCC_TEST_KUBERNETES_CODEX_IMAGE`       | Imported immutable real Codex image; `OCC_TEST_KUBERNETES_AGENT_IMAGE` is also accepted. |
| `OCC_TEST_DATABASE_URL`                 | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                 |

This scenario uses its newly issued access token, not `OPENAI_API_KEY`. Its
optional `OCC_TEST_OPENAI_MODEL` defaults to `gpt-4.1`; set it to an authorized
custom-tool-capable model, such as `gpt-5.1`, for dedicated Codex execution.
When using the file path, unset `OCC_TEST_CHATGPT_ADMIN_KEY` first so the test
actually reads the protected file. See the
[ChatGPT service-account testing guide](../testing.md#chatgpt-service-accounts)
for the complete setup.

### Helm packaging test environment

The checked-in production packaging integration renders the real Helm chart
and inspects it with an existing `yq` executable. `OCC_HELM_BIN` optionally
selects an existing Helm executable; otherwise the test resolves `helm` from
`PATH`. Missing Helm or `yq` skips this packaging check. Rendering does not
install the chart, reconcile a cluster, or establish a real model turn.

## Fixed development security settings

The active runtime does not expose environment variables for these settings:

- Maximum HTTP request body: `64 KiB`.
- Maximum nested JSON configuration depth: `24`; prototype-mutating property
  names are rejected.
- Resource display names: `1` through `200` characters, without outer whitespace
  or control characters.
- Proxy trust: disabled; `Forwarded`, `X-Forwarded-*`, and `X-Real-IP` traffic
  is rejected.
- Admission scope: exactly one server-selected Installation.
- Internal tenant scope: exact `namespaceId` for ordinary resources, policy,
  controller work, and Compute lifecycle observations.
- Development-default Compute Driver for PostgreSQL-backed development: the
  Docker driver, `compute-docker-development`. Manual host-process debugging
  also needs PostgreSQL for a durable worker path.
- Agent gateway cardinality: exactly one gateway Deployment and gateway Pod per
  deployed Agent; a Namespace can contain multiple single-replica gateways.
- Background reconciliation: available through a separately started PostgreSQL
  polling worker; production workers reconcile Namespace operations and
  embedded OpenClaw or dedicated Codex AgentRevisions, and the API never
  launches a worker automatically.
- Public ingress, stronger pre-execution sandbox barriers, credential brokerage,
  and external identity providers remain
  unavailable.

An embedded caller can set `ControllerAppOptions.maxBodyBytes` to a positive
integer, but the supported development compositions fix it at `64 * 1024` and
offer no environment override.

## Programmatic configuration

The following options are TypeScript integration seams. They are not
environment variables, public API parameters, or operator configuration.

### Controller and admission

[`ControllerOptions`](../../packages/occ/src/index.ts) can inject an authorization
callback, clock, resource-ID generator, `PlatformStateStore`, and
`recordOperations` flag. The supported development and production paths use
PostgreSQL composition with `recordOperations: true`.

[`ControllerAppOptions`](../../apps/controller/src/index.ts) supplies the existing
controller or controller factory, selected IAM and optional Compute Drivers,
audit sink, required controller auth, optional audit factory, and optional
positive request-body limit.

[`ControllerAuthOptions`](../../apps/controller/src/auth/index.ts) requires an
explicit runtime mode, Installation ID, Better Auth base URL, high-entropy
secret, and either memory or PostgreSQL-backed Better Auth storage. Development
can use insecure cookies for loopback; production uses secure cookies.

[`NativeIAMDriverOptions`](../../packages/iam/src/index.ts) accepts an optional
nonempty Driver `id` and `implementation`. Its standalone defaults are
`occ-native-iam` and `native`; application compositions choose their own Driver
IDs as described above. The Driver reads current policy from controller-owned
platform state for each identity lookup and authorization decision.

[`PostgresPlatformStateOptions`](../../packages/occ/src/state/postgres-state.ts)
accepts optional bootstrap native IAM policy. Groups, memberships, Roles,
bindings, and deny-only Restrictions are persisted policy data, not
environment-configurable authorization rules.

[`InMemoryPlatformStateOptions`](../../packages/occ/src/state/platform-state.ts)
accepts an optional transactional audit sink.

[`AuditEventFactoryOptions`](../../packages/audit/src/index.ts) accepts an optional
clock and audit-ID generator; their defaults are the current time and a new
`aud_`-prefixed UUID.

### Kubernetes Compute Driver

[`KubernetesComputeDriver` and `createKubernetesComputeDriver`](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
accept an explicit `authentication` mode
(`"inCluster"` or `"kubeconfig"`); approved `images` and immutable-image
policy; explicit gateway, Agent, and namespace `resources`; exact DNS and
gateway-client `network` peers; `servicePrincipalCredentials` policy; and an
explicit production `runtime` containing per-Agent operator-provisioned
transport and model Secret-name prefixes and required
`gatewayStorageClassName` selecting the StorageClass for each gateway's private
disk, not its shared workspace. The operator must verify the backing disk's
filesystem locking and durability guarantees.
The Codex port and volume sizes are driver-owned constants; see the
[storage contract](drivers/kubernetes-compute.md#storage-and-credentials).
Production currently permits temporary Agent public TCP/443 egress until a
restricted model proxy exists. Every tenant gateway Deployment
has exactly one replica because the OpenClaw gateway does not support multiple
replicas. The kubeconfig mode requires both an explicit file and named context;
in-cluster mode uses the controller's ServiceAccount. The driver never selects
the ambient kubeconfig or context. Driver options do not accept injected
Kubernetes clients or bypass selected credentials, HTTPS, or TLS verification.

Production persists the exact Compute Driver ID and implementation selected by
the startup YAML, such as `compute-kubernetes` / `occ/kubernetes`. Existing
direct development constructors retain their own local default identities.
Neither identity restricts verified cluster authentication or Kubernetes API
endpoints to local-only access.

Production API and worker entrypoints both load the same explicit
`drivers.compute.configuration` section
from the Installation startup YAML at `OCC_CONFIG_PATH`; each resolves the
bootstrapped singleton Installation internally. Development callers may
also pass the driver programmatically to
`composePostgresDevelopment(config, { computeDriver })`. The selected
driver preserves tenant-local RBAC boundaries, enforced NetworkPolicies,
hardened workloads, and projected Agent ServicePrincipal tokens. When the
explicit production runtime is enabled, it routes dedicated Codex or combined
embedded OpenClaw Agents only after their exact revisions become active. Each
production Harness receives only its own Agent's projected identity and
operator-owned model key. See the
[Kubernetes Compute Driver guide](drivers/kubernetes-compute.md) for the exact options,
installation prerequisites, and k3d verification.

### Kubernetes Configuration Driver

The selected Kubernetes Configuration Driver stores Namespace-owned native
OpenClaw configuration documents. It maps each
Configuration to one ConfigMap in the Kubernetes namespace selected by OCC for
that exact tenant, with exactly one `openclaw.json` data entry. Nested values
and canonical inline SecretRefs retain their original structure; references
remain unresolved. Installation settings and Driver options remain in startup
YAML; ConfigMaps do not store Installation configuration. Its
namespaced Kubernetes Role requires only ConfigMap `create`, `get`, `update`,
and `delete`.

Each selected Driver exposes its closed configuration schema and validates its
own startup settings before OCC constructs the implementation. API operations
are authorized against their exact Namespace or Configuration, OCC validates
native Configuration semantics, and deployment deeply snapshots the complete
document into immutable AgentRevisions. See
[Namespace configuration](configuration.md) for CRUD, exact permissions,
minimal RBAC, startup validation, revision safety, and troubleshooting.
Configuration Driver Kubernetes access is checked lazily during the first exact
CRUD request, not by startup preflight; a provisioning Namespace without its
Kubernetes namespace or tenant grant may return `503` until infrastructure is
ready.

### Durable controller-work queue

[`PostgresWorkQueueOptions`](../../packages/occ/src/state/postgres-work-queue.ts)
accepts these constructor options:

| Option             | Default       | Constraint                                        |
| ------------------ | ------------- | ------------------------------------------------- |
| `maxAttempts`      | `10`          | Positive safe integer.                            |
| `leaseDurationMs`  | `60000`       | Positive safe integer, expressed in milliseconds. |
| `claimRaceRetries` | `3`           | Positive safe integer.                            |
| `random`           | `Math.random` | Function returning a finite number in `[0, 1)`.   |
| `workKind`         | `all`         | `all` or `namespace`; production uses `all`.      |

Retry backoff starts at `1000 ms`, is capped at `300000 ms`, and includes the
configured jitter source. Stale-claim recovery defaults to `100` rows and
rejects limits above `1000`. The worker overrides the queue's standalone
`maxAttempts` and `leaseDurationMs` defaults through its
[environment settings](#controller-worker-environment). Development and
production workers consume Namespace work and selected AgentRevision work
through the configured bundled or installed Compute Driver. The bundled
Kubernetes Driver activates approved embedded OpenClaw and dedicated Codex
revisions. Pending Namespace convergence
returns the live claim
to the queue without consuming a failure attempt and remains bounded by
`OCC_WORKER_CONVERGENCE_TIMEOUT_MS`.
Retry backoff, queue jitter, claim-race retries, and stale-recovery limits have
no environment-variable overrides.

## Repository and tooling configuration

The active workspace requires Node.js 24 or newer and pins pnpm `11.15.1` in
[`package.json`](../../package.json). Repository-wide settings are defined in:

- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml): one controller application
  and five platform packages.
- [`tsconfig.base.json`](../../tsconfig.base.json): strict TypeScript,
  `NodeNext` modules, ES2022 output, and declaration generation.
- [`tsconfig.json`](../../tsconfig.json): the six active TypeScript project
  references.
- [`.prettierrc.json`](../../.prettierrc.json): a `100`-column print width.
- [`.githooks/pre-push`](../../.githooks/pre-push): the repository-managed
  formatting check invoked by a normal Git push. It runs the installed Prettier
  executable directly without invoking a package manager or installing
  dependencies, and blocks pushes when Prettier is unavailable.

Dependency installation installs the hook in Git's native hooks directory.
Run `pnpm hooks:install` to reinstall it. Installation preserves an existing
`core.hooksPath` setting and refuses to replace an unmanaged pre-push hook.
The hook checks active source and root files; authored documentation also needs
the full formatting check below.

The root formatting scripts cover active source files, root Markdown, and
authored `docs/**/*.md`. The generated API reference is excluded and verified by
`pnpm openapi:check`. Run the complete authored-file check with:

```bash
pnpm format:check
git diff --check
```

After changing API routes or schemas, regenerate the API artifacts with
`pnpm openapi:generate` and verify them with `pnpm openapi:check`. To check the
generated Markdown against the checked-in OpenAPI contract without loading
controller dependencies, run `node scripts/generate-occ-api-reference.mjs --check`.

See the [architecture guide](../ARCHITECTURE.md) for ownership and runtime
boundaries, the [quickstart](../guides/quickstart.md) for the default local
startup helper, and the [deployment guide](../guides/deploy.md) for production
example files and Helm installation.
