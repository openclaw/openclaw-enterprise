CREATE INDEX audit_events_agent_http_chat_page_idx ON occ.audit_events
  (namespace_id, resource_id, occurred_at DESC, id DESC)
  WHERE resource_kind = 'agent' AND kind = 'mutation' AND action IN (
    'openclaw.agents.chat.admitted', 'openclaw.agents.chat.completed',
    'openclaw.agents.chat.failed', 'openclaw.agents.chat.interrupted'
  );
