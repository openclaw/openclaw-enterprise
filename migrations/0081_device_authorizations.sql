CREATE TABLE occ.device_authorizations (
  id text PRIMARY KEY CHECK (id ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  agent_id text,
  harness_id text NOT NULL,
  credential_gateway_id text NOT NULL,
  credential_refresh_id text NOT NULL,
  source_id text NOT NULL,
  encrypted_challenge text,
  interval_seconds integer NOT NULL CHECK (interval_seconds > 0),
  phase text NOT NULL CHECK (phase IN ('pending', 'polling', 'cancelled', 'ready')),
  expires_at timestamptz NOT NULL,
  next_poll_at timestamptz NOT NULL,
  private_state text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((phase IN ('pending', 'polling')) = (private_state IS NOT NULL)),
  CHECK ((phase <> 'cancelled') = (encrypted_challenge IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX device_authorizations_expiry ON occ.device_authorizations (expires_at, id) WHERE phase <> 'cancelled';
--> statement-breakpoint
REVOKE ALL ON occ.device_authorizations FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE, UPDATE (phase, expires_at, next_poll_at, private_state, encrypted_challenge, version)
  ON occ.device_authorizations TO occ_app;
