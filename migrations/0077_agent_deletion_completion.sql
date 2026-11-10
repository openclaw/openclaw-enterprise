-- Deletion status reads the finalizer's committed AGENT_DELETED event after Agent grants and work are gone.
CREATE INDEX audit_events_agent_deletion_completion_idx
  ON occ.audit_events (namespace_id, resource_id)
  WHERE action = 'openclaw.agents.lifecycle.delete' AND kind = 'mutation'
    AND resource_kind = 'agent' AND outcome = 'success' AND details->>'reasonCode' = 'AGENT_DELETED';
--> statement-breakpoint
-- Written by the worker in the transaction that rechecked the actor's delete grant and finalized
-- the deletion. A completion without a row (finalized before 0077 or by an older controller)
-- never shows its actor `deleted` through the actor fallback.
CREATE TABLE occ.agent_deletion_rechecks (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  actor_id text NOT NULL,
  rechecked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_deletion_rechecks_pkey PRIMARY KEY (namespace_id, agent_id)
);
--> statement-breakpoint
REVOKE ALL ON occ.agent_deletion_rechecks FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.agent_deletion_rechecks TO occ_app;
