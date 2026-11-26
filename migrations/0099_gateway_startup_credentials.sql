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
          'ALL_PROXY', 'NO_PROXY', 'LOG_FORMAT', 'RUST_LOG'
        )
        OR destination ~* '^(OPENAI_|ANTHROPIC_|OCE_MODEL_API_KEY$)'
        OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
        OR NOT (binding ? 'source')
        OR binding - 'source' - 'delivery' <> '{}'::jsonb
        OR jsonb_typeof(binding->'source') IS DISTINCT FROM 'object'
        OR NOT ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        OR (binding->'source') - 'kind' - 'namespaceId' - 'id' <> '{}'::jsonb
        OR jsonb_typeof(binding #> '{source,kind}') IS DISTINCT FROM 'string'
        OR binding #>> '{source,kind}' NOT IN ('secret', 'credential_source')
        OR jsonb_typeof(binding #> '{source,namespaceId}') IS DISTINCT FROM 'string'
        OR binding #>> '{source,namespaceId}' IS DISTINCT FROM expected_namespace_id
        OR jsonb_typeof(binding #> '{source,id}') IS DISTINCT FROM 'string'
        OR CASE binding #>> '{source,kind}'
          WHEN 'secret' THEN binding #>> '{source,id}'
            !~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          WHEN 'credential_source' THEN binding #>> '{source,id}'
            !~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          ELSE true
        END
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
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'occ.agent_revisions'::regclass
    AND conname = 'agent_revisions_admitted_snapshot';
  IF definition IS NULL OR position('- ''secret_bindings''::text' IN definition) = 0 THEN
    RAISE EXCEPTION 'Agent revision snapshot constraint does not contain the expected binding key';
  END IF;
  ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
  EXECUTE 'ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot '
    || replace(definition, '- ''secret_bindings''::text',
      '- ''secret_bindings''::text - ''gateway_token_service_instance_id''::text');
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_gateway_token_service_owner CHECK (
  CASE WHEN COALESCE(jsonb_path_exists(admitted_spec->'secret_bindings',
    '$.* ? (@.source.kind == "credential_source")'), false)
  THEN jsonb_typeof(admitted_spec->'gateway_token_service_instance_id') = 'string'
    AND admitted_spec->>'gateway_token_service_instance_id'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ELSE NOT (admitted_spec ? 'gateway_token_service_instance_id') END IS TRUE
);
