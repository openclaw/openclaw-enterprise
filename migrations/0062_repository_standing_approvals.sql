CREATE TABLE occ.repository_standing_approvals (
 id text PRIMARY KEY CONSTRAINT standing_approvals_id_check CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
 namespace_id text NOT NULL,
 agent_id text NOT NULL,
 repository_ref text NOT NULL,
 binding jsonb NOT NULL CONSTRAINT standing_approvals_binding_check CHECK (occ.repository_bindings_are_valid(jsonb_build_array(binding),true) AND binding->>'repositoryRef'=repository_ref),
 scope jsonb NOT NULL CONSTRAINT standing_approvals_scope_check CHECK (jsonb_typeof(scope)='object' AND octet_length(scope::text) BETWEEN 2 AND 65536),
 scope_fingerprint text NOT NULL CONSTRAINT standing_approvals_scope_fingerprint_check CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
 generation bigint NOT NULL CONSTRAINT standing_approvals_generation_check CHECK (generation BETWEEN 1 AND 9007199254740991),
 approved_by text NOT NULL CONSTRAINT standing_approvals_approved_by_check CHECK (length(approved_by) BETWEEN 1 AND 512),
 created_at timestamptz NOT NULL CONSTRAINT standing_approvals_created_at_check CHECK (isfinite(created_at)),
 revoked_at timestamptz CONSTRAINT standing_approvals_revoked_at_check CHECK (isfinite(revoked_at) AND revoked_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_standing_approvals_generation
 ON occ.repository_standing_approvals(namespace_id,agent_id,repository_ref,generation);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_standing_approvals_current ON occ.repository_standing_approvals(namespace_id,agent_id,repository_ref) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION occ.guard_repository_standing_approval() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE previous_generation bigint;
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM 1 FROM occ.agents a WHERE a.namespace_id=NEW.namespace_id AND a.id=NEW.agent_id AND a.status='active'
   AND a.repository_bindings @> jsonb_build_array(jsonb_build_object('repositoryRef',NEW.repository_ref,'profile',NEW.binding->>'profile')) FOR UPDATE;
  IF NOT FOUND OR NEW.revoked_at IS NOT NULL THEN
   RAISE EXCEPTION 'Standing approval requires exact current Agent binding' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(max(generation),0) INTO previous_generation FROM occ.repository_standing_approvals
   WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id AND repository_ref=NEW.repository_ref;
  -- Duplicate request IDs are compared by State; they must not activate an old generation.
  IF NOT EXISTS(SELECT FROM occ.repository_standing_approvals WHERE id=NEW.id) AND NEW.generation <> previous_generation+1 THEN
   RAISE EXCEPTION 'Standing approval generation must advance' USING ERRCODE='23514';
  END IF;
 ELSE
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.generation <> OLD.generation+1 OR
    (to_jsonb(NEW)-'revoked_at'-'generation') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'generation') THEN
   RAISE EXCEPTION 'Standing approval permits only fenced terminal revocation' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER repository_standing_approval_guard BEFORE INSERT OR UPDATE ON occ.repository_standing_approvals FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_standing_approval();
--> statement-breakpoint
CREATE TRIGGER repository_standing_approval_retained BEFORE DELETE ON occ.repository_standing_approvals FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.repository_standing_approvals FROM PUBLIC,occ_app;
GRANT SELECT,INSERT ON occ.repository_standing_approvals TO occ_app;
GRANT UPDATE(revoked_at,generation) ON occ.repository_standing_approvals TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.repository_credentials_are_valid(credentials jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  identity_value jsonb;
  deadline numeric;
BEGIN
  IF jsonb_typeof(credentials) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF NOT (credentials ?& ARRAY['driver', 'deadlineWallMs', 'bindings'])
    OR credentials - 'driver' - 'deadlineWallMs' - 'bindings' - 'standingApprovalId' - 'standingApprovalGeneration' - 'standingApprovalScopeFingerprint' <> '{}'::jsonb
    OR jsonb_typeof(credentials->'driver') IS DISTINCT FROM 'object'
    OR jsonb_typeof(credentials->'deadlineWallMs') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  IF NOT ((credentials->'driver') ?& ARRAY['id', 'implementation'])
    OR (credentials->'driver') - 'id' - 'implementation' <> '{}'::jsonb THEN
    RETURN false;
  END IF;
  FOR identity_value IN SELECT value FROM jsonb_each(credentials->'driver') LOOP
    IF jsonb_typeof(identity_value) IS DISTINCT FROM 'string'
      OR octet_length(identity_value #>> '{}') NOT BETWEEN 1 AND 512
      OR (identity_value #>> '{}') ~ U&'[\0001-\001F\007F]' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF credentials ? 'standingApprovalId' AND (
    jsonb_typeof(credentials->'standingApprovalScopeFingerprint') IS DISTINCT FROM 'string'
    OR credentials->>'standingApprovalScopeFingerprint' !~ '^[0-9a-f]{64}$' OR
    jsonb_typeof(credentials->'standingApprovalGeneration') IS DISTINCT FROM 'number'
    OR (credentials->>'standingApprovalGeneration')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR mod((credentials->>'standingApprovalGeneration')::numeric,1) <> 0
    OR
    jsonb_typeof(credentials->'standingApprovalId') IS DISTINCT FROM 'string'
    OR credentials->>'standingApprovalId' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR jsonb_typeof(credentials->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(credentials->'bindings') <> 1) THEN RETURN false; END IF;
  IF (credentials ? 'standingApprovalGeneration' OR credentials ? 'standingApprovalScopeFingerprint') AND NOT credentials ? 'standingApprovalId' THEN RETURN false; END IF;
  deadline := (credentials->>'deadlineWallMs')::numeric;
  IF deadline NOT BETWEEN 1 AND 9007199254740991 OR mod(deadline, 1) <> 0 THEN
    RETURN false;
  END IF;
  RETURN occ.repository_bindings_are_valid(credentials->'bindings', true);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.repository_standing_approval_is_current(credentials jsonb, namespace_id text, agent_id text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
 IF NOT (credentials ? 'standingApprovalId') THEN RETURN true; END IF;
 PERFORM 1 FROM occ.repository_standing_approvals p
 WHERE p.id=credentials->>'standingApprovalId' AND p.namespace_id=$2 AND p.agent_id=$3
   AND p.revoked_at IS NULL AND p.generation=(credentials->>'standingApprovalGeneration')::bigint
   AND p.scope_fingerprint=credentials->>'standingApprovalScopeFingerprint'
   AND credentials->'bindings'=jsonb_build_array(p.binding)
 FOR SHARE;
 RETURN FOUND;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.repository_standing_approval_is_current(jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.repository_standing_approval_is_current(jsonb,text,text) TO occ_app;
--> statement-breakpoint
-- One observed execution per revision. Stopping it, including while keeping its
-- approval, is terminal. Keep the receipt after the Agent and revision are deleted.
CREATE TABLE occ.repository_standing_executions (
  namespace_id text NOT NULL, agent_id text NOT NULL, revision_id text PRIMARY KEY,
  approval_id text NOT NULL REFERENCES occ.repository_standing_approvals(id),
  approval_generation bigint NOT NULL,
  execution_id text NOT NULL CONSTRAINT repository_standing_execution_id CHECK (length(execution_id) BETWEEN 1 AND 512),
  fingerprint text NOT NULL CONSTRAINT repository_standing_execution_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  closed boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
REVOKE ALL ON occ.repository_standing_executions FROM PUBLIC, occ_app;
GRANT SELECT ON occ.repository_standing_executions TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.record_repository_standing_execution(ns text, agent text, revision text, execution text, digest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE snapshot jsonb; recorded occ.repository_standing_executions;
BEGIN
  PERFORM 1 FROM occ.namespaces WHERE id=ns AND status='ready' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Repository execution requires ready Namespace' USING ERRCODE='23514'; END IF;
  SELECT r.admitted_spec->'repository_credentials' INTO snapshot
    FROM occ.agents a JOIN occ.agent_revisions r ON (r.namespace_id,r.agent_id,r.id)=(a.namespace_id,a.id,a.active_revision_id)
    WHERE a.namespace_id=ns AND a.id=agent AND r.id=revision AND a.status='active' AND a.desired_runtime_state='running'
    FOR UPDATE OF a;
  IF NOT FOUND OR NOT coalesce(snapshot ? 'standingApprovalId', false)
    OR NOT occ.repository_standing_approval_is_current(snapshot,ns,agent) THEN
    RAISE EXCEPTION 'Repository execution requires its admitted standing approval and active revision' USING ERRCODE='23514';
  END IF;
  SELECT * INTO recorded FROM occ.repository_standing_executions WHERE revision_id=revision;
  IF FOUND THEN
    IF recorded.closed OR (recorded.execution_id, recorded.fingerprint) IS DISTINCT FROM (execution,digest) THEN
      RAISE EXCEPTION 'Standing repository execution changed or ended' USING ERRCODE='23514';
    END IF;
  ELSE
    -- An expired admission is never the first evidence of a live execution.
    IF (snapshot->>'deadlineWallMs')::bigint <= extract(epoch FROM clock_timestamp())*1000 THEN
      RAISE EXCEPTION 'Initial repository execution observation is too late' USING ERRCODE='23514'; END IF;
    INSERT INTO occ.repository_standing_executions VALUES
      (ns,agent,revision,snapshot->>'standingApprovalId',(snapshot->>'standingApprovalGeneration')::bigint,execution,digest,false);
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.record_repository_standing_execution(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.record_repository_standing_execution(text,text,text,text,text) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.close_repository_standing_execution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  UPDATE occ.repository_standing_executions SET closed=true
  WHERE revision_id=OLD.active_revision_id AND namespace_id=OLD.namespace_id AND agent_id=OLD.id AND NOT closed;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_standing_execution_close AFTER UPDATE OF active_revision_id,status,desired_runtime_state ON occ.agents
FOR EACH ROW WHEN (OLD.active_revision_id IS NOT NULL AND (NEW.status <> 'active' OR NEW.desired_runtime_state <> 'running'
                   OR NEW.active_revision_id IS DISTINCT FROM OLD.active_revision_id))
EXECUTE FUNCTION occ.close_repository_standing_execution();
--> statement-breakpoint
CREATE FUNCTION occ.repository_standing_execution_is_current(snapshot jsonb, ns text, agent text, revision text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog, occ, pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM occ.repository_standing_executions e JOIN occ.agents a ON (a.namespace_id,a.id,a.active_revision_id)=(e.namespace_id,e.agent_id,e.revision_id)
    WHERE (e.namespace_id,e.agent_id,e.revision_id)=(ns,agent,revision) AND NOT e.closed
      AND a.status='active' AND a.desired_runtime_state='running'
      AND e.approval_id=snapshot->>'standingApprovalId' AND e.approval_generation=(snapshot->>'standingApprovalGeneration')::bigint
      AND occ.repository_standing_approval_is_current(snapshot,ns,agent)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.repository_standing_execution_is_current(jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.repository_standing_execution_is_current(jsonb,text,text,text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.repository_session_attempts
  ADD COLUMN predecessor_admission_id text,
  ADD COLUMN execution_fingerprint text,
  ADD CONSTRAINT repository_session_succession_fields CHECK (
    (predecessor_admission_id IS NULL AND execution_fingerprint IS NULL) OR
    (predecessor_admission_id IS NOT NULL AND execution_fingerprint IS NOT NULL AND execution_fingerprint ~ '^[0-9a-f]{64}$')
  );
--> statement-breakpoint
CREATE UNIQUE INDEX repository_session_succession_once ON occ.repository_session_attempts(predecessor_admission_id)
  WHERE predecessor_admission_id IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_repository_session_attempt() RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  credentials pg_catalog.jsonb;
  context pg_catalog.jsonb;
  namespace_status pg_catalog.text;
  namespace_deleted_at pg_catalog.timestamptz;
  agent_status pg_catalog.text;
  runtime_state pg_catalog.text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase IS DISTINCT FROM 'opening' OR NEW.session_id IS NOT NULL THEN
      RAISE EXCEPTION 'Repository session attempts must begin opening without a session ID'
        USING ERRCODE = '23514';
    END IF;
    -- Serialize admission with lifecycle owners in the same Namespace/Agent order.
    SELECT namespace.status, namespace.deleted_at INTO namespace_status, namespace_deleted_at
    FROM occ.namespaces AS namespace WHERE namespace.id = NEW.namespace_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repository session Namespace does not exist' USING ERRCODE = '23503';
    END IF;
    SELECT agent.status, agent.desired_runtime_state INTO agent_status, runtime_state
    FROM occ.agents AS agent
    WHERE agent.namespace_id = NEW.namespace_id AND agent.id = NEW.agent_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repository session Agent does not exist' USING ERRCODE = '23503';
    END IF;
    IF namespace_status <> 'ready' OR namespace_deleted_at IS NOT NULL
      OR agent_status <> 'active' OR runtime_state <> 'running' THEN
      RAISE EXCEPTION 'Repository session admission requires a live running owner'
        USING ERRCODE = '23514';
    END IF;
    SELECT revision.admitted_spec->'repository_credentials' INTO credentials
    FROM occ.agent_revisions AS revision
    WHERE revision.namespace_id = NEW.namespace_id AND revision.agent_id = NEW.agent_id
      AND revision.id = NEW.revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repository session revision does not exist' USING ERRCODE = '23503';
    END IF;
    IF NOT occ.repository_credentials_are_valid(credentials) THEN
      RAISE EXCEPTION 'Repository session attempt requires an admitted repository binding'
        USING ERRCODE = '23514';
    END IF;
    SELECT pg_catalog.jsonb_build_object('driver', credentials->'driver', 'binding', binding)
      INTO context FROM pg_catalog.jsonb_array_elements(credentials->'bindings') AS binding
      WHERE binding->>'repositoryRef' = NEW.repository_ref;
    IF NOT FOUND OR (NEW.predecessor_admission_id IS NULL AND NEW.deadline_wall_ms IS DISTINCT FROM
      (credentials->>'deadlineWallMs')::pg_catalog.numeric::pg_catalog.int8)
      OR (NEW.live_revision_id IS NOT NULL AND NEW.live_revision_id <> NEW.revision_id)
      OR (NEW.cleanup_context IS NOT NULL AND NEW.cleanup_context IS DISTINCT FROM context) THEN
      RAISE EXCEPTION 'Repository session attempt must match its admitted cleanup context'
        USING ERRCODE = '23514';
    END IF;
    NEW.live_revision_id := NEW.revision_id;
    NEW.cleanup_context := context;
    RETURN NEW;
  END IF;
  IF ROW(NEW.namespace_id, NEW.agent_id, NEW.revision_id, NEW.repository_ref,
      NEW.admission_id, NEW.duration_seconds, NEW.deadline_wall_ms, NEW.created_at,
      NEW.cleanup_context, NEW.predecessor_admission_id, NEW.execution_fingerprint)
    IS DISTINCT FROM ROW(OLD.namespace_id, OLD.agent_id, OLD.revision_id, OLD.repository_ref,
      OLD.admission_id, OLD.duration_seconds, OLD.deadline_wall_ms, OLD.created_at,
      OLD.cleanup_context, OLD.predecessor_admission_id, OLD.execution_fingerprint)
    OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    RAISE EXCEPTION 'Repository session identity, cleanup context and known session are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.live_revision_id IS DISTINCT FROM OLD.live_revision_id THEN
    -- Only the migrator-owned finalizer has the app-callable privilege to detach.
    IF CURRENT_USER = 'occ_migrator' AND OLD.live_revision_id IS NOT NULL
      AND NEW.live_revision_id IS NULL AND NEW.phase = OLD.phase
      AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
      AND EXISTS (
        SELECT 1 FROM occ.agents AS agent
        WHERE agent.namespace_id = OLD.namespace_id AND agent.id = OLD.agent_id
          AND agent.status = 'deleting' AND agent.desired_runtime_state = 'stopped'
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Repository session live owner can detach only during Agent deletion'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.phase = 'opening' AND NEW.phase IN ('open', 'closing', 'invalidated'))
    OR (OLD.phase = 'open' AND NEW.phase IN ('closing', 'invalidated'))
    OR (OLD.phase = 'closing' AND NEW.phase IN ('closing', 'disposed', 'invalidated'))
  ) THEN
    RAISE EXCEPTION 'Repository session attempt phase transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.guard_standing_repository_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE credentials jsonb; predecessor occ.repository_session_attempts; ceiling bigint; now_ms bigint;
BEGIN
 IF NEW.phase NOT IN ('opening','open') THEN RETURN NEW; END IF;
 SELECT admitted_spec->'repository_credentials' INTO credentials FROM occ.agent_revisions
 WHERE id=NEW.revision_id AND namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id;
 IF NOT coalesce(credentials ? 'standingApprovalId',false) THEN
   IF NEW.predecessor_admission_id IS NULL THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Finite repository admission cannot succeed another session' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM occ.agents WHERE id=NEW.agent_id AND namespace_id=NEW.namespace_id
   AND status='active' AND desired_runtime_state='running' FOR SHARE;
 IF NOT FOUND OR NOT occ.repository_standing_approval_is_current(credentials,NEW.namespace_id,NEW.agent_id) THEN
   RAISE EXCEPTION 'Standing repository session requires current approval and running Agent' USING ERRCODE='23514';
 END IF;
 IF NEW.predecessor_admission_id IS NOT NULL THEN
   IF NEW.broker_protocol IS DISTINCT FROM 1
     OR NOT occ.repository_standing_execution_is_current(credentials,NEW.namespace_id,NEW.agent_id,NEW.revision_id)
     OR NOT EXISTS (SELECT FROM occ.repository_standing_executions
          WHERE revision_id=NEW.revision_id AND fingerprint=NEW.execution_fingerprint AND NOT closed) THEN
     RAISE EXCEPTION 'Repository successor requires the same current standing execution' USING ERRCODE='23514';
   END IF;
   IF TG_OP='INSERT' THEN
     SELECT s.* INTO predecessor FROM occ.repository_session_attempts s JOIN occ.repository_broker_receipts b USING (admission_id)
       WHERE s.admission_id=NEW.predecessor_admission_id AND s.phase='disposed' AND b.state='disposed' AND b.session_id=s.session_id;
     IF NOT FOUND THEN RAISE EXCEPTION 'Repository predecessor disposal is unconfirmed' USING ERRCODE='23514'; END IF;
     SELECT (scope->>'maximumSessionDurationSeconds')::bigint INTO ceiling FROM occ.repository_standing_approvals
       WHERE id=credentials->>'standingApprovalId' AND revoked_at IS NULL;
     now_ms := floor(extract(epoch FROM clock_timestamp())*1000);
     IF (NEW.namespace_id,NEW.agent_id,NEW.revision_id,NEW.cleanup_context) IS DISTINCT FROM
        (predecessor.namespace_id,predecessor.agent_id,predecessor.revision_id,predecessor.cleanup_context)
       OR ceiling IS NULL OR NEW.duration_seconds>ceiling OR NEW.deadline_wall_ms<=greatest(predecessor.deadline_wall_ms,now_ms)
       OR NEW.deadline_wall_ms>least(now_ms,extract(epoch FROM NEW.created_at)*1000)+NEW.duration_seconds*1000 THEN
       RAISE EXCEPTION 'Repository successor exceeds its admitted scope or session duration' USING ERRCODE='23514';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER repository_session_standing_guard BEFORE INSERT OR UPDATE ON occ.repository_session_attempts
 FOR EACH ROW EXECUTE FUNCTION occ.guard_standing_repository_session();
