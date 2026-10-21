-- Install before admitting v5. Older workers reject that revision; v4 remains exact dispatch.
-- No existing admission, recipient, possible use or custody obligation is reinterpreted.
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
            AND CASE admitted_spec #>> '{execution_admission,version}'
              WHEN '2' THEN NOT ((admitted_spec->'egress_plan') ?| ARRAY['driver','repositoryGit','repositoryGitAuthorization'])
              ELSE
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5')
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5'))
                  = ((admitted_spec->'egress_plan') ? 'repositoryGit')
                AND (NOT ((admitted_spec->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(admitted_spec->'repository_credentials')='object'
                    AND admitted_spec #> '{egress_plan,repositoryGit}' = admitted_spec->'repository_credentials'))
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '5'
                    THEN admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              END)
        ), false)) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_standing_repository_session()RETURNS trigger
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
 IF ((NEW.broker_protocol=2) IS DISTINCT FROM (version IN (4,5))) THEN
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
   IF NEW.broker_protocol NOT IN (1,2)
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
--> statement-breakpoint

-- A reply deadline records possible use, not an assertion that the sender enforces a send cutoff.
ALTER TABLE occ.prepared_repository_git_uses
  ALTER COLUMN send_start_by DROP NOT NULL,
  ADD COLUMN authorization_reply_by timestamptz,
  ADD CONSTRAINT prepared_repository_git_uses_decision_deadline
    CHECK (num_nonnulls(send_start_by, authorization_reply_by) = 1) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.prepared_repository_git_uses VALIDATE CONSTRAINT prepared_repository_git_uses_decision_deadline;
--> statement-breakpoint

-- A reply deadline records possible use, not an assertion that the sender enforces a send cutoff.
ALTER TABLE occ.prepared_repository_draft_pulls
  ALTER COLUMN send_start_by DROP NOT NULL,
  ADD COLUMN authorization_reply_by timestamptz,
  ADD CONSTRAINT prepared_repository_draft_pulls_decision_deadline
    CHECK (num_nonnulls(send_start_by, authorization_reply_by) = 1) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.prepared_repository_draft_pulls VALIDATE CONSTRAINT prepared_repository_draft_pulls_decision_deadline;
--> statement-breakpoint
