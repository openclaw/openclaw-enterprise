-- RFC-0019 `occ login`: a device authorization the person approves in the console, and the
-- CLI session it yields. Only SHA-256 hashes of the device code, user code and session token
-- are stored. A CLI session is a child of the approving browser session: deleting that
-- session (sign-out, expiry purge, account disable or revoke, method detach) deletes it.
CREATE TABLE occ.cli_device_authorizations (
  id text PRIMARY KEY CONSTRAINT cli_device_authorization_id CHECK (id ~ '^cda_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  device_code_hash text NOT NULL UNIQUE CONSTRAINT cli_device_authorization_device_code_hash CHECK (device_code_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text NOT NULL UNIQUE CONSTRAINT cli_device_authorization_user_code_hash CHECK (user_code_hash ~ '^[a-f0-9]{64}$'),
  client_label text NOT NULL CONSTRAINT cli_device_authorization_client_label CHECK (client_label ~ '^[\x20-\x7e]{1,64}$'),
  requester_address text NOT NULL CONSTRAINT cli_device_authorization_requester_address CHECK (char_length(requester_address) BETWEEN 1 AND 64),
  namespace_id text CONSTRAINT cli_device_authorization_namespace_id CHECK (namespace_id ~ '^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  state text NOT NULL DEFAULT 'pending' CONSTRAINT cli_device_authorization_state CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
  user_id text REFERENCES occ."user"(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  parent_session_id text REFERENCES occ.session(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT cli_device_authorization_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  -- A pending authorization names no person; an approved or consumed one names the person and
  -- the browser session that approved it; a denied one names only the person.
  CONSTRAINT cli_device_authorization_decision CHECK (
    (state = 'pending' AND user_id IS NULL AND parent_session_id IS NULL AND decided_at IS NULL)
    OR (state IN ('approved', 'consumed') AND user_id IS NOT NULL AND parent_session_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (state = 'denied' AND user_id IS NOT NULL AND parent_session_id IS NULL AND decided_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX cli_device_authorization_expiry ON occ.cli_device_authorizations (expires_at);
--> statement-breakpoint
CREATE INDEX cli_device_authorization_pending ON occ.cli_device_authorizations (created_at) WHERE state = 'pending';
--> statement-breakpoint
CREATE TABLE occ.cli_sessions (
  id text PRIMARY KEY CONSTRAINT cli_session_id CHECK (id ~ '^cls_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  token_hash text NOT NULL UNIQUE CONSTRAINT cli_session_token_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  -- One session per authorization, even after the authorization row is swept.
  authorization_id text NOT NULL UNIQUE CONSTRAINT cli_session_authorization_id CHECK (authorization_id ~ '^cda_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id text NOT NULL REFERENCES occ."user"(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  parent_session_id text NOT NULL REFERENCES occ.session(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  namespace_id text CONSTRAINT cli_session_namespace_id CHECK (namespace_id ~ '^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  client_label text NOT NULL CONSTRAINT cli_session_client_label CHECK (client_label ~ '^[\x20-\x7e]{1,64}$'),
  -- Guarded profile only: the parent's sign-in method and versions, copied at issue.
  method_id text REFERENCES occ.account(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  version integer CONSTRAINT cli_session_version_positive CHECK (version > 0),
  method_version integer CONSTRAINT cli_session_method_version_positive CHECK (method_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT cli_session_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours'),
  CONSTRAINT cli_session_binding CHECK (
    (method_id IS NULL AND version IS NULL AND method_version IS NULL)
    OR (method_id IS NOT NULL AND version IS NOT NULL AND method_version IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX cli_session_parent ON occ.cli_sessions (parent_session_id);
--> statement-breakpoint
CREATE INDEX cli_session_user ON occ.cli_sessions (user_id);
--> statement-breakpoint
CREATE INDEX cli_session_expiry ON occ.cli_sessions (expires_at);
--> statement-breakpoint
-- A CLI session belongs to its parent's account, ends no later than the parent, carries the
-- parent's guarded binding exactly (or none when the parent has none), and a parent holds at
-- most 10 unexpired CLI sessions. The parent row lock serializes concurrent issues.
CREATE FUNCTION occ.guard_cli_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  parent_user text;
  parent_expires timestamptz;
  bound_method text;
  bound_version integer;
  bound_method_version integer;
BEGIN
  SELECT s.user_id, s.expires_at INTO parent_user, parent_expires
  FROM occ.session s WHERE s.id = NEW.parent_session_id FOR NO KEY UPDATE;
  IF NOT FOUND OR parent_user <> NEW.user_id OR parent_expires <= clock_timestamp()
     OR NEW.expires_at > parent_expires THEN
    RAISE EXCEPTION 'A CLI session must belong to an unexpired parent session and end no later than it';
  END IF;
  SELECT b.method_id, b.version, b.method_version
  INTO bound_method, bound_version, bound_method_version
  FROM occ.human_authentication_sessions b
  WHERE b.session_id = NEW.parent_session_id AND b.user_id = NEW.user_id;
  IF FOUND THEN
    IF (NEW.method_id, NEW.version, NEW.method_version)
       IS DISTINCT FROM (bound_method, bound_version, bound_method_version) THEN
      RAISE EXCEPTION 'A CLI session must carry its parent session''s authentication binding';
    END IF;
  ELSIF NEW.method_id IS NOT NULL THEN
    RAISE EXCEPTION 'A CLI session must carry its parent session''s authentication binding';
  END IF;
  IF (SELECT count(*) FROM occ.cli_sessions c
      WHERE c.parent_session_id = NEW.parent_session_id AND c.expires_at > clock_timestamp()) >= 10 THEN
    RAISE EXCEPTION 'The parent session already holds the maximum number of CLI sessions'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_cli_session BEFORE INSERT ON occ.cli_sessions
FOR EACH ROW EXECUTE FUNCTION occ.guard_cli_session();
--> statement-breakpoint
REVOKE ALL ON occ.cli_device_authorizations, occ.cli_sessions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.cli_device_authorizations, occ.cli_sessions TO occ_app;
--> statement-breakpoint
GRANT UPDATE (state, user_id, parent_session_id, decided_at) ON occ.cli_device_authorizations TO occ_app;
