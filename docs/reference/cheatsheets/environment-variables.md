# Environment variables cheat sheet

Find supported environment variables for the CLI, controller, worker, bootstrap,
and local development. The controller reads its process environment; it does
not load `.env` automatically. See [Settings](../settings.md) for configuration
precedence and [Testing](../../testing/README.md) for test-only variables.
Variables generated internally for Agent containers or development tooling are
not listed unless they are also documented settings.

## CLI

Command-line flags override these variables. See the [CLI reference](../cli.md).

- `OCC_URL` — Control Plane HTTP(S) origin; required for resource commands.
- `OCC_SERVICE_KEY_FILE` — Path to a service-key JSON response; required for resource commands.
- `OCC_NAMESPACE` — Namespace ID for scoped resource commands.
- `OCC_CA_BUNDLE` — Additional PEM certificate-authority bundle for HTTPS.
- `OCC_TIMEOUT_SECONDS` — Request timeout in whole seconds; default: `30`.

## Controller and authentication

See the [production settings](../settings/production.md) or
[development settings](../settings/development.md) for required inputs. The browser
console uses the current origin and has no separate environment settings.

- `NODE_ENV` — Required mode: `development` or `production`; shared with the worker and bootstrap.
- `OCC_HOST` — API bind address: one explicit Pod IP in production; loopback for host-process development.
- `OCC_PORT` — API listener port; no process default.
- `OCC_CONFIG_PATH` — Absolute path to trusted Installation YAML; required in production and shared with the worker.
- `OCC_AUTH_SECRET` — Production requires a high-entropy session-signing secret; development has a local-only fallback.
- `OCC_AUTH_BASE_URL` — Authentication and cookie origin; required in production; default in development: `http://127.0.0.1:3000`.
- `OCC_AGENT_NATIVE_ADMIN_ENABLED` — Enables the Agent native admin pilot; default: `false`.
- `OCC_AGENT_NATIVE_ADMIN_DOMAIN` — Agent hostname suffix; required when the pilot is enabled.
- `OCC_AUTH_COOKIE_DOMAIN` — Shared parent domain for console and Agent cookies; required when the pilot is enabled.
- `OCC_GATEWAY_API_KEY_PATH` — API/worker absolute path to the private gateway service-key file for operator RPCs and dedicated node enrollment.
- `NODE_EXTRA_CA_CERTS` — Additional Node.js PEM trust bundle for a private OCC or gateway CA; read at process startup.

## PostgreSQL and migrations

See [PostgreSQL settings](../settings/operations.md#postgresql-connection-authentication)
for authentication modes and TLS requirements.

- `OCC_DATABASE_URL` — Application-role URL for the API, worker, and bootstrap.
- `OCC_MIGRATION_DATABASE_URL` — Separate migrator-role URL; never use it for the API or worker.
- `OCC_DATABASE_POOL_MAX` — API pool size; client default: `10`.
- `OCC_DATABASE_AUTH` — `password` (default) or `azure-workload-identity`.
- `AZURE_TENANT_ID` — Workload identity tenant; required in Azure mode.
- `AZURE_CLIENT_ID` — Workload identity client; required in Azure mode.
- `AZURE_FEDERATED_TOKEN_FILE` — Projected token file; required in Azure mode.
- `OCC_POSTGRES_PORT` — Local Compose PostgreSQL host port; default: `55432`.

## Installation bootstrap

These belong to the initializer, not the running API or worker. See
[production bootstrap settings](../settings/production.md#production-installation-bootstrap-environment)
and [development defaults](../settings/development.md#required-development-controller-environment).

- `OCC_BOOTSTRAP_ADMIN_EMAIL` — Initial production administrator email.
- `OCC_BOOTSTRAP_INSTALLATION_NAME` — Initial production Installation display name.
- `OCC_BOOTSTRAP_PASSWORD_FILE` — New protected output path for the production administrator password.
- `OCC_BOOTSTRAP_SERVICE_KEY_FILE` — New private absolute output path for the initial service-key JSON; used in production and development.
- `OPENCLAW_DEV_EMAIL` — Development administrator email; default: `admin@openclaw.local`.
- `OPENCLAW_DEV_PASSWORD` — Development administrator password.
- `OPENCLAW_DEV_INSTALLATION_NAME` — Development Installation display name; default: `OpenClaw Local Development`.

## Worker

The worker shares `NODE_ENV`, `OCC_DATABASE_URL`, and `OCC_CONFIG_PATH` with
the API. It does not use API listener or session-authentication settings. See
[worker settings](../settings/operations.md#controller-worker-environment).

- `OCC_WORKER_POLL_INTERVAL_MS` — Idle polling delay; default: `250` ms.
- `OCC_WORKER_LEASE_DURATION_MS` — Claim lease; default: `5000` ms.
- `OCC_WORKER_MAX_ATTEMPTS` — Maximum work attempts; default: `5`.
- `OCC_WORKER_CONVERGENCE_TIMEOUT_MS` — Namespace convergence timeout; default: `900000` ms.
- `OCC_WORKER_READINESS_PATH` — Optional absolute path for the readiness marker; packaged probes require it.

## Local development and Compute

These settings belong to the checkout's development stack. See
[development settings](../settings/development.md#required-development-controller-environment)
for supported engines, images, and security restrictions.

- `OCC_DEVELOPMENT_COMPUTE_DRIVER` — `docker` (default) or `kubernetes`; only the Kubernetes quickstart can deploy Agents.
- `OCC_DEVELOPMENT_CONTAINER_ENGINE` — `auto` (default), `docker`, or `podman`.
- `OPENCLAW_DEV_PORT` — Published API port on host loopback; default: `3000`.
- `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` — Compose bridge allowed to reach the development API.
- `OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR` — Single private forwarding IP; supplied automatically for rootful macOS Podman.
- `OCC_DEVELOPMENT_CONFIGURATION_ROOT` — Absolute path to the development filesystem Configuration Driver's root.
- `OCC_DOCKER_RUNTIME_IMAGE` — Shared image for the Docker gateway and Agent; may replace the two separate images.
- `OCC_DOCKER_GATEWAY_IMAGE` — Docker gateway image when a shared image is not used.
- `OCC_DOCKER_AGENT_IMAGE` — Docker Codex Agent image when a shared image is not used.
- `OCC_KUBERNETES_RUNTIME_IMAGE` — Existing local Kubernetes runtime image; otherwise the helper builds its default image.
- `OCC_DEVELOPMENT_STATE_DIRECTORY` — Private Kubernetes profile state; default: `/tmp/openclaw-development`. Use the same value for cleanup.
- `OCC_DEVELOPMENT_COMPOSE_PROJECT` — Kubernetes profile's Compose project; default: `openclaw-enterprise-development-kubernetes`.
- `OCC_DEVELOPMENT_KUBERNETES_CLUSTER` — Disposable k3d cluster; default: a generated name beginning with `occ-dev-`.
- `OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS` — Kubernetes profile startup timeout; default: `300` seconds per wait.
- `OCC_DEVELOPMENT_KUBERNETES_API_PORT` — Local Kubernetes API port; default: `6443`.
- `OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT` — Disposable cluster disk-pressure threshold; default: `5`.
- `OCC_CONTAINER_ENGINE_SOCKET` — Podman API socket; the development helper supplies it automatically.
- `DOCKER_HOST`, `DOCKER_CONTEXT` — Docker endpoint or named context; an explicit context takes precedence. The Kubernetes profile requires a local `unix:///` socket and records the selected endpoint.
- `CONTAINER_CONNECTION`, `CONTAINER_HOST` — Podman's connection selection; preserved during Docker-profile cleanup when Podman is the engine.

### First Agent and local model credentials

For a local model turn, see [Deploy your first Agent](../../guides/first-agent.md).
Use only one of the two credential inputs. In production, use
[platform Secret bindings](../configuration/secrets.md) instead of setting the
credential on the controller.

- `OPENAI_API_KEY` — Authorized credential for local real-model use.
- `OPENAI_API_KEY_FILE` — Absolute path to a private credential file for the first-Agent helper.
- `OPENCLAW_FIRST_AGENT_MODEL` — Plain OpenAI model ID, without a provider prefix; default for a new Agent: `gpt-6-astra`.

## Observability

The application log level is the Installation YAML setting `logging.level`;
there is no controller environment override. The variables below configure the
Collector or local Docker log forwarding. See [Observability](../../guides/observability.md).

- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` — Collector export endpoint; required by the logging Compose override.
- `OTEL_COLLECTOR_PORT` — Local Collector Fluent Forward port; default: `24224`.
- `OTEL_COLLECTOR_METRICS_PORT` — Local Collector metrics port; default: `8888`.
- `OCC_DOCKER_LOGGING_ADDRESS` — Docker Compute log destination; local override default: `127.0.0.1:24224`.
