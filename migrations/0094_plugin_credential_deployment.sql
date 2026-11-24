-- An admitted Plugin Source records the Template version used to intersect its requests.
CREATE OR REPLACE FUNCTION occ.credential_source_snapshots_are_valid(snapshots jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  entry jsonb;
  owner_key text;
  template jsonb;
  template_version numeric;
  ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(snapshots) = 0
    OR jsonb_array_length(snapshots) > 64 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    owner_key := CASE
      WHEN entry ? 'tokenServiceInstanceId' THEN 'tokenServiceInstanceId'
      WHEN entry ? 'credentialProxyId' THEN 'credentialProxyId'
      ELSE 'credentialGatewayId'
    END;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT (entry ?& ARRAY['sourceId', owner_key, 'sourceType'])
      OR entry - 'sourceId' - owner_key - 'sourceType' - 'connectionTemplate' <> '{}'::jsonb
      OR jsonb_typeof(entry->'sourceId') IS DISTINCT FROM 'string'
      OR (entry->>'sourceId') !~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (entry->>'sourceId') = ANY(ids)
      OR jsonb_typeof(entry->owner_key) IS DISTINCT FROM 'string'
      OR COALESCE(btrim(entry->>owner_key), '') = ''
      OR (owner_key = 'tokenServiceInstanceId' AND (entry->>owner_key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR jsonb_typeof(entry->'sourceType') IS DISTINCT FROM 'string'
      OR (entry->>'sourceType') !~ '^[a-z][a-z0-9-]{0,63}$' THEN
      RETURN false;
    END IF;
    IF entry ? 'connectionTemplate' THEN
      template := entry->'connectionTemplate';
      IF owner_key <> 'tokenServiceInstanceId' OR jsonb_typeof(template) IS DISTINCT FROM 'object'
        OR template - 'id' - 'version' <> '{}'::jsonb
        OR jsonb_typeof(template->'id') IS DISTINCT FROM 'string'
        OR (template->>'id') !~ '^ctp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(template->'version') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      template_version := (template->>'version')::numeric;
      IF template_version NOT BETWEEN 1 AND 2147483647 OR trunc(template_version) <> template_version THEN RETURN false; END IF;
    END IF;
    ids := array_append(ids, entry->>'sourceId');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.standalone_credential_deployment_is_valid(spec jsonb, owner_namespace text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  policy jsonb := spec->'credential_deployment';
  auth jsonb := spec->'harness_auth';
  snapshots jsonb := spec->'credential_sources';
  snapshot jsonb;
  binding jsonb;
  injection jsonb;
  requested jsonb;
  requested_port jsonb;
  covered boolean;
  binding_refs text[] := '{}';
  environments text[] := '{}';
  model_bindings integer := 0;
  consumer_keys text[] := '{}';
  consumer_key text;
BEGIN
  IF spec ? 'repository_credentials'
    OR jsonb_typeof(spec->'sandbox_driver_id') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(spec->>'sandbox_driver_id'), '') = ''
    OR jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR NOT (policy ?& ARRAY['driver', 'proxyDriverId', 'networkAccessPolicy', 'bindings', 'injectionPolicies'])
    OR policy - 'driver' - 'proxyDriverId' - 'networkAccessPolicy' - 'bindings' - 'injectionPolicies' <> '{}'::jsonb
    OR jsonb_typeof(policy->'driver') IS DISTINCT FROM 'object'
    OR NOT ((policy->'driver') ?& ARRAY['id', 'implementation', 'configurationId'])
    OR (policy->'driver') - 'id' - 'implementation' - 'configurationId' <> '{}'::jsonb
    OR jsonb_typeof(policy #> '{driver,id}') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy #>> '{driver,id}'), '') = ''
    OR jsonb_typeof(policy #> '{driver,implementation}') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy #>> '{driver,implementation}'), '') = ''
    OR jsonb_typeof(policy #> '{driver,configurationId}') IS DISTINCT FROM 'string'
    OR (policy #>> '{driver,configurationId}') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(policy->'proxyDriverId') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy->>'proxyDriverId'), '') = ''
    OR jsonb_typeof(policy->'networkAccessPolicy') IS DISTINCT FROM 'object'
    OR (policy->'networkAccessPolicy') - 'allowed' <> '{}'::jsonb
    OR NOT occ.deployment_request_matches_have_valid_shape(policy #> '{networkAccessPolicy,allowed}')
    OR jsonb_typeof(policy->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(policy->'injectionPolicies') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_typeof(auth) IS DISTINCT FROM 'object'
    OR NOT occ.harness_auth_is_valid(auth, owner_namespace, true)
    OR NOT occ.credential_source_snapshots_are_valid(snapshots) THEN RETURN false; END IF;
  IF jsonb_array_length(policy->'bindings') = 0
    OR jsonb_array_length(policy->'bindings') <> jsonb_array_length(policy->'injectionPolicies') THEN RETURN false; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(policy->'bindings') LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
      OR NOT (binding ?& ARRAY['bindingRef', 'sourceRef', 'consumer', 'projection'])
      OR binding - 'bindingRef' - 'sourceRef' - 'consumer' - 'projection' <> '{}'::jsonb
      OR jsonb_typeof(binding->'bindingRef') IS DISTINCT FROM 'string'
      OR COALESCE(btrim(binding->>'bindingRef'), '') = ''
      OR (binding->>'bindingRef') = ANY(binding_refs)
      OR jsonb_typeof(binding->'sourceRef') IS DISTINCT FROM 'object'
      OR NOT ((binding->'sourceRef') ?& ARRAY['kind', 'namespaceId', 'id'])
      OR (binding->'sourceRef') - 'kind' - 'namespaceId' - 'id' <> '{}'::jsonb
      OR binding #>> '{sourceRef,kind}' IS DISTINCT FROM 'credential_source'
      OR binding #>> '{sourceRef,namespaceId}' IS DISTINCT FROM owner_namespace
      OR jsonb_typeof(binding->'consumer') IS DISTINCT FROM 'object'
      OR jsonb_typeof(binding->'projection') IS DISTINCT FROM 'object'
      OR NOT ((binding->'projection') ?& ARRAY['environment', 'presentation'])
      OR (binding->'projection') - 'environment' - 'presentation' <> '{}'::jsonb
      OR jsonb_typeof(binding #> '{projection,environment}') IS DISTINCT FROM 'string'
      OR COALESCE(binding #>> '{projection,environment}', '') !~ '^[A-Za-z_][A-Za-z0-9_]*$'
      OR (binding #>> '{projection,environment}') = ANY(environments) THEN RETURN false; END IF;
    binding_refs := array_append(binding_refs, binding->>'bindingRef');
    environments := array_append(environments, binding #>> '{projection,environment}');
    SELECT value INTO snapshot FROM jsonb_array_elements(snapshots)
      WHERE value->>'sourceId' = binding #>> '{sourceRef,id}';
    IF snapshot IS NULL OR COALESCE(btrim(snapshot->>'tokenServiceInstanceId'), '') = '' THEN RETURN false; END IF;
    IF binding #>> '{consumer,kind}' = 'model' THEN
      model_bindings := model_bindings + 1;
      IF model_bindings <> 1 OR auth->>'method' IS DISTINCT FROM 'credential_source'
        OR snapshot->>'sourceId' IS DISTINCT FROM auth->>'sourceId'
        OR snapshot->>'sourceType' IS DISTINCT FROM auth->>'sourceType'
        OR snapshot->>'tokenServiceInstanceId' IS DISTINCT FROM auth->>'tokenServiceInstanceId'
        OR NOT ((binding->'consumer') ?& ARRAY['kind', 'providerId'])
        OR (binding->'consumer') - 'kind' - 'providerId' <> '{}'::jsonb
        OR jsonb_typeof(binding #> '{consumer,providerId}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,providerId}'), '') = ''
        OR COALESCE(binding #>> '{projection,presentation}', '') NOT IN ('bearer', 'x-api-key') THEN RETURN false; END IF;
    ELSIF binding #>> '{consumer,kind}' = 'plugin' THEN
      IF snapshot->>'sourceType' NOT IN ('static', 'oauth2-refresh-token')
        OR NOT (snapshot ? 'connectionTemplate')
        OR NOT ((binding->'consumer') ?& ARRAY['kind', 'pluginId', 'requirement', 'connection'])
        OR (binding->'consumer') - 'kind' - 'pluginId' - 'requirement' - 'connection' <> '{}'::jsonb
        OR jsonb_typeof(binding #> '{consumer,pluginId}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,pluginId}'), '') = ''
        OR jsonb_typeof(binding #> '{consumer,requirement}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,requirement}'), '') = ''
        OR jsonb_typeof(binding #> '{consumer,connection}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,connection}'), '') = ''
        OR spec #> ARRAY['plugins','plugins',binding #>> '{consumer,pluginId}','enabled'] IS DISTINCT FROM 'true'::jsonb
        OR binding #>> '{projection,presentation}' IS DISTINCT FROM 'bearer' THEN RETURN false; END IF;
      consumer_key := jsonb_build_array(binding #>> '{consumer,pluginId}', binding #>> '{consumer,requirement}', binding #>> '{consumer,connection}')::text;
      IF consumer_key = ANY(consumer_keys) THEN RETURN false; END IF;
      consumer_keys := array_append(consumer_keys, consumer_key);
    ELSE RETURN false; END IF;
    SELECT value INTO injection FROM jsonb_array_elements(policy->'injectionPolicies')
      WHERE value->>'bindingRef' = binding->>'bindingRef';
    IF injection IS NULL OR jsonb_typeof(injection) IS DISTINCT FROM 'object'
      OR NOT (injection ?& ARRAY['bindingRef', 'allowedRequests'])
      OR injection - 'bindingRef' - 'allowedRequests' <> '{}'::jsonb
      OR jsonb_typeof(injection->'bindingRef') IS DISTINCT FROM 'string'
      OR NOT occ.deployment_request_matches_have_valid_shape(injection->'allowedRequests')
      OR jsonb_array_length(injection->'allowedRequests') = 0 THEN RETURN false; END IF;
    FOR requested IN SELECT value FROM jsonb_array_elements(injection->'allowedRequests') LOOP
      IF binding #>> '{consumer,kind}' = 'plugin'
        AND requested #>> '{requestPolicy,type}' IS DISTINCT FROM 'http' THEN RETURN false; END IF;
      FOR requested_port IN SELECT value FROM jsonb_array_elements(requested->'ports') LOOP
        SELECT COALESCE(
          range_agg(int4range((allowed_port.value->>'from')::integer,
                              (allowed_port.value->>'to')::integer + 1, '[)'))
            @> int4range((requested_port->>'from')::integer,
                         (requested_port->>'to')::integer + 1, '[)'), false)
        INTO covered
        FROM jsonb_array_elements(policy #> '{networkAccessPolicy,allowed}') AS network(value)
        CROSS JOIN LATERAL jsonb_array_elements(network.value->'ports') AS allowed_port(value)
        WHERE network.value->>'binary' = requested->>'binary'
          AND (
            network.value->>'host' = requested->>'host'
            OR (left(network.value->>'host', 2) = '*.'
              AND left(requested->>'host', 2) <> '*.'
              AND length(requested->>'host') > length(network.value->>'host') - 1
              AND right(requested->>'host', length(network.value->>'host') - 1)
                = substring(network.value->>'host' FROM 2)
              AND position('.' IN left(requested->>'host',
                length(requested->>'host') - length(network.value->>'host') + 1)) = 0)
          )
          AND (
            NOT (network.value ? 'requestPolicy')
            OR (network.value #>> '{requestPolicy,type}' = 'http'
              AND requested #>> '{requestPolicy,type}' = 'http'
              AND network.value #>> '{requestPolicy,method}' = requested #>> '{requestPolicy,method}'
              AND (
                network.value #>> '{requestPolicy,path}' = requested #>> '{requestPolicy,path}'
                OR (right(network.value #>> '{requestPolicy,path}', 3) = '/**'
                  AND (requested #>> '{requestPolicy,path}'
                      = left(network.value #>> '{requestPolicy,path}',
                             length(network.value #>> '{requestPolicy,path}') - 3)
                    OR left(requested #>> '{requestPolicy,path}',
                            length(network.value #>> '{requestPolicy,path}') - 2)
                      = left(network.value #>> '{requestPolicy,path}',
                             length(network.value #>> '{requestPolicy,path}') - 3) || '/'))
              ))
            OR (network.value #>> '{requestPolicy,type}' = 'mcp'
              AND network.value->'requestPolicy' = requested->'requestPolicy')
          );
        IF NOT covered THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF auth->>'method' = 'credential_source' AND auth ? 'tokenServiceInstanceId'
    AND model_bindings <> 1 THEN RETURN false; END IF;
  FOR snapshot IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'bindings') AS b(value)
      WHERE b.value #>> '{sourceRef,id}' = snapshot->>'sourceId') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
