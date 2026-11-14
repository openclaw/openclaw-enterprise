CREATE FUNCTION occ.control_plane_audit_capacity_available() RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  configured text := nullif(current_setting('occ.control_plane_audit_max_bytes', true), '');
  max_bytes bigint := 1073741824;
BEGIN
  IF configured IS NOT NULL THEN
    IF configured !~ '^[1-9][0-9]{0,15}$' THEN
      RAISE EXCEPTION 'Invalid control plane audit storage budget'
        USING ERRCODE = '53400', CONSTRAINT = 'control_plane_audit_capacity';
    END IF;
    max_bytes := configured::bigint;
  END IF;
  RETURN pg_total_relation_size('occ.audit_events'::regclass) < max_bytes;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.control_plane_audit_capacity_available() FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.control_plane_audit_capacity_available() TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.guard_control_plane_audit_append() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF octet_length(row_to_json(NEW)::text) > 8192 THEN
    RAISE EXCEPTION 'Control plane audit event exceeds its size limit'
      USING ERRCODE = '53400', CONSTRAINT = 'control_plane_audit_event_size';
  END IF;
  IF NOT occ.control_plane_audit_capacity_available() THEN
    RAISE EXCEPTION 'Control plane audit storage budget reached'
      USING ERRCODE = '53400', CONSTRAINT = 'control_plane_audit_capacity';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER control_plane_audit_append_limits
BEFORE INSERT ON occ.audit_events FOR EACH ROW
WHEN (NEW.action IN (
  'openclaw.api.request.admitted',
  'openclaw.api.request.result',
  'openclaw.controller_work.queued',
  'openclaw.controller_work.claimed',
  'openclaw.controller_work.deferred',
  'openclaw.controller_work.completed',
  'openclaw.agents.provision.cancelled',
  'openclaw.audit.agent.read'
) OR (
  NEW.action IN ('reconcile', 'openclaw.agents.lifecycle.delete')
  AND NEW.details->>'attemptId' IS NOT NULL
))
EXECUTE FUNCTION occ.guard_control_plane_audit_append();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_control_plane_audit_append() FROM PUBLIC, occ_app;
--> statement-breakpoint
ALTER TABLE occ.controller_work ADD COLUMN audit_attempt_id uuid;
--> statement-breakpoint
GRANT UPDATE (audit_attempt_id) ON occ.controller_work TO occ_app;
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
  v_audit_attempt_id uuid;
BEGIN
  SELECT work.actor_id, work.attempt_count, work.audit_attempt_id
    INTO v_actor_id, v_attempt_count, v_audit_attempt_id
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

  UPDATE occ.controller_work AS work
  SET agent_id = NULL,
      revision_id = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NOT NULL
    AND work.namespace_target IS NULL
    AND work.agent_target IS NULL
    AND work.revision_id ~ '^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND work.idempotency_key ~ (
      '^agent_revision:' || work.revision_id ||
      ':repository_cleanup:(retire:)?[0-9a-f]{64}$'
    );

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
    ) || CASE WHEN v_audit_attempt_id IS NULL THEN '{}'::jsonb ELSE
      pg_catalog.jsonb_build_object(
        'workId', p_idempotency_key,
        'attemptId', 'aud_' || v_audit_attempt_id::text
      )
    END
  );

  DELETE FROM occ.controller_work
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions
  DROP CONSTRAINT iam_restrictions_action_valid,
  ADD CONSTRAINT iam_restrictions_action_valid
    CHECK (action IN ('create','read','update','delete','deploy','operate','administer','read_logs','manage_policy','read_audit'));
--> statement-breakpoint
CREATE INDEX audit_events_agent_page_idx ON occ.audit_events
  (namespace_id, (CASE WHEN resource_kind = 'agent' THEN resource_id ELSE details->>'agentId' END),
   occurred_at DESC, id DESC)
  WHERE (resource_kind = 'agent' AND kind = 'api_request'
      AND action = 'openclaw.api.request.result' AND outcome = 'success')
    OR (resource_kind IN ('agent','agent_revision') AND kind = 'mutation'
      AND details->>'agentId' IS NOT NULL
      AND (action IN ('openclaw.controller_work.queued','openclaw.controller_work.claimed')
        OR (action IN ('reconcile','openclaw.controller_work.deferred','openclaw.controller_work.completed')
          AND details->>'attemptId' IS NOT NULL)));
--> statement-breakpoint
-- A disclosure keeps the same Native IAM policy through COMMIT. NOWAIT avoids
-- waiting into a writer's lock order. Other readers can hold these locks.
CREATE FUNCTION occ.hold_agent_audit_policy(installation_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  IF installation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM occ.installation WHERE id = installation_id
  ) THEN
    RAISE EXCEPTION 'Agent audit requires the current Installation' USING ERRCODE = '23514';
  END IF;
  LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups,
    occ.iam_group_memberships, occ.iam_access_bindings, occ.iam_restrictions
    IN SHARE MODE NOWAIT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.hold_agent_audit_policy(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.hold_agent_audit_policy(text) TO occ_app;
