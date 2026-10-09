-- The worker rechecks agent:operate for a withdrawal's requested_by. A replay that queues a new
-- attempt makes its caller the requester of a pending withdrawal, so a requester who lost
-- agent:operate cannot leave the source attached until a redeploy. The requester is final once
-- the withdrawal is revoked; the other identity columns never change.
DROP TRIGGER credential_withdrawal_identity_is_immutable ON occ.credential_withdrawals;
--> statement-breakpoint
CREATE TRIGGER credential_withdrawal_identity_is_immutable
BEFORE UPDATE OF namespace_id, agent_id, revision_id, credential_source_id, requested_at
ON occ.credential_withdrawals
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
DROP TRIGGER credential_withdrawal_revocation_is_final ON occ.credential_withdrawals;
--> statement-breakpoint
CREATE TRIGGER credential_withdrawal_revocation_is_final
BEFORE UPDATE OF state, completed_at, requested_by ON occ.credential_withdrawals
FOR EACH ROW WHEN (OLD.state = 'revoked')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
GRANT UPDATE (requested_by) ON occ.credential_withdrawals TO occ_app;
