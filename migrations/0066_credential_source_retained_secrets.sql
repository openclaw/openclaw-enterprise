-- A legacy Credential Gateway update commits each Secret it may send to the gateway, and the
-- attempt allowed to send it, before the gateway write. The gateway may hold any retained
-- Secret's value until an update's own commit after a gateway write removes them all, so a
-- retained Secret cannot be deleted and a refresh type cannot resend it. A later attempt only
-- adds to the set and takes the fence, so an earlier attempt stops before its gateway write.
CREATE TABLE occ.credential_source_retained_secrets (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  field text COLLATE "C" NOT NULL,
  secret_id text NOT NULL,
  CONSTRAINT credential_source_retained_secrets_pkey
    PRIMARY KEY (credential_source_id, field, secret_id),
  CONSTRAINT credential_source_retained_secrets_source_owner
    FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT credential_source_retained_secrets_field_owner
    FOREIGN KEY (credential_source_id, field)
    REFERENCES occ.credential_source_secrets(credential_source_id, field)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- A retained Secret cannot be deleted while the gateway may still hold its value.
  CONSTRAINT credential_source_retained_secrets_secret_owner
    FOREIGN KEY (namespace_id, secret_id)
    REFERENCES occ.secrets(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX credential_source_retained_secrets_secret_idx
ON occ.credential_source_retained_secrets (namespace_id, secret_id);
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  ADD COLUMN update_attempt_id text,
  ADD CONSTRAINT credential_sources_update_attempt_id_valid CHECK (
    update_attempt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
--> statement-breakpoint
REVOKE ALL ON occ.credential_source_retained_secrets FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.credential_source_retained_secrets TO occ_app;
--> statement-breakpoint
GRANT UPDATE (update_attempt_id) ON occ.credential_sources TO occ_app;
