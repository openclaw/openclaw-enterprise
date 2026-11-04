-- One row per connected credential source: who consented and the exact
-- connection template version they approved. A referenced version cannot be deleted.
CREATE TABLE occ.agent_connections (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  -- Optional UI origin; deleting the Agent must not delete this account or consent session.
  agent_id text,
  owner_principal_id text NOT NULL REFERENCES occ.iam_identities(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_connections_pkey PRIMARY KEY (namespace_id, credential_source_id),
  CONSTRAINT agent_connections_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT agent_connections_template_version FOREIGN KEY
    (connection_template_id, connection_template_version)
    REFERENCES occ.connection_template_versions(template_id, version)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX agent_connections_namespace_owner_idx
  ON occ.agent_connections (namespace_id, owner_principal_id);
--> statement-breakpoint
CREATE INDEX agent_connections_template_idx
  ON occ.agent_connections (connection_template_id, connection_template_version);
--> statement-breakpoint
CREATE TRIGGER agent_connection_is_immutable
BEFORE UPDATE ON occ.agent_connections
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- A pending browser authorization, found by the SHA-256 of its `state`. The private
-- PKCE state belongs to OCC. Only the initiating login can consume the row.
CREATE TABLE occ.connection_sessions (
  state_hash text PRIMARY KEY,
  namespace_id text NOT NULL,
  -- Optional UI origin; deleting the Agent must not delete this account or consent session.
  agent_id text,
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
REVOKE ALL ON occ.agent_connections, occ.connection_sessions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.agent_connections TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.connection_sessions TO occ_app;
