-- The append-only possible-use ledger records each exchange before authorization returns.
-- The separate one-draft allowance retains its original receipt and any unknown outcome.
ALTER TABLE occ.prepared_repository_git_uses
  DROP CONSTRAINT prepared_repository_git_uses_operation_check,
  ADD CONSTRAINT prepared_repository_git_uses_operation_check CHECK (operation IN
    ('advertise-upload-pack','upload-pack','advertise-receive-pack','receive-pack','create-draft-pull'))
    NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.prepared_repository_git_uses VALIDATE CONSTRAINT prepared_repository_git_uses_operation_check;
