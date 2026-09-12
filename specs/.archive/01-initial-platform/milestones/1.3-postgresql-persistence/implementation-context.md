# Milestone 1.3: PostgreSQL Persistence: implementation context

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

## Current implementation

The active workspace implements the asynchronous `PlatformStateStore` contract
with both the existing clone-on-write memory adapter and
`PostgresPlatformState`. The PostgreSQL adapter owns one-client transactions,
Namespace-scoped repositories, persisted native IAM, immutable revision and
audit records, and atomic controller-work insertion. `PostgresWorkQueue` owns
leases, fencing, deduplication, retries, and stale-claim recovery. Drizzle's
single schema file, checked-in SQL and snapshot, and two migration history
entries define the durable database.

The development server selects PostgreSQL only when `OCC_DATABASE_URL` is
explicitly configured. It restores the persisted Installation and native IAM
authority on restart; otherwise the existing ephemeral memory composition
remains unchanged. The HTTP deploy route still rejects unready Namespaces and
does not admit revisions. No effectful controller, legacy reconciler, or
production admission path starts.

Verification completed against PostgreSQL 18.6 includes nine real-database
integration tests for migration/catalog enforcement, privilege boundaries,
immutable ownership, actual HTTP-process restart, transaction rollback,
duplicate work, per-resource concurrency, lease fencing, and stale recovery.
The complete contract, conformance, integration, and real-database suite passes
68 tests; TypeScript, formatting, OpenAPI generation, workspace isolation,
Drizzle schema checking, clean migration, and idempotent migration replay also
pass.

Startup must preserve the deployment's one persisted Installation. An
uninitialized database contains no `occ.installation` row; authorized, audited
bootstrap creates the server-owned Installation exactly once. Every initialized
startup loads exactly one persisted row and rejects zero or multiple rows. It
never generates a replacement Installation ID. Concurrent bootstrap is
unsupported, and `installation_id` is not duplicated across resource, IAM,
audit, or work tables. The initialized composition disables bootstrap.

The uninitialized composition authorizes one-time setup with its explicit
server-owned development principal and native IAM fixture. One transaction
persists the Installation, corresponding native IAM identities, roles,
embedded role permissions, bindings, and success audit. Initialized startup uses only the
persisted IAM policy; it never silently substitutes fresh fixture policy.

Resource contracts, admission evidence, authorization requests, audit events,
and exported observations still require `installationId`. PostgreSQL
repositories and composition project that value from the loaded
`occ.installation.id` when reading or constructing domain objects. Namespace IDs
and Namespace-scoped parent keys enforce the actual database ownership boundary.

Authorization must survive process restart. The existing controller stores
registered and selected Drivers only in process-local maps, and only the HTTP
bootstrap path calls `registerDriver` and `selectDriver`; see the
[process-local Driver registry and selection](../../../../../packages/occ/src/index.ts)
(historical lines 183–255),
[bootstrap-only registration](../../../../../apps/controller/src/index.ts)
(historical lines 568–615),
and
[native IAM state contract](../../../../../packages/iam/src/index.ts)
(historical lines 14–18). These citations record commit
`8ed90f6adf566eb555dfdc0c2333063e4725fb2f`; the local links open current files.
Every initialized durable composition therefore completes these steps before
creating a request-serving Fastify application:

1. Load exactly one Installation and validate its stable server-owned ID against
   any explicit deployment configuration.
2. Load persisted identities, roles with embedded permissions, and access
   bindings. Reconstruct `NativeIAMState` directly and
   project the loaded `installationId` into every current IAM contract.
3. Instantiate `NativeIAMDriver` with that state and a stable, fixed,
   server-configured native IAM Driver ID. No request, tenant, Namespace, or
   database row selects the Driver implementation.
4. Construct `OpenClawController` for the loaded Installation, call
   `controller.registerDriver(nativeIAMDriver)`, and call
   `controller.selectDriver("iam", configuredNativeIAMDriverId)` on **every**
   process start.
5. Verify the selected Driver's exact capability, implementation, and ID.
   Reconstruct admission mappings with the same Installation ID, pass the
   preselected controller to `createFastifyApp`, and only then open the listener.

Fail startup if the Installation is missing or ambiguous, persisted IAM policy is
invalid or incomplete, Installation and configuration disagree, hydration
fails, the Driver is unknown, or its selected capability/ID is unexpected.
Initialized restart must not depend on bootstrap-only Driver registration or
accept requests before native authorization is ready.

## Requirements -> Design Mapping

| Requirement                   | Enforcing design                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One Installation              | A unique index on a constant limits `occ.installation` to one row; initialized startup loads its stable ID and projects it into domain contracts.                   |
| Namespace and child ownership | Namespace-owned children use Namespace-aware foreign keys and scoped parent tuples; no business row duplicates the database-wide Installation ID.                   |
| Unique identities and names   | Resource IDs are unique within each kind; Namespace names are unique in the database and Agent names are unique within their Namespace.                             |
| Stable workload identity      | Deferred circular FKs bind one workload identity to its exact Agent at commit; a partial unique index prevents a second identity for that Agent.                    |
| Immutable admitted revisions  | Admitted configuration remains in `agent_revisions`; a trigger rejects every row `UPDATE` and `DELETE`.                                                             |
| At most one active revision   | Each Agent has one nullable `active_revision_id`; a composite foreign key proves the pointed revision belongs to that exact Namespace and Agent.                    |
| Namespace and Agent work      | One lifecycle claim runs per Namespace and one Agent claim runs per Agent; persisted Namespace readiness and deletion state coordinate Agent admission.             |
| Atomic mutation/audit/work    | One transaction-scoped `PlatformUnitOfWork` writes all three; no repository may open its own transaction.                                                           |
| Restart-safe claims           | A single CTE locks one ready row with `FOR UPDATE SKIP LOCKED` and commits a lease before work begins.                                                              |
| Idempotent retries            | A stable semantic `idempotency_key` is unique in the Installation-owned database and is unchanged across claims and attempts.                                       |
| Restart-safe authorization    | Every initialized startup hydrates native IAM state, projects `installationId`, registers its fixed server-owned IAM Driver, and selects it before serving traffic. |
| Stale recovery                | PostgreSQL time determines lease expiry; a bounded reaper requeues expired claims with backoff or records terminal failure and audit evidence atomically.           |
| No legacy reconciler          | The active workspace and tests reject imports, scripts, images, migrations, or entrypoints under `legacy/`; M3 uses only a non-effectful queue harness.             |
| Different backends            | PostgreSQL is the durable target. Memory implements the port only for deterministic tests; dialect portability is not promised.                                     |

