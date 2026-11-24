CREATE TRIGGER http_chat_audit_limits
BEFORE INSERT ON occ.audit_events FOR EACH ROW
WHEN (NEW.action IN (
  'openclaw.api.request.received',
  'openclaw.agents.chat.admitted',
  'openclaw.agents.chat.completed',
  'openclaw.agents.chat.failed',
  'openclaw.agents.chat.interrupted'
))
EXECUTE FUNCTION occ.guard_control_plane_audit_append();
