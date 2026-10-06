-- A succeeded provisioning record may release the Configuration it created once
-- its Agent selects another one, so that Configuration can be deleted normally.
-- The release only clears configuration_id; every other column stays immutable.
ALTER TABLE occ.agent_provisioning_work
DROP CONSTRAINT agent_provisioning_success_requires_handoff,
ADD CONSTRAINT agent_provisioning_success_requires_handoff CHECK (
  status <> 'succeeded' OR (
    completed_phase = 'handoff'
    AND agent_id IS NOT NULL
    AND revision_id IS NOT NULL
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.validate_agent_provisioning_work() RETURNS trigger
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

  IF NEW.status = 'succeeded' AND NEW.configuration_id IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status <> 'succeeded') THEN
    RAISE EXCEPTION 'agent provisioning success requires its Configuration' USING ERRCODE = '23514';
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
       )
       AND NOT (
         -- Release: the provisioned Agent no longer selects the Configuration.
         OLD.status = 'succeeded' AND NEW.status = 'succeeded'
         AND OLD.configuration_id IS NOT NULL AND NEW.configuration_id IS NULL
         AND (to_jsonb(NEW) - 'configuration_id' - 'updated_at') =
             (to_jsonb(OLD) - 'configuration_id' - 'updated_at')
         AND NOT EXISTS (
           SELECT 1 FROM occ.agents AS agent
           WHERE agent.namespace_id = OLD.namespace_id
             AND agent.id = OLD.agent_id
             AND agent.configuration_id = OLD.configuration_id
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
    -- A succeeded record reaches here with a changed Configuration only as a release.
    IF OLD.configuration_id IS NOT NULL
       AND NEW.configuration_id IS DISTINCT FROM OLD.configuration_id
       AND NOT (OLD.status = 'succeeded' AND NEW.configuration_id IS NULL) THEN
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
