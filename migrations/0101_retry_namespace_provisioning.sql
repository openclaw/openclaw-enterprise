-- Null on original runs. Creation time remains the immutable work identity clock.
ALTER TABLE occ.controller_work ADD COLUMN provisioning_retry_at timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.validate_namespace_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a deleted namespace is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'provisioning' AND NEW.status IN ('ready', 'failed', 'deleting'))
    -- Only the narrowly scoped definer operation can reopen a terminal Namespace.
    OR (OLD.status = 'failed' AND NEW.status = 'provisioning' AND current_user = 'occ_migrator')
    OR (OLD.status IN ('ready', 'failed') AND NEW.status = 'deleting')
  ) THEN
    RAISE EXCEPTION 'invalid namespace lifecycle transition' USING ERRCODE = '23514';
  END IF;

  IF NEW.deleted_at IS NOT NULL AND (
    NEW.status <> 'deleting' OR NEW.deleted_at < NEW.created_at
  ) THEN
    RAISE EXCEPTION 'invalid namespace tombstone' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND (
    EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.configurations WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.service_accounts WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.secrets WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.presets WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.credential_sources WHERE namespace_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.retry_failed_namespace_provisioning(p_namespace_id text, p_actor_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  started_at timestamptz;
BEGIN
  PERFORM 1 FROM occ.namespaces WHERE id = p_namespace_id
    AND status = 'failed' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  started_at := pg_catalog.clock_timestamp();
  UPDATE occ.controller_work SET state = 'queued', attempt_count = 0,
    provisioning_retry_at = started_at, available_at = started_at, updated_at = started_at,
    claim_token = NULL, audit_attempt_id = NULL, lease_expires_at = NULL,
    completed_at = NULL, reason_code = NULL, result_data = NULL
  WHERE idempotency_key = 'namespace:' || p_namespace_id || ':reconcile:ready'
    AND namespace_id = p_namespace_id AND actor_id = p_actor_id
    AND work_kind = 'lifecycle' AND namespace_target = 'ready'
    AND agent_id IS NULL AND revision_id IS NULL AND agent_target IS NULL
    AND state = 'failed_permanent';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE occ.namespaces SET status = 'provisioning' WHERE id = p_namespace_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.retry_failed_namespace_provisioning(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.retry_failed_namespace_provisioning(text, text) TO occ_app;
