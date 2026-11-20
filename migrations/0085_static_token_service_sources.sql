CREATE TABLE occ.token_service_instances (
  installation_id text PRIMARY KEY REFERENCES occ.installation(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  id text NOT NULL UNIQUE,
  driver_id text NOT NULL,
  store_identity text NOT NULL,
  CONSTRAINT token_service_instances_id_valid CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT token_service_instances_driver_valid CHECK (char_length(driver_id) BETWEEN 1 AND 200 AND driver_id = btrim(driver_id)),
  CONSTRAINT token_service_instances_store_valid CHECK (char_length(store_identity) BETWEEN 1 AND 200 AND store_identity = btrim(store_identity))
);
--> statement-breakpoint
REVOKE ALL ON occ.token_service_instances FROM PUBLIC, occ_app;
GRANT SELECT, INSERT, DELETE ON occ.token_service_instances TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.token_service_registration_is_valid(registration jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_typeof(registration) = 'object'
    AND registration - 'backendRef' = '{}'::jsonb
    AND (NOT (registration ? 'backendRef') OR (
      jsonb_typeof(registration->'backendRef') = 'object'
      AND NOT jsonb_path_exists(registration->'backendRef', 'strict $.* ? (@.type() != "string")')
    )), false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.token_service_registration_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.token_service_registration_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  ADD COLUMN token_service_instance_id text REFERENCES occ.token_service_instances(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN registration jsonb,
  ADD COLUMN registration_dispatched_at timestamptz,
  DROP CONSTRAINT credential_sources_owner_capability_valid,
  ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
    CASE WHEN owner_capability = 'token_service' THEN driver_id IS NULL AND egress IS NULL AND (
      (type = 'oauth2-refresh-token' AND token_service_instance_id IS NULL AND registration IS NULL AND registration_dispatched_at IS NULL)
      OR (type <> 'oauth2-refresh-token' AND token_service_instance_id IS NOT NULL
        AND (registration IS NULL OR occ.token_service_registration_is_valid(registration))
        AND (registration_dispatched_at IS NULL OR registration_dispatched_at >= created_at)
        AND (state <> 'registering' OR registration IS NULL)
        AND (state <> 'ready' OR (registration IS NOT NULL AND registration_dispatched_at IS NOT NULL)))
    )
    ELSE driver_id IS NOT NULL AND token_service_instance_id IS NULL AND registration IS NULL AND registration_dispatched_at IS NULL
      AND (owner_capability = 'credential_gateway' OR (owner_capability = 'credential_proxy' AND egress IS NOT NULL)) END IS TRUE
  );
--> statement-breakpoint
DROP TRIGGER credential_source_metadata_is_immutable ON occ.credential_sources;
CREATE TRIGGER credential_source_metadata_is_immutable
BEFORE UPDATE OF id, namespace_id, name, type, driver_id, owner_capability, created_at ON occ.credential_sources
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
CREATE TRIGGER credential_source_config_requires_managed_owner
BEFORE UPDATE OF config ON occ.credential_sources
FOR EACH ROW WHEN (NEW.config IS DISTINCT FROM OLD.config AND NOT
  (OLD.token_service_instance_id IS NOT NULL AND NEW.state = 'ready' AND OLD.state IN ('registering','ready')))
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER credential_source_instance_is_immutable
BEFORE UPDATE OF token_service_instance_id ON occ.credential_sources
FOR EACH ROW WHEN (NEW.token_service_instance_id IS DISTINCT FROM OLD.token_service_instance_id)
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER credential_source_registration_is_write_once
BEFORE UPDATE OF registration ON occ.credential_sources
FOR EACH ROW WHEN (NEW.registration IS DISTINCT FROM OLD.registration AND
  (OLD.registration IS NOT NULL OR OLD.state <> 'registering' OR NEW.state <> 'ready'))
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER credential_source_dispatch_is_guarded
BEFORE UPDATE OF registration_dispatched_at ON occ.credential_sources
FOR EACH ROW WHEN (NEW.registration_dispatched_at IS DISTINCT FROM OLD.registration_dispatched_at AND NOT (
  (OLD.state = 'registering' AND NEW.state = 'registering' AND OLD.registration_dispatched_at IS NULL AND NEW.registration_dispatched_at IS NOT NULL)
  OR (OLD.state = 'deleting' AND NEW.state = 'deleting' AND OLD.registration_dispatched_at IS NOT NULL AND NEW.registration_dispatched_at IS NULL)
)) EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE FUNCTION occ.reject_managed_source_secret() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.credential_sources s WHERE s.namespace_id = NEW.namespace_id
      AND s.id = NEW.credential_source_id AND s.token_service_instance_id IS NOT NULL FOR KEY SHARE) THEN
    RAISE EXCEPTION 'A managed TokenService source cannot reference a Namespace Secret' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.reject_managed_source_secret() FROM PUBLIC;
CREATE TRIGGER credential_source_secret_requires_reference_owner
BEFORE INSERT ON occ.credential_source_secrets FOR EACH ROW EXECUTE FUNCTION occ.reject_managed_source_secret();
--> statement-breakpoint
GRANT UPDATE (registration, registration_dispatched_at, config) ON occ.credential_sources TO occ_app;
