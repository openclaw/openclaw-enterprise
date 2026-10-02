-- An update may point a credential source field at a replacement Secret; the field and owner stay fixed.
DROP TRIGGER credential_source_secrets_are_immutable ON occ.credential_source_secrets;
--> statement-breakpoint
CREATE TRIGGER credential_source_secrets_are_immutable
BEFORE UPDATE OF namespace_id, credential_source_id, field ON occ.credential_source_secrets
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
GRANT UPDATE (secret_id) ON occ.credential_source_secrets TO occ_app;
--> statement-breakpoint
-- A withdrawal revokes one credential source from one Agent revision. It is recorded before the
-- worker detaches the provider and becomes revoked only after the gateway confirms revocation.
CREATE TABLE occ.credential_withdrawals (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  credential_source_id text NOT NULL,
  state text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  -- The worker's most recent outcome code, so a withdrawal still pending can say why.
  last_reason text,
  last_attempt_at timestamptz,
  CONSTRAINT credential_withdrawals_pkey
    PRIMARY KEY (namespace_id, revision_id, credential_source_id),
  -- A withdrawal ends with its revision or source; it never blocks their deletion.
  CONSTRAINT credential_withdrawals_revision_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT credential_withdrawals_source_owner
    FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT credential_withdrawals_state_valid CHECK (state IN ('pending', 'revoked')),
  CONSTRAINT credential_withdrawals_completion
    CHECK ((state = 'revoked') = (completed_at IS NOT NULL)),
  CONSTRAINT credential_withdrawals_requested_by_valid CHECK (
    char_length(requested_by) BETWEEN 1 AND 256 AND requested_by = btrim(requested_by)
  ),
  CONSTRAINT credential_withdrawals_last_attempt CHECK (
    (last_reason IS NULL) = (last_attempt_at IS NULL)
    AND (last_reason IS NULL OR last_reason ~ '^[A-Z0-9_]{1,64}$')
  )
);
--> statement-breakpoint
CREATE INDEX credential_withdrawals_source_idx
ON occ.credential_withdrawals (namespace_id, credential_source_id);
--> statement-breakpoint
CREATE TRIGGER credential_withdrawal_identity_is_immutable
BEFORE UPDATE OF namespace_id, agent_id, revision_id, credential_source_id, requested_by, requested_at
ON occ.credential_withdrawals
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- Revocation is final: a revoked withdrawal never returns to pending.
CREATE TRIGGER credential_withdrawal_revocation_is_final
BEFORE UPDATE OF state, completed_at ON occ.credential_withdrawals
FOR EACH ROW WHEN (OLD.state = 'revoked')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.credential_withdrawals FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.credential_withdrawals TO occ_app;
--> statement-breakpoint
GRANT UPDATE (state, completed_at, last_reason, last_attempt_at)
ON occ.credential_withdrawals TO occ_app;
--> statement-breakpoint
-- A revision-scoped withdrawal work item carries out pending withdrawals for an active revision.
-- It is not a deployment: only revision work without an Agent target reconciles a revision.
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_agent_target_valid,
  ADD CONSTRAINT controller_work_agent_target_valid CHECK (
    agent_target IS NULL OR agent_target IN ('stopped', 'deleted', 'credentials_withdrawn')
  );
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NOT NULL
      AND namespace_target IN ('ready', 'deleted') AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NOT NULL
      AND agent_target IN ('stopped', 'deleted'))
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL
      AND (agent_target IS NULL OR agent_target = 'credentials_withdrawn'))
    OR (work_kind = 'provisioning' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL
      AND idempotency_key ~ '^agent_revision:rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:repository_cleanup:(retire:)?[0-9a-f]{64}$')
  );
