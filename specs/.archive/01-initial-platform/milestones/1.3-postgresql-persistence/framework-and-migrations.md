# Milestone 1.3: PostgreSQL Persistence: framework and migrations

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

## Framework decision

### Comparison

| Option                               | Useful properties                                                                                                                                  | Why it is not selected as the complete solution                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drizzle ORM + Drizzle Kit + `pg`** | Central TypeScript PostgreSQL schema, generated inspectable SQL, composite constraints and partial indexes, transaction API, raw SQL escape hatch. | Selected. Drizzle Kit applies generated and custom migrations using its built-in history; custom triggers/grants remain explicit SQL.                           |
| Kysely                               | Strong typed SQL and transactions; migrations have explicit `up`/`down` and database locking.                                                      | Core does not own a declarative current-state schema or diff generator, so application types and migration history are separate authorities.                    |
| Prisma                               | Central schema, generated migrations, drift detection, and production advisory locking.                                                            | Triggers, RLS, and other required PostgreSQL objects need custom SQL; one-provider schemas and the generated client are a poor fit for the explicit queue SQL.  |
| `node-pg-migrate` + raw `pg`         | PostgreSQL-focused migrations with transactions, locking, functions, triggers, policies, and down migrations.                                      | Migration history becomes the only schema definition; there is no centralized typed current-state model to prevent repository/schema drift.                     |
| Atlas layered over Drizzle           | Strong lint, dry-run, drift, apply, and down tooling with a Drizzle bridge.                                                                        | It adds a second migration product and operational dependency before this project has evidence that Drizzle's reviewed SQL + PostgreSQL replay is insufficient. |

Use the official Drizzle
[schema declaration](https://orm.drizzle.team/docs/sql-schema-declaration),
[index and constraint](https://orm.drizzle.team/docs/indexes-constraints),
[migration generation](https://orm.drizzle.team/docs/drizzle-kit-generate),
[custom migration](https://orm.drizzle.team/docs/kit-custom-migrations), and
[transaction](https://orm.drizzle.team/docs/transactions) contracts. Specialized
transaction code follows the `node-postgres`
[single-client transaction rule](https://node-postgres.com/features/transactions).

### Schema ownership

`packages/occ/src/state/postgres-schema.ts` owns the current-state relational
schema. Drizzle Kit and the neighboring PostgreSQL adapter consume this one
schema file directly. API TypeBox schemas remain wire contracts; they are not
database schemas.

Two complementary sources define the database:

1. The Drizzle schema defines current representable tables, columns, indexes,
   and constraints.
2. Checked-in migrations define deployed history, triggers, functions,
   privileges, data transforms, and objects the Drizzle schema cannot represent.

Change both sources in the same review. CI regenerates the schema in a scratch
directory, requires no diff, replays every migration against empty PostgreSQL,
and verifies custom objects through `pg_catalog`.

Drizzle Kit owns migration generation, application, and bookkeeping. Commit the
generated SQL and all snapshots or migration metadata produced by the pinned
Drizzle version. `drizzle-kit migrate` applies generated and named custom SQL
and records applied PostgreSQL migrations in its documented default
`drizzle.__drizzle_migrations` table. Do not add `occ.schema_migrations`, an OCC
manifest, an application-version ledger, advisory-lock orchestration, or a
custom migration runner.

### Backend boundary

```ts
interface PlatformStateStore {
  read<T>(work: (view: PlatformReadView) => Promise<T>): Promise<T>;
  transact<T>(work: (uow: PlatformUnitOfWork) => Promise<T>): Promise<T>;
}

interface WorkQueueRepository {
  enqueue(input: EnqueueWork): Promise<ControllerWork>;
  claim(input: ClaimRequest): Promise<ClaimedWork | undefined>;
  heartbeat(claim: WorkClaim): Promise<ClaimedWork | undefined>;
  complete(claim: WorkClaim, result: WorkResult): Promise<void>;
  retry(claim: WorkClaim, failure: RetryableFailure): Promise<void>;
  fail(claim: WorkClaim, failure: PermanentFailure): Promise<void>;
  recoverStale(input: RecoveryRequest): Promise<RecoverySummary>;
}
```

All aggregate repository methods are asynchronous. Each PostgreSQL transaction
checks out exactly one `pg` client, creates transaction-scoped repositories, and
passes them to the callback. Nested use cases reuse that transaction context.
Repositories cannot commit, roll back, or retain the client after the callback.
Raw Drizzle or `pg` values never cross into contracts or services.

The loaded Installation belongs to transaction/composition context, not
business-table columns. Repository reads project its ID into existing domain
objects; writes reject any logical `installationId` that does not match the
loaded Installation. Namespace-owned reads and writes require the exact
Namespace and parent identity.

The server-owned composition root selects `PostgresPlatformState`. Request
fields, Installation settings, Namespaces, tenants, and Driver registries cannot
select storage. Instantiate `InMemoryPlatformState` only for tests or explicitly
ephemeral development.

Do not use SQLite to prove compatibility: it cannot establish PostgreSQL row
locking, `SKIP LOCKED`, trigger, partial-index, lease, or transaction behavior.
PGlite may support future developer smoke tests, but it cannot provide
acceptance evidence.

### PostgreSQL production version

Use the latest stable, supported production PostgreSQL release unless a specific
compatibility constraint prevents it. As of 2026-08-17, the official
[PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)
lists PostgreSQL **18.6** as the current stable release. PostgreSQL 19 beta or
other prerelease builds are not production candidates.

Pin the exact `postgres:18.6` image for local Compose and real-PostgreSQL CI;
the production database target must use the same major and minor. Do not use a
floating `latest` tag, silently test against an older major, or treat passing
PostgreSQL 16 tests as support evidence. Before adopting a newer stable release,
update the reviewed pin and rerun migration, catalog, restart,
queue-concurrency, and adapter compatibility tests.

Use an older supported major only when a required managed provider, extension,
deployment constraint, or demonstrated adapter incompatibility blocks the
current stable major. Record the concrete blocker, supporting evidence, owner,
selected supported major and latest patch, local/CI/production parity, and
upgrade or exception-review date in the implementation change. Unsupported
versions, prereleases, and undocumented preferences never justify an exception.

## Migration lifecycle

### Generate and review

1. Change `packages/occ/src/state/postgres-schema.ts`.
2. Run `pnpm db:generate --name <kebab-change>`, which invokes
   `drizzle-kit generate`. Never use `drizzle-kit push` against a shared or
   acceptance database.
3. Generate named custom migrations for triggers, functions, grants, or data
   movement with `drizzle-kit generate --custom`, then edit their SQL. Add a
   catalog assertion for every custom object.
4. Review SQL for locking, table rewrites, data loss, defaults, constraint
   validation, and backward compatibility. Generated SQL does not bypass
   review.
5. Commit the schema file, generated/custom SQL, Drizzle-owned generated
   metadata, and integration-test catalog assertions together.
   Never edit a migration applied in a shared environment. CI validates the
   checked-in schema/history and replays every migration against fresh
   PostgreSQL; use `drizzle-kit check` when the pinned version supports it.

### Apply

Run `pnpm db:migrate` as one explicit pre-start job. It invokes
`drizzle-kit migrate` with the dedicated `occ_migrator` credential and
checked-in Drizzle configuration. `occ_migrator` owns the `occ` application
schema and Drizzle's history schema; application processes never receive this
credential or auto-migrate. The command applies pending generated and custom
migrations and updates `drizzle.__drizzle_migrations`; rerunning it without new
migrations does not reapply completed history.

Migration integration tests inspect `pg_catalog` to verify required relations,
constraints, indexes, functions, triggers, role privileges, and the RLS-disabled
decision. Startup verifies the required schema objects and application
connection privileges; a missing object fails closed until a reviewed
fix-forward migration or recovery restores the expected catalog. Do not add a
separate schema-check executable, second migration ledger, custom version
manifest, or automatic startup migration.

Stop after a failed migration. Inspect Drizzle's recorded history and the actual
PostgreSQL catalog; when shared history has already been applied, repair or
replace defective SQL in a new reviewed forward migration. Rerun the official
migration command and catalog assertions. Operations that PostgreSQL cannot
roll back require an explicit backup/PITR recovery plan before review. Do not
assume Drizzle detects edits to applied SQL. Read credentials from explicit
server configuration and never log URLs or passwords.

### Rollback and recovery

Use expand/contract migrations. Release `N` first adds schema compatible with
application `N-1`; a later release stops reading old columns, and a still later
migration removes them.

Production rollback proceeds in this order:

1. Stop the new application rollout.
2. Restore application `N-1`, which must remain compatible with the expanded
   schema.
3. Preserve the applied schema and data.
4. Repair a faulty schema with a reviewed forward migration.

Do not rely on automatic `down` execution. Supply a reverse migration only when
it is demonstrably lossless and tested in both directions. Before applying a
destructive or data-transforming migration, create a named backup or
point-in-time-recovery checkpoint and rehearse restoration. Recover the initial
migration by dropping and recreating disposable local or test databases; recover
shared environments through backup/PITR plus replay. This satisfies the source
“rollback or recovery” requirement without assuming every schema change is
reversible.

