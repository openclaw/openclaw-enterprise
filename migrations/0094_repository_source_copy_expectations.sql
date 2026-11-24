-- The Source version a replacement committed for each copy that was not retired at that moment,
-- stamped by TokenService in the transaction that commits the new value. The policy read compares
-- it with the version the target Sandbox confirmed, so an operator knows when the old token can
-- be revoked.
ALTER TABLE occ.repository_source_copies
  ADD COLUMN expected_source_version text CHECK (expected_source_version <> ''),
  ADD COLUMN expected_at timestamptz,
  ADD CONSTRAINT repository_source_copies_expected_check CHECK (
    (expected_source_version IS NULL) = (expected_at IS NULL));
--> statement-breakpoint
GRANT UPDATE(expected_source_version,expected_at) ON occ.repository_source_copies TO occ_app;
