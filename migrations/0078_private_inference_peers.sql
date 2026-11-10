CREATE FUNCTION occ.inference_private_peer_is_valid(peer jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (jsonb_typeof(peer) = 'object'
    AND jsonb_typeof(peer->'address') = 'string'
    AND peer->>'address' ~ '^(10\.(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])|172\.(1[6-9]|2[0-9]|3[01])|192\.168)(\.(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])){2}$'
    AND CASE peer->>'kind'
      WHEN 'private_ipv4' THEN (peer - 'kind' - 'address') = '{}'::jsonb
      WHEN 'kubernetes_service' THEN
        (peer - 'kind' - 'address' - 'namespace' - 'name' - 'uid' - 'targetPort' - 'podSelector') = '{}'::jsonb
        AND jsonb_typeof(peer->'namespace') = 'string' AND peer->>'namespace' ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        AND jsonb_typeof(peer->'name') = 'string' AND peer->>'name' ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        AND jsonb_typeof(peer->'uid') = 'string' AND length(peer->>'uid') > 0
        AND CASE WHEN jsonb_typeof(peer->'targetPort') = 'number' THEN
          (peer->>'targetPort')::numeric BETWEEN 1 AND 65535 AND mod((peer->>'targetPort')::numeric,1) = 0 ELSE false END
        AND jsonb_typeof(peer->'podSelector') = 'object' AND peer->'podSelector' <> '{}'::jsonb
        AND NOT jsonb_path_exists(peer->'podSelector', '$.* ? (@.type() != "string")')
      ELSE false END) IS TRUE
$$;
--> statement-breakpoint
ALTER TABLE occ.static_key_template_versions ADD COLUMN private_peer jsonb
  CONSTRAINT static_key_template_versions_private_peer CHECK (occ.inference_private_peer_is_valid(private_peer));
--> statement-breakpoint
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
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode' - 'overrides' - 'configuration' - 'modelProviderId' - 'privateInferencePeer') = '{}'::jsonb
        AND (NOT ((admitted_spec->'harness') ? 'privateInferencePeer') OR (
          (admitted_spec->'harness') ? 'modelProviderId' AND occ.inference_private_peer_is_valid(admitted_spec #> '{harness,privateInferencePeer}') IS TRUE))
    AND (NOT ((admitted_spec->'harness') ? 'modelProviderId')
         OR (jsonb_typeof(admitted_spec #> '{harness,modelProviderId}') = 'string'
             AND (admitted_spec #>> '{harness,modelProviderId}') ~ '^mpr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
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
  ) NOT VALID;
