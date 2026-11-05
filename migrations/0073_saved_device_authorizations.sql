ALTER TABLE occ.credential_sources DROP CONSTRAINT credential_sources_owner_capability_valid,
  ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
    owner_capability = 'credential_gateway' OR
    (owner_capability = 'credential_proxy' AND egress IS NOT NULL) OR
    (owner_capability = 'credential_refresh' AND type IN ('oauth2-refresh-token','codex-oauth') AND egress IS NULL)
  );
--> statement-breakpoint
ALTER TABLE occ.saved_connections ADD COLUMN codex_account jsonb,
  ADD CONSTRAINT saved_connections_codex_account CHECK (codex_account IS NULL OR (
    jsonb_typeof(codex_account) = 'object' AND
    codex_account ?& ARRAY['accountId','planType'] AND
    jsonb_typeof(codex_account->'accountId') = 'string' AND btrim(codex_account->>'accountId') <> '' AND
    jsonb_typeof(codex_account->'planType') = 'string' AND btrim(codex_account->>'planType') <> '' AND
    codex_account - ARRAY['accountId','planType','userId','accountUserId','email','isFedramp'] = '{}'::jsonb
  ));
--> statement-breakpoint
CREATE TABLE occ.saved_device_sessions (
  id text PRIMARY KEY CHECK (id ~ '^cda_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL UNIQUE,
  actor_id text NOT NULL,
  browser_session_id text NOT NULL,
  origin text NOT NULL,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  device_authorization jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  next_poll_at timestamptz NOT NULL,
  phase text NOT NULL CHECK (phase IN ('pending','polling','ready','cancelled')),
  private_state text,
  CHECK ((phase = 'pending') = (private_state IS NOT NULL)),
  FOREIGN KEY (namespace_id, credential_source_id) REFERENCES occ.credential_sources(namespace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (connection_template_id, connection_template_version)
    REFERENCES occ.oauth_connection_template_versions(template_id,version) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX saved_device_sessions_expiry_idx ON occ.saved_device_sessions(expires_at);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE, UPDATE(phase,next_poll_at,private_state,expires_at) ON occ.saved_device_sessions TO occ_app;
