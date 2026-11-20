ALTER TABLE occ.iam_restrictions
  DROP CONSTRAINT iam_restrictions_action_valid,
  ADD CONSTRAINT iam_restrictions_action_valid
    CHECK (action IN ('create','read','update','delete','deploy','operate','administer','read_logs','manage_policy','read_audit','read_audit_content'));
--> statement-breakpoint
CREATE TRIGGER audit_message_read_limits
BEFORE INSERT ON occ.audit_events FOR EACH ROW
WHEN (NEW.action = 'openclaw.audit.agent.message.read')
EXECUTE FUNCTION occ.guard_control_plane_audit_append();
