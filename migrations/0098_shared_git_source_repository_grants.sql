-- A shared Source can cover more repositories than the Agent selected.
-- Still match every saved Agent grant to one verified repository in that Source.
CREATE OR REPLACE FUNCTION occ.guard_sandbox_repository_policy_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  desired_grants jsonb;
  desired_version integer;
  desired_access jsonb;
  admitted_policy jsonb := NEW.admitted_spec#>'{sandbox_policy,repositoryNetworkPolicy}';
  expected_identity text;
  source_binding jsonb;
  source_scope jsonb;
  desired_repository jsonb;
  admitted_binding jsonb;
  verified_repository jsonb;
  repository_pin text;
  matched integer;
  used_ids text[] := ARRAY[]::text[];
  derived_grants jsonb := '[]'::jsonb;
BEGIN
  -- Follow the normal Agent-before-policy lock order and serialize with policy saves.
  SELECT repository_access INTO desired_access FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id FOR KEY SHARE;
  SELECT document->'repositoryNetworkPolicy', version INTO desired_grants, desired_version
    FROM occ.sandbox_policies
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id FOR SHARE;

  IF desired_access ? 'githubAppClientId' AND jsonb_array_length(desired_access->'repositories') > 0 THEN
    IF desired_grants IS NOT NULL OR admitted_policy IS NULL
      OR jsonb_typeof(NEW.admitted_spec#>'{credential_deployment,bindings}') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.admitted_spec#>'{repository_credentials,bindings}') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Revision repository network policy must match the saved GitHub access' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), (jsonb_agg(value))->0 INTO matched, source_binding
      FROM jsonb_array_elements(NEW.admitted_spec#>'{credential_deployment,bindings}') AS entries(value)
      WHERE value#>>'{consumer,kind}' = 'repository';
    IF matched <> 1 OR source_binding#>>'{sourceRef,kind}' IS DISTINCT FROM 'credential_source'
      OR source_binding#>>'{sourceRef,namespaceId}' IS DISTINCT FROM NEW.namespace_id THEN
      RAISE EXCEPTION 'Revision repository Source must match the saved GitHub access' USING ERRCODE = '23514';
    END IF;
    SELECT github_app_scope INTO source_scope FROM occ.credential_sources
      WHERE namespace_id=NEW.namespace_id AND id=source_binding#>>'{sourceRef,id}'
        AND owner_capability='token_service' AND type='github-app-installation' AND state='ready'
        AND github_app_client_id=desired_access->>'githubAppClientId'
        AND token_service_instance_id=NEW.admitted_spec#>>'{harness_auth,tokenServiceInstanceId}'
      FOR SHARE;
    IF source_scope IS NULL
      OR jsonb_array_length(NEW.admitted_spec#>'{repository_credentials,bindings}') <> jsonb_array_length(desired_access->'repositories') THEN
      RAISE EXCEPTION 'Revision repository Source must match the saved GitHub access' USING ERRCODE = '23514';
    END IF;
    FOR desired_repository IN SELECT value FROM jsonb_array_elements(desired_access->'repositories') LOOP
      SELECT count(*), (jsonb_agg(value))->0 INTO matched, admitted_binding
        FROM jsonb_array_elements(NEW.admitted_spec#>'{repository_credentials,bindings}') AS entries(value)
        WHERE value->>'repositoryRef'=desired_repository->>'repositoryRef' AND value->>'profile'='github-repository';
      IF matched <> 1 THEN
        RAISE EXCEPTION 'Revision repository bindings must match the saved GitHub access' USING ERRCODE = '23514';
      END IF;
      repository_pin := admitted_binding#>>'{grant,repositoryId}';
      SELECT count(*), (jsonb_agg(value))->0 INTO matched, verified_repository
        FROM jsonb_array_elements(source_scope->'repositories') AS entries(value)
        WHERE repository_pin=value->>'repositoryId'
          OR repository_pin='github-repository:' || lower((value->>'repository') COLLATE "C")
          OR repository_pin='github-repository:' || split_part(lower((value->>'repository') COLLATE "C"), '/', 2);
      IF matched <> 1 OR verified_repository->>'repositoryId'=ANY(used_ids)
        OR COALESCE(desired_repository->>'access', '') NOT IN ('read','write')
        OR COALESCE(source_scope#>>'{permissions,contents}', '') NOT IN ('read','write')
        OR (desired_repository->>'access'='write' AND source_scope#>>'{permissions,contents}'<>'write') THEN
        RAISE EXCEPTION 'Revision repository grants must match the saved GitHub access' USING ERRCODE = '23514';
      END IF;
      used_ids := array_append(used_ids, verified_repository->>'repositoryId');
      derived_grants := derived_grants || jsonb_build_array(jsonb_build_object(
        'repository', lower((verified_repository->>'repository') COLLATE "C"),
        'access', desired_repository->>'access'
      ));
    END LOOP;
    SELECT jsonb_agg(value ORDER BY value->>'repository' COLLATE "C") INTO desired_grants
      FROM jsonb_array_elements(derived_grants) AS entries(value);
    desired_version := COALESCE(desired_version, 1);
  END IF;

  IF desired_grants IS NULL AND admitted_policy IS NULL THEN
    RETURN NEW;
  END IF;
  IF desired_grants IS NULL OR admitted_policy IS NULL
    OR (CASE WHEN jsonb_typeof(admitted_policy) = 'object' THEN
      admitted_policy - 'version' - 'grants' - 'identity' <> '{}'::jsonb
    ELSE true END)
    OR admitted_policy->'grants' IS DISTINCT FROM desired_grants
    OR admitted_policy->'version' IS DISTINCT FROM '1'::jsonb
    OR NEW.admitted_spec#>'{sandbox_policy,version}' IS DISTINCT FROM to_jsonb(desired_version) THEN
    RAISE EXCEPTION 'Revision repository network policy must match the saved policy' USING ERRCODE = '23514';
  END IF;
  SELECT '{"version":1,"grants":[' || COALESCE(string_agg(
    -- Encode keys in the same order as the Agent contract, independent of jsonb storage order.
    format('{"repository":%s,"access":%s%s}', to_json(grant_entry->>'repository'), to_json(grant_entry->>'access'),
      CASE WHEN grant_entry ? 'apiLimits'
        THEN ',"apiLimits":{' || (
          SELECT string_agg(to_json(resource)::text || ':' || level::text, ',' ORDER BY resource COLLATE "C")
          FROM jsonb_each(grant_entry->'apiLimits') AS limits(resource, level)
        ) || '}'
        ELSE '' END),
    ',' ORDER BY position
  ), '') || ']}' INTO expected_identity
    FROM jsonb_array_elements(desired_grants) WITH ORDINALITY AS entries(grant_entry, position);
  IF admitted_policy->'identity' IS DISTINCT FROM to_jsonb(expected_identity) THEN
    RAISE EXCEPTION 'Revision repository network policy identity is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
