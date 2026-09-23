ALTER TABLE occ.controller_work
  ADD COLUMN work_kind text NOT NULL DEFAULT 'lifecycle',
  ADD CONSTRAINT controller_work_kind_valid CHECK (work_kind IN ('lifecycle', 'provisioning'));
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NOT NULL
      AND namespace_target IN ('ready', 'deleted') AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NOT NULL
      AND agent_target IN ('stopped', 'deleted'))
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
    OR (work_kind = 'provisioning' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
  );
--> statement-breakpoint
CREATE TABLE occ.agent_provisioning_work (
  work_id text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text,
  configuration_id text,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL,
  completed_phase text NOT NULL,
  revision_id text,
  plan jsonb NOT NULL,
  progress jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_provisioning_work_work_owner
    FOREIGN KEY (work_id)
    REFERENCES occ.controller_work(idempotency_key)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT agent_provisioning_work_agent_owner
    FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT agent_provisioning_work_configuration_owner
    FOREIGN KEY (namespace_id, configuration_id)
    REFERENCES occ.configurations(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT agent_provisioning_work_revision_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_provisioning_request_unique
    UNIQUE (namespace_id, actor_id, request_id),
  CONSTRAINT agent_provisioning_agent_unique UNIQUE (namespace_id, agent_id),
  CONSTRAINT agent_provisioning_configuration_unique UNIQUE (namespace_id, configuration_id),
  CONSTRAINT agent_provisioning_status_valid CHECK (
    status IN ('queued', 'running', 'failed', 'succeeded', 'cancelled')
  ),
  CONSTRAINT agent_provisioning_phase_valid CHECK (
    completed_phase IN ('admitted', 'configuration', 'transport', 'handoff')
  ),
  CONSTRAINT agent_provisioning_fingerprint_valid CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT agent_provisioning_json_objects CHECK (
    jsonb_typeof(plan) = 'object'
    AND jsonb_typeof(progress) = 'object'
  ),
  CONSTRAINT agent_provisioning_revision_requires_handoff CHECK (
    revision_id IS NULL OR (completed_phase = 'handoff' AND agent_id IS NOT NULL)
  ),
  CONSTRAINT agent_provisioning_success_requires_handoff CHECK (
    status <> 'succeeded' OR (
      completed_phase = 'handoff'
      AND agent_id IS NOT NULL
      AND configuration_id IS NOT NULL
      AND revision_id IS NOT NULL
    )
  ),
  CONSTRAINT agent_provisioning_failed_before_handoff CHECK (
    status NOT IN ('failed', 'cancelled') OR revision_id IS NULL
  )
);
--> statement-breakpoint
CREATE FUNCTION occ.validate_agent_provisioning_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_phase_rank_old integer;
  v_phase_rank_new integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM occ.controller_work AS work
    WHERE work.idempotency_key = NEW.work_id
      AND work.work_kind = 'provisioning'
      AND work.namespace_id = NEW.namespace_id
      AND work.agent_id IS NULL
      AND work.actor_id = NEW.actor_id
      AND work.revision_id IS NULL
      AND work.namespace_target IS NULL
      AND work.agent_target IS NULL
  ) THEN
    RAISE EXCEPTION 'agent provisioning work must match its exact controller work owner'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('failed', 'succeeded', 'cancelled') AND NEW IS DISTINCT FROM OLD
       AND NOT (
         OLD.status = 'failed' AND NEW.status = 'queued'
         AND (to_jsonb(NEW) - 'status' - 'updated_at') =
             (to_jsonb(OLD) - 'status' - 'updated_at')
       )
       AND NOT (
         OLD.status = 'failed' AND NEW.status = 'cancelled'
         AND (to_jsonb(NEW) - 'status' - 'progress' - 'updated_at') =
             (to_jsonb(OLD) - 'status' - 'progress' - 'updated_at')
         AND NEW.progress = OLD.progress ||
           jsonb_build_object('error', NEW.progress->'error')
         AND jsonb_typeof(NEW.progress->'error') = 'object'
       )
       AND NOT (
         OLD.status IN ('failed', 'cancelled')
         AND NEW.status = OLD.status
         AND (to_jsonb(NEW) - 'progress' - 'updated_at') =
             (to_jsonb(OLD) - 'progress' - 'updated_at')
         AND (
           (
             OLD.progress ? 'pendingEffect'
             AND NOT (OLD.progress ? 'effectReceipt')
             AND NEW.progress ? 'pendingEffect'
             AND NEW.progress ? 'effectReceipt'
             AND NEW.progress->'pendingEffect' = OLD.progress->'pendingEffect'
             AND NEW.progress = OLD.progress ||
               jsonb_build_object('effectReceipt', NEW.progress->'effectReceipt')
             AND NEW.progress->'effectReceipt'->>'kind' =
               OLD.progress->'pendingEffect'->>'kind'
             AND NEW.progress->'effectReceipt'->>'owner' =
               OLD.progress->'pendingEffect'->>'owner'
             AND NEW.progress->'effectReceipt'->>'targetId' =
               OLD.progress->'pendingEffect'->>'targetId'
           )
         )
       ) THEN
      RAISE EXCEPTION 'terminal agent provisioning work is immutable' USING ERRCODE = '23514';
    END IF;

    IF NEW.work_id IS DISTINCT FROM OLD.work_id
       OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
       OR NEW.plan IS DISTINCT FROM OLD.plan THEN
      RAISE EXCEPTION 'agent provisioning accepted plan is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
      RAISE EXCEPTION 'agent provisioning Agent ID is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.configuration_id IS NOT NULL
       AND NEW.configuration_id IS DISTINCT FROM OLD.configuration_id THEN
      RAISE EXCEPTION 'agent provisioning Configuration ID is immutable' USING ERRCODE = '23514';
    END IF;

    v_phase_rank_old := CASE OLD.completed_phase
      WHEN 'admitted' THEN 0
      WHEN 'configuration' THEN 1
      WHEN 'transport' THEN 2
      WHEN 'handoff' THEN 3
    END;
    v_phase_rank_new := CASE NEW.completed_phase
      WHEN 'admitted' THEN 0
      WHEN 'configuration' THEN 1
      WHEN 'transport' THEN 2
      WHEN 'handoff' THEN 3
    END;
    IF v_phase_rank_new < v_phase_rank_old THEN
      RAISE EXCEPTION 'agent provisioning progress is monotonic' USING ERRCODE = '23514';
    END IF;
    IF OLD.revision_id IS NOT NULL AND NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN
      RAISE EXCEPTION 'agent provisioning handoff revision is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_provisioning_work_is_valid
BEFORE INSERT OR UPDATE ON occ.agent_provisioning_work
FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_provisioning_work();
--> statement-breakpoint
REVOKE ALL ON occ.agent_provisioning_work FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.agent_provisioning_work TO occ_app;
--> statement-breakpoint
GRANT UPDATE (
  status,
  completed_phase,
  agent_id,
  configuration_id,
  revision_id,
  progress,
  updated_at
) ON occ.agent_provisioning_work TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.finalize_agent_deletion(
  p_namespace_id text,
  p_agent_id text,
  p_idempotency_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  v_service_principal_id text;
  v_actor_id text;
  v_attempt_count integer;
BEGIN
  SELECT work.actor_id, work.attempt_count
    INTO v_actor_id, v_attempt_count
  FROM occ.controller_work AS work
  WHERE work.idempotency_key = p_idempotency_key
    AND work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NULL
    AND work.agent_target = 'deleted'
    AND work.work_kind = 'lifecycle'
    AND work.state = 'claimed'
    AND work.claim_token = p_claim_token
    AND work.lease_expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM namespace.id FROM occ.namespaces AS namespace
  WHERE namespace.id = p_namespace_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT agent.service_principal_id
    INTO v_service_principal_id
  FROM occ.agents AS agent
  WHERE agent.namespace_id = p_namespace_id
    AND agent.id = p_agent_id
    AND agent.status = 'deleting'
    AND agent.desired_runtime_state = 'stopped'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM attempt.admission_id FROM occ.repository_session_attempts AS attempt
  WHERE attempt.namespace_id = p_namespace_id AND attempt.agent_id = p_agent_id
  ORDER BY attempt.revision_id, attempt.admission_id FOR UPDATE;

  -- Revalidate lease time after every potentially blocking ownership lock.
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work AS work
    WHERE work.idempotency_key = p_idempotency_key AND work.claim_token = p_claim_token
      AND work.state = 'claimed' AND work.lease_expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM occ.repository_session_attempts AS attempt
    WHERE attempt.namespace_id = p_namespace_id AND attempt.agent_id = p_agent_id
      AND attempt.phase <> 'disposed'
  ) THEN
    -- NULL is a live claim with outstanding cleanup, distinct from claim loss.
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.agent_provisioning_work AS provisioning
    JOIN occ.controller_work AS work ON work.idempotency_key = provisioning.work_id
    WHERE provisioning.namespace_id = p_namespace_id
      AND provisioning.agent_id = p_agent_id
      AND (
        (
          provisioning.progress ? 'pendingEffect'
          AND NOT (
            provisioning.progress ? 'effectReceipt'
            AND provisioning.progress->'effectReceipt'->>'kind' =
              provisioning.progress->'pendingEffect'->>'kind'
            AND provisioning.progress->'effectReceipt'->>'owner' =
              provisioning.progress->'pendingEffect'->>'owner'
            AND provisioning.progress->'effectReceipt'->>'targetId' =
              provisioning.progress->'pendingEffect'->>'targetId'
          )
        )
        OR (
          provisioning.progress ? 'effectReceipt'
          AND NOT (provisioning.progress ? 'pendingEffect')
        )
        OR provisioning.status IN ('queued', 'running')
        OR work.state IN ('queued', 'claimed')
      )
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE occ.repository_session_attempts SET live_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id
    AND live_revision_id IS NOT NULL;

  UPDATE occ.agents
  SET active_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  DELETE FROM occ.iam_access_bindings AS binding
  WHERE binding.identity_subject_id = v_service_principal_id
    OR (binding.resource_kind = 'agent' AND binding.resource_id = p_agent_id)
    OR (binding.resource_kind = 'agent_revision' AND binding.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.iam_restrictions AS restriction
  WHERE (restriction.resource_kind = 'agent' AND restriction.resource_id = p_agent_id)
    OR (restriction.resource_kind = 'agent_revision' AND restriction.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.apikey WHERE reference_id = v_service_principal_id;
  DELETE FROM occ.controller_work AS work
  USING occ.agent_provisioning_work AS provisioning
  WHERE work.idempotency_key = provisioning.work_id
    AND provisioning.namespace_id = p_namespace_id
    AND provisioning.agent_id = p_agent_id
    AND work.work_kind = 'provisioning';
  DELETE FROM occ.agent_revisions
    WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  DELETE FROM occ.iam_identities
    WHERE id = v_service_principal_id
      AND namespace_id = p_namespace_id
      AND agent_id = p_agent_id
      AND kind = 'service_principal';
  DELETE FROM occ.agents
    WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  INSERT INTO occ.audit_events (
    id, occurred_at, kind, actor_id, action, namespace_id,
    resource_kind, resource_id, outcome, details
  ) VALUES (
    'aud_' || pg_catalog.gen_random_uuid()::text,
    pg_catalog.clock_timestamp(),
    'mutation',
    v_actor_id,
    'openclaw.agents.lifecycle.delete',
    p_namespace_id,
    'agent',
    p_agent_id,
    'success',
    pg_catalog.jsonb_build_object(
      'reasonCode', 'AGENT_DELETED',
      'attemptCount', v_attempt_count
    )
  );

  DELETE FROM occ.controller_work
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  RETURN true;
END;
$$;
