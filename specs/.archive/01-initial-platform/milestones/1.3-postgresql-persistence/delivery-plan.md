# Milestone 1.3: PostgreSQL Persistence: delivery plan

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

## Legacy isolation

Active packages must remain isolated from the legacy reconciler. They must not
import paths containing `/legacy/`, execute legacy package scripts, read legacy
migrations as active history, build legacy images, or start the legacy
reconciler. Extend the existing workspace-boundary test to cover
the OCC PostgreSQL state adapter, database scripts, test fixtures, and any future worker
entrypoint. The local Compose file uses only the pinned stock `postgres:18.6`
image and an active-workspace health check. Advance that pin according to the
latest-stable production-version policy.

M3 tests exercise `WorkQueueRepository` through a harness that claims,
heartbeats, retries, recovers, and finalizes synthetic work without a Driver
registry or effect callback. The dedicated controller entrypoint, authorization
reload, selected Driver dispatch, observed-state handling, and health endpoint
remain source Milestone 5.

## Detailed File Plan

Each change belongs to the active workspace and has one explicit owner:

- `package.json`: add pinned Drizzle, Drizzle Kit, `pg`, type, local-PostgreSQL,
  migration, and PostgreSQL integration scripts.
- `packages/occ/package.json`: declare the PostgreSQL adapter's direct Drizzle
  and `pg` dependencies without introducing another workspace package.
- `drizzle.config.ts`: point Drizzle Kit at the single OCC PostgreSQL schema
  file and the checked-in root `migrations/` directory.
- `compose.postgres.yaml`: local-only PostgreSQL service pinned to
  `postgres:18.6`, named disposable data volume, readiness probe, and no legacy
  service; keep its reviewed version aligned with CI and the production target.
- `.env.example`: document nonsecret `OCC_DATABASE_URL`, migration-credential,
  pool, and fixed server-owned native IAM Driver ID configuration; never include
  credentials used outside local development. Expose retry-policy environment
  configuration only when the later controller actually consumes it.
- `packages/occ/src/state/platform-state.ts`: evolve the existing repository,
  `PlatformStateStore`, `PlatformUnitOfWork`, and `WorkQueueRepository` ports
  to asynchronous operations; retain the deterministic memory adapter for tests
  without introducing a hierarchy of new contract or repository modules.
- `packages/occ/src/index.ts`: await repository calls, enqueue durable work in
  the existing mutation transaction, remove `pendingOperations()` as an
  authority, and preserve explicit `registerDriver`/`selectDriver` startup
  calls on a reconstructed controller.
- `packages/occ/src/state/postgres-schema.ts`: centralize Drizzle table
  definitions, relationships, checks, keys, and indexes in one schema file;
  business tables omit the database-wide Installation ID.
- `packages/occ/src/state/postgres-state.ts`: own pool lifecycle, one-client
  units of work, scoped repositories, Installation-aware domain projection,
  native IAM hydration, safe errors, and minimal startup readiness checks.
- `packages/occ/src/state/postgres-work-queue.ts`: implement explicit enqueue,
  claim, heartbeat, finalization, retry, failure, and stale recovery; preserve
  the initiating actor, enforce per-Agent processing mutual exclusion, and
  commit failure audit evidence atomically.
- `migrations/`: check in standard Drizzle-generated and custom SQL plus the
  metadata emitted by the pinned release; applied history remains in
  `drizzle.__drizzle_migrations`.
- `apps/controller/src/composition/development-postgres.ts`: explicit durable
  local composition. Bootstrap an empty database once; on initialized startup,
  load exactly one Installation, hydrate native IAM, construct/register/select
  the fixed configured `NativeIAMDriver`, and pass the initialized controller to
  `createFastifyApp`. Do not start a worker.
- `apps/controller/src/composition/development.ts`: retain explicit ephemeral
  development composition; do not choose a backend from request or tenant data.
- `apps/controller/src/composition/production.ts`: remain fail-closed because
  OAG is still absent.
- `apps/controller/src/index.ts`: accept the preconstructed selected controller
  for initialized startup, reject bootstrap after initialization, and fail
  closed when native IAM authority is unavailable or mismatched.
- `apps/controller/src/server.mjs`: select the explicit durable composition,
  load the persisted Installation before admission setup, and never generate a
  replacement Installation ID on restart.
- `tests/conformance/platform-state-store.contract.mjs`: reusable ownership,
  uniqueness, immutability, atomicity, and rollback contract.
- `tests/conformance/platform-state-memory.test.mjs`: run the conformance suite
  against the memory adapter.
- `tests/integration/postgres-migrations.test.mjs`: empty replay, idempotent
  official migration replay, recovery, and catalog/role assertions.
- `tests/integration/postgres-platform-state.test.mjs`: run repository
  conformance against real PostgreSQL and prove process restart durability.
- `tests/integration/postgres-restart-recovery.test.mjs`: terminate and recreate
  API/harness processes while preserving the database. Prove the native IAM
  Driver is registered and selected again, persisted authorization allows exact
  grants and denies cross-Namespace access, and no state is lost. Exercise work
  deduplication, per-Namespace lifecycle and per-Agent mutual exclusion,
  concurrent claims for different Agents, token fencing, retry, stale recovery,
  and batch failure audit directly against PostgreSQL.
- `tests/conformance/workspace-boundary.test.mjs`: reject every active import or
  execution route to `legacy/`.

## Planning & Milestones

### Step 1: schema and migration foundation

**Shipped functionality:** Standard Drizzle Kit migrations deterministically
create the complete, constrained schema in a clean PostgreSQL database.

Tasks:

- Add the local database, in-package state adapter, single Drizzle schema file,
  generated initial migration, trigger/grant migration, and integration-test
  catalog assertions.
- Pin local and CI PostgreSQL to the current stable `postgres:18.6` image and
  verify production-target version parity or record an approved exception.
- Validate configuration explicitly and separate migration/application roles.
- Prove empty replay, idempotent migration reruns, and required-object startup
  checks.

Verification:

- Re-running `drizzle-kit migrate` skips already-completed migrations.
- Local, integration-test, and production-target PostgreSQL use the same
  reviewed stable release or one documented compatibility exception.
- The generated initial migration deterministically creates the expected catalog
  from an empty database; previous-version fixtures are unnecessary.
- A second Installation insert is rejected by the one-row expression index;
  bootstrap is invoked once and has no concurrency test.
- Cross-Namespace ownership, duplicate identity/name, revision mutation, an
  active revision belonging to another Agent, and audit mutation are rejected
  by PostgreSQL.

### Step 2: durable OCC unit of work

**Shipped functionality:** API resource and audit state commit atomically through
the injected persistence port and survive process restart.

Tasks:

- Make the existing repositories async, preserve the memory adapter, and
  implement the neighboring PostgreSQL state adapter.
- Bootstrap the Installation once. On restart, load its exact persisted ID,
  hydrate native IAM identities/roles/permissions/bindings, and explicitly
  register/select the stable server-configured native IAM Driver before serving
  requests.
- Stage every successful mutation and audit in one UoW; add controller work only
  for use cases that currently record reconciliation intent.

Verification:

- Shared conformance passes for memory and PostgreSQL.
- PostgreSQL process restart preserves all supported state, audit evidence, and
  exact-resource authorization without using the bootstrap-only Driver path.
- Missing or mismatched Installation, IAM policy, or Driver identity fails
  startup closed before the listener accepts requests.
- Injected write/audit/enqueue failures roll back the whole request.

### Step 3: durable queue mechanics

**Shipped functionality:** Concurrent harnesses claim, retry, fence, recover, and
terminalize synthetic work without starting a reconciler.

Tasks:

- Implement enqueue, claim, heartbeat, finalization, retry/failure, recovery,
  and polling.
- Add deterministic backoff/error classification seams and queue metrics.
- Validate one controller-wide attempt limit; persist failure details in audit
  events, never on queue rows.
- Extend legacy boundary checks to the OCC PostgreSQL adapter and harness.

Verification:

- Concurrent claim, per-Namespace lifecycle exclusion, per-Agent processing
  exclusion, parallel claims for different Agents in the same Namespace,
  worker termination, stale lease, lost heartbeat, duplicate enqueue,
  max-attempt, and restart tests pass against real PostgreSQL.
- Idempotency-key collisions compare the exact owner tuple and initiating actor;
  failed and exhausted work retains durable, attributable audit evidence after
  process restart.
- Queue-harness tests neither dispatch an infrastructure Driver nor import/run
  a legacy reconciler. Separate API restart tests exercise native IAM
  authorization.

### Dependencies

- Step 2 depends on Step 1.
- Queue table generation can begin in Step 1; runtime queue tests require
  Step 2's transaction-scoped adapter.
- Source Milestone 4 may build on persisted IAM after this work.
- Source Milestone 5 depends on the queue contract but owns effectful dispatch.
- Source Milestone 6 depends on revision constraints but owns admission and
  activation behavior.

## Rollout Plan

Phase 0 — CI only:

- Land the schema, migrations, and real-PostgreSQL tests without changing
  composition.
- Keep every running path on the memory adapter.

Phase 1 — durable local development:

- Add an explicit durable development command and migrate a disposable local
  database.
- Bootstrap once. On restart, load the existing Installation and
  rehydrate/select native IAM before accepting requests.
- Keep the existing ephemeral command available for unit/UI work.
- Do not enable production composition or start a worker.

Phase 2 — default local persistence:

- Make the documented local integration command use PostgreSQL after conformance,
  restart, queue, and recovery gates pass.
- Preserve the test-only memory adapter through explicit test composition.

Rollback:

- Restore the memory-backed local composition and previous application code;
  retain the expanded schema.
- Use a fix-forward migration for schema defects; recreate disposable databases
  or restore shared data from the predeclared recovery checkpoint.
- Never point the active application at legacy storage or run legacy migrations.

