---
created: 2026-08-24
updated: 2026-09-01
last_updated_session: codex/01a05f89-ff1c-7643-a77f-7e1e3aed9e5f
---

# Docker Compose Development Flow

## Overview

`scripts/dev-up` is the supported local OpenClaw Enterprise development entry
point. The helper performs host preflight, selects or verifies runtime images,
wraps Docker Compose, waits for PostgreSQL migration, Installation bootstrap,
API health, and worker readiness, then proves authenticated `/installation`
access with a protected local copy of the bootstrap service key. That startup
proof does not create an Agent, deploy an AgentRevision, or start a TUI.

After startup, the operator uses authenticated API calls to select a Namespace,
create a Configuration and Agent, then deploy it. The worker then claims durable
work, invokes the Docker Compute Driver, and starts real OpenClaw/Codex runtime
containers with the independently supplied provider key. The development TUI
path attaches with `docker exec` inside the Agent-owned embedded gateway
container and uses that container's inherited gateway configuration to reach the
live Agent runtime. This flow stops after the worker has reconciled
Docker-backed runtimes, the TUI client has exited, and cleanup for development
resources is understood.

Use the [deployment guide](../guides/deploy.md) for setup, API provisioning,
TUI attachment, and shutdown, and the [quickstart](../guides/quickstart.md) for
the first authenticated development API checks.

## Entry Points

- Trigger: `./scripts/dev-up [--key-output PATH] [-- COMPOSE_GLOBAL_OPTIONS...]`
  from the repository root, followed by authenticated API calls and optional
  `docker exec -it` TUI attachment.
- Source: `scripts/dev-up`, `compose.yaml`,
  `apps/controller/src/server.mjs:start`,
  `apps/controller/src/worker.ts:ControllerWorker`, and
  `apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`.
- Assumptions: Docker Engine, Docker Compose, Bash, `curl`, and Python 3 are
  available; PostgreSQL can write `occ_postgres_data`; the controller can write
  `occ_configuration_data` at `/app/.development/configurations`; runtime
  images are supplied through `OCC_DOCKER_GATEWAY_IMAGE` and
  `OCC_DOCKER_AGENT_IMAGE`, shared `OCC_DOCKER_RUNTIME_IMAGE`, or the helper's
  default quickstart runtime image; `OPENAI_API_KEY` is present in the
  Compose-starting environment or protected `.env` before the worker starts;
  the API is published only on host loopback; the TUI runs from an interactive
  terminal attached with `docker exec -it`.

## Flow

```mermaid
graph TD
  A["scripts/dev-up"] --> B["Preflight host tools and resolved Compose config"]
  B --> C["Select quickstart runtime image or validate custom images"]
  C --> D["Docker Compose starts PostgreSQL, migrate, bootstrap, API, and worker"]
  D --> E["Copy bootstrap service-key response to private local file"]
  E --> F["scripts/occ-api GET /installation proves authenticated access"]
  F --> G["Operator sends authenticated API provisioning and deploy calls"]
  G --> H["Worker claims durable Namespace and AgentRevision work"]
  H --> I["Docker driver ensures one network per Namespace"]
  H --> J{"Harness topology"}
  J -->|embedded OpenClaw| K["Start one gateway plus embedded Harness container"]
  J -->|dedicated Codex| L["Start gateway plus authenticated Codex container"]
  K --> M["Real provider response proves execution"]
  L --> M
  K --> N["docker exec starts openclaw.mjs tui in the gateway container"]
  N --> O["TUI reads inherited gateway config and isolated client state"]
  O --> P["TUI sends chat.send over localhost gateway WebSocket"]
  P --> Q["Gateway streams native session events and renders the model reply"]
  Q --> R["Ctrl+D exits the TUI client; gateway remains ready"]
  H --> S["Retire revisions and delete owned Namespace resources"]
```

## Execution Trace

### 1. scripts/dev-up: host preflight and runtime image selection

`scripts/dev-up:50`, `deploy/runtime`

The helper runs from the checkout root. It accepts an optional `--key-output`
destination and forwards arguments after `--` to Docker Compose, so native
Compose project names, profiles, and override files keep their normal
precedence. It requires Docker Engine, Docker Compose, `curl`, and Python 3,
then validates the effective Compose configuration without printing expanded
credentials.

If neither a shared runtime image nor separate gateway/Agent images are set,
the helper selects `openclaw-enterprise-runtime:quickstart` for this invocation.
It builds that default image from `deploy/runtime` only when the image is
missing. Custom image references must already exist; an incomplete custom
selection fails before startup is reported successful.

Existing tags are reused even after the runtime recipe changes. Operators
[rebuild and verify the image](../../deploy/runtime/README.md#rebuild-an-existing-image)
explicitly to pick up package changes. The runtime recipe owns packaged channel
plugins and gateway/Codex compatibility checks; `dev-up` does not install
missing plugins or verify a model turn.

### 2. compose.yaml:services.postgres and services.migrate

`compose.yaml:services.postgres`, `compose.yaml:services.migrate`

Compose starts PostgreSQL first and keeps its data in the local
`occ_postgres_data` volume. Compose also declares `occ_configuration_data`, but
mounts it only into the controller for development Configuration documents. The
PostgreSQL service uses local-only administrator credentials to initialize the
database and the checked-in local SQL to create the less-privileged
`occ_migrator` and `occ_app` roles.

The migration service waits for PostgreSQL, connects with
`OCC_MIGRATION_DATABASE_URL`, and applies Drizzle migrations. The API and
worker never use the migrator or PostgreSQL administrator URL. `dev-up` invokes
this through Compose; it does not run migration directly.

### 3. Initialize before starting the API or worker

`compose.yaml:services.bootstrap`, `scripts/bootstrap-installation.mjs`

After migration exits `0`, Compose runs the shared initializer with development
inputs. Fresh bootstrap creates the development human administrator, the
non-Agent service administrator, the singleton Installation, native IAM seed,
audit evidence, and the initial service-key response. It also creates the
initial `default` Namespace in `provisioning` state and queues worker
reconciliation; the worker later provisions its backing Docker boundary.
Existing Installations retain their Namespaces, accounts, keys, IAM policy,
configuration, and revision history. Missing, expired, or revoked keys do not
trigger another bootstrap issue.

Only the initializer mounts `occ_bootstrap_data`; the API and worker load
committed state after initializer success. The
[bootstrap flow](local-password-authentication.md) owns credentials, concurrent
attempts, and failure recovery.

### 4. The API admits only local development traffic

`apps/controller/src/server.mjs:start`,
`apps/controller/src/composition/development-postgres.ts:createDevelopmentConfigurationDriver`,
`apps/controller/src/drivers/configuration/filesystem/index.ts:FilesystemConfigurationDriver`

The API starts in `NODE_ENV=development`, binds inside the Compose network, and
publishes its host port only on `127.0.0.1`. `OCC_AUTH_SECRET` signs user
sessions and `OCC_AUTH_BASE_URL` fixes the cookie origin.

Development accepts the explicitly configured Compose bridge CIDR as local
control-plane traffic, while non-loopback clients, forwarded headers,
caller-supplied identity headers, bearer credentials, and trusted-proxy claims
remain rejected. The API uses the application-role PostgreSQL URL and never
receives the Docker socket.

After the controller health check passes, `dev-up` waits for the worker
readiness probe before copying the initializer-owned service-key JSON from the
stopped bootstrap container. `--key-output` must name an absent destination in a
private operator-owned directory; otherwise the helper creates a private
temporary directory. The helper never overwrites an existing local file, never
prints `data.key`, and never reruns bootstrap to replace a missing key.

`dev-up` then reads `/installation` with `scripts/occ-api` and the copied
service-key response. `apps/controller/src/auth/index.ts:ControllerAdmissionVerifier.verify`
validates the `x-api-key` and maps it to the Installation-scoped service
administrator; current IAM policy still authorizes each resource operation. The
startup proof succeeds only when the response returns HTTP `200` and `data.id`
matches the copied key response's `meta.installationId`. An invalid, expired,
or revoked key fails with `401` without cookie fallback. The
[service-key flow](service-api-keys.md) owns admission details.

When `OCC_CONFIG_PATH` is absent, PostgreSQL-backed development selects the
filesystem Configuration Driver from `OCC_DEVELOPMENT_CONFIGURATION_ROOT`.
Compose sets that root to `/app/.development/configurations` and backs it with
the `occ_configuration_data` named volume. PostgreSQL remains the OCC metadata
system of record; native Configuration documents live in that driver-owned
volume.

### 5. The worker selects Docker compute and claims durable work

`apps/controller/src/worker.mjs:configuration`

The worker starts after the controller is healthy with the same
application-role `OCC_DATABASE_URL`. When `OCC_CONFIG_PATH` is absent in
development, it selects `compute-docker-development` with implementation
`docker-local`. Setting `OCC_CONFIG_PATH` explicitly selects the trusted Driver
set described by that file instead.

The worker loads the singleton Installation, validates persisted IAM policy,
and polls the PostgreSQL work queue. Startup readiness means the worker can
claim durable work; it does not mean an Agent, AgentRevision, or TUI exists.
Every claimed operation reauthorizes the original actor before calling Compute.
The worker is the only Compose service with Docker Engine access. It does not
mount the configuration volume.

### 6. Authenticated API calls enqueue deployment work

`scripts/occ-api`, `packages/occ/src/index.ts:OpenClawController`

After `dev-up` prints the loopback API URL, Installation ID, copied key path,
and example `scripts/occ-api` command, the operator performs later development
work with `OCC_URL` and `OCC_SERVICE_KEY_FILE` set in the shell. Selecting the
bootstrapped Namespace, creating a Configuration and Agent, and deploying the
Agent are ordinary authenticated OCC API calls that commit state, audit
evidence, and durable work before the worker creates runtime infrastructure.

The deployment guide owns the end-to-end command sequence. This trace follows
the runtime path after those API calls have committed.

### 7. Docker creates Namespace networks and Agent runtimes

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`

For Namespace provisioning, the Docker driver creates or verifies one labeled
Docker network for the exact Namespace. The network is not the Compose
management network, and creating it does not start a gateway.

For revision preparation, the driver validates the immutable Harness identity
and mode. Embedded OpenClaw starts one Agent-owned gateway container that also
runs the Harness. Dedicated Codex starts one gateway container plus one
exact-revision Codex container connected by authenticated `APP_SERVER_URL` and
`APP_SERVER_TOKEN` transport.

Runtime images come from `OCC_DOCKER_GATEWAY_IMAGE` and
`OCC_DOCKER_AGENT_IMAGE`, or from `OCC_DOCKER_RUNTIME_IMAGE` when one supplied
image contains both entrypoints. The driver does not build or pull a hidden
runtime image.

### 8. Credential placement follows the Harness topology

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`

`OPENAI_API_KEY` is inherited from the developer environment only for the
container that performs the model call. Embedded OpenClaw receives it in the
combined gateway/Harness container. Dedicated Codex receives it only in the
Codex app-server container; the separate gateway never receives it.

The key is not stored in the Installation snapshot, native configuration,
audit events, Docker labels, API responses, command-line arguments, or sibling
Agent containers. Workload containers do not receive the Docker socket,
controller credentials, host homes, SSH-agent sockets, or another Namespace's
network.

### 9. The TUI client starts inside the embedded gateway container

`apps/controller/src/drivers/compute/docker/index.ts:GATEWAY_RUNTIME_ENTRYPOINT`,
`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`,
`tests/integration/docker-compute-real.test.mjs:tuiDockerCommand`

The [deployment guide](../guides/deploy.md#development-end-to-end-tui) owns the
service-key-authenticated provisioning commands, Docker label selection, and
cleanup of the temporary local key copy. Cleanup does not revoke the key or
remove its shared initialization output. After that guide has selected the
active embedded gateway container, `docker exec -it` starts
`node /app/openclaw.mjs tui` in that same container.

The Docker driver has already written the gateway configuration to
`OPENCLAW_CONFIG_PATH`, started `/app/openclaw.mjs gateway` on
`OPENCLAW_GATEWAY_PORT`, and injected `OPENCLAW_GATEWAY_TOKEN` into the gateway
container. The TUI process inherits those values. The OCC service key stays
with the operator and never enters the workload or TUI. The guide overrides only
`OPENCLAW_STATE_DIR` so the client uses temporary container-local state instead
of the gateway's persisted `/home/node/.openclaw` state.

### 10. The TUI turn travels through the local gateway session

`tests/integration/docker-compute-real.test.mjs:assertInteractiveTuiConversation`,
`tests/helpers/harness-topology-k3d-real.mjs:gatewayCall`,
`tests/helpers/harness-topology-k3d-real.mjs:transcript_events`

From inside the gateway container, the TUI authenticates to the gateway over the
container-local gateway endpoint. The TUI sends the first prompt as a native
session message; the gateway handles it through the same `chat.send` path used
by the runtime proof hooks, streams session events, persists transcript rows,
and renders the model-backed assistant reply in the terminal.

The same TUI process accepts the follow-up prompt in the same session. Ctrl+D
closes the client process after the second rendered reply. It does not stop the
gateway process, delete the Agent runtime, or retire the AgentRevision; the
Docker integration asserts the gateway remains ready after client exit.

### 11. Cleanup removes only owned development resources

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`

Revision retirement removes only the exact revision's owned runtime and
preserves another active Agent or replacement runtime. Namespace deletion
removes only containers and the network labeled for that exact Namespace.
Foreign resources with colliding names but different ownership labels are not
adopted or deleted.

If provisioning fails after creating partial resources, the driver compensates
resources created for that failed attempt. Interrupted work remains durable in
PostgreSQL and can be retried by the worker.

## Debugging and Verification

- `./scripts/dev-up` should show PostgreSQL readiness, migration completion,
  API listening on `127.0.0.1:${OPENCLAW_DEV_PORT:-3000}`,
  fresh-database initialization, `worker.started` with `computeDriverId` set to
  `compute-docker-development`, a private copied service-key path, and a
  successful authenticated `/installation` proof.
- `docker network ls --filter label=org.openclaw.enterprise.compute-driver=docker`
  should show one owned network for each ready development Namespace.
- `docker ps --filter label=org.openclaw.enterprise.compute-driver=docker`
  should show one embedded gateway container or a dedicated gateway plus Codex
  container for deployed revisions.
- The deployment guide owns authenticated API provisioning, gateway discovery,
  and local service-key copy cleanup before TUI attach; this flow records the
  selected container's runtime path after that operator procedure completes.
- `tests/integration/docker-compute-real.test.mjs:assertInteractiveTuiConversation`
  should reject an invalid gateway token, produce two model-backed replies in
  one TUI session, exit the client with Ctrl+D, and leave the gateway ready.
- The Docker Compose integration test must read the singleton Installation and
  perform API deployment with the bootstrap service administrator key through the worker and receive a real provider response containing
  a fresh nonce for both embedded and dedicated topologies. It may invoke the
  gateway through the Namespace network or through the Docker-published
  `127.0.0.1` gateway port.
- After Namespace deletion, the matching labeled containers and network should
  be absent while unrelated Namespaces remain.

## Related docs

- [Deployment guide: development and production](../guides/deploy.md)
- [Deployment guide: development end-to-end TUI](../guides/deploy.md#development-end-to-end-tui)
- [Quickstart](../guides/quickstart.md)
- [Controller worker execution flow](controller-worker.md)
- [Docker Compute Driver](../reference/drivers/docker-compute.md)
- [Controller worker](../reference/controller.md)
- [Configuration reference](../reference/settings.md)
- [ComputeDriver contract](../reference/drivers/compute.md)
- [Harness execution topology flow](harness-execution-topology.md)
- [Platform startup flow](platform-startup.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 22:09: Document explicit runtime image rebuilding and link packaged-plugin and Codex compatibility checks. (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f - 5fa47a6)

- 2026-09-01 19:09: Merge the development startup trace into the canonical Docker Compose flow and clarify the `dev-up` readiness proof versus later API deployment and TUI attachment. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-31 20:33: Trace the shared installation initializer, startup ordering, and initializer-owned credential delivery. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213cbcee11ba3dd69886c936c7e5abe233eb3)

- 2026-08-31 19:14: Document bootstrap service-key API access and operator credential cleanup for the TUI path. (codex/01a05a3d-526f-7553-8cd8-070bd1847acb - 06c4bccb95543d3d545d011e72074f805f339aa8)

- 2026-08-31 17:45: Align bootstrap identity and protected service-key storage with the current startup path. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)
- 2026-08-31 15:40: Added the compact development TUI runtime trace and two-turn verification boundary. (01a059f9-e5cc-7b01-9479-0c5087f5e58f - 3a04cee)
- 2026-08-28 17:54: Clarified the Docker workload execution boundary and linked operator setup, quickstart, and worker traces. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-25 10:13: Removed the deleted bootstrap sidecar/script from the Compose flow and documented controller-owned fresh-database self-bootstrap. (01a03630-cd9f-7352-9e64-1d30de98c7dd - c56867448b187304723d20043dd5a0e184736ef2)
- 2026-08-25 08:46: Clarified that Docker E2E verification may invoke gateways through Namespace networking or published loopback ports. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 949e57ba008486c7ad60978df79dc53cce31bee9)
- 2026-08-24 22:43: Added API-only filesystem Configuration Driver volume boundaries and removed stale Docker subnet knobs. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 63890cf94cfc15f848f62f8f957eb766d2101f55)
- 2026-08-24 21:40: Documented Docker Compose development startup and Docker Compute Driver runtime flow. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 63890cf94cfc15f848f62f8f957eb766d2101f55)
