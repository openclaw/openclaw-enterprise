-- Keep runtime activity within the shared audit storage limit.
CREATE TRIGGER runtime_audit_append_limits
BEFORE INSERT ON occ.audit_events FOR EACH ROW
WHEN (NEW.kind = 'runtime_activity')
EXECUTE FUNCTION occ.guard_control_plane_audit_append();
--> statement-breakpoint
CREATE INDEX audit_events_agent_runtime_page_idx ON occ.audit_events
  (namespace_id, resource_id, occurred_at DESC, id DESC)
  WHERE resource_kind = 'agent' AND kind = 'runtime_activity';
