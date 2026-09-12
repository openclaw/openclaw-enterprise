# Milestone 1.3: PostgreSQL Persistence: enforcement and transactions

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

## Enforcement behavior

### Ownership and lookup

Namespace and Agent parent tuples define integrity boundaries. Globally unique
child IDs prevent collisions but cannot establish authorization or ownership.
Repository methods accept the complete logical owner tuple, validate its
Installation against the database's sole loaded Installation, and include
Namespace and Agent identifiers in storage `WHERE` clauses. A wrong parent
returns not found; no global lookup is attempted.

The database and application own complementary enforcement:

| Invariant              | Database                                              | Application                                                                        |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Singleton Installation | Unique index on a constant allows one row.            | One-time bootstrap creates it; subsequent startup loads it.                        |
| Child ownership        | Composite FKs and immutable owner columns.            | Resolve parent first and use full-tuple repository APIs.                           |
| Scoped name uniqueness | Unique constraints with deterministic `C` collation.  | Preserve the current exact, case-sensitive name contract and map conflicts safely. |
| Revision immutability  | Reject all row updates/deletes on admitted table.     | Create a new revision for every admitted change.                                   |
| One active revision    | One nullable, owner-scoped Agent revision pointer.    | Lock Agent row and replace its active pointer in one transaction.                  |
| Audit append-only      | Trigger plus role grants.                             | Redact and allowlist before insert.                                                |
| Queue claim ownership  | State checks, partial unique index, token predicates. | Stop when heartbeat/finalization updates zero rows.                                |

### Revision activation transaction

Milestone 3 creates the immutable revision table and owner-scoped active
pointer; source Milestone 6 owns activation.
The activation transaction must:

1. `SELECT` the exact Agent tuple `FOR UPDATE`.
2. Verify the candidate revision tuple and current expected active revision.
3. Set `agents.active_revision_id` to the admitted candidate revision ID.
4. Append activation audit evidence.
5. Commit.

Any error rolls back the pointer change and audit. The Agent has only one
active-revision field, and its scoped foreign key rejects a candidate from a
different Agent or Namespace. Revision creation also locks the exact Agent row
before assigning its next revision number. Driver and network calls cannot
execute while the Agent row is locked.

### RLS and database roles

Tenant row-level security remains disabled in Milestone 3. OCC and the future
controller are server-side, cross-Namespace authorities that use pooled
connections. OAG admission and the selected IAM authority own authorization;
caller-controlled session variables do not. Namespace state carried across pool
connections risks stale context, table owners and `BYPASSRLS` roles can bypass
policies, and PostgreSQL referential-integrity checks bypass RLS. Composite
constraints and full-tuple repositories provide database containment without
creating a second authorization authority.

Two separate roles define initial database authority:

- `occ_migrator`: restricted login role used only by `drizzle-kit migrate`; it
  owns the `occ` and `drizzle` schemas, their objects, and migration history. No
  application uses it, and standard Drizzle CLI execution needs no role wrapper.
- `occ_app`: reads platform/IAM state; inserts authorized bootstrap, resource,
  IAM, audit, and work rows; updates only the active Agent pointer and mutable
  queue lifecycle columns required by the non-effectful harness. It cannot
  update/delete revisions or audit events.

A distinct least-privilege controller role is deferred to source Milestone 5,
when an effectful controller and its actual authority boundary exist.

A database administrator provisions the dedicated database, roles, and schema
ownership once. Deployment secrets supply credentials; migrations never embed
them:

```sql
CREATE ROLE occ_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE occ_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CREATE ON DATABASE openclaw_enterprise TO occ_migrator;
CREATE SCHEMA IF NOT EXISTS occ AUTHORIZATION occ_migrator;
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION occ_migrator;
```

Drizzle issues `CREATE SCHEMA IF NOT EXISTS` for its migration-history schema on
each run. PostgreSQL checks database-level `CREATE` even when that schema
already exists, so `occ_migrator` receives `CREATE` on this one database, not
the role-level `CREATEDB` privilege; `occ_app` receives neither privilege.

A checked-in custom migration applies the application privilege boundary as
`occ_migrator`:

```sql
REVOKE ALL ON SCHEMA occ FROM PUBLIC;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, occ_app;
REVOKE ALL ON ALL TABLES IN SCHEMA occ FROM PUBLIC, occ_app;
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, occ_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA occ FROM PUBLIC, occ_app;

ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator IN SCHEMA occ
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator IN SCHEMA drizzle
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE occ_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA occ TO occ_app;
GRANT SELECT ON
  occ.installation,
  occ.namespaces,
  occ.agents,
  occ.agent_revisions,
  occ.iam_identities,
  occ.iam_roles,
  occ.iam_access_bindings,
  occ.audit_events,
  occ.controller_work
TO occ_app;

GRANT INSERT ON
  occ.installation,
  occ.namespaces,
  occ.agents,
  occ.agent_revisions,
  occ.audit_events,
  occ.controller_work
TO occ_app;

GRANT INSERT ON
  occ.iam_identities,
  occ.iam_roles,
  occ.iam_access_bindings
TO occ_app;

GRANT UPDATE (active_revision_id) ON occ.agents TO occ_app;
GRANT UPDATE (
  state,
  available_at,
  attempt_count,
  claim_token,
  lease_expires_at,
  completed_at,
  updated_at
) ON occ.controller_work TO occ_app;
```

Only administrators execute the first block. Unmodified `drizzle-kit migrate`
executes the second as `occ_migrator`. Drizzle creates and manages
`drizzle.__drizzle_migrations`; application roles receive neither schema usage
nor table grants for that history. Tables added by later migrations remain
inaccessible until reviewed grants expose them. Source Milestone 4 may add
reviewed IAM update/delete grants if accepted policy-management APIs require
them.

`occ_app` owns platform policy. It requires IAM `INSERT` to seed the initial
administrator during authorized one-time bootstrap and create an Agent's
workload identity within its resource transaction. Source Milestone 3 exposes
no IAM policy-management endpoint: role, permission, and binding inserts occur
only during bootstrap, and subsequent identity insertion must belong to an
authorized Agent mutation. Route/repository tests enforce these paths. The
non-effectful queue harness uses the same application role and may update only
the explicitly granted queue lifecycle columns; it cannot change an owner or
initiating actor.

Migration integration tests attempt forbidden operations under each application
role and also assert the PostgreSQL privilege catalog:

```sql
SELECT
  NOT has_schema_privilege('occ_app', 'occ', 'CREATE')
    AS app_cannot_create_schema_objects,
  NOT has_schema_privilege('occ_app', 'drizzle', 'USAGE')
    AS app_cannot_read_drizzle_history,
  has_column_privilege('occ_app', 'occ.controller_work', 'state', 'UPDATE')
    AS harness_can_claim_work,
  NOT has_column_privilege('occ_app', 'occ.controller_work', 'namespace_id', 'UPDATE')
    AS app_cannot_retarget_work,
  NOT has_column_privilege('occ_app', 'occ.controller_work', 'actor_id', 'UPDATE')
    AS app_cannot_change_initiating_actor,
  has_column_privilege('occ_app', 'occ.agents', 'active_revision_id', 'UPDATE')
    AS app_can_update_active_revision,
  NOT has_table_privilege('occ_app', 'occ.agent_revisions', 'UPDATE, DELETE')
    AS app_cannot_change_admitted_revisions,
  NOT has_table_privilege('occ_app', 'occ.audit_events', 'UPDATE, DELETE')
    AS app_cannot_change_audit_evidence,
  NOT has_table_privilege('occ_app', 'occ.iam_identities', 'UPDATE, DELETE')
    AS app_cannot_modify_bootstrapped_iam_identities,
  NOT has_table_privilege('occ_app', 'occ.iam_roles', 'UPDATE, DELETE')
    AS app_cannot_modify_bootstrapped_iam_roles,
  NOT pg_has_role('occ_app', 'occ_migrator', 'MEMBER')
    AS app_cannot_escalate_to_migrator;
```

Every assertion must return true. Inspect `pg_roles` to reject `rolsuper`,
`rolcreaterole`, `rolcreatedb`, and `rolbypassrls` on both roles. The
database is private; tenants never connect directly. Enable RLS only after a
separate review establishes authoritative session identity and safe
connection-pool behavior.

## Atomic transaction boundaries

### Successful API mutation

1. Admit the caller, resolve exact scope, and authorize before side effects.
2. Begin one PostgreSQL transaction at `READ COMMITTED`.
3. Verify the exact Namespace and its status before accepting Agent work; later
   Namespace deletion takes a conflicting Namespace row lock. Lock and
   revalidate the exact Agent row for revision creation or activation, acquiring
   Namespace locks before Agent locks when both are needed.
4. Persist the resource mutation.
5. Append its success audit event.
6. Insert or verify the controller work row by semantic idempotency key.
7. Commit.

If any step fails, the resource, success audit, and work remain invisible.
Denied requests create neither resources nor work; the required attributable
denial audit uses a separate, short, fail-closed transaction because no
successful mutation exists to commit. An unauthenticated admission failure has
no attributable actor and performs no database write. The success audit and
work row require no foreign-key relationship: their shared transaction
guarantees atomicity.

### Queue work

Claims, heartbeats, stale recovery, and finalization each use short, independent
transactions. Database transactions and row locks must never span Driver,
Kubernetes, network, or filesystem calls.

The future effectful worker must claim + commit, reload the exact persisted
resource and initiating actor, reauthorize `reconcile`, perform one idempotent
effect, then finalize + audit + commit. This milestone implements the storage
contract and validates it with a non-effectful harness.

