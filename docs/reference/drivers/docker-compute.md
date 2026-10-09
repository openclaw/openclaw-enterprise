# Docker Compute Driver

`DockerComputeDriver` is the default Compute Driver for local control-plane
development. Compose runs PostgreSQL, migrations, the initializer, the OCC API,
and the worker on Docker Engine or Podman. The API uses filesystem
Configuration, and the Driver creates isolated Namespace networks.

**This Driver cannot deploy a new Agent under the current authentication
contract.** It rejects every `harnessAuth` binding at deployment. Its code
contains embedded OpenClaw and dedicated Codex container topologies, but those
components do not provide a currently usable Agent or model-response workflow.

Use [Kubernetes](kubernetes-compute.md) to deploy Agents locally with OCC-managed
credentials, or [SSH](ssh-compute.md) for embedded OpenClaw with operator-managed
host credentials. Docker Compute cannot be selected for production.

## Requirements

- Docker Engine with Docker Compose, or Podman with `podman-compose` and `yq` v4.
- The full Compose development stack, not a process-local controller.
- Existing production-equivalent runtime images:
  `OCC_DOCKER_GATEWAY_IMAGE` and `OCC_DOCKER_AGENT_IMAGE`, or one shared
  `OCC_DOCKER_RUNTIME_IMAGE` containing both runtime entrypoints.
- Explicit `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` when the Compose bridge range
  must be admitted as local development traffic.
- The controller-only `OCC_DEVELOPMENT_CONFIGURATION_ROOT`, which Compose sets
  to `/app/.development/configurations` from the `occ_configuration_data` named
  volume.

`scripts/dev-up` is the supported Podman entry point. It auto-detects Podman
without a `docker` alias, pins the standalone `podman-compose` provider, mounts
the reported API socket through `compose.podman.yaml`, and preserves the
driver's existing `/var/run/docker.sock` contract inside the worker. The
Docker Compute worker disables SELinux process labeling because relabeling the
host engine socket could disrupt the engine; the API, database, initializer,
and migration services remain confined. The prior verified
baseline is Podman client 6.1.0, server 5.7.1, and podman-compose 1.6.0. Prior
Podman runtime proof covered control-plane startup, worker API preflight,
authenticated Installation access, isolated Namespace networks, embedded and
dedicated model responses, recovery after worker interruption, and exact test
cleanup. That proof predates required harness bindings; current Agent admission
prevents reaching those model and recovery scenarios. Interactive TUI execution
remains unverified on Podman. `compose.logging.yaml` remains Docker-only because this Podman baseline
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

Engine requests have a 10-second deadline and observe the current Compute
cancellation signal. If the connection closes before the response body is
complete, the operation fails rather than staying pending. The Driver does
not automatically retry an interrupted request; an already-sent engine
operation may still have taken effect.

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
foreign network with the same name but different ownership labels. If the network
was removed externally, deletion still removes remaining owned containers and
workspace volumes before reporting success.

Each Namespace maps to one Docker network. Runtime containers for one
Namespace join only that network; they do not join the control-plane management
network or another Namespace network.

## AgentRevision lifecycle

`prepareRevision(revision)` validates the immutable Namespace, Agent, revision,
Harness identity, execution mode, and selected Compute implementation before it
starts containers. The code implements the topologies below, but it rejects
the model-authentication bindings required for a newly deployed Agent:

- `openclaw` with `embedded` starts one Agent-owned OpenClaw gateway container.
  That container also runs the embedded Harness and receives only that Agent's
  model credential.
- `codex` with `dedicated` starts one Agent-owned OpenClaw gateway container
  and one exact-revision Codex app-server container. The gateway connects to
  Codex through authenticated `APP_SERVER_URL` and `APP_SERVER_TOKEN`
  transport. Only the Codex container receives the model credential.

When recovery reuses a healthy Codex container, the driver reads its existing
transport token after verifying exact ownership and supplies that token to the
gateway. A surviving Codex container without a token fails closed. If Codex is
recreated, the driver replaces a gateway whose token no longer matches; a healthy
matching pair is reused.

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

`stopRevision(revision)` removes the exact dedicated Agent container and a
gateway only when it still serves that revision. Embedded execution removes the
combined gateway container. Repeating stop is safe; Docker stop does not retire
the persisted AgentRevision or remove credentials outside the containers. The
Driver retains the Agent-owned state and workspace volumes used for initial
workspace setup across stop and revision replacement. Without initial workspace
inputs, writable container tmpfs remains ephemeral.

## Gateway authentication

The container implementation renders `gateway.auth.mode: password` when native
Configuration omits the mode. Explicit `password` and `trusted-proxy` are supported.
Only supported authentication fields and modes are admitted. These rules do not
remove the harness-authentication admission limit above.

With password mode, omitting `gateway.auth.password` selects the managed
`OPENCLAW_GATEWAY_PASSWORD` reference. An explicit reference to that variable also
selects a managed password, including optional loopback access with trusted proxy.
For either mode, a new container receives a new managed password; a reused healthy
container keeps its value. Other explicit password settings are preserved and
receive no Driver-generated password. Configuration API secret-reference rules
still apply. Trusted proxy without a password reference receives no managed
password. The dedicated Codex `APP_SERVER_TOKEN` remains a separate transport
credential with its existing recovery checks.

## Initial workspace storage

When an Agent has [initial workspace contents](../agents.md#initial-contents-at-creation),
the Driver creates two named volumes owned by its exact Namespace and Agent:
one for native state at `/home/node/.openclaw` and one for workspace files. The
same workspace volume is mounted at both `/home/node/.openclaw/workspace` and
`/home/node/workspace`, so the native default and dedicated Harness directory
refer to the same files. Initial setup accepts either path; other workspace
locations and disabled native bootstrap are rejected.

A separate setup container runs native initialization and writes the supplied
files and completion marker before execution starts. Later startup checks the
marker without replaying the original text. Missing initialized storage blocks
startup. Stop, container replacement, and redeployment retain both volumes;
Agent or Namespace deletion removes them after the owned runtimes are removed.
These Driver-created volumes are separate from Compose's control-plane volumes
and are not removed by `compose down --volumes`.

Agents without initial inputs retain the existing tmpfs storage behavior.
[Workspace setup](../../flows/workspace-files.md) owns the initialization and
retry contract. The Agent admission limitation above still applies to these
Driver capabilities.

## Credential and container-engine boundaries

Only the worker container receives Docker-compatible engine access. The OCC API,
PostgreSQL, the migration job, gateway containers, and Codex containers do
not receive the Docker socket. Only the controller receives the
`occ_configuration_data` volume at `/app/.development/configurations`; the
worker and workload containers do not mount it.

The underlying container code passes `OPENAI_API_KEY` only to the component
that performs the model call: the combined embedded OpenClaw container or the
dedicated Codex container. Current Agent admission cannot reach this path. A
dedicated gateway never receives the key. It must not appear in command
arguments, API responses, audit events, logs, Compose output, Docker labels, or
persisted controller configuration.

Runtime containers receive isolated writable state and temporary directories;
Agents with initial inputs use the owned volumes described above for durable
state and workspace contents. The Docker driver does not mount host workspaces,
personal OpenClaw/Codex homes, SSH-agent sockets, cloud credentials, or
controller credentials into workload containers.

The driver detects Podman's Docker-compatible API during preflight. Docker
keeps UID/GID-owned `0700` tmpfs mount options. Podman receives the same bounded
`1Gi` home and `64Mi` temporary filesystems using its supported mount options;
the non-root runtime creates its `.openclaw` and workspace directories as
`0700` before writing configuration or state. For Agents with initial inputs,
the setup container prepares ownership and permissions on the named volumes.

## Inspect owned resources

Owned resources can be observed through the selected engine using the same
driver labels:

```bash
docker network ls --filter label=org.openclaw.enterprise.compute-driver=docker
docker ps --filter label=org.openclaw.enterprise.compute-driver=docker
docker volume ls --filter label=org.openclaw.enterprise.compute-driver=docker
```

Replace `docker` with `podman` for a Podman-backed development stack.

After deleting a Namespace, its matching network, containers, and Agent workspace
volumes should be gone while other Namespaces remain. Agent deletion removes only
that Agent's runtimes and volumes.

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
- **Agent deployment rejects model authentication:** Docker Compute does not
  accept any current Agent authentication binding. Use
  [local Kubernetes setup](../../guides/quickstart.md) to deploy an Agent and
  verify a model response.
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
