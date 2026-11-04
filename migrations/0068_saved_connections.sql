-- The saved account records who consented and which template version they approved.
CREATE TABLE occ.saved_connections (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  owner_principal_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  revocation_requested_by text,
  revoked_at timestamptz,
  CONSTRAINT saved_connections_revocation_requested CHECK (revoked_at IS NULL OR revocation_requested_by IS NOT NULL),
  CONSTRAINT saved_connections_pkey PRIMARY KEY (namespace_id, credential_source_id),
  CONSTRAINT saved_connections_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT saved_connections_template_version FOREIGN KEY
    (connection_template_id, connection_template_version)
    REFERENCES occ.connection_template_versions(template_id, version)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX saved_connections_namespace_owner_idx
  ON occ.saved_connections (namespace_id, owner_principal_id);
--> statement-breakpoint
CREATE INDEX saved_connections_template_idx
  ON occ.saved_connections (connection_template_id, connection_template_version);
--> statement-breakpoint
-- OCC identifies a private browser attempt by the hash of its OAuth state.
CREATE TABLE occ.connection_sessions (
  state_hash text PRIMARY KEY,
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  private_state text NOT NULL,
  issuer_required boolean NOT NULL,
  session_id text NOT NULL,
  redirect_uri text NOT NULL,
  -- Keep an abandoned attempt eligible for cleanup if the person is removed.
  actor_id text NOT NULL,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT connection_sessions_state_hash_format CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connection_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT connection_sessions_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT connection_sessions_template_version FOREIGN KEY
    (connection_template_id, connection_template_version)
    REFERENCES occ.connection_template_versions(template_id, version)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX connection_sessions_expiry_idx ON occ.connection_sessions (expires_at);
--> statement-breakpoint
REVOKE ALL ON occ.saved_connections, occ.connection_sessions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.saved_connections TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.connection_sessions TO occ_app;
--> statement-breakpoint
CREATE INDEX saved_connections_revoking_idx ON occ.saved_connections (credential_source_id)
WHERE revocation_requested_by IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION occ.guard_saved_connection_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revocation_requested_by','revoked_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revocation_requested_by','revoked_at'])
     OR (OLD.revocation_requested_by IS NOT NULL AND NEW.revocation_requested_by IS DISTINCT FROM OLD.revocation_requested_by)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.revocation_requested_by IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only ordered connection revocation is allowed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER saved_connection_update_is_guarded BEFORE UPDATE ON occ.saved_connections
FOR EACH ROW EXECUTE FUNCTION occ.guard_saved_connection_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_saved_connection_update() FROM PUBLIC;
--> statement-breakpoint
GRANT UPDATE (revocation_requested_by, revoked_at) ON occ.saved_connections TO occ_app;
--> statement-breakpoint
-- Only the Token Service's opaque SecretDriver reference is stored in OCC.
CREATE TABLE occ.connection_token_custody (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  secret_ref jsonb NOT NULL,
  published_version text,
  next_refresh_at timestamptz,
  PRIMARY KEY (namespace_id, credential_source_id),
  CONSTRAINT connection_token_custody_source FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id,id) ON DELETE CASCADE ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX connection_token_refresh_due ON occ.connection_token_custody(next_refresh_at) WHERE next_refresh_at IS NOT NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (published_version, next_refresh_at) ON occ.connection_token_custody TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.check_connection_template_use_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.connection_templates
    WHERE id = NEW.connection_template_id AND (namespace_id IS NULL OR namespace_id = NEW.namespace_id)
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection template is outside the Namespace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_session_checks_template_scope BEFORE INSERT ON occ.connection_sessions
FOR EACH ROW EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
CREATE TRIGGER saved_connection_checks_template_scope BEFORE INSERT ON occ.saved_connections
FOR EACH ROW EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.check_connection_template_use_scope() FROM PUBLIC;
