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
