CREATE OR REPLACE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE binding->>'method'
      WHEN 'runtime' THEN binding = '{"method":"runtime"}'::jsonb
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
          - CASE WHEN resolved THEN 'providerBinding' ELSE 'method' END) = '{}'::jsonb
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
          AND jsonb_typeof(binding->'providerBinding') = 'object'
          AND ((binding->'providerBinding') ?& ARRAY['providerId', 'driverId', 'workspaceId', 'credentialIssued'])
          AND ((binding->'providerBinding') - 'providerId' - 'driverId' - 'workspaceId' - 'credentialIssued') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{providerBinding,providerId}') = 'string'
          AND btrim(binding #>> '{providerBinding,providerId}') <> ''
          AND jsonb_typeof(binding #> '{providerBinding,driverId}') = 'string'
          AND btrim(binding #>> '{providerBinding,driverId}') <> ''
          AND jsonb_typeof(binding #> '{providerBinding,workspaceId}') = 'string'
          AND btrim(binding #>> '{providerBinding,workspaceId}') <> ''
          AND binding #> '{providerBinding,credentialIssued}' = 'true'::jsonb
        ))
      ELSE false
    END, false);
$$;
