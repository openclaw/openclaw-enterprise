CREATE TABLE occ.device_authorizations (
  id text PRIMARY KEY CHECK (id ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  agent_id text,
  harness_id text NOT NULL,
  credential_gateway_id text NOT NULL,
  credential_refresh_id text NOT NULL,
  source_id text NOT NULL,
  verification_url text NOT NULL,
  user_code text NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds > 0),
  phase text NOT NULL CHECK (phase IN ('pending', 'polling', 'cancelled', 'ready')),
  expires_at timestamptz NOT NULL,
  next_poll_at timestamptz NOT NULL,
  private_state text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((phase IN ('pending', 'polling')) = (private_state IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX device_authorizations_expiry ON occ.device_authorizations (expires_at, id) WHERE phase <> 'cancelled';
--> statement-breakpoint
REVOKE ALL ON occ.device_authorizations FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE, UPDATE (phase, expires_at, next_poll_at, private_state, version)
  ON occ.device_authorizations TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.resource_belongs_to_namespace(
  checked_namespace_id text,
  checked_resource_kind text,
  checked_resource_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF checked_namespace_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'installation' THEN
    RETURN false;
  END IF;
  IF checked_resource_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'namespace' THEN
    RETURN checked_resource_id = checked_namespace_id;
  ELSIF checked_resource_kind = 'configuration' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.configurations
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'service_account' THEN
    RETURN checked_resource_id = checked_namespace_id OR EXISTS (
      SELECT 1 FROM occ.service_accounts
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'preset' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.presets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'credential_source' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.credential_sources
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'sandbox_policy' THEN
    RETURN EXISTS (SELECT 1 FROM occ.sandbox_policies WHERE namespace_id = checked_namespace_id AND id = checked_resource_id);
  ELSIF checked_resource_kind = 'secret' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.device_authorizations
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    ) OR EXISTS (
      SELECT 1 FROM occ.secrets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agents
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent_revision' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agent_revisions
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  END IF;
  RETURN false;
END;
$$;
