-- Requeue an exact deleting Namespace's terminal teardown. Work actor identity
-- is otherwise frozen for occ_app; this narrow path reassigns it only when OCC
-- has verified that another authorized caller may take over from an initiator
-- that no longer holds delete permission.
CREATE FUNCTION occ.retry_failed_namespace_deletion(
  p_namespace_id text,
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
  FROM occ.namespaces AS namespace
  WHERE work.idempotency_key = 'namespace:' || p_namespace_id || ':reconcile:deleted'
    AND work.work_kind = 'lifecycle'
    AND work.namespace_id = p_namespace_id
    AND work.actor_id = p_initiating_actor_id
    AND work.agent_id IS NULL AND work.revision_id IS NULL
    AND work.namespace_target = 'deleted' AND work.state = 'failed_permanent'
    AND namespace.id = work.namespace_id
    AND namespace.status = 'deleting' AND namespace.deleted_at IS NULL;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.retry_failed_namespace_deletion(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.retry_failed_namespace_deletion(text, text, text) TO occ_app;
