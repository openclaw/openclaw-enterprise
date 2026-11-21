CREATE TABLE occ.agent_automations (
  id uuid PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  creator_principal_id text NOT NULL,
  native_agent_id text NOT NULL,
  native_job_id text,
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_automations_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT agent_automations_native_identity UNIQUE(namespace_id, agent_id, native_job_id),
  CONSTRAINT agent_automations_creator_valid CHECK (
    char_length(creator_principal_id) BETWEEN 1 AND 200
    AND creator_principal_id = btrim(creator_principal_id)
    AND creator_principal_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_automations_native_agent_valid CHECK (native_agent_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT agent_automations_native_job_valid CHECK (
    native_job_id IS NULL OR (char_length(native_job_id) BETWEEN 1 AND 128
    AND native_job_id = btrim(native_job_id) AND native_job_id !~ '[[:cntrl:]]')
  )
);
--> statement-breakpoint
CREATE INDEX agent_automations_agent_creator ON occ.agent_automations(namespace_id,agent_id,creator_principal_id);
--> statement-breakpoint
CREATE FUNCTION occ.guard_agent_automation_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.namespace_id,NEW.agent_id,NEW.creator_principal_id,NEW.native_agent_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.namespace_id,OLD.agent_id,OLD.creator_principal_id,OLD.native_agent_id,OLD.created_at)
     OR OLD.native_job_id IS NOT NULL OR NEW.native_job_id IS NULL THEN
    RAISE EXCEPTION 'automation ownership and established native identity are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_automations_binding_is_guarded BEFORE UPDATE ON occ.agent_automations
  FOR EACH ROW EXECUTE FUNCTION occ.guard_agent_automation_binding();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_agent_automation_binding() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON occ.agent_automations FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.agent_automations TO occ_app;
--> statement-breakpoint
GRANT INSERT (id,namespace_id,agent_id,creator_principal_id,native_agent_id,created_at) ON occ.agent_automations TO occ_app;
--> statement-breakpoint
GRANT UPDATE (native_job_id) ON occ.agent_automations TO occ_app;
