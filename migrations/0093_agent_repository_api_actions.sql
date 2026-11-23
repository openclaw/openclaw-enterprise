-- Reconstruct the canonical subset to reject duplicate, unknown or unordered
-- actions. An empty allow list blocks every API action. Empty deny is omitted.
CREATE FUNCTION occ.repository_api_actions_are_valid(actions jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
  SELECT EXISTS (
    SELECT 1 FROM (VALUES ('allow'), ('deny')) AS modes(mode)
    WHERE actions = jsonb_build_object(mode, ARRAY(
      SELECT action FROM unnest(ARRAY[
        'issues:read', 'issues:create', 'pull_requests:read', 'pull_requests:create'
      ]) WITH ORDINALITY AS known(action, position)
      WHERE (actions->mode) ? action
      ORDER BY position
    ))
      AND actions <> '{"deny":[]}'::jsonb
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.repository_api_actions_are_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_api_actions_are_valid(jsonb) TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.sandbox_repository_grants_are_valid(grants jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
  SELECT CASE
    WHEN jsonb_typeof(grants) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(grants) > 32 THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM (
        SELECT grant_entry,
          lag(grant_entry->>'repository') OVER (ORDER BY position) AS previous_repository
        FROM jsonb_array_elements(grants) WITH ORDINALITY AS entries(grant_entry, position)
      ) AS grants_in_order
      WHERE CASE WHEN jsonb_typeof(grant_entry) = 'object' THEN
        NOT (grant_entry ?& ARRAY['repository', 'access'])
        OR grant_entry - 'repository' - 'access' - 'apiActions' <> '{}'::jsonb
        OR (grant_entry ? 'apiActions' AND NOT occ.repository_api_actions_are_valid(grant_entry->'apiActions'))
        OR jsonb_typeof(grant_entry->'repository') <> 'string'
        OR grant_entry->>'repository' !~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,99}$'
        OR right(grant_entry->>'repository', 4) = '.git'
        OR jsonb_typeof(grant_entry->'access') <> 'string'
        OR grant_entry->>'access' NOT IN ('read', 'write')
        OR previous_repository COLLATE "C" >= (grant_entry->>'repository') COLLATE "C"
      ELSE true END
    )
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_sandbox_repository_policy_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  desired_grants jsonb;
  desired_version integer;
  admitted_policy jsonb := NEW.admitted_spec#>'{sandbox_policy,repositoryNetworkPolicy}';
  expected_identity text;
BEGIN
  -- Follow the normal Agent-before-policy lock order and serialize with policy saves.
  PERFORM 1 FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id FOR KEY SHARE;
  SELECT document->'repositoryNetworkPolicy', version INTO desired_grants, desired_version
    FROM occ.sandbox_policies
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id FOR SHARE;
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
    -- Match JSON.stringify key order. Validated action identifiers contain no
    -- spaces, so removing jsonb separator spaces preserves the single-key filter.
    format('{"repository":%s,"access":%s%s}', to_json(grant_entry->>'repository'), to_json(grant_entry->>'access'),
      CASE WHEN grant_entry ? 'apiActions'
        THEN ',"apiActions":' || replace((grant_entry->'apiActions')::text, ' ', '')
        ELSE '' END),
    ',' ORDER BY position
  ), '') || ']}' INTO expected_identity
    FROM jsonb_array_elements(desired_grants) WITH ORDINALITY AS entries(grant_entry, position);
  IF admitted_policy->'identity' IS DISTINCT FROM to_jsonb(expected_identity) THEN
    RAISE EXCEPTION 'Revision repository network policy identity is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
