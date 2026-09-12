# Docker Compute Driver

`DockerComputeDriver` is the default local development Compute Driver. Compose
development runs PostgreSQL, migrations, and the shared initializer on Docker
Engine or Podman before starting the OCC API and worker. The API uses filesystem
Configuration. Docker verifies both runtime topologies; Podman verifies
Namespace networks and the embedded OpenClaw runtime topology.

This driver is a development runtime. Production can select bundled
[Kubernetes](kubernetes-compute.md), [SSH](ssh-compute.md), or an installed
Compute Driver through trusted Installation configuration.

## Requirements

- Docker Engine with Docker Compose, or Podman with `podman-compose` and `yq` v4.
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

`scripts/dev-up` is the supported Podman entry point. It auto-detects Podman
without a `docker` alias, pins the standalone `podman-compose` provider, mounts
the reported API socket through `compose.podman.yaml`, and preserves the
driver's existing `/var/run/docker.sock` contract inside the worker. The current
baseline is Podman client 6.1.0, server 5.7.1, and podman-compose 1.6.0. Verified
Podman coverage includes control-plane startup, worker API preflight,
authenticated Installation access, isolated Namespace networks, one embedded
gateway/Harness container, a provider-backed nonce response, and exact test
cleanup. Dedicated Codex and interactive TUI execution remain unverified on
Podman. `compose.logging.yaml` remains Docker-only because this Podman baseline
does not provide the required Fluentd log driver.

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
[Compose development flow](../../flows/docker-compose-development.md) traces ordering.

The cleanup command printed by `dev-up` keeps `occ_postgres_data`,
`occ_configuration_data`, and the bootstrap-only `occ_bootstrap_data` volume.
Adding `--volumes` deletes all three, including the initial service-key JSON.

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
unsupported Harness combinations, unavailable container-engine access, failed
transport authentication, or unready containers fail closed.

Container image references must already resolve in the selected engine. The
development Driver accepts tags as well as digests; production Kubernetes
digest requirements do not imply that the local engine enforces immutable
images.

`retireRevision(revision)` removes only the exact revision's owned runtime. It
preserves another Agent's containers and preserves a gateway still required by
a replacement revision for the same Agent.

## Credential and container-engine boundaries

Only the worker container receives Docker-compatible engine access. The OCC API,
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

The driver detects Podman's Docker-compatible API during preflight. Docker
keeps UID/GID-owned `0700` tmpfs mount options. Podman receives the same bounded
`1Gi` home and `64Mi` temporary filesystems using its supported mount options;
the non-root runtime creates its `.openclaw` and workspace directories as
`0700` before writing configuration or state.

## Inspect owned resources

Owned resources can be observed through the selected engine using the same
driver labels:

```bash
docker network ls --filter label=org.openclaw.enterprise.compute-driver=docker
docker ps --filter label=org.openclaw.enterprise.compute-driver=docker
```

Replace `docker` with `podman` for a Podman-backed development stack.

After deleting a Namespace, the matching network and containers should be gone
while other Namespaces remain.

## Troubleshooting

- **Worker starts with the wrong Compute Driver:** unset `OCC_CONFIG_PATH` for
  default Compose development, or inspect the trusted startup YAML if selecting
  another Driver intentionally.
- **Container-engine access denied:** verify the worker service has access to
  the selected Docker-compatible API socket. With Podman, use `dev-up` so it
  supplies the reported socket and the narrow SELinux override. Do not mount
  the socket into the API or workload services.
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

- [Docker or Podman Compose development flow](../../flows/docker-compose-development.md)
- [Controller worker](../controller.md)
- [Configuration reference](../settings.md)
- [ComputeDriver contract](compute.md)
- [Harness execution topology flow](../../flows/harness-execution-topology.md)
- [Kubernetes Compute Driver](kubernetes-compute.md)
