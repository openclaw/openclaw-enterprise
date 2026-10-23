CREATE TABLE occ.native_browser_intents (
  id uuid PRIMARY KEY,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  parent_session_id text NOT NULL REFERENCES occ.human_authentication_sessions(session_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  principal_id text NOT NULL REFERENCES occ.iam_identities(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 512 AND origin ~ '^https://[^/]+$'),
  challenge_hash text CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
  exchange_hash text UNIQUE CHECK (exchange_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT native_browser_intent_revision FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT native_browser_intent_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 seconds'),
  CONSTRAINT native_browser_intent_exchange CHECK (exchange_hash IS NULL OR challenge_hash IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX native_browser_intent_parent ON occ.native_browser_intents(parent_session_id);
--> statement-breakpoint
CREATE INDEX native_browser_intent_expiry ON occ.native_browser_intents(installation_id, expires_at);
--> statement-breakpoint
CREATE TABLE occ.native_browser_handles (
  handle_hash text PRIMARY KEY CHECK (handle_hash ~ '^[a-f0-9]{64}$'),
  installation_id text NOT NULL REFERENCES occ.installation(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  parent_session_id text NOT NULL REFERENCES occ.human_authentication_sessions(session_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  principal_id text NOT NULL REFERENCES occ.iam_identities(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 512 AND origin ~ '^https://[^/]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT native_browser_handle_revision FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT native_browser_handle_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours')
);
--> statement-breakpoint
CREATE INDEX native_browser_handle_parent ON occ.native_browser_handles(parent_session_id);
--> statement-breakpoint
CREATE INDEX native_browser_handle_expiry ON occ.native_browser_handles(installation_id, expires_at);
--> statement-breakpoint
REVOKE ALL ON occ.native_browser_intents, occ.native_browser_handles FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.native_browser_intents, occ.native_browser_handles TO occ_app;
--> statement-breakpoint
GRANT UPDATE (challenge_hash, exchange_hash) ON occ.native_browser_intents TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.guard_native_browser_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM occ.human_authentication_sessions b
    JOIN occ.human_authentication_accounts a ON a.user_id = b.user_id
    JOIN occ.session s ON s.id = b.session_id AND s.user_id = b.user_id
    WHERE b.session_id = NEW.parent_session_id
      AND a.installation_id = NEW.installation_id AND a.principal_id = NEW.principal_id
      AND NEW.expires_at <= s.expires_at
  ) THEN
    RAISE EXCEPTION 'Native browser access must remain within its parent session';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_native_browser_intent_parent BEFORE INSERT ON occ.native_browser_intents
FOR EACH ROW EXECUTE FUNCTION occ.guard_native_browser_parent();
--> statement-breakpoint
CREATE TRIGGER guard_native_browser_handle_parent BEFORE INSERT ON occ.native_browser_handles
FOR EACH ROW EXECUTE FUNCTION occ.guard_native_browser_parent();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_native_browser_parent() FROM PUBLIC, occ_app;
