-- An issue attempt settles when no token from it can still be live. Its start bounds an
-- uncertain issue or revocation; a provider refusal with no token is terminal at once.
-- Existing attempts start at migration time, which is never earlier than their real start.
ALTER TABLE occ.prepared_github_attempts
  ADD COLUMN started_at timestamptz NOT NULL DEFAULT clock_timestamp();
--> statement-breakpoint
ALTER TABLE occ.prepared_github_attempts DROP CONSTRAINT prepared_github_attempts_custody_check;
--> statement-breakpoint
ALTER TABLE occ.prepared_github_attempts ADD CONSTRAINT prepared_github_attempts_custody_check
  CHECK (custody IN ('intent', 'current', 'retire', 'revoking', 'revoked', 'expired', 'unknown', 'not_issued'));
--> statement-breakpoint
ALTER TABLE occ.prepared_github_attempts ADD CONSTRAINT prepared_github_attempts_not_issued_check
  CHECK (custody <> 'not_issued' OR (state = 'quarantined' AND material_version IS NULL));
--> statement-breakpoint
-- The controller never writes it: only the insert default sets it. Tests move it to stand for
-- elapsed time. This adds no authority over settlement: the application role already inserts
-- attempts and sets their custody, including 'revoked'.
GRANT UPDATE (started_at) ON occ.prepared_github_attempts TO occ_app;
