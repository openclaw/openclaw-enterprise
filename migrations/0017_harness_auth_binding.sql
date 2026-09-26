DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.agents WHERE service_account_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM occ.agent_revisions) THEN
    RAISE EXCEPTION 'Legacy Agent authentication state is unsupported; explicit harness authentication bindings and new revisions are required' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE binding->>'method'
      WHEN 'api_key' THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source' - CASE WHEN resolved THEN 'secretDriverId' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'secret'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (jsonb_typeof(binding->'secretDriverId') = 'string' AND btrim(binding->>'secretDriverId') <> ''))
      WHEN 'chatgpt_service_account' THEN
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
ALTER TABLE occ.agents
  DROP CONSTRAINT agents_service_account_owner,
  DROP COLUMN service_account_id,
  ADD COLUMN harness_auth jsonb,
  ADD COLUMN harness_auth_secret_id text GENERATED ALWAYS AS (
    CASE WHEN harness_auth->>'method' = 'api_key' THEN harness_auth #>> '{source,id}' END
  ) STORED,
  ADD COLUMN harness_auth_service_account_id text GENERATED ALWAYS AS (
    CASE WHEN harness_auth->>'method' = 'chatgpt_service_account' THEN harness_auth->>'serviceAccountId' END
  ) STORED,
  ADD CONSTRAINT agents_harness_auth_valid CHECK (
    harness_auth IS NULL OR occ.harness_auth_is_valid(harness_auth, namespace_id, false)
  ),
  ADD CONSTRAINT agents_harness_auth_secret_owner FOREIGN KEY (namespace_id, harness_auth_secret_id)
    REFERENCES occ.secrets(namespace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT agents_harness_auth_service_account_owner FOREIGN KEY (namespace_id, harness_auth_service_account_id)
    REFERENCES occ.service_accounts(namespace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;
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
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'plugins') = '{}'::jsonb
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
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
  );

--> statement-breakpoint
GRANT UPDATE (harness_auth) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.harness_auth_is_valid(jsonb, text, boolean) TO occ_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.secret_bindings_are_valid(
  bindings jsonb,
  expected_namespace_id text
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    jsonb_typeof(bindings) = 'object'
    AND expected_namespace_id
      ~ '^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (SELECT count(*) FROM jsonb_each(bindings)) <= 64
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(bindings) AS entry(destination, binding)
      WHERE destination !~ '^[A-Za-z_][A-Za-z0-9_]{0,252}$'
        OR destination ~* '^(OPENCLAW_|CODEX_|OCC_|KUBERNETES_|KUBECONFIG$|APP_SERVER_|NODE_|LD_|DYLD_|PYTHON|SSL_|TLS_|NPM_|PNPM_|OTEL_)'
        OR upper(destination) IN (
          'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'ENV', 'BASH_ENV',
          'IFS', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY',
          'ALL_PROXY', 'NO_PROXY'
        )
        OR upper(destination) LIKE 'OPENAI\_%' ESCAPE '\'
        OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
        OR NOT (binding ? 'source')
        OR binding - 'source' - 'delivery' <> '{}'::jsonb
        OR jsonb_typeof(binding->'source') IS DISTINCT FROM 'object'
        OR NOT ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        OR (binding->'source') - 'kind' - 'namespaceId' - 'id' <> '{}'::jsonb
        OR jsonb_typeof(binding #> '{source,kind}') IS DISTINCT FROM 'string'
        OR binding #>> '{source,kind}' <> 'secret'
        OR jsonb_typeof(binding #> '{source,namespaceId}') IS DISTINCT FROM 'string'
        OR binding #>> '{source,namespaceId}' IS DISTINCT FROM expected_namespace_id
        OR jsonb_typeof(binding #> '{source,id}') IS DISTINCT FROM 'string'
        OR binding #>> '{source,id}'
          !~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR (
          binding ? 'delivery'
          AND (
            jsonb_typeof(binding->'delivery') IS DISTINCT FROM 'object'
            OR NOT ((binding->'delivery') ? 'type')
            OR (binding->'delivery') - 'type' <> '{}'::jsonb
            OR jsonb_typeof(binding #> '{delivery,type}') IS DISTINCT FROM 'string'
            OR binding #>> '{delivery,type}' <> 'env'
          )
        )
    );
$$;

--> statement-breakpoint
ALTER TABLE occ.configurations DROP CONSTRAINT configurations_secret_bindings_valid,
  ADD CONSTRAINT configurations_secret_bindings_valid CHECK (
    secret_bindings IS NULL OR occ.secret_bindings_are_valid(secret_bindings, namespace_id)
  );
