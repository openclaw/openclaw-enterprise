-- Match the two authenticated requests without recording the outbound HTTP request or token.
CREATE TABLE occ.request_credential_approvals (
  recipient_id text NOT NULL,
  request_id text NOT NULL,
  binding_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  policy_digest text NOT NULL,
  driver_ref jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (recipient_id, request_id),
  CONSTRAINT request_credential_approval_revision FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE,
  CONSTRAINT request_credential_approval_digest CHECK (policy_digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX request_credential_approvals_expiry ON occ.request_credential_approvals(expires_at);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE, UPDATE (consumed) ON occ.request_credential_approvals TO occ_app;
--> statement-breakpoint
-- Request-authorized models cannot inherit strict-dispatch or Harness authority.
CREATE FUNCTION occ.request_model_plan_is_valid(plan jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    plan->>'authorization' = 'online-request'
    AND NOT (plan ? 'harnessCredentialSource')
    AND NOT (plan ? 'policyReductionVersion')
    AND CASE WHEN jsonb_typeof(plan->'routes') = 'array' THEN
      jsonb_array_length(plan->'routes') > 0
      AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(plan->'routes') AS route
        WHERE route #>> '{binding,grant,kind}' IS DISTINCT FROM 'inference'
          OR jsonb_typeof(route #> '{binding,source,source,id}') IS DISTINCT FROM 'string'
          OR length(route #>> '{binding,source,source,id}') = 0
      )
      AND (SELECT count(DISTINCT route #>> '{binding,source,source,id}') = 1
           FROM jsonb_array_elements(plan->'routes') AS route)
    ELSE false END,
    false)
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.request_model_plan_is_valid(jsonb) TO occ_app;
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
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7','8','9')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '7'
                  THEN admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7','9'))
                  = ((admitted_spec->'egress_plan') ? 'repositoryGit')
                AND (NOT ((admitted_spec->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(admitted_spec->'repository_credentials')='object'
                    AND admitted_spec #> '{egress_plan,repositoryGit}' = admitted_spec->'repository_credentials'))
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' IN ('5','9')
                    THEN admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    WHEN admitted_spec #>> '{execution_admission,version}' = '6' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'request-hook-observed'
                      AND admitted_spec #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                      AND jsonb_array_length(admitted_spec #> '{egress_plan,repositoryGit,bindings}') = 1
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' IN ('8','9')
                  THEN admitted_spec #> '{execution_admission,version}' IN ('8'::jsonb,'9'::jsonb)
                    AND occ.request_model_plan_is_valid(admitted_spec->'egress_plan')
                  ELSE NOT (admitted_spec->'egress_plan' ? 'authorization') END
                AND jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
        ), false));
--> statement-breakpoint
-- v9 retains the same OCC-owned Git session and standing-approval checks.
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
 IF ((NEW.broker_protocol=2) IS DISTINCT FROM (version IN (4,5,6,7,9))) THEN
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
