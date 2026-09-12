# Milestone 1.3: PostgreSQL Persistence: acceptance and operations

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

## Testing Plan and Acceptance

### Unit and conformance

- Namespace-owned repository methods require the exact Namespace/parent tuple.
  Project logical `installationId` from the loaded Installation and fail closed
  on mismatches.
- Memory and PostgreSQL adapters return immutable domain copies and map expected
  unique/FK/check failures to bounded domain errors.
- Backoff, classification, dedupe-key derivation, claim-token checks, and safe
  error redaction are deterministic.
- The validated controller-wide attempt limit is positive; request, Namespace,
  and per-work-item data cannot override it.
- Nested transactions reuse the same UoW; repository calls cannot escape it.

### Real-PostgreSQL integration

- Run migration, catalog, restart, and queue tests against pinned PostgreSQL
  18.6; reject version drift from the selected production target unless a
  documented compatibility exception explicitly establishes a different
  supported baseline.
- Replay the initial migration against an empty PostgreSQL database.
- Verify checks, FKs, partial indexes, functions, triggers, concrete role
  privileges, Drizzle migration history, and RLS-disabled decision through
  `pg_catalog`.
- Bootstrap an empty database once, reload exactly one unchanged Installation on
  restart, reject a second Installation insert, and reject zero-row initialized
  startup.
- Verify PostgreSQL rejects cross-Namespace child inserts and reparenting
  updates.
- Verify PostgreSQL rejects direct revision/audit updates or deletes and active
  revision pointers targeting a different Agent or Namespace.
- Attempt to omit, share, or cross-bind an Agent workload identity and observe
  commit-time rejection; prove exactly one stable identity per Agent.
- Rerun `drizzle-kit migrate` without new migrations and prove applied history is
  unchanged; remove or alter a required catalog object and prove schema
  assertions/startup fail closed.
- Terminate API and queue-harness processes at every documented crash point;
  restart against the same PostgreSQL volume and verify recovery.
- Bootstrap an Installation-scoped Principal with a Namespace-scoped access
  binding, terminate the API, restart against the same database, and prove
  persisted native IAM is hydrated, registered, and selected: the exact
  authorized request succeeds, an ungranted/cross-Namespace request is denied,
  and no new Installation is created.
- Prove startup refuses missing IAM policy, invalid principal/role/binding
  references, mismatched configured Installation ID, and incorrect or
  unselected native IAM Driver identity before accepting requests.
- Prove Milestone 3 exposes no IAM policy-management route, policy grants are
  inserted only by authorized bootstrap, and workload identities are inserted
  only within an authorized owning Agent transaction.
- Run multiple claimers and reapers; prove no row has two valid claim tokens and
  no derived `COALESCE(agent_id, namespace_id)` root has two claimed rows.
- Prove two Namespace lifecycle operations for the same Namespace cannot run
  concurrently, two operations for the same Agent cannot run concurrently, and
  operations for different Agents in the same ready Namespace can run together.
- Reuse an idempotency key with equal and conflicting owner tuples or actor IDs;
  prove exact duplicates return the original work and conflicting targets or
  initiating actors fail.
- Persist the initiating actor and exact resource owner tuple across restart;
  source Milestone 5 owns reloading both and proving that a missing or
  unauthorized actor fails closed before Driver dispatch.
- Restart after retry, stale recovery, and attempt exhaustion; prove persisted
  `attempt_count`, the configured attempt limit, and immutable failure audit
  remain actionable.
- Verify periodic scans discover and drain every eligible synthetic work item.
- Inject resource, audit, work, and finalization failures and prove transaction
  rollback leaves no partial state.

### Required commands

Implementation adds and passes:

```text
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm db:migrate:test
pnpm test:contracts
pnpm test:conformance
pnpm test:postgres
pnpm test
```

Never run `npm run precommit` and never execute an archived package script.

### Acceptance criteria

Milestone 1.3 is complete only when:

1. Passing automated evidence covers every source-checklist item.
2. Restarting the API or queue harness preserves every resource, revision, IAM
   state, audit event, and nonterminal work item.
3. Exactly one Installation is loaded after one-time bootstrap; Namespace
   ownership, uniqueness, revision immutability, and one active revision are
   enforced by PostgreSQL.
4. A successful mutation, its success audit, and its work item appear together
   or remain absent together.
5. A denied request creates no work or external side effect.
6. Duplicate enqueue returns the same semantic work without creating another
   effect identity or changing its persisted initiating actor.
7. Concurrent claims enforce one Namespace lifecycle operation per Namespace and
   one Agent operation per Agent while allowing different Agents in the same
   Namespace to run together. Heartbeats, token fencing, retry backoff, stale
   recovery, and controller-wide max-attempt terminalization pass against real
   PostgreSQL; terminal failures retain attributable audit evidence after
   restart.
8. Table polling discovers and recovers every eligible work item without a
   notification listener.
9. No active code imports, executes, or starts the legacy reconciler, migration,
   package, image, or deployment.
10. Production startup remains blocked pending OAG, and no Driver is invoked by
    the M3 claim harness.
11. Every initialized restart reconstructs and selects the fixed native IAM
    Driver from persisted policy before serving requests. Exact-resource grants
    remain effective; missing or mismatched authorization authority fails
    closed.
12. Standard `drizzle-kit generate`/`drizzle-kit migrate` own checked-in SQL and
    applied history; no custom migration runner, manifest, or OCC ledger exists.
13. Development, CI, and the production target use the latest stable PostgreSQL
    release, currently 18.6, unless an evidence-backed supported-version
    exception is documented and tested across all environments.

## Observability and operations

Expose bounded metrics without resource names, actor IDs, idempotency keys,
credentials, or error details:

- Queue depth by state and derived resource kind.
- Oldest eligible work age and claim latency.
- Processing duration and attempt distribution.
- Retries by bounded error code and terminal failures.
- Stale-claim recoveries, heartbeat loss, and token-fence rejection.
- Dedupe conflicts and per-resource mutual-exclusion claim retries.
- Database pool saturation, transaction failures, and migration duration/version.

Structured logs include the stable nonsecret idempotency key, attempt, derived
resource kind, Installation ID, Namespace ID when applicable, runtime worker
identity, and claim outcome. They exclude admitted configuration, credentials,
authorization headers, prompts/messages, secret values, raw database URLs, and
unredacted exceptions; runtime worker identity is not persisted on work rows.

The future controller reports readiness only when it can safely scan, claim,
heartbeat, and finalize work. Graceful shutdown stops new claims, continues
heartbeating in-flight claims while draining, and lets lease expiry recover
ambiguous work instead of releasing it blindly.

## Risks and mitigations

1. **A lease is mistaken for exactly-once external execution.**
   Mitigation: define the queue as at-least-once, fence database finalization,
   and require stable effect identity plus Driver-specific ensure/observe proof
   in source Milestone 5.

2. **Schema and custom SQL drift.**
   Mitigation: scratch regeneration, checked-in Drizzle SQL/snapshots, clean
   replay, and `pg_catalog` assertions for every custom object.

3. **Application rollback is blocked by schema change.**
   Mitigation: expand/contract compatibility, application-first rollback,
   fix-forward schema repair, and rehearsed restore for destructive work.

4. **A second backend weakens PostgreSQL invariants.**
   Mitigation: keep PostgreSQL as the sole durable target; use memory only as a
   test implementation of the application port.

5. **Generic queue targets bypass ownership.**
   Mitigation: store explicit parent columns and initiating actor, reject a
   revision without its owning Agent, use composite FKs, derive resource kind
   and serialization from the owner tuple, and fail closed if the actor cannot
   be reauthorized.

6. **RLS becomes a conflicting authorization authority.**
   Mitigation: keep RLS disabled, use least-privilege server roles and tuple
   constraints, and preserve exact OAG/IAM authorization in the application.

7. **Restart silently loses the selected IAM authority.**
   Mitigation: hydrate persisted policy, project the loaded Installation ID,
   register and select the fixed server-owned native IAM Driver on every start,
   and fail closed before binding the listener.

## Deferred decisions

- Source Milestone 5 defines the final operation taxonomy, Driver effect
  context, reauthorization reload, controller concurrency, dedicated
  least-privilege controller database role, optional notification-based wake-up,
  and health contract. Source Milestone 3 persists the existing reconcile
  intent without adding those workflow steps.
- Source Milestone 6 defines candidate preparation and activation orchestration.
  Source Milestone 3 provides immutable revision and single-active database
  enforcement only.
- Queue retention and archival require a later policy that preserves durable
  idempotency receipts and audit evidence.
- A second durable database backend requires its own proposal, schema,
  migrations, enforcement analysis, and acceptance suite.

There are no open decisions blocking this implementation.

## References

- Implementation milestones
- [Authoritative platform design](../../../../../docs/design.md)
- [Initial OCC API milestone](../1.2-initial-occ-api.md)
- [Drizzle schema declaration](https://orm.drizzle.team/docs/sql-schema-declaration)
- [Drizzle indexes and constraints](https://orm.drizzle.team/docs/indexes-constraints)
- [Drizzle migration generation](https://orm.drizzle.team/docs/drizzle-kit-generate)
- [Drizzle migration application](https://orm.drizzle.team/docs/drizzle-kit-migrate)
- [Drizzle custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations)
- [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- [Kysely migrations](https://kysely.dev/docs/migrations)
- [Prisma development and production migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production)
- [Prisma unsupported database features](https://docs.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)
- [`node-pg-migrate` migration framework](https://salsita.github.io/node-pg-migrate/migrations/)
- [`node-postgres` transactions](https://node-postgres.com/features/transactions)
- [PostgreSQL versioning and supported releases](https://www.postgresql.org/support/versioning/)
- [PostgreSQL 18.6 release notes](https://www.postgresql.org/docs/release/18.6/)
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL indexes on expressions](https://www.postgresql.org/docs/current/indexes-expressional.html)
- [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- [PostgreSQL locking and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL triggers](https://www.postgresql.org/docs/current/sql-createtrigger.html)
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL role privileges and `GRANT`](https://www.postgresql.org/docs/current/sql-grant.html)
- [Testcontainers PostgreSQL module](https://node.testcontainers.org/modules/postgresql/)

