CREATE OR REPLACE FUNCTION occ.observer_create_dispatch_evidence_is_valid(evidence jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
 SELECT COALESCE(
  jsonb_typeof(evidence) = 'object'
  AND evidence ?& ARRAY['invocationId', 'dispatchedAt']
  AND evidence - ARRAY['invocationId', 'dispatchedAt'] = '{}'::jsonb
  AND jsonb_typeof(evidence->'invocationId') = 'string'
  AND char_length(evidence->>'invocationId') BETWEEN 1 AND 512
  AND jsonb_typeof(evidence->'dispatchedAt') = 'string'
  AND occ.observer_invocation_timestamp_is_valid(evidence->>'dispatchedAt') IS TRUE,
  false
 );
$$;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_create_dispatch_evidence_is_valid(jsonb) TO occ_app;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION occ.observer_invocation_progress_is_valid(progress jsonb, plan jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
BEGIN
  IF jsonb_typeof(progress) IS DISTINCT FROM 'object'
    OR progress - ARRAY['observerAbsence', 'targetResolution', 'observerCreateDispatch', 'observer', 'readiness', 'terminal', 'cleanup', 'retryResume']
      <> '{}'::jsonb
  THEN
    RETURN false;
  END IF;

  IF progress ? 'retryResume' THEN
 IF jsonb_typeof(progress->'retryResume') IS DISTINCT FROM 'object'
 OR NOT (progress->'retryResume') ?& ARRAY['failedPhase', 'resumeFrom']
 OR (progress->'retryResume') - ARRAY['failedPhase', 'resumeFrom'] <> '{}'::jsonb
 OR progress #>> '{retryResume,failedPhase}' NOT IN ('admitted', 'target_resolved', 'observer_created', 'ready', 'terminal', 'cleanup')
 OR progress #>> '{retryResume,resumeFrom}' NOT IN ('target_resolution', 'observer_creation_reconciliation', 'cleanup')
 OR (progress #>> '{retryResume,resumeFrom}' = 'target_resolution' AND NOT (progress ? 'cleanup' OR progress ? 'observerAbsence'))
 OR (progress #>> '{retryResume,resumeFrom}' = 'observer_creation_reconciliation' AND (progress #>> '{retryResume,failedPhase}' <> 'observer_created' OR NOT progress ? 'observerCreateDispatch' OR progress ? 'observer'))
 OR (progress #>> '{retryResume,resumeFrom}' = 'cleanup' AND progress #>> '{retryResume,failedPhase}' <> 'cleanup')
 THEN
 RETURN false;
 END IF;
 END IF;

 IF progress ? 'observerAbsence' THEN
    IF (occ.observer_absence_evidence_is_valid(progress->'observerAbsence')) IS DISTINCT FROM true
      OR progress ?| ARRAY['observer', 'readiness', 'terminal', 'cleanup']
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'targetResolution'
    AND (occ.observer_target_resolution_is_valid(progress->'targetResolution')) IS DISTINCT FROM true
  THEN
    RETURN false;
  END IF;

  IF progress ? 'observerCreateDispatch' THEN
  IF NOT progress ? 'targetResolution'
  OR progress ? 'observerAbsence'
  OR (occ.observer_create_dispatch_evidence_is_valid(progress->'observerCreateDispatch')) IS DISTINCT FROM true
  THEN
   RETURN false;
  END IF;
 END IF;

 IF progress ? 'observer' THEN
    IF NOT progress ? 'targetResolution'
      OR (occ.observer_container_evidence_is_valid(progress->'observer')) IS DISTINCT FROM true
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'readiness' THEN
    IF NOT progress ? 'targetResolution'
      OR NOT progress ? 'observer'
      OR (occ.observer_readiness_evidence_is_valid(progress->'readiness', plan, progress)) IS DISTINCT FROM true
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'terminal' THEN
    IF NOT progress ? 'observer'
      OR (occ.observer_terminal_evidence_is_valid(progress->'terminal', plan)) IS DISTINCT FROM true
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'cleanup' THEN
    IF NOT progress ? 'terminal'
      OR (occ.observer_cleanup_evidence_is_valid(progress->'cleanup', plan)) IS DISTINCT FROM true
    THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_invocation_progress_is_valid(jsonb, jsonb) TO occ_app;

--> statement-breakpoint

ALTER TABLE occ.observer_invocations
 DROP CONSTRAINT observer_invocation_status_phase_valid,
 ADD CONSTRAINT observer_invocation_status_phase_valid CHECK (
 (completed_phase = 'admitted' AND status = 'queued')
 OR (completed_phase IN ('target_resolved', 'observer_created', 'ready', 'terminal')
 AND status IN ('queued', 'running'))
 OR (completed_phase = 'cleanup' AND status IN ('succeeded', 'failed', 'cancelled'))
 OR (completed_phase = 'cleanup' AND status = 'running'
 AND progress #>> '{retryResume,resumeFrom}' IN ('target_resolution', 'cleanup'))
);

--> statement-breakpoint

ALTER TABLE occ.observer_invocations
 DROP CONSTRAINT observer_invocation_terminal_outcome_valid,
 ADD CONSTRAINT observer_invocation_terminal_outcome_valid CHECK (
 completed_phase <> 'cleanup'
 OR (status = 'running' AND progress ? 'retryResume'
 AND (progress ? 'observerAbsence' OR progress ? 'cleanup'))
 OR (progress ? 'observerAbsence' AND status IN ('failed', 'cancelled'))
 OR (NOT progress ? 'observerAbsence'
 AND status = 'succeeded'
 AND progress #>> '{terminal,stopOutcome}' = 'succeeded')
 OR (NOT progress ? 'observerAbsence'
 AND status = 'cancelled'
 AND progress #>> '{terminal,stopOutcome}' = 'cancelled')
 OR (NOT progress ? 'observerAbsence'
 AND status = 'failed'
 AND progress #>> '{terminal,stopOutcome}' IN ('failed', 'timed_out'))
);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION occ.validate_observer_invocation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_phase_rank integer;
  new_phase_rank integer;
 retry_reset boolean;

 reconciliation_completed boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work AS work
    WHERE work.idempotency_key = NEW.work_id
      AND work.work_kind = 'observer'
      AND work.namespace_id = NEW.namespace_id
      AND work.agent_id = NEW.agent_id
      AND work.revision_id = NEW.revision_id
      AND work.actor_id = NEW.actor_id
      AND work.namespace_target IS NULL
      AND work.agent_target IS NULL
  ) THEN
    RAISE EXCEPTION 'observer invocation must match its exact controller work owner'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.progress ? 'observerCreateDispatch'
 AND NEW.progress #>> '{observerCreateDispatch,invocationId}' <> NEW.work_id
 THEN
  RAISE EXCEPTION 'observer create dispatch must identify its exact invocation'
  USING ERRCODE = '23514';
 END IF;

 IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal observer invocation is immutable' USING ERRCODE = '23514';
    END IF;

    IF NEW.work_id IS DISTINCT FROM OLD.work_id
      OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
      OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
      OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
      OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
      OR NEW.request_id IS DISTINCT FROM OLD.request_id
      OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
      OR NEW.target_role IS DISTINCT FROM OLD.target_role
      OR NEW.qualification IS DISTINCT FROM OLD.qualification
      OR NEW.plan IS DISTINCT FROM OLD.plan
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'observer invocation accepted identity and authority are immutable'
        USING ERRCODE = '23514';
    END IF;

    old_phase_rank := CASE OLD.completed_phase
      WHEN 'admitted' THEN 0
      WHEN 'target_resolved' THEN 1
      WHEN 'observer_created' THEN 2
      WHEN 'ready' THEN 3
      WHEN 'terminal' THEN 4
      WHEN 'cleanup' THEN 5
    END;
    new_phase_rank := CASE NEW.completed_phase
      WHEN 'admitted' THEN 0
      WHEN 'target_resolved' THEN 1
      WHEN 'observer_created' THEN 2
      WHEN 'ready' THEN 3
      WHEN 'terminal' THEN 4
      WHEN 'cleanup' THEN 5
    END;
    retry_reset := OLD.completed_phase = 'cleanup'
 AND OLD.status = 'running'
 AND OLD.progress #>> '{retryResume,resumeFrom}' = 'target_resolution'
 AND NEW.completed_phase = 'target_resolved'
 AND NEW.status = 'running'
 AND (SELECT count(*) FROM jsonb_each(NEW.progress)) = 1
 AND NEW.progress ? 'targetResolution';

 reconciliation_completed := OLD.completed_phase = 'target_resolved'
 AND OLD.status = 'running'
 AND OLD.progress #>> '{retryResume,resumeFrom}' = 'observer_creation_reconciliation'
 AND OLD.progress ? 'observerCreateDispatch'
 AND NOT OLD.progress ? 'observer'
 AND NEW.completed_phase = 'observer_created'
 AND NEW.status = 'running'
 AND NEW.progress ? 'observer'
 AND NOT NEW.progress ? 'retryResume';
 IF new_phase_rank < old_phase_rank AND NOT retry_reset THEN
 RAISE EXCEPTION 'observer invocation progress is monotonic' USING ERRCODE = '23514';
 END IF;
 IF NOT retry_reset AND EXISTS (
 SELECT 1
 FROM jsonb_each(OLD.progress) AS prior(key, value)
 WHERE (prior.key <> 'retryResume' OR NOT reconciliation_completed)
 AND (NOT NEW.progress ? prior.key OR NEW.progress->prior.key IS DISTINCT FROM prior.value)
 ) THEN
 RAISE EXCEPTION 'observer invocation evidence is append-only' USING ERRCODE = '23514';
 END IF;
 END IF;

 RETURN NEW;
END;
$$;
