# Milestone 1.3: PostgreSQL Persistence: schema resources and iam

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

### Core resources and revision state

```sql
CREATE SCHEMA IF NOT EXISTS occ;

CREATE TABLE occ.installation (
  id text PRIMARY KEY
    CHECK (id ~ '^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  name text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (char_length(name) BETWEEN 1 AND 200),
  CHECK (name = btrim(name) AND name !~ '[[:cntrl:]]')
);

CREATE UNIQUE INDEX installation_one_row ON occ.installation ((true));

CREATE TABLE occ.namespaces (
  id text PRIMARY KEY,
  name text COLLATE "C" NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
  created_at timestamptz NOT NULL,
  CHECK (id ~ '^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (char_length(name) BETWEEN 1 AND 200),
  CHECK (name = btrim(name) AND name !~ '[[:cntrl:]]')
);

CREATE TABLE occ.agents (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C" NOT NULL,
  workload_identity_id text NOT NULL,
  active_revision_id text,
  created_at timestamptz NOT NULL,
  UNIQUE (namespace_id, id),
  UNIQUE (namespace_id, name),
  UNIQUE (namespace_id, id, workload_identity_id),
  CHECK (id ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (char_length(name) BETWEEN 1 AND 200),
  CHECK (name = btrim(name) AND name !~ '[[:cntrl:]]')
);

CREATE TABLE occ.agent_revisions (
  id text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_number bigint NOT NULL CHECK (revision_number > 0),
  admitted_spec jsonb NOT NULL CHECK (jsonb_typeof(admitted_spec) = 'object'),
  admitted_at timestamptz NOT NULL,
  UNIQUE (namespace_id, agent_id, id),
  UNIQUE (namespace_id, agent_id, revision_number),
  FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

ALTER TABLE occ.agents
  ADD CONSTRAINT agent_active_revision_owner
  FOREIGN KEY (namespace_id, id, active_revision_id)
  REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
```

The Installation remains a stable logical and API resource; its database is the
physical ownership boundary. A unique index on the constant `true` rejects a
second Installation row without a `singleton_key` column or concurrent-bootstrap
handling. Repository adapters read the sole `occ.installation` row and project
its `id` into existing domain and API contracts instead of storing it on every
resource. Resource IDs are globally unique. Composite Namespace/Agent foreign
keys prevent attaching a resource to an Agent in another Namespace.

The Agent API reads `activeRevisionId` directly from `agents.active_revision_id`,
matching the existing Agent contract. One nullable field makes multiple active
revisions structurally impossible, and its composite foreign key rejects a
revision belonging to another Agent or Namespace. The pointer starts `NULL`
and can be set after an admitted revision is inserted, so this relationship
needs no deferred cycle. `agent_revisions.admitted_spec` remains the immutable
source of revision configuration. Revisions inherit their owning Agent's
workload identity; attributable audit evidence identifies the initiating actor.

### Native IAM and audit

Milestone 3 persists the existing Principal, Role, Permission, and AccessBinding
shapes so development authorization survives restart. Source Milestone 4 owns
complete native IAM semantics, Restrictions, groups, readiness, and
cross-Namespace behavioral proof.

```sql
CREATE TABLE occ.iam_identities (
  id text PRIMARY KEY,
  namespace_id text,
  agent_id text,
  kind text NOT NULL CHECK (kind IN ('principal', 'service_principal', 'workload_identity')),
  issuer text,
  subject text,
  UNIQUE NULLS NOT DISTINCT (namespace_id, agent_id, id),
  FOREIGN KEY (namespace_id) REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (kind = 'principal'
      AND namespace_id IS NULL AND agent_id IS NULL
      AND issuer IS NOT NULL AND subject IS NOT NULL)
    OR (kind = 'service_principal'
      AND agent_id IS NULL AND issuer IS NULL AND subject IS NULL)
    OR (kind = 'workload_identity'
      AND namespace_id IS NOT NULL AND agent_id IS NOT NULL
      AND issuer IS NULL AND subject IS NULL)
  )
);

CREATE UNIQUE INDEX iam_principal_external_subject
  ON occ.iam_identities (issuer, subject)
  WHERE kind = 'principal';

CREATE UNIQUE INDEX iam_one_workload_identity_per_agent
  ON occ.iam_identities (namespace_id, agent_id)
  WHERE kind = 'workload_identity';

ALTER TABLE occ.agents
  ADD CONSTRAINT agent_workload_identity_owner
  FOREIGN KEY (namespace_id, id, workload_identity_id)
  REFERENCES occ.iam_identities(namespace_id, agent_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE occ.iam_roles (
  id text PRIMARY KEY,
  namespace_id text,
  name text COLLATE "C",
  permissions jsonb NOT NULL
    CHECK (jsonb_typeof(permissions) = 'array'),
  FOREIGN KEY (namespace_id) REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE occ.iam_access_bindings (
  id text PRIMARY KEY,
  namespace_id text,
  subject_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  role_id text NOT NULL REFERENCES occ.iam_roles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  resource_kind text,
  resource_id text,
  FOREIGN KEY (namespace_id) REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((resource_kind IS NULL) = (resource_id IS NULL))
);

CREATE TABLE occ.audit_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  namespace_id text,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  details jsonb CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  CHECK (id ~ '^aud_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
```

Each Agent and its workload identity are created in one transaction. Two
deferred foreign keys enforce exact ownership at commit: the Agent's non-null
`workload_identity_id` must identify a `workload_identity` whose `agent_id`
identifies that Agent, and the identity must reference the same Namespace/Agent
owner tuple. A partial unique index permits one workload identity per Agent.
Neither row can commit alone, identities cannot be shared, and an identity owned
by another Agent in the same Namespace cannot satisfy the constraint.

Each role stores its current contract's `Permission[]` directly in
`iam_roles.permissions`; hydration validates the JSON array and constructs the
existing `Role.permissions` without a join or a separate permissions table.
Role-name uniqueness and policy-administration indexes remain deferred until
their corresponding APIs exist.

Audit stores Namespace and resource IDs as immutable historical snapshots, not
foreign keys to deletable resources. The adapter attaches the sole Installation's
stable ID when constructing audit domain objects or exporting attributable
evidence; audit rows contain no Installation column or foreign key. The `kind`
column preserves the existing nonoptional `AuditEvent.kind` contract and
distinguishes bootstrap, mutation, and authorization-denial events. Because
database constraints cannot detect every secret inside JSON, the existing audit
factory owns allowlisting and redaction before insert. Any optional request,
source, admission, authorization, reason, or other redacted metadata belongs
only in the optional `details` object, not dedicated schema columns.

Before source Milestone 4, binding repositories must verify that the subject,
role, binding, and exact resource agree on the binding's optional Namespace.
Installation-wide principals and roles may participate only when their allowed
scope covers that Namespace; Namespace-scoped identities, roles, and target
resources must belong to it. Milestone 4 may strengthen these constraints after
implementing its final scope model.

