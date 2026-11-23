ALTER TABLE occ.credential_sources
  DROP CONSTRAINT credential_sources_owner_capability_valid;
--> statement-breakpoint
DROP TRIGGER credential_source_registration_is_write_once ON occ.credential_sources;
DROP TRIGGER credential_source_dispatch_is_guarded ON occ.credential_sources;
ALTER TABLE occ.credential_sources
  DROP COLUMN registration,
  DROP COLUMN registration_dispatched_at;
DROP FUNCTION occ.token_service_registration_is_valid(jsonb);
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
    CASE WHEN owner_capability = 'token_service' THEN driver_id IS NULL AND egress IS NULL AND (
      (type = 'oauth2-refresh-token' AND token_service_instance_id IS NULL)
      OR (type <> 'oauth2-refresh-token' AND token_service_instance_id IS NOT NULL AND state IN ('ready', 'deleting'))
    ) ELSE driver_id IS NOT NULL AND token_service_instance_id IS NULL
      AND (owner_capability = 'credential_gateway' OR (owner_capability = 'credential_proxy' AND egress IS NOT NULL)) END IS TRUE
  );
--> statement-breakpoint
DROP TRIGGER credential_source_config_requires_managed_owner ON occ.credential_sources;
CREATE TRIGGER credential_source_config_requires_managed_owner
BEFORE UPDATE OF config ON occ.credential_sources
FOR EACH ROW WHEN (NEW.config IS DISTINCT FROM OLD.config AND NOT
  (OLD.token_service_instance_id IS NOT NULL AND OLD.state = 'ready' AND NEW.state = 'ready'))
EXECUTE FUNCTION occ.reject_row_mutation();
