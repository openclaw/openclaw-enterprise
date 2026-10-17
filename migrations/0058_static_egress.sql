-- Protected static inputs are opt-in for existing sources. NULL preserves the
-- legacy gateway's approved copy; it must never be reinterpreted as a live Secret.
ALTER TABLE occ.credential_sources ADD COLUMN egress jsonb;
--> statement-breakpoint
CREATE FUNCTION occ.egress_ref_is_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['id', 'generation'] AND (value - 'id' - 'generation') = '{}'::jsonb
    AND jsonb_typeof(value->'id') = 'string' AND length(value->>'id') BETWEEN 1 AND 200
    AND jsonb_typeof(value->'generation') = 'number' AND (value->>'generation') ~ '^[1-9][0-9]{0,14}$', false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.static_egress_source_is_valid(value jsonb, owner_namespace text, owner_source text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['key', 'schemaVersion', 'adoption', 'materialRefId', 'secret', 'secretDriver', 'sender', 'resolver', 'retention']
    AND (value - 'key' - 'schemaVersion' - 'adoption' - 'materialRefId' - 'secret' - 'secretDriver' - 'sender' - 'resolver' - 'retention') = '{}'::jsonb
    AND value->'schemaVersion' = '1'::jsonb AND value->>'adoption' = 'live' AND value->>'retention' = 'none'
    AND jsonb_typeof(value->'materialRefId') = 'string' AND length(value->>'materialRefId') BETWEEN 1 AND 200
    AND jsonb_typeof(value->'key') = 'object'
    AND (value->'key') ?& ARRAY['installationId', 'namespaceId', 'source', 'backend', 'provider']
    AND ((value->'key') - 'installationId' - 'namespaceId' - 'source' - 'backend' - 'provider') = '{}'::jsonb
    AND (value->'key'->>'installationId') ~ '^ins_[0-9a-f-]{36}$'
    AND value->'key'->>'namespaceId' = owner_namespace AND value->'key'->'source'->>'id' = owner_source
    AND occ.egress_ref_is_valid(value->'key'->'source') AND occ.egress_ref_is_valid(value->'key'->'backend') AND occ.egress_ref_is_valid(value->'key'->'provider')
    AND jsonb_typeof(value->'secret') = 'object'
    AND (value->'secret') ?& ARRAY['kind', 'namespaceId', 'id'] AND ((value->'secret') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
    AND value->'secret'->>'kind' = 'secret' AND value->'secret'->>'namespaceId' = owner_namespace
    AND (value->'secret'->>'id') ~ '^sec_[0-9a-f-]{36}$'
    AND occ.egress_ref_is_valid(value->'secretDriver') AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver'), false)
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.egress_ref_is_valid(jsonb), occ.static_egress_source_is_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources ADD CONSTRAINT credential_sources_egress_valid CHECK (
  egress IS NULL OR occ.static_egress_source_is_valid(egress, namespace_id, id)
);
--> statement-breakpoint

CREATE TABLE occ.egress_installations (
  sender_id text NOT NULL,
  sandbox_id text NOT NULL,
  namespace_id text NOT NULL,
  revision_id text NOT NULL,
  agent_id text NOT NULL,
  installation jsonb NOT NULL,
  PRIMARY KEY (sender_id, sandbox_id),
  UNIQUE (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, agent_id, revision_id) REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE,
  CHECK (length(sender_id) BETWEEN 1 AND 200 AND length(sandbox_id) BETWEEN 1 AND 200),
  CHECK (COALESCE(installation->'sender'->>'id' = sender_id
    AND installation->>'sandboxId' = sandbox_id
    AND installation->'plan'->'execution'->>'namespaceId' = namespace_id
    AND installation->'plan'->'execution'->>'revisionId' = revision_id
    AND installation->'plan'->'execution'->>'agentId' = agent_id, false))
);

-- A provider rejection fences the selected store-qualified version across restart
-- and rereads. Rotation to a new version does not inherit the old rejection.
--> statement-breakpoint
CREATE TABLE occ.egress_rejected_material (
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  secret_driver_id text NOT NULL,
  material_id text NOT NULL,
  material_version text NOT NULL,
  PRIMARY KEY (namespace_id, secret_driver_id, material_id, material_version),
  CHECK (length(secret_driver_id) > 0 AND length(material_id) > 0 AND length(material_version) > 0)
);

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
    AND occ.harness_auth_is_valid((admitted_spec->'harness_auth') - 'protectedExecutionVersion', namespace_id, true)
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


--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_egress_scope CHECK (
  NOT (admitted_spec ? 'egress_plan') OR COALESCE(
    jsonb_typeof(admitted_spec->'egress_plan') = 'object'
    AND admitted_spec->'egress_plan'->'execution'->>'namespaceId' = namespace_id
    AND admitted_spec->'egress_plan'->'execution'->>'agentId' = agent_id
    AND admitted_spec->'egress_plan'->'execution'->>'revisionId' = id
    AND jsonb_typeof(admitted_spec->'egress_plan'->'routes') = 'array',
    false)
);
-- Existing snapshots are deliberately not relabeled as safe. New readers refuse
-- their missing decision. NOT VALID preserves history while rejecting old writers.
-- v1 readers require an exact Harness auth snapshot. For protected revisions, put
-- the minimum reader version in that snapshot, not only in an unknown top-level
-- field v1 would discard. This version is a read barrier, never launch authority.
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_execution_admission CHECK (
  COALESCE(
    jsonb_typeof(admitted_spec->'execution_admission') = 'object'
    AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
    AND ((admitted_spec->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
    AND admitted_spec->'execution_admission'->'version' = '2'::jsonb
    AND (
      (admitted_spec->'execution_admission'->>'mode' = 'unprotected'
        AND NOT (admitted_spec ? 'egress_plan')
        AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion'))
      OR (admitted_spec->'execution_admission'->>'mode' = 'protected'
        AND admitted_spec ? 'egress_plan'
        AND admitted_spec #> '{harness_auth,protectedExecutionVersion}' = '2'::jsonb)
    ), false)
) NOT VALID;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON occ.egress_installations, occ.egress_rejected_material TO occ_app;

--> statement-breakpoint
GRANT UPDATE (egress) ON occ.credential_sources TO occ_app;
