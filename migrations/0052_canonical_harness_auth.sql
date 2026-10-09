CREATE OR REPLACE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE
      WHEN binding->>'method' = 'runtime' THEN binding = '{"method":"runtime"}'::jsonb
      WHEN binding->>'method' IN ('api_key', 'codex_pat')
        AND binding #>> '{source,kind}' = 'secret' THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source' - CASE WHEN resolved THEN 'secretDriverId' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'secret'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (jsonb_typeof(binding->'secretDriverId') = 'string' AND btrim(binding->>'secretDriverId') <> ''))
      WHEN binding->>'method' = 'codex_pat' THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source'
          - CASE WHEN resolved THEN 'credential' ELSE 'method' END
          - CASE WHEN resolved THEN 'backendBinding' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'service_account'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
      WHEN binding->>'method' = 'credential_source' THEN
        (binding ?& ARRAY['method', 'sourceId'])
        AND jsonb_typeof(binding->'sourceId') = 'string'
        AND (binding->>'sourceId') ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND CASE WHEN resolved THEN
          (binding - 'method' - 'sourceId' - 'credentialGatewayId' - 'sourceType' - 'loginMode') = '{}'::jsonb
          AND jsonb_typeof(binding->'credentialGatewayId') = 'string'
          AND btrim(binding->>'credentialGatewayId') <> ''
          AND jsonb_typeof(binding->'sourceType') = 'string'
          AND (binding->>'sourceType') ~ '^[a-z][a-z0-9-]{0,63}$'
          AND jsonb_typeof(binding->'loginMode') = 'string'
          AND binding->>'loginMode' IN ('api_key', 'chatgptAuthTokens')
        ELSE (binding - 'method' - 'sourceId') = '{}'::jsonb END
      ELSE false
    END, false);
$$;
--> statement-breakpoint
-- Retired OAuth Secret bindings are unsupported development state.
-- Reject them before accepting the external credential-source mode.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM occ.agents
    WHERE harness_auth IS NOT NULL
      AND NOT occ.harness_auth_is_valid(harness_auth, namespace_id, false)
  ) OR EXISTS (
    SELECT 1 FROM occ.agent_revisions
    WHERE NOT occ.harness_auth_is_valid(admitted_spec->'harness_auth', namespace_id, true)
  ) OR EXISTS (
    SELECT 1 FROM occ.agent_provisioning_work
    WHERE plan->'harnessAuth' IS NOT NULL AND plan->'harnessAuth' <> 'null'::jsonb
      AND NOT occ.harness_auth_is_valid(plan->'harnessAuth', namespace_id, false)
  ) THEN
    RAISE EXCEPTION 'Unsupported legacy OAuth authentication: recreate development Agents, revisions, and provisioning requests before migrating'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
