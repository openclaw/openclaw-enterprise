-- Associate a grant assertion with its installed provider credential and consume it once.
ALTER TABLE occ.request_credential_approvals
  ADD COLUMN expected_credential_identity text,
  ADD COLUMN assertion_replay_key text,
  ADD CONSTRAINT request_credential_approval_assertion_identity
    CHECK (expected_credential_identity IS NULL OR expected_credential_identity ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT request_credential_approval_assertion_replay
    CHECK (
      (consumed AND expected_credential_identity IS NOT NULL) = (assertion_replay_key IS NOT NULL)
      AND (assertion_replay_key IS NULL OR assertion_replay_key ~ '^[a-f0-9]{64}$')
    );
--> statement-breakpoint
CREATE UNIQUE INDEX request_credential_approvals_assertion_replay
  ON occ.request_credential_approvals(assertion_replay_key) WHERE assertion_replay_key IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE (assertion_replay_key, replay_until_at) ON occ.request_credential_approvals TO occ_app;
