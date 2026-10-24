-- A deletion receipt reads the finalizer's committed result after Agent grants and work are gone.
CREATE INDEX audit_events_agent_deletion_completion_idx
  ON occ.audit_events (namespace_id, resource_id)
  WHERE action = 'openclaw.agents.lifecycle.delete' AND kind = 'mutation'
    AND resource_kind = 'agent' AND outcome = 'success' AND details->>'reasonCode' = 'AGENT_DELETED';
