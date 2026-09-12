# Development controller settings

This reference owns development controller settings. Start with the
[settings reference](../settings.md) for startup configuration and precedence.

## Required development controller environment

The table includes Compose inputs for its separate processes. `OPENCLAW_DEV_EMAIL`,
`OPENCLAW_DEV_PASSWORD`, `OPENCLAW_DEV_INSTALLATION_NAME`, and
`OCC_BOOTSTRAP_SERVICE_KEY_FILE` belong only to the initializer; the API and
worker require initialized state and do not read those credentials or output.

| Variable                              | Required value or format                                                     | Behavior                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | Exactly `development`.                                                       | Selects local development admission; production has [separate required inputs](production.md#required-production-controller-environment).                                                                         |
| `OCC_HOST`                            | Host-process development: exactly `127.0.0.1` or `::1`; Compose: `0.0.0.0`.  | Host-process development must bind loopback. Compose may bind `0.0.0.0` inside its private bridge only because the published host port remains `127.0.0.1` and `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` is explicit. |
| `OCC_PORT`                            | Decimal integer from `1` through `65535`.                                    | Selects the controller TCP port; no default is supplied.                                                                                                                                                          |
| `OCC_AUTH_SECRET`                     | High-entropy secret string.                                                  | Signs and verifies user session material; do not reuse across installations.                                                                                                                                      |
| `OCC_AUTH_BASE_URL`                   | Absolute controller base URL.                                                | Defines the Better Auth base URL and cookie origin for backend auth endpoints.                                                                                                                                    |
| `OPENCLAW_DEV_EMAIL`                  | Email address.                                                               | Initializer input selecting the development administrator sign-in email; defaults to `admin@openclaw.local`.                                                                                                      |
| `OPENCLAW_DEV_INSTALLATION_NAME`      | `OpenClaw Local Development`.                                                | Development-only Installation name used by the initializer when the database is fresh.                                                                                                                            |
| `OPENCLAW_DEV_PASSWORD`               | String from `12` through `128` characters.                                   | Initializer input selecting the development administrator sign-in password; defaults to `openclaw-development-password`.                                                                                          |
| `OCC_DOCKER_GATEWAY_IMAGE`            | Image reference.                                                             | Existing OpenClaw gateway image with Node 24.15+, `/app/openclaw.mjs`, bundled skills, and the Codex plugin. Required unless `OCC_DOCKER_RUNTIME_IMAGE` supplies both runtimes.                                   |
| `OCC_DOCKER_AGENT_IMAGE`              | Image reference.                                                             | Existing Codex Agent image with Node 24.15+, `codex` on `PATH`, and `codex app-server`. Required unless `OCC_DOCKER_RUNTIME_IMAGE` supplies both runtimes.                                                        |
| `OCC_DOCKER_RUNTIME_IMAGE`            | Image reference.                                                             | Optional shared image used for both gateway and Agent runtimes when it contains both entrypoints; `scripts/dev-up` selects `openclaw-enterprise-runtime:quickstart` for its default invocation.                   |
| `OPENCLAW_DEV_PORT`                   | TCP port; defaults to `3000`.                                                | Publishes the controller on host `127.0.0.1:<port>`.                                                                                                                                                              |
| `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` | CIDR block.                                                                  | Explicit Compose bridge range admitted as local development traffic while keeping forwarded headers rejected.                                                                                                     |
| `OCC_CONTAINER_ENGINE_SOCKET`         | Absolute socket path; Podman only.                                           | `scripts/dev-up` reads Podman's reported API socket and supplies it to `compose.podman.yaml`; operators do not need to set it for the supported helper path.                                                      |
| `OCC_DEVELOPMENT_CONFIGURATION_ROOT`  | Absolute path.                                                               | Development filesystem Configuration Driver root. Compose sets `/app/.development/configurations` from the controller-only `occ_configuration_data` volume.                                                       |
| `OCC_BOOTSTRAP_SERVICE_KEY_FILE`      | Required private absolute output path; written only on fresh initialization. | Compose supplies `/var/lib/openclaw/bootstrap/initial-admin-service-key.json` on its bootstrap-only volume. Existing Installations do not issue or replace output.                                                |
| `OPENAI_API_KEY`                      | Existing authorized provider credential.                                     | Used only by the Agent-owned combined embedded container or dedicated Codex container for real model turns; never print or commit it.                                                                             |

Generate `OCC_AUTH_SECRET` with `openssl rand -hex 32`; do not commit it, log
it, or reuse another installation's secret. Local `.env` files are ignored by
Git. Compose reads them through native precedence; do not source `.env` as
shell.

Caller-supplied identity headers, forwarded requests, trusted proxies, bearer
credentials, and non-loopback clients are rejected. The Compose bridge CIDR is
trusted only for the development stack's internal controller and worker path;
workload containers do not receive the container-engine socket, controller
credentials, the configuration volume, or sibling Namespace network access.

## Optional controller environment

| Variable                   | Default or behavior when omitted                                                                     | Validation and scope                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OCC_DATABASE_URL`         | Compose supplies PostgreSQL. Manual host-process debugging should also set the application-role URL. | Must use a `postgresql:` or `postgres:` URL and the application role for the supported development path.                      |
| `OCC_CONFIG_PATH`          | Optional in development; required in production.                                                     | Must be an absolute path to trusted, closed-schema Installation startup YAML whenever present.                                |
| `OCC_GATEWAY_API_KEY_PATH` | Optional when development selects Kubernetes Compute with private routing.                           | Absolute mounted service-key file, read by the API only. Docker Compute does not provide private gateway endpoint resolution. |
| `OCC_DATABASE_POOL_MAX`    | The installed PostgreSQL client's default: `10`.                                                     | Must be a positive safe integer. Applies to the PostgreSQL connection pool; it is validated whenever present.                 |

OCC resolves the one persisted Installation internally; no startup environment
variable or YAML field supplies its identifier. The stable ID remains visible
through `GET /installation` and is retained at server admission,
exported-audit, and external deployment boundaries. Ordinary Namespace and Agent
API resources, internal IAM records, repository calls, controller-work
objects, and Compute lifecycle observations inherit the singleton Installation
implicitly; `namespaceId` remains their exact tenant boundary.

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
