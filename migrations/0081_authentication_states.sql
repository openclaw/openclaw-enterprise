ALTER TABLE occ.connection_sessions RENAME TO authentication_states;
--> statement-breakpoint
ALTER TABLE occ.authentication_states RENAME COLUMN state_hash TO id;
--> statement-breakpoint
ALTER TABLE occ.authentication_states RENAME CONSTRAINT connection_sessions_pkey TO authentication_states_pkey;
--> statement-breakpoint
ALTER TABLE occ.authentication_states
  ADD COLUMN kind text NOT NULL DEFAULT 'oauth_connection',
  ALTER COLUMN credential_source_id DROP NOT NULL,
  ALTER COLUMN pkce_verifier DROP NOT NULL,
  ALTER COLUMN selected_scopes DROP NOT NULL,
  ALTER COLUMN issuer_required DROP NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL,
  ALTER COLUMN redirect_uri DROP NOT NULL,
  ALTER COLUMN connection_template_id DROP NOT NULL,
  ALTER COLUMN connection_template_version DROP NOT NULL,
  ALTER COLUMN created_at DROP NOT NULL,
  ADD COLUMN agent_id text,
  ADD COLUMN harness_id text,
  ADD COLUMN credential_gateway_id text,
  ADD COLUMN credential_refresh_id text,
  ADD COLUMN device_source_id text,
  ADD COLUMN encrypted_challenge text,
  ADD COLUMN interval_seconds integer,
  ADD COLUMN phase text,
  ADD COLUMN next_poll_at timestamptz,
  ADD COLUMN private_state text,
  ADD COLUMN version integer,
  DROP CONSTRAINT connection_sessions_state_hash_format,
  ADD CONSTRAINT authentication_states_namespace FOREIGN KEY (namespace_id)
    REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT authentication_states_kind CHECK (kind IN ('oauth_connection', 'device_authorization')),
  ADD CONSTRAINT authentication_states_oauth_shape CHECK (kind <> 'oauth_connection' OR (
    id ~ '^[0-9a-f]{64}$' AND credential_source_id IS NOT NULL AND pkce_verifier IS NOT NULL
    AND selected_scopes IS NOT NULL AND issuer_required IS NOT NULL AND session_id IS NOT NULL
    AND redirect_uri IS NOT NULL AND connection_template_id IS NOT NULL
    AND connection_template_version IS NOT NULL AND created_at IS NOT NULL
    AND agent_id IS NULL AND harness_id IS NULL AND credential_gateway_id IS NULL
    AND credential_refresh_id IS NULL AND device_source_id IS NULL AND encrypted_challenge IS NULL
    AND interval_seconds IS NULL AND phase IS NULL AND next_poll_at IS NULL AND private_state IS NULL
    AND version IS NULL
  )),
  ADD CONSTRAINT authentication_states_device_shape CHECK (kind <> 'device_authorization' OR (
    id ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND credential_source_id IS NULL AND pkce_verifier IS NULL AND selected_scopes IS NULL
    AND issuer_required IS NULL AND session_id IS NULL AND redirect_uri IS NULL
    AND connection_template_id IS NULL AND connection_template_version IS NULL AND created_at IS NULL
    AND harness_id IS NOT NULL AND credential_gateway_id IS NOT NULL AND credential_refresh_id IS NOT NULL
    AND device_source_id IS NOT NULL AND interval_seconds IS NOT NULL AND interval_seconds > 0
    AND phase IS NOT NULL AND phase IN ('pending', 'polling', 'cancelled', 'ready')
    AND next_poll_at IS NOT NULL AND version IS NOT NULL AND version > 0
    AND ((phase IN ('pending', 'polling')) = (private_state IS NOT NULL))
    AND ((phase <> 'cancelled') = (encrypted_challenge IS NOT NULL))
  ));
--> statement-breakpoint
ALTER TABLE occ.authentication_states ALTER COLUMN kind DROP DEFAULT;
--> statement-breakpoint
DROP INDEX occ.connection_sessions_expiry_idx;
--> statement-breakpoint
CREATE INDEX authentication_states_oauth_expiry ON occ.authentication_states (expires_at, id)
  WHERE kind = 'oauth_connection';
--> statement-breakpoint
CREATE INDEX authentication_states_device_expiry ON occ.authentication_states (expires_at, id)
  WHERE kind = 'device_authorization' AND phase <> 'cancelled';
--> statement-breakpoint
DROP TRIGGER connection_session_checks_template_scope ON occ.authentication_states;
--> statement-breakpoint
CREATE TRIGGER connection_session_checks_template_scope BEFORE INSERT ON occ.authentication_states
  FOR EACH ROW WHEN (NEW.kind = 'oauth_connection') EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
CREATE FUNCTION occ.guard_authentication_state_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'OAuth connection authentication state is immutable' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE TRIGGER authentication_state_update_is_guarded BEFORE UPDATE ON occ.authentication_states
  FOR EACH ROW WHEN (OLD.kind <> 'device_authorization') EXECUTE FUNCTION occ.guard_authentication_state_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_authentication_state_update() FROM PUBLIC;
--> statement-breakpoint
GRANT UPDATE (phase, expires_at, next_poll_at, private_state, encrypted_challenge, version)
  ON occ.authentication_states TO occ_app;
