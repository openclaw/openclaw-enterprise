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
          jsonb_typeof(binding->'sourceType') = 'string'
          AND (binding->>'sourceType') ~ '^[a-z][a-z0-9-]{0,63}$'
          AND CASE WHEN binding ? 'tokenServiceInstanceId' THEN
            (binding - 'method' - 'sourceId' - 'sourceType' - 'tokenServiceInstanceId') = '{}'::jsonb
            AND jsonb_typeof(binding->'tokenServiceInstanceId') = 'string'
            AND (binding->>'tokenServiceInstanceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          ELSE
            (binding - 'method' - 'sourceId' - 'credentialGatewayId' - 'sourceType' - 'loginMode') = '{}'::jsonb
            AND jsonb_typeof(binding->'credentialGatewayId') = 'string'
            AND btrim(binding->>'credentialGatewayId') <> ''
            AND jsonb_typeof(binding->'loginMode') = 'string'
            AND binding->>'loginMode' IN ('api_key', 'codex_pat', 'chatgptAuthTokens')
          END
        ELSE (binding - 'method' - 'sourceId') = '{}'::jsonb END
      ELSE false
    END, false);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.credential_source_snapshots_are_valid(snapshots jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  entry jsonb;
  owner_key text;
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
      OR entry - 'sourceId' - owner_key - 'sourceType' <> '{}'::jsonb
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
    ids := array_append(ids, entry->>'sourceId');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.deployment_request_matches_have_valid_shape(matches jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  item jsonb;
  port_range jsonb;
  request jsonb;
BEGIN
  IF jsonb_typeof(matches) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(matches) = 0 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(matches) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR NOT (item ?& ARRAY['binary', 'host', 'ports'])
      OR item - 'binary' - 'host' - 'ports' - 'requestPolicy' <> '{}'::jsonb
      OR jsonb_typeof(item->'binary') IS DISTINCT FROM 'string'
      OR char_length(item->>'binary') NOT BETWEEN 2 AND 512
      OR (item->>'binary') !~ '^/[^[:space:][:cntrl:]]+$'
      OR jsonb_typeof(item->'host') IS DISTINCT FROM 'string'
      OR char_length(item->>'host') NOT BETWEEN 1 AND 253
      OR (item->>'host') !~ '^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
      OR jsonb_typeof(item->'ports') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(item->'ports') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
    FOR port_range IN SELECT value FROM jsonb_array_elements(item->'ports') LOOP
      IF jsonb_typeof(port_range) IS DISTINCT FROM 'object'
        OR NOT (port_range ?& ARRAY['from', 'to'])
        OR port_range - 'from' - 'to' <> '{}'::jsonb
        OR jsonb_typeof(port_range->'from') IS DISTINCT FROM 'number'
        OR jsonb_typeof(port_range->'to') IS DISTINCT FROM 'number'
        OR (port_range->>'from') !~ '^[0-9]+$'
        OR (port_range->>'to') !~ '^[0-9]+$' THEN RETURN false; END IF;
      IF (port_range->>'from')::numeric < 1 OR (port_range->>'to')::numeric > 65535
        OR (port_range->>'from')::numeric > (port_range->>'to')::numeric THEN RETURN false; END IF;
    END LOOP;
    IF item ? 'requestPolicy' THEN
      request := item->'requestPolicy';
      IF jsonb_typeof(request) IS DISTINCT FROM 'object'
        OR NOT (request ?& ARRAY['type', 'method', 'path'])
        OR jsonb_typeof(request->'method') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(request->>'method'), '') = ''
        OR jsonb_typeof(request->'path') IS DISTINCT FROM 'string'
        OR left(request->>'path', 1) IS DISTINCT FROM '/'
        OR position('//' IN request->>'path') > 0 THEN RETURN false; END IF;
      IF request->>'type' = 'http' THEN
        IF request - 'type' - 'method' - 'path' <> '{}'::jsonb
          OR (request->>'method') !~ '^[A-Za-z0-9!#$%&''+.^_`|~-]+$' THEN RETURN false; END IF;
      ELSIF request->>'type' = 'mcp' THEN
        IF request - 'type' - 'method' - 'path' - 'toolName' <> '{}'::jsonb
          OR (request->>'method') ~ '[[:space:][:cntrl:]*?]'
          OR ((request->>'method') = 'tools/call') IS DISTINCT FROM (request ? 'toolName')
          OR (request ? 'toolName' AND (jsonb_typeof(request->'toolName') IS DISTINCT FROM 'string'
            OR COALESCE(btrim(request->>'toolName'), '') = ''
            OR (request->>'toolName') ~ '[[:space:][:cntrl:]*?]')) THEN RETURN false; END IF;
      ELSE RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.deployment_request_matches_have_valid_shape(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.deployment_request_matches_have_valid_shape(jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.standalone_credential_deployment_is_valid(spec jsonb, owner_namespace text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  policy jsonb := spec->'credential_deployment';
  auth jsonb := spec->'harness_auth';
  snapshots jsonb := spec->'credential_sources';
  snapshot jsonb;
  binding jsonb;
  injection jsonb;
BEGIN
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR NOT (policy ?& ARRAY['proxyDriverId', 'networkAccessPolicy', 'bindings', 'injectionPolicies'])
    OR policy - 'proxyDriverId' - 'networkAccessPolicy' - 'bindings' - 'injectionPolicies' <> '{}'::jsonb
    OR jsonb_typeof(policy->'proxyDriverId') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy->>'proxyDriverId'), '') = ''
    OR jsonb_typeof(policy->'networkAccessPolicy') IS DISTINCT FROM 'object'
    OR (policy->'networkAccessPolicy') - 'allowed' <> '{}'::jsonb
    OR NOT occ.deployment_request_matches_have_valid_shape(policy #> '{networkAccessPolicy,allowed}')
    OR jsonb_typeof(policy->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(policy->'injectionPolicies') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_typeof(auth) IS DISTINCT FROM 'object'
    OR auth->>'method' IS DISTINCT FROM 'credential_source'
    OR NOT (auth ? 'tokenServiceInstanceId')
    OR NOT occ.harness_auth_is_valid(auth, owner_namespace, true)
    OR NOT occ.credential_source_snapshots_are_valid(snapshots) THEN RETURN false; END IF;
  IF jsonb_array_length(policy->'bindings') <> 1 OR jsonb_array_length(policy->'injectionPolicies') <> 1
    OR jsonb_array_length(snapshots) <> 1 THEN RETURN false; END IF;
  snapshot := snapshots->0;
  binding := policy->'bindings'->0;
  injection := policy->'injectionPolicies'->0;
  IF snapshot->>'sourceId' IS DISTINCT FROM auth->>'sourceId'
    OR snapshot->>'sourceType' IS DISTINCT FROM auth->>'sourceType'
    OR snapshot->>'tokenServiceInstanceId' IS DISTINCT FROM auth->>'tokenServiceInstanceId'
    OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
    OR NOT (binding ?& ARRAY['bindingRef', 'sourceRef', 'consumer', 'projection'])
    OR binding - 'bindingRef' - 'sourceRef' - 'consumer' - 'projection' <> '{}'::jsonb
    OR jsonb_typeof(binding->'bindingRef') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(binding->>'bindingRef'), '') = ''
    OR jsonb_typeof(binding->'sourceRef') IS DISTINCT FROM 'object'
    OR NOT ((binding->'sourceRef') ?& ARRAY['kind', 'namespaceId', 'id'])
    OR (binding->'sourceRef') - 'kind' - 'namespaceId' - 'id' <> '{}'::jsonb
    OR binding #>> '{sourceRef,kind}' IS DISTINCT FROM 'credential_source'
    OR binding #>> '{sourceRef,namespaceId}' IS DISTINCT FROM owner_namespace
    OR binding #>> '{sourceRef,id}' IS DISTINCT FROM auth->>'sourceId'
    OR jsonb_typeof(binding->'consumer') IS DISTINCT FROM 'object'
    OR NOT ((binding->'consumer') ?& ARRAY['kind', 'providerId'])
    OR (binding->'consumer') - 'kind' - 'providerId' <> '{}'::jsonb
    OR binding #>> '{consumer,kind}' IS DISTINCT FROM 'model'
    OR jsonb_typeof(binding #> '{consumer,providerId}') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(binding #>> '{consumer,providerId}'), '') = ''
    OR jsonb_typeof(binding->'projection') IS DISTINCT FROM 'object'
    OR NOT ((binding->'projection') ?& ARRAY['environment', 'presentation'])
    OR (binding->'projection') - 'environment' - 'presentation' <> '{}'::jsonb
    OR jsonb_typeof(binding #> '{projection,environment}') IS DISTINCT FROM 'string'
    OR COALESCE(binding #>> '{projection,environment}', '') !~ '^[A-Za-z_][A-Za-z0-9_]*$'
    OR COALESCE(binding #>> '{projection,presentation}', '') NOT IN ('bearer', 'x-api-key')
    OR jsonb_typeof(injection) IS DISTINCT FROM 'object'
    OR NOT (injection ?& ARRAY['bindingRef', 'allowedRequests'])
    OR injection - 'bindingRef' - 'allowedRequests' <> '{}'::jsonb
    OR jsonb_typeof(injection->'bindingRef') IS DISTINCT FROM 'string'
    OR injection->>'bindingRef' IS DISTINCT FROM binding->>'bindingRef'
    OR NOT occ.deployment_request_matches_have_valid_shape(injection->'allowedRequests') THEN RETURN false; END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.standalone_credential_deployment_is_valid(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.standalone_credential_deployment_is_valid(jsonb, text) TO occ_app;
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
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id' - 'sandbox_policy'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins' - 'plugin_approvers'
      - 'repository_credentials' - 'egress_plan' - 'execution_admission' - 'credential_deployment') = '{}'::jsonb
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
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode' - 'overrides' - 'configuration') = '{}'::jsonb
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
    AND ((admitted_spec->'compute') - 'id' - 'implementation' - 'admission' - 'runtimeInputs') = '{}'::jsonb
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
      NOT ((admitted_spec->'compute') ? 'runtimeInputs')
      OR (jsonb_typeof(admitted_spec #> '{compute,runtimeInputs}') = 'string'
          AND char_length(admitted_spec #>> '{compute,runtimeInputs}') BETWEEN 1 AND 4096
          AND (admitted_spec #>> '{compute,runtimeInputs}') ~ '^[ -~]+$')
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
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_execution_admission,
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((admitted_spec->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
        AND (
          (admitted_spec->'execution_admission'->>'mode' = 'unprotected'
            AND admitted_spec #> '{execution_admission,version}' = '2'::jsonb
            AND NOT (admitted_spec ? 'egress_plan')
            AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion'))
          OR (admitted_spec->'execution_admission'->>'mode' = 'protected'
            AND admitted_spec ? 'egress_plan'
            AND admitted_spec #> '{harness_auth,protectedExecutionVersion}'
              = admitted_spec #> '{execution_admission,version}'
            AND (
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '7'
                  THEN admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7'))
                  = ((admitted_spec->'egress_plan') ? 'repositoryGit')
                AND (NOT ((admitted_spec->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(admitted_spec->'repository_credentials')='object'
                    AND admitted_spec #> '{egress_plan,repositoryGit}' = admitted_spec->'repository_credentials'))
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '5'
                    THEN admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    WHEN admitted_spec #>> '{execution_admission,version}' = '6' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'request-hook-observed'
                      AND admitted_spec #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                      AND jsonb_array_length(admitted_spec #> '{egress_plan,repositoryGit,bindings}') = 1
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
          OR (admitted_spec #>> '{execution_admission,mode}' = 'standalone'
            AND admitted_spec #> '{execution_admission,version}' = '8'::jsonb
            AND NOT (admitted_spec ? 'egress_plan')
            AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion')
            AND occ.standalone_credential_deployment_is_valid(admitted_spec, namespace_id))
        )
        AND (admitted_spec #>> '{execution_admission,mode}' = 'standalone' OR (
          NOT (admitted_spec ? 'credential_deployment')
          AND NOT ((admitted_spec->'harness_auth') ? 'tokenServiceInstanceId')
          AND NOT COALESCE(jsonb_path_exists(admitted_spec->'credential_sources', '$[*] ? (exists(@.tokenServiceInstanceId))'), false)
        )), false)) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
