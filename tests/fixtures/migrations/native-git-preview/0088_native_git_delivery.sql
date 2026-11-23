CREATE FUNCTION occ.repository_git_network_admission_is_valid(spec jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
  SELECT COALESCE(
    (NOT input.native OR (
      spec #> '{execution_admission,version}' = '8'::jsonb
      AND spec #> '{execution_admission,repositoryNetworkPolicyVersion}' = '1'::jsonb
      AND spec #> '{sandbox_policy,repositoryNetworkPolicy,version}' = '1'::jsonb
      AND CASE WHEN jsonb_typeof(input.grants) = 'array'
        THEN jsonb_array_length(input.grants) > 0 AND occ.sandbox_repository_grants_are_valid(input.grants)
        ELSE false END
      AND NOT (input.repository ? 'standingApprovalId')
      AND CASE WHEN jsonb_typeof(input.deadline) = 'number'
        THEN input.deadline::numeric BETWEEN 1 AND 9007199254740991
          AND trunc(input.deadline::numeric) = input.deadline::numeric
        ELSE false END
      AND occ.repository_bindings_are_valid(input.bindings, true)
      AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(input.bindings) = 'array' THEN input.bindings
            ELSE '[]'::jsonb END
        ) AS member(binding)
        WHERE member.binding->>'profile' IS DISTINCT FROM 'github-repository'
      )
    )), false
  )
  FROM (
    SELECT COALESCE(spec #>> '{execution_admission,version}' = '8', false) AS native,
      spec->'repository_credentials' AS repository,
      spec #> '{repository_credentials,bindings}' AS bindings,
      spec #> '{repository_credentials,deadlineWallMs}' AS deadline,
      spec #> '{sandbox_policy,repositoryNetworkPolicy,grants}' AS grants
  ) AS input;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_git_network_admission_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_execution_admission,
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND occ.repository_git_network_admission_is_valid(admitted_spec)
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
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7','8')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '7'
                  THEN admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7','8'))
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
                    WHEN admitted_spec #>> '{execution_admission,version}' = '8' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'network-policy'
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
        ), false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_standing_repository_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE version integer; credentials jsonb; predecessor occ.repository_session_attempts; ceiling bigint; now_ms bigint;
BEGIN
 IF TG_OP='UPDATE' AND NEW.broker_protocol<>OLD.broker_protocol THEN
   RAISE EXCEPTION 'Repository session authority is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.phase NOT IN ('opening','open') THEN RETURN NEW; END IF;
 SELECT admitted_spec->'repository_credentials', (admitted_spec #>> '{execution_admission,version}')::int
 INTO credentials,version FROM occ.agent_revisions
 WHERE id=NEW.revision_id AND namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id;
 IF ((NEW.broker_protocol=2) IS DISTINCT FROM (version IN (4,5,6,7,8))) THEN
   RAISE EXCEPTION 'Repository session requires its admitted sender' USING ERRCODE='23514';
 END IF;
 IF NOT coalesce(credentials ? 'standingApprovalId',false) THEN
   IF NEW.predecessor_admission_id IS NULL THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Finite repository admission cannot succeed another session' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM occ.agents WHERE id=NEW.agent_id AND namespace_id=NEW.namespace_id
   AND status='active' AND desired_runtime_state='running' FOR SHARE;
 IF NOT FOUND OR NOT occ.repository_standing_approval_is_current(credentials,NEW.namespace_id,NEW.agent_id) THEN
   RAISE EXCEPTION 'Standing repository session requires current approval and running Agent' USING ERRCODE='23514';
 END IF;
 IF NEW.predecessor_admission_id IS NOT NULL THEN
   IF (TG_OP='INSERT' AND NEW.broker_protocol NOT IN (2,3))
     OR NOT occ.repository_standing_execution_is_current(credentials,NEW.namespace_id,NEW.agent_id,NEW.revision_id)
     OR NOT EXISTS (SELECT FROM occ.repository_standing_executions
          WHERE revision_id=NEW.revision_id AND fingerprint=NEW.execution_fingerprint AND NOT closed) THEN
     RAISE EXCEPTION 'Repository successor requires the same current standing execution' USING ERRCODE='23514';
   END IF;
   IF TG_OP='INSERT' THEN
     SELECT s.* INTO predecessor FROM occ.repository_session_attempts s LEFT JOIN occ.repository_broker_receipts b USING (admission_id)
       WHERE s.admission_id=NEW.predecessor_admission_id AND s.phase='disposed' AND s.broker_protocol=NEW.broker_protocol
         AND (CASE WHEN NEW.broker_protocol=2 THEN b.admission_id IS NULL
                   ELSE b.state='disposed' AND b.session_id=s.session_id END);
     IF NOT FOUND THEN RAISE EXCEPTION 'Repository predecessor disposal is unconfirmed' USING ERRCODE='23514'; END IF;
     SELECT (scope->>'maximumSessionDurationSeconds')::bigint INTO ceiling FROM occ.repository_standing_approvals
       WHERE id=credentials->>'standingApprovalId' AND revoked_at IS NULL;
     now_ms := floor(extract(epoch FROM clock_timestamp())*1000);
     IF (NEW.namespace_id,NEW.agent_id,NEW.revision_id,NEW.cleanup_context) IS DISTINCT FROM
        (predecessor.namespace_id,predecessor.agent_id,predecessor.revision_id,predecessor.cleanup_context)
       OR ceiling IS NULL OR NEW.duration_seconds>ceiling OR NEW.deadline_wall_ms<=greatest(predecessor.deadline_wall_ms,now_ms)
       OR NEW.deadline_wall_ms>least(now_ms,extract(epoch FROM NEW.created_at)*1000)+NEW.duration_seconds*1000 THEN
       RAISE EXCEPTION 'Repository successor exceeds its admitted scope or session duration' USING ERRCODE='23514';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END; $$;
