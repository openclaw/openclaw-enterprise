-- Keep runtime activity within the shared audit storage limit.
CREATE TRIGGER runtime_audit_append_limits
BEFORE INSERT ON occ.audit_events FOR EACH ROW
WHEN (NEW.kind = 'runtime_activity')
EXECUTE FUNCTION occ.guard_control_plane_audit_append();
--> statement-breakpoint
CREATE INDEX audit_events_agent_runtime_page_idx ON occ.audit_events
  (namespace_id, resource_id, occurred_at DESC, id DESC)
  WHERE resource_kind = 'agent' AND kind = 'runtime_activity';
--> statement-breakpoint
CREATE INDEX audit_events_agent_lifecycle_page_idx ON occ.audit_events
  (namespace_id, resource_kind, resource_id, occurred_at DESC, id DESC)
  WHERE kind = 'mutation' AND (
    (resource_kind = 'agent' AND (
      (outcome = 'success' AND action IN (
        'openclaw.agents.create',
        'openclaw.agents.update',
        'openclaw.agents.stop',
        'openclaw.agents.lifecycle.stop',
        'openclaw.agents.provision.checkpoint'
      ))
      OR (outcome = 'failure' AND action = 'openclaw.agents.provision.failure')
    ))
    OR (resource_kind = 'agent_revision' AND outcome = 'success' AND action IN (
      'openclaw.agents.deploy',
      'openclaw.agents.lifecycle.activate',
      'openclaw.agents.lifecycle.supersede'
    ))
  );
--> statement-breakpoint
CREATE TABLE occ.gateway_runtime_audit_grants (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  runtime_source text NOT NULL CHECK (runtime_source IN ('openclaw', 'codex')),
  CONSTRAINT gateway_runtime_audit_grants_revision_unique UNIQUE (namespace_id, agent_id, revision_id),
  CONSTRAINT gateway_runtime_audit_grants_revision_owner FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER gateway_runtime_audit_grants_are_immutable
BEFORE UPDATE ON occ.gateway_runtime_audit_grants FOR EACH ROW
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.gateway_runtime_audit_grants FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.gateway_runtime_audit_grants TO occ_app;
--> statement-breakpoint
-- PostgreSQL requires UPDATE privilege on a column for the admission row lock.
-- The trigger above rejects every update. Revocation deletes the matching row.
GRANT UPDATE (runtime_source) ON occ.gateway_runtime_audit_grants TO occ_app;
