-- One row per connected credential source: who consented, for which Agent, and the exact
-- connection template version they approved. A referenced version cannot be deleted.
CREATE TABLE occ.agent_connections (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  agent_id text NOT NULL,
  owner_principal_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_connections_pkey PRIMARY KEY (namespace_id, credential_source_id),
  CONSTRAINT agent_connections_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT agent_connections_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT agent_connections_template_version FOREIGN KEY
    (connection_template_id, connection_template_version)
    REFERENCES occ.connection_template_versions(template_id, version)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX agent_connections_agent_idx ON occ.agent_connections (namespace_id, agent_id);
--> statement-breakpoint
CREATE INDEX agent_connections_template_idx
  ON occ.agent_connections (connection_template_id, connection_template_version);
--> statement-breakpoint
CREATE TRIGGER agent_connection_is_immutable
BEFORE UPDATE ON occ.agent_connections
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- A pending browser authorization, found by the SHA-256 of its `state`. The private
-- session lives in a Namespace Secret; this row is consumed at most once.
CREATE TABLE occ.connection_sessions (
  state_hash text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  credential_source_id text NOT NULL,
  secret_id text NOT NULL,
  actor_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT connection_sessions_state_hash_format CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connection_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT connection_sessions_consumed_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT connection_sessions_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT connection_sessions_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT connection_sessions_template_version FOREIGN KEY
    (connection_template_id, connection_template_version)
    REFERENCES occ.connection_template_versions(template_id, version)
    ON DELETE CASCADE ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION occ.guard_connection_session_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF ROW(NEW.state_hash, NEW.namespace_id, NEW.agent_id, NEW.credential_source_id,
      NEW.secret_id, NEW.actor_id, NEW.connection_template_id,
      NEW.connection_template_version, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.state_hash, OLD.namespace_id, OLD.agent_id,
      OLD.credential_source_id, OLD.secret_id, OLD.actor_id, OLD.connection_template_id,
      OLD.connection_template_version, OLD.created_at, OLD.expires_at)
    OR OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a connection session is consumed once and otherwise immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_session_update_is_guarded
BEFORE UPDATE ON occ.connection_sessions
FOR EACH ROW EXECUTE FUNCTION occ.guard_connection_session_update();
--> statement-breakpoint
REVOKE ALL ON occ.agent_connections, occ.connection_sessions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.agent_connections TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.connection_sessions TO occ_app;
--> statement-breakpoint
GRANT UPDATE (consumed_at) ON occ.connection_sessions TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_connection_session_update() FROM PUBLIC;
