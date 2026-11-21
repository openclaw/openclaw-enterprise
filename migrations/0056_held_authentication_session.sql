-- A no-op session UPDATE requests a hold without changing authentication data.
-- Validate that held session when PostgreSQL executes COMMIT, after any client
-- scheduling or transport delay, in the same transaction as policy and audit.
CREATE FUNCTION occ.require_held_authentication_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM occ.session s
    WHERE s.id = NEW.id AND s.user_id = NEW.user_id
      AND s.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'held_authentication_session_is_current',
      MESSAGE = 'The assigning session is no longer current.';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER held_authentication_session_is_current
AFTER UPDATE ON occ.session
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD IS NOT DISTINCT FROM NEW)
EXECUTE FUNCTION occ.require_held_authentication_session();
