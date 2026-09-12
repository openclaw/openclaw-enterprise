# Milestone 1.3: PostgreSQL Persistence: schema controller and triggers

[Spec overview](../1.3-postgresql-persistence.md). Original record; decisions and status are preserved.

### Controller work

```sql
CREATE TABLE occ.controller_work (
  idempotency_key text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text,
  revision_id text,
  actor_id text NOT NULL,

  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'claimed', 'succeeded', 'failed_permanent')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  claim_token uuid,
  lease_expires_at timestamptz,

  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  FOREIGN KEY (namespace_id)
    REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  CHECK (revision_id IS NULL OR agent_id IS NOT NULL),
  CHECK (
    (state = 'claimed'
      AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'claimed'
      AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'failed_permanent')
      AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed_permanent')
      AND completed_at IS NULL)
  )
);

CREATE INDEX controller_work_ready
  ON occ.controller_work (available_at, created_at, idempotency_key)
  WHERE state = 'queued';

CREATE INDEX controller_work_expired
  ON occ.controller_work (lease_expires_at, idempotency_key)
  WHERE state = 'claimed';

CREATE UNIQUE INDEX controller_work_one_claim_per_resource
  ON occ.controller_work ((COALESCE(agent_id, namespace_id)))
  WHERE state = 'claimed';
```

The owner tuple determines the exact resource: no Agent ID identifies Namespace
work; an Agent ID without a revision ID identifies Agent work; both IDs identify
AgentRevision work. A `revision_id` requires its owning Agent. The sole operation
is the existing `reconcile` action; the controller reloads the exact persisted
resource instead of accepting a serialized payload.

`COALESCE(agent_id, namespace_id)` derives processing mutual exclusion from the
stored owner tuple. Namespace lifecycle work excludes only other Namespace
lifecycle work for that same Namespace. Agent and AgentRevision work exclude
only work for the same parent Agent, preventing concurrent revision activation;
different Agents in one Namespace can run concurrently. Installation operations
are never queued. The partial unique expression index enforces at most one claim
per Namespace lifecycle or Agent resource. Revision creation and activation
still lock the exact Agent row, but enqueue requires no extra serialization-root
lock, strict FIFO, sibling scan, or ordering index. Eligible later work may
overtake delayed same-resource work once no sibling is currently claimed.

Namespace state coordinates lifecycle and Agent work independently of queue
serialization:

- **Provisioning:** At most one Namespace lifecycle operation is claimed per
  Namespace. It owns gateway provisioning; Agent deployment cannot begin while
  the Namespace is `provisioning` or its assigned gateway is not ready.
- **Ready operation:** A `ready` Namespace admits authorized Agent work. At most
  one operation runs per Agent; operations for different Agents in that Namespace
  can run concurrently.
- **Deletion:** A Namespace deletion transaction locks the Namespace row and
  changes its status to `deleting`, blocking new Agent mutations and new Agent
  work. Agent admission checks Namespace status in its own transaction using a
  Namespace row lock that conflicts with the deletion transition. Already
  accepted Agent operations drain before deletion continues; no database lock is
  held while those operations finish. Final removal additionally requires a
  later milestone's explicit dependent-resource teardown and retention policy,
  because the current `RESTRICT` foreign keys and immutable revision records do
  not permit unconditional physical deletion.

Source Milestone 3 persists Namespace status and proves queue claim exclusion.
Source Milestone 4 owns Namespace readiness and deletion behavior; source
Milestone 5 owns effectful processing and draining. These lifecycle checks do
not serialize every Agent operation through a Namespace-wide queue lock.

`idempotency_key` identifies both the work row and its semantic desired-state
effect; it never contains a claim token, attempt, or time. Enqueue uses
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, reads an existing row in
the same transaction, and rejects collisions with a different `namespace_id`,
`agent_id`, `revision_id`, or `actor_id`. Compare nullable owner IDs with
`IS DISTINCT FROM`. Enqueue never updates existing work.

`actor_id` stores the current `PlatformOperation.actorId`. Before Driver
dispatch, source Milestone 5 must resolve that initiating actor from persisted
IAM state and reauthorize the sole `reconcile` action against each exact
resource. A missing, disabled, or unauthorized actor fails closed with
attributable audit evidence. Queue deduplication must never replace the actor on
existing work.

The queue persists ownership, scheduling, claims, and restart-safe attempt
history. Retry limits belong to controller-wide configuration, not individual
rows. Resource mutations, audit evidence, and queued work commit together
without a queue-to-audit foreign key. Attributable audit events persist retry,
stale-lease, and terminal-failure details; work rows do not duplicate them.

Terminal work remains durable. A future retention policy may archive it only
while preserving its idempotency receipt; deleting successful work and its
unique key would permit old retries to execute again.

### Immutable and append-only triggers

```sql
CREATE FUNCTION occ.reject_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER agent_revisions_are_immutable
BEFORE UPDATE OR DELETE ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();

CREATE TRIGGER audit_events_are_append_only
BEFORE UPDATE OR DELETE ON occ.audit_events
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();

CREATE TRIGGER installation_identity_is_immutable
BEFORE UPDATE OF id ON occ.installation
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();

CREATE TRIGGER installation_cannot_be_deleted
BEFORE DELETE ON occ.installation
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();

CREATE TRIGGER namespace_owner_and_identity_are_immutable
BEFORE UPDATE OF id ON occ.namespaces
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();

CREATE TRIGGER agent_owner_and_identity_are_immutable
BEFORE UPDATE OF namespace_id, id, workload_identity_id ON occ.agents
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();

CREATE TRIGGER iam_identity_ownership_is_immutable
BEFORE UPDATE OF namespace_id, agent_id, id, kind
ON occ.iam_identities
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
```

Platform-resource and immutable-evidence foreign keys use `RESTRICT`, not
cascading deletes. Later milestones must implement resource deletion through
explicit state transitions and retention rules, not accidental cascades.

