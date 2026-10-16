-- An update records the Secret it is about to send to the Credential Gateway, committed before
-- the gateway write. Until the update's own commit replaces secret_id and clears the mark, the
-- gateway may hold this Secret's value, so it cannot be deleted and a refresh type cannot resend it.
ALTER TABLE occ.credential_source_secrets
  ADD COLUMN pending_secret_id text,
  ADD CONSTRAINT credential_source_secrets_pending_secret_owner
    FOREIGN KEY (namespace_id, pending_secret_id)
    REFERENCES occ.secrets(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX credential_source_secrets_pending_secret_idx
ON occ.credential_source_secrets (namespace_id, pending_secret_id);
--> statement-breakpoint
GRANT UPDATE (pending_secret_id) ON occ.credential_source_secrets TO occ_app;
