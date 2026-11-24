-- One native Git Provider copy of a repository token Source per Agent revision. Deployment
-- records it before the revision is queued; the Worker completes it at installation and retires
-- it after reading back that the Provider is gone. Source deletion waits for retirement.
CREATE TABLE occ.repository_source_copies (
  revision_id text PRIMARY KEY CHECK (revision_id <> ''),
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  token_service_instance_id text NOT NULL CHECK (token_service_instance_id <> ''),
  agent_id text NOT NULL CHECK (agent_id <> ''),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provider_name text CHECK (provider_name <> ''),
  source_version text CHECK (source_version <> ''),
  installed_at timestamptz,
  confirmed_source_version text CHECK (confirmed_source_version <> ''),
  confirmed_at timestamptz,
  unknown_write_version text CHECK (unknown_write_version <> ''),
  unknown_write_at timestamptz,
  retirement_blocked text CHECK (retirement_blocked <> ''),
  retirement_attempted_at timestamptz,
  retired_at timestamptz,
  FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE CASCADE,
  CONSTRAINT repository_source_copies_installed_check CHECK (
    (provider_name IS NULL) = (installed_at IS NULL) AND (source_version IS NULL) = (installed_at IS NULL)),
  CONSTRAINT repository_source_copies_confirmed_check CHECK (
    (confirmed_source_version IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT repository_source_copies_unknown_write_check CHECK (
    (unknown_write_version IS NULL) = (unknown_write_at IS NULL)),
  CONSTRAINT repository_source_copies_retirement_check CHECK (
    (retirement_blocked IS NULL OR retirement_attempted_at IS NOT NULL)
    AND (retired_at IS NULL OR retirement_blocked IS NULL))
);
--> statement-breakpoint
CREATE INDEX repository_source_copies_unretired
  ON occ.repository_source_copies(namespace_id, credential_source_id) WHERE retired_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION occ.keep_repository_source_copy_retired() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'A retired repository Source copy is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_source_copies_retired_final BEFORE UPDATE ON occ.repository_source_copies
FOR EACH ROW EXECUTE FUNCTION occ.keep_repository_source_copy_retired();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.keep_repository_source_copy_retired() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON occ.repository_source_copies FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(provider_name,source_version,installed_at,confirmed_source_version,
  confirmed_at,unknown_write_version,unknown_write_at,retirement_blocked,retirement_attempted_at,retired_at)
ON occ.repository_source_copies TO occ_app;
