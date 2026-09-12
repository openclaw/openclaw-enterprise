# Feature Spec: Docker Compose development and Docker Compute Driver

**Date:** 2026-08-24
**Status:** Completed
**Owner:** OCC development runtime and Compute Driver

## Problem and Decision

The Docker Compose development path replaces the retired deterministic fake,
which reported Namespace and AgentRevision readiness without starting
workloads. The API, durable worker, and PostgreSQL also require separate manual
startup. Replace this path with one Docker Compose development stack and a real
`DockerComputeDriver`. Compose starts PostgreSQL, migrations, the OCC API, and its worker; the
controller self-bootstraps fresh databases through the existing authenticated
Installation bootstrap route before the worker starts; the driver creates one Docker network
per Namespace and starts the existing production OpenClaw/Codex images as
Agent-owned containers.

The driver implements the existing
[ComputeDriver contract](../../docs/reference/drivers/compute.md), preserves both
approved [Harness topologies](../../docs/flows/harness-execution-topology.md), and
becomes the development default. A real authenticated model response proves the
complete Compose-backed lifecycle. Production Kubernetes behavior is unchanged.

## Scope

**Changes**

- Make `docker compose up --build` the complete local-development startup.
- Replace in-memory development and the deterministic development Compute
  Driver with PostgreSQL-backed OCC and `DockerComputeDriver`.
- Provision exactly one owned Docker network per Namespace and exactly one
  gateway per deployed Agent; dedicated Codex additionally receives its own
  remote Harness container.
- Reuse the same approved gateway and Codex image references as production.
- Verify both topologies through real Compose, Docker, and provider model calls.

**Does not change**

- Production Helm, `KubernetesComputeDriver`, the existing `ComputeDriver`
  interface, OCC authentication/IAM, immutable revisions, or Agent ownership.
- Published runtime images; developers supply existing production-equivalent
  OpenClaw and Codex images.
- Restart adoption, persistent workload volumes, a cleanup daemon, new platform
  resources, Kubernetes workload identity, or production-grade Docker isolation.

## Contract

### One Compose-owned development stack

Compose owns one PostgreSQL service with the existing persistent local volume,
migrates it with its migrator credentials, starts the session-authenticated OCC
API, and starts the worker after the controller is healthy. On a fresh database,
the controller provisions the configured development administrator account,
signs in using `OPENCLAW_DEV_EMAIL` and `OPENCLAW_DEV_PASSWORD`, sends its
user session cookie to the existing `POST /installation/bootstrap`
route, and creates the first Installation with
`OPENCLAW_DEV_INSTALLATION_NAME`. Existing databases are not re-bootstrapped,
and development does not generate, print, or write a password.
API and worker share the same application-role database connection and select
the same Docker Compute Driver identity. The API selects a minimal filesystem
Configuration Driver backed by its own Compose-managed persistent volume;
PostgreSQL remains the owner of Configuration identity and lifecycle metadata.
The worker needs no Configuration volume because immutable AgentRevisions
already contain their admitted configuration. Their image includes the
development composition and Docker driver without changing the production image
boundary.

Development requires PostgreSQL; missing configuration or an unavailable Docker
daemon/image fails explicitly. There is no in-memory server mode or fallback fake.
Without `OCC_CONFIG_PATH`, the API and worker both select `DockerComputeDriver`;
an explicitly configured Installation still selects its existing configured
Drivers. Reuse the
existing [Compose PostgreSQL definition](../../compose.postgres.yaml), role
separation, and migration tooling rather than introducing a second database.

The API listens on its container interface and publishes its port exclusively
on host `127.0.0.1`. Compose explicitly configures its management bridge CIDR;
development admission accepts only direct socket addresses in that CIDR or
loopback while retaining loopback host/origin validation, user
session authentication, exact-resource authorization, and rejection of
forwarded headers. Runtime containers join only their Namespace network, not
the control-plane management network. Only the worker receives Docker Engine
access; workload containers never receive the Docker socket.

### Docker-backed Namespace and Agent lifecycle

`ensureNamespace(namespace)` creates or verifies exactly one driver-owned Docker
network for that Namespace. It does not create a gateway or workload. Ownership
labels and stable exact-resource names prevent adopting foreign resources.

`prepareRevision(revision)` validates the exact Namespace, Agent, immutable
revision, and approved Harness topology, then realizes its Agent-owned runtime
on that Namespace network:

- `openclaw` + `embedded`: one Agent-owned OpenClaw gateway container also runs
  its embedded Harness and receives only that Agent's model credential.
- `codex` + `dedicated`: one Agent-owned OpenClaw gateway container connects to
  one separate exact-revision Codex Harness container through authenticated
  `APP_SERVER_URL`/`APP_SERVER_TOKEN` transport. Only the Harness receives the
  model credential; its gateway never receives it.

The operator supplies the same approved production gateway/Codex image
references through `OCC_DOCKER_GATEWAY_IMAGE` and `OCC_DOCKER_AGENT_IMAGE`, or
uses `OCC_DOCKER_RUNTIME_IMAGE` as their shared fallback. Missing image
references fail; Helm placeholder values are never treated as defaults. Reuse
native
[runtime entrypoints](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
instead of inventing development runtime images. Provider credentials come from
an already authorized developer environment and must not enter configuration
snapshots, command arguments, logs, audit events, API responses, sibling Agents,
or a dedicated gateway. Unavailable images, credentials, unsupported topology,
wrong-owner resources, transport failures, and unready containers fail closed.

`retireRevision(revision)` removes only the exact revision's owned runtime while
preserving another Agent and an Agent gateway required by its replacement.
`deleteNamespace(namespace)` removes only that Namespace's owned containers and
network. Failed or interrupted provisioning cleans up resources created for the
failed attempt. Reuse existing Compute lifecycle hooks when selected; no restart
adoption contract is added.

## Implementation

1. Add `DockerComputeDriver` under
   [`apps/controller/src/drivers/compute/`](../../apps/controller/src/drivers/compute).
   Implement the four existing lifecycle methods against Docker Engine, exact
   owner labels, per-Namespace networks, both Agent-owned topologies, readiness,
   authenticated dedicated transport, scoped model credentials, and cleanup.
2. Replace fake selection in
   [`development-postgres.ts`](../../apps/controller/src/composition/development-postgres.ts)
   and [`worker.mjs`](../../apps/controller/src/worker.mjs); remove in-memory
   selection from [`server.mjs`](../../apps/controller/src/server.mjs). Select the
   smallest persistent filesystem Configuration Driver for the API when no
   Driver configuration is provided. Keep explicitly selected Drivers and
   existing auth/IAM ownership intact.
3. Evolve the existing Compose/PostgreSQL setup into one canonical four-service
   development stack with ordered migrations, controller-owned Installation
   self-bootstrap for fresh databases, worker-only Docker socket access,
   explicit production-equivalent runtime image references,
   and host-loopback-only API publication. Add the smallest development image
   target and tighten Compose-aware transport checks in
   [`server.mjs`](../../apps/controller/src/server.mjs) and
   [`index.ts`](../../apps/controller/src/index.ts).
4. Update [`README.md`](../../README.md), [`docs/config.md`](../../docs/reference/settings.md),
   [`docs/controller.md`](../../docs/reference/controller.md), and
   [`docs/contracts/computedriver.md`](../../docs/reference/drivers/compute.md);
   add a focused Docker Compute Driver guide under
   [`docs/reference/drivers/`](../../docs/reference/drivers).
5. Add one real Compose-backed integration journey under
   [`tests/integration/`](../../tests/integration), reusing existing session,
   deployment, Harness, and provider-response helpers instead of parallel
   fixtures or mocked Docker execution.

## Verification

| Required outcome                         | How to verify                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One command starts usable development    | `docker compose up --build` starts PostgreSQL, migrates, exposes an authenticated loopback-only API, self-bootstraps fresh databases through the controller, and starts its worker without manual host processes.                   |
| Docker replaces fake/in-memory execution | API and worker report the same Docker Driver; development without PostgreSQL or Docker fails rather than reporting synthetic readiness.                                                                                             |
| Exact tenant isolation and cleanup       | Create two Namespaces; inspect two distinct labeled networks; delete one and verify only its owned containers/network disappear.                                                                                                    |
| Embedded Agent executes for real         | Create and deploy an embedded Agent through the authenticated API; its single real gateway container returns a model response containing a fresh nonce.                                                                             |
| Dedicated Agent executes for real        | Create and deploy a dedicated Agent through the authenticated API; its gateway and separate real Codex container authenticate their connection and return a model response containing a fresh nonce.                                |
| Credential and admission boundaries hold | Verify model credentials exist only in the combined embedded runtime or dedicated Codex container; unauthenticated gateway/API requests, forwarded headers, unrelated networks, and invalid image/daemon prerequisites fail closed. |
| Existing behavior remains intact         | Run focused controller, auth, worker, Compute lifecycle, and production Kubernetes configuration/packaging checks without changing production selection.                                                                            |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:06]: Repaired repository links while preserving historical citations and implementation decisions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-24 21:00]: Created Docker Compose development and Docker Compute Driver feature specification. (01a03630-cd9f-7352-9e64-1d30de98c7dd - e847976)
- [2026-08-25 10:46]: Marked the implemented and end-to-end verified Docker Compute Driver complete. (01a0362e-66e2-7b33-a874-18469fce575f - 1a1ad22)
