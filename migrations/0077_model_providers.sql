-- Stock Drizzle may apply earlier seed migrations in this same transaction. Complete their
-- deferred references before changing the template and Agent tables.
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
-- Separate immutable static-key versions from OAuth versions and their client registrations.
ALTER TABLE occ.connection_templates
  DROP CONSTRAINT connection_templates_current_version_exists,
  ADD COLUMN static_key boolean NOT NULL DEFAULT false,
  ADD COLUMN installation_static_template_id text GENERATED ALWAYS AS (CASE WHEN namespace_id IS NULL AND static_key THEN id END) STORED UNIQUE,
  ADD COLUMN current_oauth_version integer GENERATED ALWAYS AS (CASE WHEN NOT static_key THEN current_version END) STORED,
  ADD COLUMN current_static_version integer GENERATED ALWAYS AS (CASE WHEN static_key THEN current_version END) STORED,
  ADD CONSTRAINT connection_templates_current_oauth_version FOREIGN KEY (id, current_oauth_version)
    REFERENCES occ.oauth_connection_template_versions(template_id, version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE occ.static_key_template_versions (
  template_id text NOT NULL REFERENCES occ.connection_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  base_url text NOT NULL CHECK (length(base_url) <= 2048 AND base_url ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]+)?/v1$'),
  protocol text NOT NULL CHECK (protocol IN ('openai-responses', 'openai-completions')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, version),
  UNIQUE (template_id, version, base_url, protocol)
);
--> statement-breakpoint
ALTER TABLE occ.connection_templates ADD CONSTRAINT connection_templates_current_static_version FOREIGN KEY (id, current_static_version)
  REFERENCES occ.static_key_template_versions(template_id, version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TRIGGER static_key_template_version_is_immutable BEFORE UPDATE ON occ.static_key_template_versions
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.static_key_template_versions TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.model_providers (
  id text PRIMARY KEY CHECK (id ~ '^mpr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200 AND display_name = btrim(display_name)),
  base_url text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('openai-responses', 'openai-completions')),
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array' AND jsonb_array_length(models) BETWEEN 1 AND 256),
  default_model_id text CHECK (default_model_id IS NULL OR models @> jsonb_build_array(jsonb_build_object('id', default_model_id))),
  connection_template_id text NOT NULL REFERENCES occ.connection_templates(installation_static_template_id) ON DELETE RESTRICT
);
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.model_providers TO occ_app;
--> statement-breakpoint
GRANT UPDATE (display_name, base_url, protocol, models, default_model_id, connection_template_id) ON occ.model_providers TO occ_app;
--> statement-breakpoint
-- A source can approve exactly one immutable template version. The route in the source must match it.
ALTER TABLE occ.credential_sources
  ADD COLUMN static_template_id text,
  ADD COLUMN static_template_version integer,
  ADD COLUMN static_base_url text,
  ADD COLUMN static_protocol text,
  ADD CONSTRAINT credential_source_static_key_grant FOREIGN KEY
    (static_template_id, static_template_version, static_base_url, static_protocol)
    REFERENCES occ.static_key_template_versions(template_id,version,base_url,protocol) MATCH FULL ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN model_provider_id text
  REFERENCES occ.model_providers(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
CREATE INDEX agents_model_provider ON occ.agents(model_provider_id) WHERE model_provider_id IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE (model_provider_id) ON occ.agents TO occ_app;
--> statement-breakpoint
-- Persist the selected provider alongside the resolved immutable Harness settings.
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
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode' - 'overrides' - 'configuration' - 'modelProviderId') = '{}'::jsonb
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
--> statement-breakpoint
SET CONSTRAINTS ALL DEFERRED;
