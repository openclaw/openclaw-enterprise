-- Requeue an exact deleting Agent's terminal teardown. Work actor identity is
-- otherwise frozen for occ_app; this narrow path reassigns it only when OCC has
-- verified that another authorized caller may take over from an initiator that
-- no longer holds delete permission.
CREATE FUNCTION occ.retry_failed_agent_deletion(
  p_namespace_id text,
  p_agent_id text,
  p_initiating_actor_id text,
  p_actor_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN
    RETURN false;
  END IF;
  UPDATE occ.controller_work AS work
  SET state = 'queued', attempt_count = 0, actor_id = p_actor_id,
      available_at = pg_catalog.clock_timestamp(), claim_token = NULL,
      lease_expires_at = NULL, completed_at = NULL,
      reason_code = NULL, result_data = NULL, updated_at = pg_catalog.clock_timestamp()
  FROM occ.agents AS agent
  WHERE work.idempotency_key = 'agent:' || p_agent_id || ':reconcile:deleted'
    AND work.work_kind = 'lifecycle'
    AND work.namespace_id = p_namespace_id AND work.agent_id = p_agent_id
    AND work.actor_id = p_initiating_actor_id
    AND work.revision_id IS NULL AND work.namespace_target IS NULL
    AND work.agent_target = 'deleted' AND work.state = 'failed_permanent'
    AND agent.namespace_id = work.namespace_id AND agent.id = work.agent_id
    AND agent.status = 'deleting' AND agent.desired_runtime_state = 'stopped';
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.retry_failed_agent_deletion(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.retry_failed_agent_deletion(text, text, text, text) TO occ_app;
