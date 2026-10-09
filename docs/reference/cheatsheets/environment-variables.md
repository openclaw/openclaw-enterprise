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
- `OCC_AUTH_GITHUB_CLIENT_ID` — Optional GitHub App client ID, not App ID; selects the provider instance. Requires PostgreSQL, native IAM, and both GitHub settings below; see [GitHub sign-in](../authentication/external-sign-in.md#github-sign-in-for-existing-accounts).
- `OCC_AUTH_GITHUB_CLIENT_SECRET` — Protected server-side client secret for the configured GitHub App; its private key stays with the repository credential consumer.
- `OCC_AUTH_GITHUB_ALLOWED_ORGS` — Optional comma-separated GitHub organization logins; when set (or with the teams), GitHub sign-in requires active membership. See the [allowlist](../authentication/external-sign-in.md#organization-and-team-allowlist).
- `OCC_AUTH_GITHUB_ALLOWED_TEAMS` — Optional comma-separated `org/team-slug` entries whose active members may use GitHub sign-in; at most 10 entries with the organizations.
- `OCC_AUTH_GITHUB_RECOVERY_USER_ID` — Existing local password administrator protected for recovery when GitHub, Google or OIDC sign-in is enabled.
- `OCC_AUTH_PASSWORD_SIGN_IN` — `all` (default) or `recovery-only`, which lets only the recovery account sign in with a password; requires GitHub, Google or OIDC sign-in. See [recovery-only password sign-in](../authentication/external-sign-in.md#recovery-only-password-sign-in).
- `OCC_AUTH_GOOGLE_CLIENT_ID` — Optional Google OAuth web client ID; selects the provider instance. Requires the client secret and the recovery user ID; see [Google sign-in](../../guides/deploy/google-sign-in.md).
- `OCC_AUTH_GOOGLE_CLIENT_SECRET` — Protected server-side client secret for the configured Google OAuth client.
- `OCC_AUTH_GOOGLE_ALLOWED_DOMAINS` — Optional comma-separated Google Workspace hosted domains; when set, sign-in requires a matching `hd` claim and a verified email.
- `OCC_AUTH_OIDC_ISSUER`, `OCC_AUTH_OIDC_AUTHORIZATION_URL`, `OCC_AUTH_OIDC_TOKEN_URL`, `OCC_AUTH_OIDC_JWKS_URL` — Optional generic OIDC issuer and its URLs, copied from the discovery document: `https:` on port 443, one DNS host, no query or fragment. Set all of them with the client ID, client secret and recovery user ID, or none; see [OIDC sign-in](../../guides/deploy/oidc-sign-in.md).
- `OCC_AUTH_OIDC_CLIENT_ID`, `OCC_AUTH_OIDC_CLIENT_SECRET` — The OIDC client; with the issuer, they select the provider instance.
- `OCC_AUTH_OIDC_TOKEN_AUTH` — `client_secret_post` (default) or `client_secret_basic`.
- `OCC_AUTH_OIDC_DISPLAY_NAME` — Optional Console button label, 1–40 printable characters; default `single sign-on`.
- `OCC_AUTH_TRUSTED_PROXY_CIDRS` — Production-only, off by default: comma-separated ingress or load balancer CIDRs. IPv4-mapped IPv6 counts as IPv4 (prefix 1–32); entries covering every IPv4 or every IPv6 address are refused. Trusted peers may report client addresses for sign-in limits; see [trusted proxies](../settings/production.md#github-sign-in-and-trusted-proxies).
- `OCC_AUTH_TRUSTED_PROXY_PRESET` — `ingress-nginx` (default) or `aws` (Application Load Balancer), both reading `X-Forwarded-For`, or `generic`. A Network Load Balancer that preserves client addresses needs no trusted proxy.
- `OCC_AUTH_CLIENT_IP_HEADER` — Lowercase header carrying the client address, such as `x-real-ip`; required by `generic` only.
- `OCC_AGENT_NATIVE_ADMIN_ENABLED` — Enables the Agent native admin pilot; default: `false`.
- `OCC_AGENT_RUNTIME_LOGS_ENABLED` — `false` makes the Agent runtime status and log routes answer `501`; default: `true`. Set by the chart's `agentRuntimeLogs.enabled`.
- `OCC_AGENT_NATIVE_ADMIN_DOMAIN` — Agent hostname suffix; required when the pilot is enabled.
- `OCC_AUTH_COOKIE_DOMAIN` — Shared parent domain for console and Agent cookies; required when the pilot is enabled.
- `OCC_GATEWAY_API_KEY_PATH` — API/worker absolute path to the private gateway service-key file for operator RPCs and dedicated node enrollment.
- `OCC_CHANNEL_DIRECTORY_PROXY_URL` — Optional API-only HTTP(S) proxy endpoint for production Slack directory lookup and credential validation; set by Helm `slackProxy.enabled` or `api.channelDirectoryProxyUrl`.
- `OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST` — Exact Kubernetes Service host accepted as a managed Slack directory proxy; set only by Helm `slackProxy.enabled`.
- `NODE_EXTRA_CA_CERTS` — Additional process-wide Node.js PEM trust for private OCC, Gateway or IdP CAs; read at process startup. The chart combines IdP and Gateway roots for the API; see [OIDC CA settings](../settings/oidc.md).

## PostgreSQL and migrations

See [PostgreSQL settings](../settings/operations.md#postgresql-connection-authentication)
for authentication modes and TLS requirements.

- `OCC_DATABASE_URL` — Application-role URL for the API, worker, and bootstrap.
- `OCC_MIGRATION_DATABASE_URL` — Separate migrator-role URL for migrations and `pnpm auth:maintain`; never use it for the API or worker.
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
- `OCC_WORKER_DATABASE_TIMEOUT_MS` — Client-side bound on each worker database query; default: `60000` ms.
- `OCC_WORKER_READINESS_PATH` — Optional absolute path for the readiness marker; packaged probes require it.
- `OCC_WORKER_LIVENESS_PATH` — Optional absolute path for the run-loop progress marker; the packaged liveness probe checks its age.

## Local development and Compute

These settings belong to the checkout's development stack. See
[development settings](../settings/development.md#required-development-controller-environment)
for supported engines, images, and security restrictions.

- `OCC_DEVELOPMENT_COMPUTE_DRIVER` — `docker` (default) or `kubernetes`; the Docker preview cannot deploy Agents.
- `OCC_DEVELOPMENT_SANDBOX_DRIVER` — `none` (default) or `openshell`; OpenShell requires Kubernetes Compute.
- `OCC_DEVELOPMENT_CONTROL_PLANE` — `compose` (default) or `kubernetes`; Kubernetes control plane requires Kubernetes Compute. Compose mode keeps PostgreSQL and OCC in Compose while Kubernetes Compute runs in k3d.
- `OCC_DEVELOPMENT_CONTAINER_ENGINE` — `auto` (default), `docker`, or `podman`; Kubernetes-only mode uses it for k3d and image operations, while Compose mode also requires its Compose provider.
- `OPENCLAW_DEV_PORT` — Published API port on host loopback; default: `3000`.
- `OCC_DEVELOPMENT_BROWSER_PORT` — Published HTTPS browser port on host loopback; default: `8443`.
- `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` — Compose bridge allowed to reach the development API.
- `OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR` — Single private forwarding IP; supplied automatically for rootful macOS Podman.
- `OCC_DEVELOPMENT_CONFIGURATION_ROOT` — Absolute path to the development filesystem Configuration Driver's root.
- `OCC_DOCKER_RUNTIME_IMAGE` — Shared image for the Docker gateway and Agent; may replace the two separate images.
- `OCC_DOCKER_GATEWAY_IMAGE` — Docker gateway image when a shared image is not used.
- `OCC_DOCKER_AGENT_IMAGE` — Docker Codex Agent image when a shared image is not used.
- `OCC_KUBERNETES_RUNTIME_IMAGE` — Existing local Kubernetes runtime image; Kubernetes-only startup requires a matching controller digest and checkout revision.
- `OCC_DEVELOPMENT_CONTROLLER_IMAGE` — Existing local OCE controller digest matching the runtime and checkout revision for the Kubernetes-only profile.
- `OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY` — Private local repository registry, App key, and approved upstream IPv4 `/32` endpoint inputs.
- `OCC_DEVELOPMENT_REPOSITORY_IMAGE` — Optional matching immutable repository service image for the Kubernetes-only profile.
- `OCC_DEVELOPMENT_POSTGRES_IMAGE` — Existing local PostgreSQL image for the Kubernetes-only profile; defaults to the pinned PostgreSQL 18.6 image.
- `OCC_DEVELOPMENT_NODE_BASE_IMAGE` — Immutable Node 24 base used when building the Kubernetes-only OCE controller image.
- `OCC_DEVELOPMENT_STATE_DIRECTORY` — Private Kubernetes profile state. When unset, the launching process's temporary directory plus `openclaw-development` (`TMPDIR` if that process set it, otherwise `/tmp` on Linux). Use the same value for cleanup.
- `OCC_DEVELOPMENT_COMPOSE_PROJECT` — Compose control-plane project's name; default: `openclaw-enterprise-development-kubernetes`. Kubernetes-only mode does not use Compose.
- `OCC_DEVELOPMENT_KUBERNETES_NAMESPACE` — Kubernetes namespace that runs the control plane in the Kubernetes-only profile; default: `oce-system`.
- `OCC_DEVELOPMENT_KUBERNETES_CLUSTER` — Disposable k3d cluster; default: a generated name beginning with `occ-dev-`.
- `OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS` — Kubernetes profile cluster and service readiness timeout; default: `600` seconds per wait in Kubernetes-only mode, `300` in Compose mode.
- `OCC_DEVELOPMENT_KUBERNETES_API_PORT` — Local Kubernetes API port; default: `6443`.
- `OCC_DEVELOPMENT_K3D_DNS_RESOLVER` — Optional IPv4 resolver for either local k3d profile, or `k3d` for k3d's default; Linux Docker defaults to the host's upstream resolver.
- `OCC_DEVELOPMENT_K3S_IMAGE` — K3s node image or channel for Compose control plane without OpenShell; default: `+v1.35`. Kubernetes-only and OpenShell profiles use their pinned image.
- `OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT` — Disposable cluster disk-pressure threshold; default: `5`.
- `OCC_DEVELOPMENT_OPENSHELL_HELM_CHART` — Optional absolute OpenShell Gateway chart directory or archive; set it together with the workspace chart override.
- `OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART` — Optional absolute OpenShell workspace chart directory or archive; set it together with the Gateway chart override.
- `OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST` — Optional absolute Agent Sandbox manifest; otherwise the helper downloads its checksum-verified pinned manifest.
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

- `OCC_METRICS_ENABLED`, `OCC_METRICS_HOST`, `OCC_METRICS_PORT` — Private API/worker metrics; the production Helm chart enables Pod-IP port 9464 by default. See [Metrics](../metrics.md).
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` — Collector export endpoint; required by the logging Compose override.
- `OTEL_COLLECTOR_PORT` — Local Collector Fluent Forward port; default: `24224`.
- `OTEL_COLLECTOR_METRICS_PORT` — Local Collector metrics port; default: `8888`.
- `OCC_DOCKER_LOGGING_ADDRESS` — Docker Compute log destination; local override default: `127.0.0.1:24224`.
