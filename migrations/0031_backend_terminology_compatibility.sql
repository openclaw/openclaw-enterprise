DO $$
DECLARE
  has_agent_provider boolean;
  has_agent_backend boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'occ' AND table_name = 'agents' AND column_name = 'provider_id'
  ) INTO has_agent_provider;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'occ' AND table_name = 'agents' AND column_name = 'backend_id'
  ) INTO has_agent_backend;

  IF has_agent_provider AND has_agent_backend THEN
    RAISE EXCEPTION 'Backend terminology migration found mixed Agent provider/backend columns'
      USING ERRCODE = '23514';
  END IF;

  IF has_agent_provider THEN
    ALTER TABLE occ.agents RENAME COLUMN provider_id TO backend_id;
    ALTER TABLE occ.agents RENAME CONSTRAINT agents_provider_id_valid TO agents_backend_id_valid;
    GRANT UPDATE (backend_id) ON occ.agents TO occ_app;

    ALTER TABLE occ.agent_revisions RENAME COLUMN provider_id TO backend_id;
    ALTER TABLE occ.agent_revisions RENAME CONSTRAINT agent_revisions_provider_id_valid TO agent_revisions_backend_id_valid;

    DROP TRIGGER service_account_driver_binding_identity_is_immutable
    ON occ.service_account_driver_bindings;
    ALTER TABLE occ.service_account_driver_bindings RENAME COLUMN provider_id TO backend_id;
    ALTER TABLE occ.service_account_driver_bindings
      RENAME CONSTRAINT service_account_driver_bindings_provider_id_valid
      TO service_account_driver_bindings_backend_id_valid;
    CREATE TRIGGER service_account_driver_binding_identity_is_immutable
    BEFORE UPDATE OF service_account_id, namespace_id, backend_id, driver_id,
      external_account_id, workspace_id
    ON occ.service_account_driver_bindings
    FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
  ELSIF NOT has_agent_backend THEN
    RAISE EXCEPTION 'Backend terminology migration found neither Agent provider nor backend columns'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM occ.agents
    WHERE harness_auth ?& ARRAY['providerBinding', 'backendBinding']
  ) OR EXISTS (
    SELECT 1 FROM occ.agent_revisions
    WHERE (admitted_spec #> '{harness_auth}') ?& ARRAY['providerBinding', 'backendBinding']
  ) OR EXISTS (
    SELECT 1
    FROM occ.agent_revisions AS revision
    CROSS JOIN LATERAL jsonb_array_elements(
      revision.admitted_spec #> '{repository_credentials,bindings}'
    ) AS binding
    WHERE jsonb_typeof(revision.admitted_spec #> '{repository_credentials,bindings}') = 'array'
      AND binding ?& ARRAY['providerId', 'backendId']
  ) OR EXISTS (
    SELECT 1 FROM occ.presets
    WHERE (template #> '{agent}') ?& ARRAY['providerId', 'backendId']
  ) OR EXISTS (
    SELECT 1 FROM occ.repository_session_attempts
    WHERE (cleanup_context #> '{binding}') ?& ARRAY['providerId', 'backendId']
  ) OR EXISTS (
    SELECT 1 FROM occ.agent_provisioning_work
    WHERE plan ?& ARRAY['providerId', 'backendId']
  ) THEN
    RAISE EXCEPTION 'Backend terminology migration found ambiguous Provider and Backend JSON keys'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE
      WHEN binding->>'method' = 'runtime' THEN binding = '{"method":"runtime"}'::jsonb
      WHEN binding->>'method' IN ('api_key', 'codex_pat') THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source' - CASE WHEN resolved THEN 'secretDriverId' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'secret'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (jsonb_typeof(binding->'secretDriverId') = 'string' AND btrim(binding->>'secretDriverId') <> ''))
      WHEN binding->>'method' = 'chatgpt_service_account' THEN
        (binding ?& ARRAY['method', 'serviceAccountId'])
        AND (binding - 'method' - 'serviceAccountId'
          - CASE WHEN resolved THEN 'credential' ELSE 'method' END
          - CASE WHEN resolved THEN 'backendBinding' ELSE 'method' END) = '{}'::jsonb
        AND (binding->>'serviceAccountId') ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (
          jsonb_typeof(binding->'credential') = 'object'
          AND ((binding->'credential') ?& ARRAY['kind', 'secretRef'])
          AND ((binding->'credential') - 'kind' - 'secretRef') = '{}'::jsonb
          AND binding #>> '{credential,kind}' = 'access_token'
          AND jsonb_typeof(binding #> '{credential,secretRef}') = 'object'
          AND ((binding #> '{credential,secretRef}') ?& ARRAY['name', 'key'])
          AND ((binding #> '{credential,secretRef}') - 'name' - 'key') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{credential,secretRef,name}') = 'string'
          AND char_length(binding #>> '{credential,secretRef,name}') BETWEEN 1 AND 253
          AND (binding #>> '{credential,secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
          AND jsonb_typeof(binding #> '{credential,secretRef,key}') = 'string'
          AND char_length(binding #>> '{credential,secretRef,key}') BETWEEN 1 AND 253
          AND (binding #>> '{credential,secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
          AND (binding #>> '{credential,secretRef,key}') NOT IN ('.', '..')
          AND jsonb_typeof(binding->'backendBinding') = 'object'
          AND ((binding->'backendBinding') ?& ARRAY['backendId', 'driverId', 'workspaceId', 'credentialIssued'])
          AND ((binding->'backendBinding') - 'backendId' - 'driverId' - 'workspaceId' - 'credentialIssued') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{backendBinding,backendId}') = 'string'
          AND btrim(binding #>> '{backendBinding,backendId}') <> ''
          AND jsonb_typeof(binding #> '{backendBinding,driverId}') = 'string'
          AND btrim(binding #>> '{backendBinding,driverId}') <> ''
          AND jsonb_typeof(binding #> '{backendBinding,workspaceId}') = 'string'
          AND btrim(binding #>> '{backendBinding,workspaceId}') <> ''
          AND binding #> '{backendBinding,credentialIssued}' = 'true'::jsonb
        ))
      ELSE false
    END, false);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.repository_bindings_are_valid(bindings jsonb, admitted boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  binding jsonb;
  identity_value jsonb;
  backend_id text;
  repository_refs text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(bindings) IS DISTINCT FROM 'array' OR admitted IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(bindings) NOT BETWEEN 1 AND 16 THEN
    RETURN false;
  END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(binding->'repositoryRef') IS DISTINCT FROM 'string'
      OR jsonb_typeof(binding->'profile') IS DISTINCT FROM 'string'
      OR (binding->>'repositoryRef') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      OR (binding->>'profile') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      OR (binding->>'repositoryRef') = ANY(repository_refs) THEN
      RETURN false;
    END IF;
    repository_refs := array_append(repository_refs, binding->>'repositoryRef');
    IF NOT admitted THEN
      IF binding - 'repositoryRef' - 'profile' <> '{}'::jsonb THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;
    IF binding - 'repositoryRef' - 'profile' - 'backendId' - 'grant' <> '{}'::jsonb
      OR jsonb_typeof(binding->'backendId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(binding->'grant') IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    backend_id := binding->>'backendId';
    -- Backend IDs retain their existing JavaScript whitespace and UTF-16 bounds.
    IF char_length(backend_id)
        + char_length(regexp_replace(backend_id, U&'[\0001-\FFFF]', '', 'g'))
        NOT BETWEEN 1 AND 200
      OR backend_id <> btrim(backend_id,
        U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      OR backend_id ~ U&'[\0001-\001F\007F\2028\2029]' THEN
      RETURN false;
    END IF;
    IF NOT ((binding->'grant') ?& ARRAY['providerInstanceId', 'repositoryId', 'grantId'])
      OR (binding->'grant') - 'providerInstanceId' - 'repositoryId' - 'grantId' <> '{}'::jsonb THEN
      RETURN false;
    END IF;
    FOR identity_value IN SELECT value FROM jsonb_each(binding->'grant') LOOP
      IF jsonb_typeof(identity_value) IS DISTINCT FROM 'string'
        OR octet_length(identity_value #>> '{}') NOT BETWEEN 1 AND 512
        OR (identity_value #>> '{}') ~ U&'[\0001-\001F\007F]' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
UPDATE occ.presets
SET template = jsonb_set(
  template #- '{agent,providerId}',
  '{agent,backendId}',
  template #> '{agent,providerId}',
  true
)
WHERE template #> '{agent,providerId}' IS NOT NULL
  AND template #> '{agent,backendId}' IS NULL;
--> statement-breakpoint
UPDATE occ.agents
SET harness_auth = (harness_auth - 'providerBinding'::text) || jsonb_build_object(
  'backendBinding',
  ((harness_auth->'providerBinding') - 'providerId'::text) || jsonb_build_object(
    'backendId', harness_auth #> '{providerBinding,providerId}'
  )
)
WHERE harness_auth ? 'providerBinding'
  AND NOT (harness_auth ? 'backendBinding');
--> statement-breakpoint
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
--> statement-breakpoint
DROP TRIGGER agent_revisions_are_immutable ON occ.agent_revisions;
--> statement-breakpoint
UPDATE occ.agent_revisions
SET admitted_spec = jsonb_set(
  admitted_spec,
  '{harness_auth}',
  ((admitted_spec->'harness_auth') - 'providerBinding'::text) || jsonb_build_object(
    'backendBinding',
    ((admitted_spec #> '{harness_auth,providerBinding}') - 'providerId'::text) || jsonb_build_object(
      'backendId', admitted_spec #> '{harness_auth,providerBinding,providerId}'
    )
  ),
  false
)
WHERE admitted_spec #> '{harness_auth,providerBinding}' IS NOT NULL
  AND admitted_spec #> '{harness_auth,backendBinding}' IS NULL;
--> statement-breakpoint
WITH rewritten AS (
  SELECT revision.namespace_id, revision.agent_id, revision.id,
    jsonb_agg(
      CASE
        WHEN binding ? 'providerId' AND NOT (binding ? 'backendId') THEN
          (binding - 'providerId'::text) || jsonb_build_object('backendId', binding->'providerId')
        ELSE binding
      END
      ORDER BY binding_position.ordinality
    ) AS bindings
  FROM occ.agent_revisions AS revision
  CROSS JOIN LATERAL jsonb_array_elements(admitted_spec #> '{repository_credentials,bindings}')
    WITH ORDINALITY AS binding_position(binding, ordinality)
  WHERE jsonb_typeof(admitted_spec #> '{repository_credentials,bindings}') = 'array'
    AND admitted_spec #> '{repository_credentials,bindings}' @? '$[*].providerId'
  GROUP BY revision.namespace_id, revision.agent_id, revision.id
)
UPDATE occ.agent_revisions AS revision
SET admitted_spec = jsonb_set(
  revision.admitted_spec,
  '{repository_credentials,bindings}',
  rewritten.bindings,
  false
)
FROM rewritten
WHERE revision.namespace_id = rewritten.namespace_id
  AND revision.agent_id = rewritten.agent_id
  AND revision.id = rewritten.id;
--> statement-breakpoint
DROP TRIGGER repository_session_attempts_guard ON occ.repository_session_attempts;
--> statement-breakpoint
UPDATE occ.repository_session_attempts
SET cleanup_context = jsonb_set(
  cleanup_context #- '{binding,providerId}',
  '{binding,backendId}',
  cleanup_context #> '{binding,providerId}',
  true
)
WHERE cleanup_context #> '{binding,providerId}' IS NOT NULL
  AND cleanup_context #> '{binding,backendId}' IS NULL;
--> statement-breakpoint
CREATE TRIGGER repository_session_attempts_guard
  BEFORE INSERT OR UPDATE ON occ.repository_session_attempts
  FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_session_attempt();
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
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'plugins' - 'repository_credentials') = '{}'::jsonb
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
  );
--> statement-breakpoint
CREATE TRIGGER agent_revisions_are_immutable
BEFORE UPDATE ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
DROP TRIGGER agent_provisioning_work_is_valid ON occ.agent_provisioning_work;
--> statement-breakpoint
UPDATE occ.agent_provisioning_work
SET plan = (plan - 'providerId'::text) || jsonb_build_object('backendId', plan->'providerId')
WHERE plan ? 'providerId'
  AND NOT (plan ? 'backendId');
--> statement-breakpoint
CREATE TRIGGER agent_provisioning_work_is_valid
BEFORE INSERT OR UPDATE ON occ.agent_provisioning_work
FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_provisioning_work();
--> statement-breakpoint
