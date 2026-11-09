-- Observe irreversible withdrawal after acquiring admission's lifecycle locks. Separate
-- statements are intentional: an INSERT that waited for removal must see its commit.
CREATE FUNCTION occ.guard_repository_session_withdrawal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.namespaces WHERE id = NEW.namespace_id FOR UPDATE;
  PERFORM 1 FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM occ.controller_work
    WHERE (namespace_id, agent_id, revision_id) =
      (NEW.namespace_id, NEW.agent_id, NEW.revision_id)
      AND agent_target IS NULL AND namespace_target IS NULL
      AND idempotency_key = 'agent_revision:' || NEW.revision_id || ':repository_cleanup:' ||
        encode(sha256(convert_to('removal:' || NEW.revision_id, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'Repository session admission was withdrawn for this revision'
      USING ERRCODE = '23514', CONSTRAINT = 'repository_session_admission_not_withdrawn';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_session_withdrawal_guard
  BEFORE INSERT ON occ.repository_session_attempts
  FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_session_withdrawal();
