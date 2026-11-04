-- Account-wide revocation must outlive the initiating request and every Agent using the source.
ALTER TABLE occ.agent_connections
  ADD COLUMN revocation_requested_by text,
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT agent_connections_revocation_requested CHECK (
    revoked_at IS NULL OR revocation_requested_by IS NOT NULL
  );
--> statement-breakpoint
CREATE INDEX agent_connections_revoking_idx ON occ.agent_connections (credential_source_id)
WHERE revocation_requested_by IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION occ.guard_agent_connection_update() RETURNS trigger
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
DROP TRIGGER agent_connection_is_immutable ON occ.agent_connections;
--> statement-breakpoint
CREATE TRIGGER agent_connection_update_is_guarded BEFORE UPDATE ON occ.agent_connections
FOR EACH ROW EXECUTE FUNCTION occ.guard_agent_connection_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_agent_connection_update() FROM PUBLIC;
--> statement-breakpoint
GRANT UPDATE (revocation_requested_by, revoked_at) ON occ.agent_connections TO occ_app;
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
