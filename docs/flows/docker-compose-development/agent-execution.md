# Docker-compatible Agent execution and cleanup

Continue from the initialized Compose stack through Agent provisioning, a native TUI turn, and cleanup. See the [parent flow](../docker-compose-development.md) for its context and overall sequence.

## Execution trace

### 6. Authenticated API calls enqueue deployment work

`cmd/occ/main.go`, `internal/occcli/cli.go`, `internal/occclient/client.go`,
`packages/occ/src/index.ts:OpenClawController`

After `dev-up` prints the loopback API URL, Installation ID, copied key path,
and example `occ installation get` command, the operator performs later development
work with `OCC_URL` and `OCC_SERVICE_KEY_FILE` set in the shell. Selecting the
bootstrapped Namespace, creating a Configuration and Agent, and deploying the
Agent are authenticated domain operations whose internal OCC calls commit state, audit
evidence, and durable work before the worker creates runtime infrastructure.

The deployment guide owns the end-to-end command sequence. This trace follows
the runtime path after those API calls have committed.

### 7. The selected engine creates Namespace networks and Agent runtimes

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`

For Namespace provisioning, the Docker driver creates or verifies one labeled
network through the selected Docker-compatible API. The network is not the Compose
management network, and creating it does not start a gateway.

For revision preparation, the driver validates the immutable Harness identity
and mode. Embedded OpenClaw starts one Agent-owned gateway container that also
runs the Harness. Dedicated Codex starts one gateway container plus one
exact-revision Codex container connected by authenticated `APP_SERVER_URL` and
`APP_SERVER_TOKEN` transport.

When a worker restarts during preparation, `reconcileAgent` verifies the
surviving container's ownership and returns its existing transport token.
`reconcileGateway` uses that token and replaces a gateway with mismatched
transport credentials. Missing tokens on reused Codex containers fail closed.

Docker and Podman verify both topologies and interrupted dedicated preparation.
Docker also verifies the interactive TUI sequence below.

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

The [deployment guide](../../guides/deploy/local-operations.md#development-end-to-end-tui) owns the
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

## Related

- [Return to the parent flow](../docker-compose-development.md).
