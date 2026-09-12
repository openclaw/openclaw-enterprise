ALTER TABLE occ.agents
  ADD COLUMN plugins jsonb,
  ADD CONSTRAINT agents_plugins_object
    CHECK (plugins IS NULL OR jsonb_typeof(plugins) = 'object');
--> statement-breakpoint
GRANT UPDATE (plugins) ON occ.agents TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot,
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
      - 'secret_driver_id' - 'secret_bindings' - 'service_account' - 'plugins') = '{}'::jsonb
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
    AND ((admitted_spec->'compute') - 'id' - 'implementation') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
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
    AND (
      NOT (admitted_spec ? 'service_account')
      OR (
        jsonb_typeof(admitted_spec->'service_account') = 'object'
        AND ((admitted_spec->'service_account') ?& ARRAY['id', 'credential'])
        AND ((admitted_spec->'service_account') - 'id' - 'credential') = '{}'::jsonb
        AND jsonb_typeof(admitted_spec #> '{service_account,id}') = 'string'
        AND (admitted_spec #>> '{service_account,id}') ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(admitted_spec #> '{service_account,credential}') = 'object'
        AND ((admitted_spec #> '{service_account,credential}') ?& ARRAY['kind', 'secretRef'])
        AND ((admitted_spec #> '{service_account,credential}') - 'kind' - 'secretRef') = '{}'::jsonb
        AND jsonb_typeof(admitted_spec #> '{service_account,credential,kind}') = 'string'
        AND (admitted_spec #>> '{service_account,credential,kind}') IN ('api_key', 'access_token')
        AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef}') = 'object'
        AND ((admitted_spec #> '{service_account,credential,secretRef}') ?& ARRAY['name', 'key'])
        AND ((admitted_spec #> '{service_account,credential,secretRef}') - 'name' - 'key') = '{}'::jsonb
        AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,name}') = 'string'
        AND char_length(admitted_spec #>> '{service_account,credential,secretRef,name}') BETWEEN 1 AND 253
        AND (admitted_spec #>> '{service_account,credential,secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
        AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,key}') = 'string'
        AND char_length(admitted_spec #>> '{service_account,credential,secretRef,key}') BETWEEN 1 AND 253
        AND (admitted_spec #>> '{service_account,credential,secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
        AND (admitted_spec #>> '{service_account,credential,secretRef,key}') NOT IN ('.', '..')
      )
    )
    AND (
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
  );
