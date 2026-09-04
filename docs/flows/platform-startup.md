---
created: 2026-08-20
updated: 2026-09-01
last_updated_session: codex/01a05f95-dd80-7011-990f-d1c46b5bb3cc
---

# Platform Startup Flow

## Overview

The OCC API and controller worker start as separate Node.js processes, resolve
the same singleton Installation and trusted Driver selections, and coordinate
through PostgreSQL. Each process constructs its own shared Driver instances;
when a ServiceAccount Driver is selected, only the API additionally initializes
its Provider client and Driver. PostgreSQL-backed development uses the
Docker Compute Driver by default, while the development filesystem
Configuration Driver is API-only. The singleton invariant is the selected Driver
identity, not JavaScript object identity. This trace ends when the API accepts
requests and the worker begins polling durable work.

## Entry Points

- Trigger: Start the API with `node apps/controller/src/server.mjs`; start the
  worker separately with `node apps/controller/src/worker.mjs`.
- Source: `apps/controller/src/server.mjs:start`,
  `apps/controller/src/worker.mjs:configuration`, and
  `apps/controller/src/composition/installation-config.ts:loadInstallationConfiguration`.
- Assumptions: PostgreSQL-backed startup requires the same migrated application
  database, one bootstrapped Installation, and persisted IAM policy. Production
  additionally requires the same absolute `OCC_CONFIG_PATH`, exact selected
  bundled or installed IAM, Compute, and Configuration Drivers, and the API's
  mounted Better Auth signing Secret. A selected ServiceAccount Driver additionally
  requires the provider admin Secret mounted only into the API. Compose
  development additionally mounts `occ_configuration_data` only into the API at
  `/app/.development/configurations`; manual host-process development must pass
  the same application-role PostgreSQL URL, configuration root, and Docker
  runtime-image inputs.

## Flow

```mermaid
graph TD
  subgraph Shared["Shared configuration and persistence"]
    Y["Trusted Installation startup YAML"]
    D["PostgreSQL Installation, IAM policy, and work queue"]
  end

  subgraph API["OCC API process"]
    A["server.mjs validates API settings"] --> B["Load shared Drivers and optional API-only ServiceAccount Driver"]
    B --> C["Compose authorized OCC and Fastify"]
    C --> E["Listen for requests and enqueue durable work"]
  end

  subgraph Worker["Controller worker process"]
    F["worker.mjs validates worker settings"] --> G["Load Installation and construct shared worker-owned Drivers"]
    G --> H["Validate persisted IAM and preflight Compute"]
    H --> I["Start polling and claim authorized work"]
  end

  subgraph Runtime["Compute-owned tenant runtimes"]
    N["One isolated backing namespace per Namespace"]
    J["One OpenClaw gateway per deployed Agent"]
    K["Embedded OpenClaw or dedicated Codex revision"]
  end

  Y --> B
  Y --> G
  D --> C
  D --> H
  E -->|persist lifecycle work| D
  D -->|claim durable work| I
  I -->|provision Namespace infrastructure| N
  I -->|prepare each deployed Agent's gateway| J
  I -->|development or production AgentRevision work| K
```

## Execution Trace

### 1. Launch independent API and worker processes

`apps/controller/src/server.mjs:start`

The [API entrypoint](../../apps/controller/src/server.mjs) and
[worker entrypoint](../../apps/controller/src/worker.mjs) are separate commands;
the API never starts or embeds the worker. The API validates `NODE_ENV`, its
listener address and port, admission inputs, and optional PostgreSQL settings.
The worker validates its own `NODE_ENV`, required `OCC_DATABASE_URL`, poll
interval, lease duration, retry limit, and convergence timeout.

Production API binding requires one explicit Pod interface address.
Host-process development API binding permits only loopback. Compose binds the
API to `0.0.0.0` inside its private bridge, publishes only
`127.0.0.1:${OPENCLAW_DEV_PORT:-3000}` on the host, and requires the explicit
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR`. The worker never opens the API listener
and does not receive API authentication configuration.

### 2. Resolve process-local Installation and Driver state

`apps/controller/src/composition/installation-config.ts:loadInstallationConfiguration`

When `OCC_CONFIG_PATH` is set, each process reads the same trusted file and
constructs its own Installation, Compute, Configuration, and mandatory
`createIAMDriver(state)` bundle. The shared loader parses provider-integration
metadata but never reads an admin credential or initializes a provider client.
Production requires the startup file. Development may omit it: the API then
uses PostgreSQL plus the filesystem Configuration Driver rooted at
`OCC_DEVELOPMENT_CONFIGURATION_ROOT`, and the worker uses the Docker Compute
Driver. The
[Driver package loading flow](driver-plugin-loading.md) owns package
resolution, identity, validation, and trust boundaries. Installation identity
comes from server-owned singleton state, never startup YAML.

API and worker use matching logical Driver identities but separate instances.
Each IAM Driver loads current persisted policy for every identity lookup and
authorization decision. Only `server.mjs` reads the mounted ChatGPT admin key,
constructs `Provider<ChatGPTClient>`, and injects it into the optional
ServiceAccount Driver factory. The worker consumes only nonsecret Provider
metadata and never receives the client or admin credential. Startup validates
required member selections without scanning saved Provider references. Exact
ownership is checked when credentials or deployments are used, allowing the API
to start so stale references can be repaired. Lifecycle owners remain stable,
and controller Drivers are never exposed to tenant workloads.

### 3. Compose the API according to its persistence and execution mode

`apps/controller/src/composition/production.ts:composeProduction`

Production [API composition](../../apps/controller/src/composition/production.ts)
opens its own PostgreSQL pool, loads the already-bootstrapped Installation and
IAM policy, validates its user session configuration, constructs the
exact bundled or installed IAM Driver with platform state, and structurally
verifies the selected Compute and Configuration Drivers. It runs a selected
Compute preflight when present; bundled Kubernetes Compute must provide one.
It registers IAM, Compute, Configuration, and any selected API-only
ServiceAccount Driver with OCC before
[`createFastifyApp`](../../apps/controller/src/index.ts) installs authenticated,
exact-resource-authorized API routes.

Development with `OCC_DATABASE_URL` instead calls
[`composePostgresDevelopment`](../../apps/controller/src/composition/development-postgres.ts)
and loads the initialized Installation and current IAM state. In both modes,
[`scripts/bootstrap-installation.mjs`](../../scripts/bootstrap-installation.mjs)
runs before composition; the API and worker fail if that state is absent.
Credential creation, private delivery, and failure handling belong to
the [bootstrap flow](local-password-authentication.md).

When `OCC_CONFIG_PATH` is absent, it registers the bundled Docker Compute Driver and filesystem
Configuration Driver, which writes native documents under
`OCC_DEVELOPMENT_CONFIGURATION_ROOT`. Compose always supplies PostgreSQL for
the supported development path.

### 4. Verify persisted ownership and start the independent worker

`apps/controller/src/worker.ts:ControllerWorker.start`

The [worker entrypoint](../../apps/controller/src/worker.mjs) creates a
separate PostgreSQL pool. With `OCC_CONFIG_PATH`, it passes independently
constructed Compute and Configuration Drivers into
[`ControllerWorker`](../../apps/controller/src/worker.ts). Without
`OCC_CONFIG_PATH` in development, it constructs only the Docker Compute Driver;
the filesystem Configuration Driver stays API-only. The constructor rejects
mismatched selected Compute, Configuration, or IAM identities and requires the
selected factory for packaged IAM. It never constructs a ServiceAccount Driver
or ChatGPT client. It claims Namespace lifecycle plus embedded OpenClaw and
dedicated Codex AgentRevision work using the exact selected Compute Driver.

`start()` loads the existing singleton Installation, validates current native
IAM policy from PostgreSQL, and uses its stable selected bundled or installed
IAM Driver. That Driver loads current policy for every identity lookup and
authorization decision. Production runs available Compute preflight and
requires it for bundled Kubernetes. Successful startup emits `worker.started`
with the selected `computeDriverId`; no AgentRevision workload is admitted or
started merely because the worker boots.

### 5. Hand off to request serving and durable queue processing

`apps/controller/src/worker.ts:ControllerWorker.run`

The API registers shutdown callbacks, binds its listener, and emits `listening`.
The worker registers its own shutdown callbacks, starts polling, recovers stale
claims, and emits `worker.health`. Authorized API mutations persist lifecycle
work in PostgreSQL; the worker independently claims that work and invokes its
own selected ComputeDriver under the claim's ownership and cancellation scope.

Compute prepares Namespace backing infrastructure and creates one gateway for
each deployed Agent. Default PostgreSQL-backed development uses Docker networks
and runtime containers; the bundled Kubernetes Driver prepares either an
embedded OpenClaw or dedicated Codex revision, activates its exact Agent-owned
gateway route, and retires any predecessor. Reviewed installed Compute Drivers
can also be selected in development and production. Docker containers and
Kubernetes Pods are downstream tenant
runtimes, not extra copies of the API or worker. Detailed lifecycle-hook
execution begins in the adjacent
[Compute Driver lifecycle flow](compute-driver-lifecycle-hooks.md).

## Debugging and Verification

- Verify matching selection and process-local instances with
  `node --test --test-name-pattern='independent API and worker startup construct the same selected runtime Drivers' tests/integration/configuration-startup.test.mjs`.
- Expect API `{"event":"listening",...}` and worker
  `{"event":"worker.started","computeDriverId":"..."}` events, followed by
  `worker.health`. Startup failures emit `startup-error` or
  `worker.startup-error`; stale claim failures emit `CLAIM_LOST`.
- Compare both processes' `OCC_DATABASE_URL`, production `OCC_CONFIG_PATH`, and
  selected Driver IDs/implementations. Missing singleton bootstrap, incomplete
  persisted IAM policy, mismatched Driver identity, unavailable cluster access,
  and invalid API admission configuration fail before normal operation.
- Production queue processing includes Namespace lifecycle plus embedded
  OpenClaw and dedicated Codex AgentRevision work. A real Kubernetes cluster is
  required to prove gateway or Agent workload execution; startup tests alone do
  not establish that outcome.
- With a selected ServiceAccount Driver, verify the admin key and ChatGPT client
  exist only in the API process; provider-issued access tokens require the
  genuine scenario in `tests/integration/service-account-driver-real.test.mjs`.

## Related docs

- [Provider-managed credential delivery](service-account-driver-credential-delivery.md)

- [Platform architecture](../ARCHITECTURE.md)
- [Controller worker operation](../reference/controller.md)
- [Controller and Installation configuration](../reference/settings.md)
- [ComputeDriver contract](../reference/drivers/compute.md)
- [Configuration Driver and Agent Revision flow](configuration-driver.md)
- [Installation Driver package loading flow](driver-plugin-loading.md)
- [Compute Driver lifecycle-hook flow](compute-driver-lifecycle-hooks.md)
- [Service Account Driver credential delivery flow](service-account-driver-credential-delivery.md)
- [Kubernetes ComputeDriver](../reference/drivers/kubernetes-compute.md)
- [Docker ComputeDriver](../reference/drivers/docker-compute.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 19:09: Validate Provider configuration at startup and exact saved ownership at use, preserving API repair access. (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 1c7eae4d11e6c474cc7f1bbbb05d2c2e7052a158) (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-09-01 08:47: Trace Provider membership, API-only client injection, and persisted ownership checks. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- 2026-08-31 22:29: Remove automatic bootstrap recovery; preserve artifacts after any error and require manual repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)

- 2026-08-31 20:33: Trace the shared installation initializer, startup ordering, and initializer-owned credential delivery. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213cbcee11ba3dd69886c936c7e5abe233eb3)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- 2026-08-28 21:20: Removed local-test Compute Driver startup references; retain Docker and Kubernetes runtime ownership. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 3ec166eb5fae39ed0f51ffb5ebd93338c4a2db94)
- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-25 08:46: Clarified that supported development startup requires PostgreSQL, API-only filesystem configuration storage, and Docker runtime-image inputs. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 949e57ba008486c7ad60978df79dc53cce31bee9)
- 2026-08-24 22:43: Updated PostgreSQL-backed development startup for Docker Compute and API-only filesystem Configuration defaults. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 63890cf94cfc15f848f62f8f957eb766d2101f55)
- 2026-08-24 23:46: Distinguished shared Installation Drivers from API-only provider initialization, mounted admin authority, and dedicated account-Secret projection. (01a03542-30ff-77a1-9967-587d55548ace - 51033bee121374332df2791e90e2290a5c892e5d)
- 2026-08-24 19:46: Pass platform state directly to process-local IAM Drivers. (01a036c0-9a0e-7ee0-8428-17824f5172a0 - 786b7ce)
- 2026-08-24 17:12: Documented stable API and worker IAM Drivers with current-policy identity lookup and authorization. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e)
- 2026-08-24 17:12: Removed IAM policy snapshots and Driver replacement; API and worker Drivers load current policy for every authorization decision. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e) (NOT_IN_SPEC)
- 2026-08-21 20:53: Merged duplicate Installation startup phases and retained process ownership, Harness topology, and real-infrastructure verification boundaries. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - f6491502262d6190c95d2a910ee46283c30244f9)
- 2026-08-21 20:05: Scoped startup documentation to process ownership and the single state-aware Driver bundle; delegated package details to their owning flow. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - b651c4ae38310032f8cda47c868a9b282fb12ff3)
- 2026-08-21 19:28: Documented production-capable packaged IAM, Compute, and Configuration with persisted IAM refresh and capability-owned preflight. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - a45b01d258c6a6b10db2301cad3303e2fa520f09)
- 2026-08-21 17:28: Updated independent API and worker startup to consume the single asynchronous Installation-and-Drivers result. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - d17a87541cbebc8e333bd00bd90c42e734d91a80)
- 2026-08-21 16:27: Clarified OCC lifecycle ownership for external Driver construction after factory simplification. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - 4fe8091c5f7faa1a56445beb022e075b59787bee)
- 2026-08-21 16:24: Corrected production worker startup and execution to support both embedded OpenClaw and dedicated Codex. (01a0259c-c825-71c3-8092-eb2afb161355 - 1379b0f500317e7f32559c711e31378eb22a8072)
- 2026-08-21 16:19: Documented installed Configuration Driver startup and external Compute selection while preserving bundled Kubernetes ownership. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - 9e356f7228c51fe68d85327cf7b47dbd04e420a4)
- 2026-08-21 11:39: Corrected production AgentRevision processing, per-Agent gateway ownership, active routing, and real-runtime verification boundaries. (01a0259c-c825-71c3-8092-eb2afb161355 - 9ae2efc1899a69463e7cab463e12a4ad27113f8d)
- 2026-08-20 15:40: Traced independent API and worker startup, shared singleton Installation selections, process-local Drivers, PostgreSQL coordination, and tenant-runtime handoff. (01a01fd2-0582-7702-a51d-c742deee0089 - 15219a570d00d9ef30dfaa090e7ee1b23dfa0201)
