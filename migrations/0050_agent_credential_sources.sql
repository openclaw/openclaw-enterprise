-- Agent drafts may list up to eight credential sources, in order.
CREATE FUNCTION occ.agent_credential_sources_are_valid(sources jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  entry jsonb;
  ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(sources) IS DISTINCT FROM 'array'
    OR jsonb_array_length(sources) = 0
    OR jsonb_array_length(sources) > 8 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(sources) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR entry - 'sourceId' <> '{}'::jsonb
      OR jsonb_typeof(entry->'sourceId') IS DISTINCT FROM 'string'
      OR (entry->>'sourceId') !~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (entry->>'sourceId') = ANY(ids) THEN
      RETURN false;
    END IF;
    ids := array_append(ids, entry->>'sourceId');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD COLUMN credential_sources jsonb,
  ADD CONSTRAINT agents_credential_sources_valid CHECK (
    credential_sources IS NULL OR occ.agent_credential_sources_are_valid(credential_sources)
  );
--> statement-breakpoint
-- One row per draft reference, so deleting a referenced source fails in the database.
CREATE TABLE occ.agent_credential_sources (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  credential_source_id text NOT NULL,
  CONSTRAINT agent_credential_sources_pkey PRIMARY KEY (namespace_id, agent_id, credential_source_id),
  CONSTRAINT agent_credential_sources_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT agent_credential_sources_source_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX agent_credential_sources_source_idx
  ON occ.agent_credential_sources (namespace_id, credential_source_id);
--> statement-breakpoint
-- The application role cannot write the join table directly; only this trigger keeps it exact.
CREATE FUNCTION occ.sync_agent_credential_sources() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
BEGIN
  DELETE FROM occ.agent_credential_sources
   WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.id;
  IF NEW.credential_sources IS NOT NULL THEN
    INSERT INTO occ.agent_credential_sources (namespace_id, agent_id, credential_source_id)
    SELECT NEW.namespace_id, NEW.id, entry->>'sourceId'
      FROM jsonb_array_elements(NEW.credential_sources) AS entry;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_credential_sources_are_synchronized
AFTER INSERT OR UPDATE OF credential_sources ON occ.agents
FOR EACH ROW EXECUTE FUNCTION occ.sync_agent_credential_sources();
--> statement-breakpoint
-- The list holds every source the Agent binds, so a credential-source Harness binding names a
-- listed entry. Existing drafts gain their Harness source as the list's only entry.
UPDATE occ.agents
   SET credential_sources = jsonb_build_array(
         jsonb_build_object('sourceId', harness_auth->>'sourceId'))
 WHERE harness_auth->>'method' = 'credential_source';
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD CONSTRAINT agents_harness_credential_source_listed CHECK (
    harness_auth IS NULL
    OR harness_auth->>'method' IS DISTINCT FROM 'credential_source'
    OR COALESCE(credential_sources, '[]'::jsonb) @> jsonb_build_array(
         jsonb_build_object('sourceId', harness_auth->>'sourceId'))
  );
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.sync_agent_credential_sources() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON occ.agent_credential_sources FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.agent_credential_sources TO occ_app;
--> statement-breakpoint
GRANT UPDATE (credential_sources) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.agent_credential_sources_are_valid(jsonb) TO occ_app;
--> statement-breakpoint
-- Revisions freeze each non-model source with the Credential Gateway and type admitted for it.
CREATE FUNCTION occ.credential_source_snapshots_are_valid(snapshots jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  entry jsonb;
  ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(snapshots) = 0
    OR jsonb_array_length(snapshots) > 8 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT (entry ?& ARRAY['sourceId', 'credentialGatewayId', 'sourceType'])
      OR entry - 'sourceId' - 'credentialGatewayId' - 'sourceType' <> '{}'::jsonb
      OR jsonb_typeof(entry->'sourceId') IS DISTINCT FROM 'string'
      OR (entry->>'sourceId') !~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (entry->>'sourceId') = ANY(ids)
      OR jsonb_typeof(entry->'credentialGatewayId') IS DISTINCT FROM 'string'
      OR COALESCE(btrim(entry->>'credentialGatewayId'), '') = ''
      OR jsonb_typeof(entry->'sourceType') IS DISTINCT FROM 'string'
      OR (entry->>'sourceType') !~ '^[a-z][a-z0-9-]{0,63}$' THEN
      RETURN false;
    END IF;
    ids := array_append(ids, entry->>'sourceId');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.credential_source_snapshots_are_valid(jsonb) TO occ_app;
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
      - 'repository_credentials') = '{}'::jsonb
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
