# Docker Compute Driver

`DockerComputeDriver` is the default local development Compute Driver. The
Docker Compose development stack runs PostgreSQL, migrations, and the shared
initializer before starting the OCC API and worker. The API uses filesystem
Configuration; the worker uses this driver to create real
Docker networks and runtime containers for Namespaces and AgentRevisions.

This driver is a development runtime. Production can select bundled
[Kubernetes](kubernetes-compute.md), [SSH](ssh-compute.md), or an installed
Compute Driver through trusted Installation configuration.

## Requirements

- Docker Engine and `docker compose`.
- The full Compose development stack, not a process-local controller.
- Existing production-equivalent runtime images:
  `OCC_DOCKER_GATEWAY_IMAGE` and `OCC_DOCKER_AGENT_IMAGE`, or one shared
  `OCC_DOCKER_RUNTIME_IMAGE` containing both runtime entrypoints.
- An existing shell `OPENAI_API_KEY` for real embedded and dedicated model
  turns. The stack must not print, persist, or pass it to the wrong container.
- Explicit `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` when the Compose bridge range
  must be admitted as local development traffic.
- The controller-only `OCC_DEVELOPMENT_CONFIGURATION_ROOT`, which Compose sets
  to `/app/.development/configurations` from the `occ_configuration_data` named
  volume.

## Development configuration and persistence

The [deployment guide](../../guides/deploy.md) owns the Compose startup
procedure. [Settings](../settings.md) owns the environment-variable reference;
[the development flow](../../flows/docker-compose-development.md) traces API,
worker, and container startup.

Compose publishes the OCC API on host
`127.0.0.1:${OPENCLAW_DEV_PORT:-3000}`. PostgreSQL remains on a loopback host
port. The API and worker share the same application-role database connection
and select `compute-docker-development` with implementation `docker-local`
unless `OCC_CONFIG_PATH` explicitly selects another trusted Driver set.

Compose runs the shared initializer after migration and before the API or
worker. Fresh setup creates the configured human administrator, service
administrator, and singleton Installation; existing state is retained. Only
the initializer mounts the protected initial-key output volume. The
[authentication reference](../authentication.md#installation-and-account-ownership)
owns credential creation and recovery; the
[Docker development flow](../../flows/docker-compose-development.md) traces ordering.

`docker compose down` keeps `occ_postgres_data`, `occ_configuration_data`, and
the bootstrap-only `occ_bootstrap_data` volume. `docker compose down --volumes`
deletes all three, including the initial service-key JSON.

## Namespace lifecycle

`ensureNamespace(namespace)` creates or verifies one Docker network for the
exact Namespace. The network is labeled with the driver, Installation,
Namespace, and ownership metadata. The method does not start a gateway or Agent
workload.

`deleteNamespace(namespace)` removes only driver-owned containers and the
driver-owned network for that exact Namespace. It refuses to adopt or delete a
foreign network with the same name but different ownership labels.

Each Namespace maps to one Docker network. Runtime containers for one
Namespace join only that network; they do not join the control-plane management
network or another Namespace network.

## AgentRevision lifecycle

`prepareRevision(revision)` validates the immutable Namespace, Agent, revision,
Harness identity, execution mode, and selected Compute implementation before it
starts containers.

- `openclaw` with `embedded` starts one Agent-owned OpenClaw gateway container.
  That container also runs the embedded Harness and receives only that Agent's
  model credential.
- `codex` with `dedicated` starts one Agent-owned OpenClaw gateway container
  and one exact-revision Codex app-server container. The gateway connects to
  Codex through authenticated `APP_SERVER_URL` and `APP_SERVER_TOKEN`
  transport. Only the Codex container receives the model credential.

The driver uses the same runtime entrypoint contract as production. It does
not build, download, or publish runtime images. Missing image references,
unsupported Harness combinations, unavailable Docker Engine access, failed
transport authentication, or unready containers fail closed.

Docker image references must already resolve in the selected Engine. The
development Driver accepts tags as well as digests; production Kubernetes
digest requirements do not imply that Docker enforces immutable images.

`retireRevision(revision)` removes only the exact revision's owned runtime. It
preserves another Agent's containers and preserves a gateway still required by
a replacement revision for the same Agent.

## Credential and Docker Engine boundaries

Only the worker container receives Docker Engine access. The OCC API,
PostgreSQL, the migration job, gateway containers, and Codex containers do
not receive the Docker socket. Only the controller receives the
`occ_configuration_data` volume at `/app/.development/configurations`; the
worker and workload containers do not mount it.

`OPENAI_API_KEY` enters only the container that performs the model call: the
combined embedded OpenClaw container or the dedicated Codex container. A
dedicated gateway never receives it. The key must not appear in command
arguments, API responses, audit events, logs, Compose output, Docker labels, or
persisted controller configuration.

Runtime containers receive isolated writable state and temporary directories
inside the container. The Docker driver does not mount host workspaces,
personal OpenClaw/Codex homes, SSH-agent sockets, cloud credentials, or
controller credentials into workload containers.

## Verification evidence

Use the Compose integration when changing this driver or development startup.
It must exercise the authenticated API, durable PostgreSQL state, worker queue,
Docker network/container provisioning, both Harness topologies, cleanup, and a
real provider response containing a fresh nonce. The E2E call may reach the
gateway through its Namespace network address or the driver-published loopback
host port.

Owned resources can be observed through Docker labels:

```bash
docker compose ps
docker network ls --filter label=org.openclaw.enterprise.compute-driver=docker
docker ps --filter label=org.openclaw.enterprise.compute-driver=docker
```

After deleting a Namespace, the matching network and containers should be gone
while other Namespaces remain.

## Troubleshooting

- **Worker starts with the wrong Compute Driver:** unset `OCC_CONFIG_PATH` for
  default Compose development, or inspect the trusted startup YAML if selecting
  another Driver intentionally.
- **Docker access denied:** verify the worker service has Docker Engine access.
  Do not mount the Docker socket into the API or workload services.
- **Image not found:** provide locally available images through
  `OCC_DOCKER_GATEWAY_IMAGE` and `OCC_DOCKER_AGENT_IMAGE`, or
  `OCC_DOCKER_RUNTIME_IMAGE` when one image contains both entrypoints.
- **API rejects Compose traffic:** set `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR`
  to the exact Compose bridge range. Do not enable forwarded-header trust.
- **Model turn fails:** confirm `OPENAI_API_KEY` exists in the shell that starts
  Compose, the selected model is authorized, and the key reaches only the
  embedded OpenClaw or dedicated Codex container.
- **Namespace cleanup leaves resources:** inspect ownership labels before
  deleting anything manually. The driver removes only exact owned resources.

## Related

- [Development and production deployment](../../guides/deploy.md)

- [Docker Compose development flow](../../flows/docker-compose-development.md)
- [Controller worker](../controller.md)
- [Configuration reference](../settings.md)
- [ComputeDriver contract](compute.md)
- [Harness execution topology flow](../../flows/harness-execution-topology.md)
- [Kubernetes Compute Driver](kubernetes-compute.md)
