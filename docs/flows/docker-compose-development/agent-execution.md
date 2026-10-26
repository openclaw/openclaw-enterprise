# Docker-compatible Namespace execution and Agent admission

Continue from the initialized Compose stack through Namespace provisioning and
the current Agent deployment boundary. See the [parent flow](../docker-compose-development.md).

## Execution trace

### 6. Authenticated API calls create Namespace resources

`internal/occclient/client.go`,
`packages/occ/src/index.ts:OpenClawController`

After `dev-up` prints the loopback API URL and private bootstrap key path, the
operator uses `OCC_URL` and `OCC_SERVICE_KEY_FILE` for authenticated OCC calls.
Namespace creation commits state, audit evidence, and durable provisioning work.
Configuration and Agent drafts can be saved subject to normal admission rules;
saving an Agent does not create its runtime.

### 7. The selected engine prepares the Namespace network

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.ensureNamespace`

The worker claims Namespace work and the Docker Driver creates or verifies one
owned, labeled network through the selected engine's Docker-compatible API. The
network is separate from the Compose management network. Readiness does not
start a gateway or prove model access.

### 8. Agent deployment stops at harness authentication admission

`packages/occ/src/index.ts:OpenClawController.deployAgent`,
`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.validateHarnessAuth`

Deployment requires Agent `harnessAuth`. The Docker Driver rejects bindings,
so deployment cannot queue a new Agent revision or reach workload preparation.
Exporting a model key to the worker cannot bypass this admission boundary.
The retained container preparation and TUI test helpers do not establish a
supported authenticated Agent journey. Use the
[Kubernetes Agent procedure](../../guides/deploy/production-agents.md) for model
execution and TUI verification.

The retained preparation code still handles interrupted dedicated startup:
`reconcileAgent` verifies the surviving Codex container's ownership and recovers
its existing transport token; `reconcileGateway` replaces a gateway whose
transport token does not match. Missing tokens on reused Codex containers fail
closed. These safeguards do not make the current binding-based Agent path
supported on Docker or Podman.

### 9. Cleanup removes only owned development resources

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.deleteNamespace`

Namespace deletion removes only resources labeled for that exact Namespace;
foreign resources with colliding names are not adopted or removed. Use the
`dev-up` cleanup command to stop the Compose stack. Add volume removal only when
intentionally deleting its persisted development Installation.

## Related

- [Return to the parent flow](../docker-compose-development.md).
- [Current Docker test boundary](../../testing/docker.md).
