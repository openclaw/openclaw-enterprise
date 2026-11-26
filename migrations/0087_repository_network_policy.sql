CREATE FUNCTION occ.sandbox_repository_grants_are_valid(grants jsonb) RETURNS boolean
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
        OR grant_entry - 'repository' - 'access' <> '{}'::jsonb
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
REVOKE ALL ON FUNCTION occ.sandbox_repository_grants_are_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.sandbox_repository_grants_are_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.sandbox_policies
  DROP CONSTRAINT sandbox_policies_document_valid,
  ADD CONSTRAINT sandbox_policies_document_valid CHECK (
    occ.sandbox_policy_is_valid(document - 'repositoryNetworkPolicy', id, namespace_id, agent_id, version)
    AND (
      NOT (document ? 'repositoryNetworkPolicy')
      OR occ.sandbox_repository_grants_are_valid(document->'repositoryNetworkPolicy')
    )
  );
--> statement-breakpoint
-- Preserve the existing admission modes and plan checks. The additional key
-- fences readers that cannot enforce a stored repository network policy.
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_execution_admission,
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((admitted_spec->'execution_admission') - 'version' - 'mode' - 'repositoryNetworkPolicyVersion') = '{}'::jsonb
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
        ), false)),
  ADD CONSTRAINT agent_revisions_repository_policy_reader_version CHECK (
    CASE WHEN (admitted_spec->'sandbox_policy') ? 'repositoryNetworkPolicy'
      THEN admitted_spec #> '{execution_admission,repositoryNetworkPolicyVersion}' IS NOT DISTINCT FROM '1'::jsonb
        AND admitted_spec #> '{sandbox_policy,repositoryNetworkPolicy,version}' IS NOT DISTINCT FROM '1'::jsonb
      ELSE NOT COALESCE((admitted_spec->'execution_admission') ? 'repositoryNetworkPolicyVersion', false)
    END
  );
--> statement-breakpoint
CREATE FUNCTION occ.guard_sandbox_repository_policy_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF (OLD.document ? 'repositoryNetworkPolicy' AND NOT (NEW.document ? 'repositoryNetworkPolicy'))
    OR (NEW.version = OLD.version
      AND NEW.document->'repositoryNetworkPolicy' IS DISTINCT FROM OLD.document->'repositoryNetworkPolicy') THEN
    RAISE EXCEPTION 'Invalid repository network policy transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.document ? 'application' AND (
    NEW.document ? 'repositoryNetworkPolicy'
    OR EXISTS (
      SELECT 1 FROM occ.agent_revisions
      WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
        AND id = NEW.document#>>'{application,revisionId}'
        AND (admitted_spec->'sandbox_policy') ? 'repositoryNetworkPolicy'
    )
  ) THEN
    RAISE EXCEPTION 'Repository network policy requires a new deployment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sandbox_repository_policy_transition_valid BEFORE UPDATE ON occ.sandbox_policies
FOR EACH ROW EXECUTE FUNCTION occ.guard_sandbox_repository_policy_update();
--> statement-breakpoint
CREATE FUNCTION occ.guard_sandbox_repository_policy_revision() RETURNS trigger
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
    format('{"repository":%s,"access":%s}', to_json(grant_entry->>'repository'), to_json(grant_entry->>'access')),
    ',' ORDER BY position
  ), '') || ']}' INTO expected_identity
    FROM jsonb_array_elements(desired_grants) WITH ORDINALITY AS entries(grant_entry, position);
  IF admitted_policy->'identity' IS DISTINCT FROM to_jsonb(expected_identity) THEN
    RAISE EXCEPTION 'Revision repository network policy identity is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sandbox_repository_policy_revision_valid BEFORE INSERT ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.guard_sandbox_repository_policy_revision();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_sandbox_repository_policy_update(), occ.guard_sandbox_repository_policy_revision() FROM PUBLIC;
