ALTER TABLE occ.credential_sources
  ADD COLUMN backend_ref jsonb,
  ADD CONSTRAINT credential_sources_backend_ref_valid CHECK (
    backend_ref IS NULL OR (
      token_service_instance_id IS NOT NULL
      AND jsonb_typeof(backend_ref) = 'object'
      AND backend_ref <> '{}'::jsonb
      AND NOT jsonb_path_exists(backend_ref, 'strict $.* ? (@.type() != "string" || @ == "")', '{}'::jsonb, true)
    )
  );
--> statement-breakpoint
CREATE TRIGGER credential_source_backend_ref_is_immutable
BEFORE UPDATE OF backend_ref ON occ.credential_sources
FOR EACH ROW WHEN (NEW.backend_ref IS DISTINCT FROM OLD.backend_ref)
EXECUTE FUNCTION occ.reject_row_mutation();
