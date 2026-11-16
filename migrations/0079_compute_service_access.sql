-- Persist the generic, nonsecret Compute descriptor contract. Driver-owned
-- configuration stays opaque; Core admits the same exact descriptor to Sandbox.
CREATE FUNCTION occ.compute_service_access_is_valid(services jsonb, compute jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE
  service jsonb;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(services) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(services) = 0 THEN RETURN false; END IF;
  FOR service IN SELECT value FROM jsonb_array_elements(services) LOOP
    IF jsonb_typeof(service) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT (service ?& ARRAY['id','driverId','implementation','endpoint','configuration'])
      OR service - 'id' - 'driverId' - 'implementation' - 'endpoint' - 'configuration' <> '{}'::jsonb
      OR jsonb_typeof(service->'id') IS DISTINCT FROM 'string'
      OR NOT (service->>'id' ~ '^[a-z][a-z0-9-]{0,63}$')
      OR jsonb_typeof(service->'driverId') IS DISTINCT FROM 'string'
      OR (service->>'driverId') IS DISTINCT FROM (compute->>'id')
      OR COALESCE(btrim(service->>'driverId'), '') = ''
      OR jsonb_typeof(service->'implementation') IS DISTINCT FROM 'string'
      OR (service->>'implementation') IS DISTINCT FROM (compute->>'implementation')
      OR COALESCE(btrim(service->>'implementation'), '') = ''
      OR jsonb_typeof(service->'endpoint') IS DISTINCT FROM 'string'
      OR length(service->>'endpoint') = 0
      OR jsonb_typeof(service->'configuration') IS DISTINCT FROM 'object'
      OR service->>'id' = ANY(seen)
    THEN RETURN false; END IF;
    seen := array_append(seen, service->>'id');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.compute_service_access_is_valid(jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.compute_service_access_is_valid(jsonb,jsonb) TO occ_app;
--> statement-breakpoint
-- Retain historical revisions without Harness settings for cleanup; check all new writes.
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot,
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute', 'harness_auth'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id' - 'sandbox_policy'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins' - 'plugin_approvers'
      - 'repository_credentials' - 'egress_plan' - 'execution_admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
    AND (admitted_spec->>'configuration_id') ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
    AND (admitted_spec->>'configuration_kind') = 'agent'
    AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
    AND (admitted_spec->>'configuration_generation')::numeric BETWEEN 1 AND 9007199254740991
    AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
    AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
    AND jsonb_typeof(admitted_spec->'harness') = 'object'
    AND ((admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode', 'overrides', 'configuration'])
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode' - 'overrides' - 'configuration') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{harness,overrides}') = 'object'
    AND jsonb_typeof(admitted_spec #> '{harness,configuration}') = 'object'
    AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
    AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
    AND jsonb_typeof(admitted_spec->'compute') = 'object'
    AND ((admitted_spec->'compute') ?& ARRAY['id', 'implementation'])
    AND ((admitted_spec->'compute') - 'id' - 'implementation' - 'admission' - 'serviceAccess') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
    AND (
      NOT ((admitted_spec->'compute') ? 'admission')
      OR (jsonb_typeof(admitted_spec #> '{compute,admission}') = 'string'
          AND char_length(admitted_spec #>> '{compute,admission}') BETWEEN 1 AND 1024
          AND (admitted_spec #>> '{compute,admission}') ~ '^[ -~]+$')
    )
    AND (
      NOT (admitted_spec ? 'sandbox_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_bindings')
      OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
    )
    AND CASE WHEN jsonb_typeof(admitted_spec->'harness_auth') = 'object' THEN
      occ.harness_auth_is_valid((admitted_spec->'harness_auth') - 'protectedExecutionVersion', namespace_id, true)
    ELSE false END
    AND (
      NOT (admitted_spec ? 'repository_credentials')
      OR occ.repository_credentials_are_valid(admitted_spec->'repository_credentials')
    )
    AND (
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
    AND (
      NOT (admitted_spec ? 'plugin_approvers')
      OR (jsonb_typeof(admitted_spec->'plugin_approvers') = 'array'
          AND jsonb_array_length(admitted_spec->'plugin_approvers') <= 64)
    )
    AND (
      NOT (admitted_spec ? 'credential_sources')
      OR occ.credential_source_snapshots_are_valid(admitted_spec->'credential_sources')
    )
    AND (
      NOT ((admitted_spec->'compute') ? 'serviceAccess')
      OR occ.compute_service_access_is_valid(admitted_spec #> '{compute,serviceAccess}', admitted_spec->'compute')
    )
    AND (
      NOT (admitted_spec ? 'sandbox_policy')
      OR (admitted_spec #> '{sandbox_policy,serviceAccess}') IS NOT DISTINCT FROM (admitted_spec #> '{compute,serviceAccess}')
    )
  ) NOT VALID;
