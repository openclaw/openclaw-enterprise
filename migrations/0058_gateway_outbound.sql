CREATE FUNCTION occ.gateway_outbound_selection_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE host jsonb; seen text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF value->>'mode' IN ('channelsOnly', 'publicHttps') THEN
    RETURN value - 'mode' = '{}'::jsonb;
  END IF;
  IF value->>'mode' IS DISTINCT FROM 'restricted'
    OR value - 'mode' - 'hosts' <> '{}'::jsonb
    OR jsonb_typeof(value->'hosts') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'hosts') NOT BETWEEN 1 AND 64 THEN RETURN false; END IF;
  FOR host IN SELECT * FROM jsonb_array_elements(value->'hosts') LOOP
    IF jsonb_typeof(host) IS DISTINCT FROM 'string' OR length(host #>> '{}') > 253
      OR (host #>> '{}') !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$' OR (host #>> '{}') = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, host #>> '{}');
  END LOOP;
  RETURN true;
END; $$;
--> statement-breakpoint
CREATE FUNCTION occ.gateway_outbound_snapshot_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE requirement jsonb; destination jsonb; cidr jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value - 'selection' - 'requirements' - 'denyCidrs' <> '{}'::jsonb
    OR jsonb_typeof(value->'denyCidrs') IS DISTINCT FROM 'array'
    OR NOT COALESCE(occ.gateway_outbound_selection_valid(value->'selection'), false)
    OR jsonb_typeof(value->'requirements') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'denyCidrs') > 64 THEN RETURN false; END IF;
  FOR cidr IN SELECT * FROM jsonb_array_elements(value->'denyCidrs') LOOP
    IF jsonb_typeof(cidr) IS DISTINCT FROM 'string' OR length(cidr #>> '{}') NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(value->'requirements') > 32 THEN RETURN false; END IF;
  FOR requirement IN SELECT * FROM jsonb_array_elements(value->'requirements') LOOP
    IF jsonb_typeof(requirement) IS DISTINCT FROM 'object'
      OR requirement - 'source' - 'destinations' <> '{}'::jsonb
      OR jsonb_typeof(requirement->'source') IS DISTINCT FROM 'string'
      OR (requirement->>'source') !~ '^[a-z0-9][a-z0-9._/-]{0,127}$'
      OR jsonb_typeof(requirement->'destinations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(requirement->'destinations') NOT BETWEEN 1 AND 64 THEN RETURN false; END IF;
    FOR destination IN SELECT * FROM jsonb_array_elements(requirement->'destinations') LOOP
      IF jsonb_typeof(destination) IS DISTINCT FROM 'object'
        OR destination - 'host' - 'includeSubdomains' <> '{}'::jsonb
        OR jsonb_typeof(destination->'host') IS DISTINCT FROM 'string'
        OR length(destination->>'host') > 253 OR (destination->>'host') !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
        OR jsonb_typeof(destination->'includeSubdomains') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END; $$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN gateway_outbound jsonb NOT NULL DEFAULT '{"mode":"channelsOnly"}'::jsonb,
  ADD CONSTRAINT agents_gateway_outbound_valid CHECK (occ.gateway_outbound_selection_valid(gateway_outbound)),
  ADD CONSTRAINT agents_gateway_outbound_topology CHECK (gateway_outbound->>'mode' = 'channelsOnly' OR execution_mode = 'dedicated');
--> statement-breakpoint
GRANT UPDATE (gateway_outbound) ON occ.agents TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.gateway_outbound_selection_valid(jsonb), occ.gateway_outbound_snapshot_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.gateway_outbound_selection_valid(jsonb), occ.gateway_outbound_snapshot_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute', 'harness_auth'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins' - 'plugin_approvers'
      - 'repository_credentials' - 'gateway_outbound') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
    AND (admitted_spec->>'configuration_id') ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
    AND (admitted_spec->>'configuration_kind') = 'agent'
    AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
    AND (admitted_spec->>'configuration_generation')::numeric BETWEEN 1 AND 9007199254740991
    AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
    AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
    AND jsonb_typeof(admitted_spec->'harness') = 'object'
    AND ((admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode'])
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
    AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
    AND jsonb_typeof(admitted_spec->'compute') = 'object'
    AND ((admitted_spec->'compute') ?& ARRAY['id', 'implementation'])
    AND ((admitted_spec->'compute') - 'id' - 'implementation' - 'admission') = '{}'::jsonb
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
    AND (NOT (admitted_spec ? 'gateway_outbound') OR (occ.gateway_outbound_snapshot_valid(admitted_spec->'gateway_outbound') AND admitted_spec #>> '{harness,mode}' = 'dedicated'))
    AND occ.harness_auth_is_valid(admitted_spec->'harness_auth', namespace_id, true)
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
  );
