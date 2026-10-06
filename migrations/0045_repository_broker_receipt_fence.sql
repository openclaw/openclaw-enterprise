-- A broker that reserved an admission and then refused it, or could not record its session,
-- fences its own reservation so retries and recovery answer missing instead of unavailable.
-- The fence keeps the reserving generation, so a fenced receipt may now carry one.
ALTER TABLE occ.repository_broker_receipts
  DROP CONSTRAINT repository_broker_receipts_state_valid;
--> statement-breakpoint
ALTER TABLE occ.repository_broker_receipts
  ADD CONSTRAINT repository_broker_receipts_state_valid CHECK (
    (state = 'fenced' AND session_id IS NULL
      AND deadline_wall_ms IS NULL AND revoked IS NULL AND expired IS NULL)
    OR (state = 'reserved' AND generation IS NOT NULL AND session_id IS NULL
      AND deadline_wall_ms IS NULL AND revoked IS NULL AND expired IS NULL)
    OR (state = 'active' AND generation IS NOT NULL AND session_id IS NOT NULL
      AND deadline_wall_ms IS NOT NULL AND deadline_wall_ms BETWEEN 1 AND 9007199254740991
      AND revoked IS NULL AND expired IS NULL)
    OR (state = 'disposed' AND generation IS NOT NULL AND session_id IS NOT NULL
      AND deadline_wall_ms IS NOT NULL AND deadline_wall_ms BETWEEN 1 AND 9007199254740991
      AND revoked IS NOT NULL AND revoked BETWEEN 0 AND 9007199254740991
      AND expired IS NOT NULL AND expired BETWEEN 0 AND 9007199254740991)
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_repository_broker_receipt() RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  owner occ.repository_session_attempts%ROWTYPE;
BEGIN
  SELECT * INTO owner FROM occ.repository_session_attempts
    WHERE admission_id = NEW.admission_id FOR UPDATE;
  IF NOT FOUND OR owner.broker_protocol <> 1 OR owner.phase IN ('invalidated', 'disposed') THEN
    RAISE EXCEPTION 'Repository broker receipt requires a current durable admission'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('fenced', 'reserved')
      OR (NEW.state = 'reserved' AND owner.phase <> 'opening')
      OR (NEW.state = 'fenced' AND (NEW.generation IS NOT NULL OR owner.phase = 'open'
        OR owner.session_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'Repository broker receipt must begin reserved or fenced'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id)
    OR (OLD.deadline_wall_ms IS NOT NULL AND NEW.deadline_wall_ms IS DISTINCT FROM OLD.deadline_wall_ms)
    OR NOT ((OLD.state = 'reserved' AND NEW.state = 'active')
      OR (OLD.state = 'active' AND NEW.state = 'disposed')
      OR (OLD.state = 'reserved' AND NEW.state = 'fenced'
        AND owner.phase <> 'open' AND owner.session_id IS NULL))
    OR (NEW.session_id IS NOT NULL AND owner.session_id IS NOT NULL AND NEW.session_id <> owner.session_id)
    OR (NEW.deadline_wall_ms IS NOT NULL AND NEW.deadline_wall_ms > owner.deadline_wall_ms) THEN
    RAISE EXCEPTION 'Repository broker receipt identity or transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
