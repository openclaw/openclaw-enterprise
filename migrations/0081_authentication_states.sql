DROP TABLE occ.connection_sessions;
--> statement-breakpoint
CREATE TABLE occ.authentication_states (
  id text PRIMARY KEY,
  namespace_id text NOT NULL,
  credential_source_id text,
  pkce_verifier text,
  selected_scopes text[],
  issuer_required boolean,
  session_id text,
  redirect_uri text,
  actor_id text NOT NULL,
  connection_template_id text,
  connection_template_version integer,
  created_at timestamptz,
  expires_at timestamptz NOT NULL,
  kind text NOT NULL,
  agent_id text,
  harness_id text,
  credential_gateway_id text,
  credential_refresh_id text,
  device_source_id text,
  encrypted_challenge text,
  interval_seconds integer,
  phase text,
  next_poll_at timestamptz,
  private_state text,
  version integer,
  CONSTRAINT authentication_states_selected_scopes_valid CHECK (array_position(selected_scopes,NULL) IS NULL),
  CONSTRAINT authentication_states_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT authentication_states_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT authentication_states_template_version FOREIGN KEY (connection_template_id, connection_template_version)
    REFERENCES occ.oauth_connection_template_versions(template_id, version) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT authentication_states_namespace FOREIGN KEY (namespace_id)
    REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  CONSTRAINT authentication_states_kind CHECK (kind IN ('oauth_connection', 'device_authorization')),
  CONSTRAINT authentication_states_oauth_shape CHECK (kind <> 'oauth_connection' OR (
    id ~ '^[0-9a-f]{64}$' AND credential_source_id IS NOT NULL AND pkce_verifier IS NOT NULL
    AND selected_scopes IS NOT NULL AND issuer_required IS NOT NULL AND session_id IS NOT NULL
    AND redirect_uri IS NOT NULL AND connection_template_id IS NOT NULL
    AND connection_template_version IS NOT NULL AND created_at IS NOT NULL
    AND agent_id IS NULL AND harness_id IS NULL AND credential_gateway_id IS NULL
    AND credential_refresh_id IS NULL AND device_source_id IS NULL AND encrypted_challenge IS NULL
    AND interval_seconds IS NULL AND phase IS NULL AND next_poll_at IS NULL AND private_state IS NULL
    AND version IS NULL
  )),
  CONSTRAINT authentication_states_device_shape CHECK (kind <> 'device_authorization' OR (
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
  ))
);
--> statement-breakpoint
CREATE INDEX authentication_states_oauth_expiry ON occ.authentication_states (expires_at, id)
  WHERE kind = 'oauth_connection';
--> statement-breakpoint
CREATE INDEX authentication_states_device_expiry ON occ.authentication_states (expires_at, id)
  WHERE kind = 'device_authorization' AND phase <> 'cancelled';
--> statement-breakpoint
CREATE TRIGGER authentication_states_check_template_scope BEFORE INSERT ON occ.authentication_states
  FOR EACH ROW WHEN (NEW.kind = 'oauth_connection') EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
CREATE FUNCTION occ.guard_authentication_state_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'OAuth connection authentication state is immutable' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE TRIGGER authentication_states_update_is_guarded BEFORE UPDATE ON occ.authentication_states
  FOR EACH ROW WHEN (OLD.kind <> 'device_authorization') EXECUTE FUNCTION occ.guard_authentication_state_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_authentication_state_update() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON occ.authentication_states FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.authentication_states TO occ_app;
--> statement-breakpoint
GRANT UPDATE (phase, expires_at, next_poll_at, private_state, encrypted_challenge, version)
  ON occ.authentication_states TO occ_app;
