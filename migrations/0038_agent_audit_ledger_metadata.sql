-- Database-owned audit receipt and retained immutable resource associations.
-- This storage prerequisite does not enable protected History disclosure or retention.
-- Apply atomically as occ_migrator. Historical rows receive allocation keys,
-- never fabricated receipt times, facts or retained associations.
DO $$
BEGIN
  IF current_user <> 'occ_migrator' OR session_user <> current_user
    OR pg_catalog.current_setting('server_encoding') <> 'UTF8'
    OR (SELECT count(*) <> 2 OR NOT bool_and(rolcanlogin AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
      FROM pg_catalog.pg_roles WHERE rolname IN ('occ_app', 'occ_migrator'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname <> 'occ_app'
        AND pg_catalog.pg_has_role('occ_app', role.oid, 'MEMBER'))
    OR pg_catalog.pg_has_role('occ_migrator', 'occ_app', 'MEMBER')
    OR pg_catalog.has_database_privilege('occ_app', pg_catalog.current_database(), 'CREATE')
    OR pg_catalog.has_schema_privilege('occ_app', 'occ', 'CREATE')
    OR (SELECT nspowner <> 'occ_migrator'::pg_catalog.regrole
      FROM pg_catalog.pg_namespace WHERE nspname = 'occ')
    OR (SELECT relowner <> 'occ_migrator'::pg_catalog.regrole
      FROM pg_catalog.pg_class WHERE oid = 'occ.audit_events'::pg_catalog.regclass)
    OR (SELECT proowner <> 'occ_migrator'::pg_catalog.regrole FROM pg_catalog.pg_proc
      WHERE oid = 'occ.finalize_agent_deletion(text,text,text,uuid)'::pg_catalog.regprocedure)
  THEN
    RAISE EXCEPTION 'history storage requires isolated migration and application roles'
      USING ERRCODE = '42501';
  END IF;
  -- Origin mode protects both this stamp and the existing immutable ownership
  -- triggers. ALWAYS on the stamp alone would not protect those associations.
  -- Effective parameter privileges include direct, inherited and PUBLIC grants.
  -- Reject all applicable login overrides, even origin: database+role overrides
  -- role, which overrides database, and a migrator origin override could hide a
  -- server replica default from this session. The supported roles inherit the
  -- same server origin setting without any of these overrides or SET authority.
  IF pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname IN ('occ_app', 'occ_migrator')
        AND (pg_catalog.has_parameter_privilege(role.oid, 'session_replication_role', 'SET')
          OR pg_catalog.has_parameter_privilege(role.oid, 'session_replication_role', 'ALTER SYSTEM')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting
      CROSS JOIN LATERAL pg_catalog.unnest(setting.setconfig) AS config(value)
      WHERE setting.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database
        WHERE datname = pg_catalog.current_database()))
        AND (setting.setrole = 0 OR setting.setrole IN (SELECT oid FROM pg_catalog.pg_roles
          WHERE rolname IN ('occ_app', 'occ_migrator')))
        AND pg_catalog.split_part(config.value, '=', 1) = 'session_replication_role')
  THEN
    RAISE EXCEPTION 'history storage requires origin sessions without replication-role control or login overrides'
      USING ERRCODE = '42501';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.audit_events
  ADD COLUMN ledger_sequence bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN received_at timestamptz,
  ADD COLUMN history_fact jsonb,
  ADD COLUMN retained_installation_id text,
  ADD COLUMN retained_namespace_id text,
  ADD COLUMN retained_agent_id text,
  ADD COLUMN retained_revision_id text,
  ADD CONSTRAINT audit_events_ledger_sequence_unique UNIQUE (ledger_sequence),
  ADD CONSTRAINT audit_events_ledger_sequence_positive CHECK (ledger_sequence > 0),
  ADD CONSTRAINT audit_events_received_at_finite CHECK (
    received_at IS NULL OR pg_catalog.isfinite(received_at)
  ),
  ADD CONSTRAINT audit_events_history_fact_object CHECK (
    history_fact IS NULL OR pg_catalog.jsonb_typeof(history_fact) = 'object'
  ),
  ADD CONSTRAINT audit_events_retained_scope CHECK (
    (retained_namespace_id IS NULL OR retained_installation_id IS NOT NULL)
    AND (retained_agent_id IS NULL OR retained_namespace_id IS NOT NULL)
    AND (retained_revision_id IS NULL OR retained_agent_id IS NOT NULL)
    AND (history_fact IS NULL OR (received_at IS NOT NULL AND retained_agent_id IS NOT NULL))
  );
--> statement-breakpoint
-- Exact retained scope plus allocation key supports bounded keyset reads after
-- live Agent deletion. This index does not authorize or expose a History reader.
CREATE INDEX audit_events_retained_agent_sequence_idx
  ON occ.audit_events (retained_installation_id, retained_namespace_id,
    retained_agent_id, ledger_sequence)
  WHERE retained_agent_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION occ.audit_history_safe_text(p_text text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_folded text;
  v_space text := U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_code integer;
BEGIN
  IF pg_catalog.octet_length(p_text) > 512 THEN RETURN false; END IF;
  FOR i IN 1..pg_catalog.char_length(p_text) LOOP
    v_code := pg_catalog.ascii(pg_catalog.substr(p_text, i, 1));
    IF v_code BETWEEN 0 AND 31 OR v_code BETWEEN 127 AND 159 THEN RETURN false; END IF;
  END LOOP;
  -- ECMAScript /iu adds long s and Kelvin sign to ASCII word/case matching.
  -- Spell out its whitespace and word sets instead of locale-sensitive \m/\s.
  v_folded := pg_catalog.translate(p_text,
    U&'ABCDEFGHIJKLMNOPQRSTUVWXYZ\017F\212A', 'abcdefghijklmnopqrstuvwxyzsk');
  RETURN NOT (
    v_folded COLLATE "C" ~ ('(^|[^a-z0-9_])(bearer|basic)[' || v_space || ']+[^' || v_space || ']')
    OR v_folded COLLATE "C" ~ '(^|[^a-z0-9_])(sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,}|xox[baprs]-[a-z0-9-]{8,})'
    OR v_folded COLLATE "C" ~ '-----begin [a-z ]*private key-----'
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.audit_history_json_bytes(p_value jsonb, p_depth integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_kind text := pg_catalog.jsonb_typeof(p_value);
  v_bytes integer := 2;
  v_count integer := 0;
  v_child integer;
  v_number numeric;
  v_entry record;
BEGIN
  IF p_depth > 6 OR p_depth < 0 THEN RETURN -1; END IF;
  IF v_kind = 'string' THEN
    IF occ.audit_history_safe_text(p_value #>> '{}') IS NOT TRUE THEN RETURN -1; END IF;
    -- Safe strings have no control characters or unpaired surrogates. PostgreSQL
    -- and JSON.stringify escape only quotes/backslashes here, with UTF-8 bytes.
    RETURN pg_catalog.octet_length(p_value::text);
  ELSIF v_kind = 'number' THEN
    v_number := (p_value #>> '{}')::numeric;
    IF v_number <> pg_catalog.trunc(v_number) OR abs(v_number) > 9007199254740991 THEN
      RETURN -1;
    END IF;
    RETURN pg_catalog.length(pg_catalog.trunc(v_number)::text);
  ELSIF v_kind = 'null' THEN RETURN 4;
  ELSIF v_kind = 'boolean' THEN RETURN pg_catalog.length(p_value::text);
  ELSIF v_kind <> 'object' THEN RETURN -1;
  END IF;
  FOR v_entry IN SELECT key, value FROM pg_catalog.jsonb_each(p_value) LOOP
    v_count := v_count + 1;
    IF v_count > 32 OR v_entry.key IN ('__proto__', 'constructor', 'prototype') THEN
      RETURN -1;
    END IF;
    v_child := occ.audit_history_json_bytes(v_entry.value, p_depth + 1);
    IF v_child < 0 THEN RETURN -1; END IF;
    -- Count compact object punctuation and individually encoded keys/values.
    -- jsonb::text adds separator spaces; removing spaces from the whole value
    -- would also remove meaningful spaces inside strings.
    v_bytes := v_bytes + pg_catalog.octet_length(pg_catalog.to_jsonb(v_entry.key)::text)
      + 1 + v_child + CASE WHEN v_count > 1 THEN 1 ELSE 0 END;
    IF v_bytes > 8192 THEN RETURN -1; END IF;
  END LOOP;
  RETURN v_bytes;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.audit_history_keys(p_value jsonb, p_required text[], p_optional text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.jsonb_typeof(p_value) <> 'object' THEN RETURN false; END IF;
  RETURN p_value ?& p_required AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_value) AS member(key)
    WHERE NOT (member.key = ANY(p_required || p_optional))
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.audit_history_id(p_value jsonb, p_prefix text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_typeof(p_value) = 'string'
    AND (p_value #>> '{}') COLLATE "C" ~ ('^' || p_prefix ||
      '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
$$;
--> statement-breakpoint
CREATE FUNCTION occ.audit_history_timestamp(p_text text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_year integer;
BEGIN
  IF p_text COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    OR pg_catalog.substr(p_text, 12, 2)::integer > 23
    OR pg_catalog.substr(p_text, 15, 2)::integer > 59
    OR pg_catalog.substr(p_text, 18, 2)::integer > 59
  THEN RETURN NULL; END IF;
  v_year := pg_catalog.substr(p_text, 1, 4)::integer;
  RETURN pg_catalog.make_timestamptz(CASE WHEN v_year = 0 THEN -1 ELSE v_year END,
    pg_catalog.substr(p_text, 6, 2)::integer, pg_catalog.substr(p_text, 9, 2)::integer,
    pg_catalog.substr(p_text, 12, 2)::integer, pg_catalog.substr(p_text, 15, 2)::integer,
    pg_catalog.substr(p_text, 18, 6)::double precision, 'UTC');
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.audit_history_reason_code(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_typeof(p_value) = 'string'
    AND (p_value #>> '{}') = ANY(ARRAY[
      'REQUESTED','ACCEPTED','OBSERVED','AUTHORIZATION_DENIED','ACTOR_REVOKED',
      'DEPENDENCY_UNAVAILABLE','UNKNOWN_OUTCOME','UNRESOLVED_LEGACY','UNCLASSIFIED_FAILURE',
      'INVALID_TARGET','INVALID_AGENT_OWNER','INVALID_AGENT_PRINCIPAL','INVALID_REVISION_OWNER',
      'INVALID_ACTIVE_REVISION','INVALID_ADMITTED_REVISION','INVALID_DRIVER_OBSERVATION',
      'INVALID_HARNESS_AUTH','INVALID_SECRET_BINDINGS','HARNESS_AUTH_REQUIRED',
      'HARNESS_AUTH_SOURCE_CHANGED','HARNESS_AUTH_SOURCE_UNAVAILABLE','HARNESS_DESCRIPTOR_MISMATCH',
      'COMPUTE_BINDING_INCOMPLETE','COMPUTE_DRIVER_MISMATCH','PROVIDER_UNAVAILABLE',
      'SECRET_BINDING_UNAVAILABLE','SECRET_DRIVER_MISMATCH','SERVICE_ACCOUNT_PROVIDER_MISMATCH',
      'NAMESPACE_NOT_READY','ACTIVE_REVISION_CHANGED','AGENT_ALREADY_STOPPED','AGENT_STOPPED',
      'REVISION_ACTIVATED','REVISION_ALREADY_ACTIVE','REVISION_INCOMPLETE',
      'REVISION_FINALIZATION_INCOMPLETE','REVISION_MAINTENANCE_SUPERSEDED','REVISION_STOPPED',
      'REVISION_SUPERSEDED','STOP_SUPERSEDED','SUPERSEDED_TARGET','CONVERGENCE_DEADLINE_EXCEEDED'] )
$$;
--> statement-breakpoint
CREATE FUNCTION occ.validate_audit_history_fact(p_fact jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_subject jsonb := p_fact->'subject';
  v_resource jsonb := p_fact->'resource';
  v_initiator jsonb := p_fact->'initiator';
  v_auth jsonb := p_fact->'authorization';
  v_auth_resource jsonb := v_auth->'resource';
  v_cause jsonb := p_fact->'causation';
  v_phase text := p_fact->>'phase';
  v_result text := p_fact->>'result';
  v_action text := p_fact->>'action';
  v_permission text;
  v_revision_resource boolean;
  v_key text;
BEGIN
  IF (occ.audit_history_keys(p_fact,
    ARRAY['schema','id','installationId','namespaceId','occurredAt','subject','resource',
      'source','action','phase','result','reasonCode','initiator','executor','authorization','causation'],
    ARRAY[]::text[])
    AND occ.audit_history_json_bytes(p_fact, 0) BETWEEN 0 AND 8192
    AND p_fact->>'schema' = 'openclaw.audit-history/v1'
    AND occ.audit_history_id(p_fact->'id', 'aud')
    AND occ.audit_history_id(p_fact->'installationId', 'ins')
    AND occ.audit_history_id(p_fact->'namespaceId', 'ns')
    AND pg_catalog.jsonb_typeof(p_fact->'occurredAt') = 'string'
    AND occ.audit_history_timestamp(p_fact->>'occurredAt') IS NOT NULL
    AND p_fact->>'source' IN ('occ_admission','occ_worker')
    AND v_action IN ('openclaw.agents.create','openclaw.agents.update','openclaw.agents.deploy',
      'openclaw.agents.stop','openclaw.agents.lifecycle.activate',
      'openclaw.agents.lifecycle.stop','openclaw.agents.lifecycle.supersede')
    AND CASE v_phase
      WHEN 'requested' THEN v_result IN ('pending','denied','failure')
      WHEN 'accepted' THEN v_result = 'accepted'
      WHEN 'observed' THEN v_result IN ('success','denied','failure','superseded')
      WHEN 'unknown' THEN v_result = 'unknown'
      ELSE false END
    AND occ.audit_history_reason_code(p_fact->'reasonCode')
  ) IS NOT TRUE THEN RETURN false; END IF;

  IF (occ.audit_history_keys(v_subject, ARRAY['kind','id','namespaceId'], ARRAY[]::text[])
    AND v_subject->>'kind' = 'agent' AND occ.audit_history_id(v_subject->'id', 'agt')
    AND v_subject->'namespaceId' = p_fact->'namespaceId'
    AND occ.audit_history_keys(v_resource, ARRAY['kind','id','namespaceId'], ARRAY[]::text[])
    AND v_resource->'namespaceId' = p_fact->'namespaceId'
    AND CASE v_resource->>'kind'
      WHEN 'agent' THEN v_resource->'id' = v_subject->'id'
      WHEN 'agent_revision' THEN occ.audit_history_id(v_resource->'id', 'rev')
      ELSE false END
    AND occ.audit_history_keys(p_fact->'executor', ARRAY['kind'], ARRAY[]::text[])
    AND p_fact #>> '{executor,kind}' = 'controller'
    AND occ.audit_history_keys(v_cause, ARRAY[]::text[],
      ARRAY['operationId','requestId','admissionDecisionId','parentEventId','revisionId',
        'workId','attemptId','attempt'])
  ) IS NOT TRUE THEN RETURN false; END IF;

  IF v_initiator->>'kind' = 'unresolved' THEN
    IF occ.audit_history_keys(v_initiator, ARRAY['kind'], ARRAY[]::text[]) IS NOT TRUE THEN
      RETURN false;
    END IF;
  ELSIF v_initiator->>'kind' = 'resolved' THEN
    IF (occ.audit_history_keys(v_initiator, ARRAY['kind','principalId'], ARRAY[]::text[])
      AND pg_catalog.jsonb_typeof(v_initiator->'principalId') = 'string'
      AND pg_catalog.length(v_initiator->>'principalId') > 0) IS NOT TRUE THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['operationId','admissionDecisionId','workId','attemptId'] LOOP
    IF v_cause ? v_key AND (pg_catalog.jsonb_typeof(v_cause->v_key) = 'string'
      AND pg_catalog.length(v_cause->>v_key) > 0) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  IF ((NOT (v_cause ? 'requestId') OR occ.audit_history_id(v_cause->'requestId', 'req'))
    AND (NOT (v_cause ? 'parentEventId') OR (occ.audit_history_id(v_cause->'parentEventId', 'aud')
      AND v_cause->'parentEventId' <> p_fact->'id'))
    AND (NOT (v_cause ? 'revisionId') OR occ.audit_history_id(v_cause->'revisionId', 'rev'))
    AND (NOT (v_cause ? 'attempt') OR (pg_catalog.jsonb_typeof(v_cause->'attempt') = 'number'
      AND (v_cause->>'attempt')::numeric BETWEEN 1 AND 9007199254740991))
    AND (v_resource->>'kind' <> 'agent_revision' OR v_cause->'revisionId' = v_resource->'id')
  ) IS NOT TRUE THEN RETURN false; END IF;

  IF v_auth->>'kind' = 'unresolved' THEN
    IF occ.audit_history_keys(v_auth, ARRAY['kind'], ARRAY[]::text[]) IS NOT TRUE THEN
      RETURN false;
    END IF;
  ELSIF v_auth->>'kind' = 'decision' THEN
    IF (occ.audit_history_keys(v_auth,
      ARRAY['kind','decision','principalId','action','resource','iamDriverId'],
      ARRAY['admissionDecisionId'])
      AND v_auth->>'decision' IN ('allowed','denied')
      AND pg_catalog.jsonb_typeof(v_auth->'principalId') = 'string'
      AND pg_catalog.length(v_auth->>'principalId') > 0
      AND pg_catalog.jsonb_typeof(v_auth->'iamDriverId') = 'string'
      AND pg_catalog.length(v_auth->>'iamDriverId') > 0
      AND v_auth->>'action' IN ('create','read','update','deploy','operate')
      AND (NOT (v_auth ? 'admissionDecisionId') OR (
        pg_catalog.jsonb_typeof(v_auth->'admissionDecisionId') = 'string'
        AND pg_catalog.length(v_auth->>'admissionDecisionId') > 0))
      AND occ.audit_history_keys(v_auth_resource, ARRAY['kind','id','namespaceId'], ARRAY[]::text[])
      AND v_auth_resource->'namespaceId' = p_fact->'namespaceId'
      AND CASE v_auth_resource->>'kind'
        WHEN 'agent' THEN v_auth_resource->'id' = v_subject->'id'
          OR (v_auth->>'action' = 'create' AND v_auth_resource->'id' = p_fact->'namespaceId')
        WHEN 'agent_revision' THEN occ.audit_history_id(v_auth_resource->'id', 'rev')
          AND v_auth_resource->'id' = v_cause->'revisionId'
        WHEN 'configuration' THEN occ.audit_history_id(v_auth_resource->'id', 'cfg')
        WHEN 'service_account' THEN occ.audit_history_id(v_auth_resource->'id', 'sa')
        WHEN 'secret' THEN occ.audit_history_id(v_auth_resource->'id', 'sec')
        ELSE false END
      AND (NOT (v_auth ? 'admissionDecisionId') OR NOT (v_cause ? 'admissionDecisionId')
        OR v_auth->'admissionDecisionId' = v_cause->'admissionDecisionId')
      AND (v_auth->>'decision' = 'denied') = (v_result = 'denied')
    ) IS NOT TRUE THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;

  v_permission := CASE v_action
    WHEN 'openclaw.agents.create' THEN 'create'
    WHEN 'openclaw.agents.update' THEN 'update'
    WHEN 'openclaw.agents.deploy' THEN 'deploy'
    WHEN 'openclaw.agents.stop' THEN 'operate' END;
  IF p_fact->>'source' = 'occ_admission' THEN
    IF v_permission IS NULL OR v_phase = 'observed' THEN RETURN false; END IF;
    IF v_phase = 'accepted' AND (
      v_initiator->>'kind' = 'resolved' AND v_auth->>'kind' = 'decision'
      AND v_auth->>'decision' = 'allowed'
      AND v_auth->'principalId' = v_initiator->'principalId'
      AND v_cause ?& ARRAY['requestId','admissionDecisionId']
      AND v_auth->'admissionDecisionId' = v_cause->'admissionDecisionId'
      AND v_auth->>'action' = v_permission AND v_auth_resource->>'kind' = 'agent'
      AND v_auth_resource->'id' = CASE WHEN v_action = 'openclaw.agents.create'
        THEN p_fact->'namespaceId' ELSE v_subject->'id' END
    ) IS NOT TRUE THEN RETURN false; END IF;
  ELSE
    IF v_phase NOT IN ('observed','unknown')
      OR (v_permission IS NOT NULL AND (v_action NOT IN ('openclaw.agents.deploy','openclaw.agents.stop')
        OR v_result <> 'denied')) THEN RETURN false; END IF;
  END IF;
  v_revision_resource := v_action IN (
    'openclaw.agents.lifecycle.activate','openclaw.agents.lifecycle.supersede')
    OR (v_action = 'openclaw.agents.deploy' AND v_phase = 'accepted');
  IF (v_resource->>'kind' = CASE WHEN v_revision_resource THEN 'agent_revision' ELSE 'agent' END
    AND (v_phase = 'unknown' OR CASE v_action
      WHEN 'openclaw.agents.lifecycle.activate' THEN v_phase = 'observed' AND v_result = 'success'
      WHEN 'openclaw.agents.lifecycle.stop' THEN v_phase = 'observed' AND v_result IN ('success','failure')
      WHEN 'openclaw.agents.lifecycle.supersede' THEN v_phase = 'observed' AND v_result = 'superseded'
      ELSE true END)
  ) IS NOT TRUE THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.stamp_audit_ledger_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_fact jsonb := NEW.history_fact;
  v_metadata jsonb := NEW.details->'__occAuditMetadata';
  v_auth jsonb := v_fact->'authorization';
  v_actor jsonb := v_metadata->'actor';
  v_revision_id text;
  v_agent_id text;
  v_reason text;
  v_key text;
BEGIN
  IF NEW.received_at IS NOT NULL OR NEW.retained_installation_id IS NOT NULL
    OR NEW.retained_namespace_id IS NOT NULL OR NEW.retained_agent_id IS NOT NULL
    OR NEW.retained_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'audit receipt and retained associations are database owned'
      USING ERRCODE = '42501';
  END IF;
  IF v_fact IS NOT NULL AND occ.validate_audit_history_fact(v_fact) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid audit history fact' USING ERRCODE = '23514';
  END IF;

  v_revision_id := CASE WHEN NEW.resource_kind = 'agent_revision' THEN NEW.resource_id
    ELSE v_fact #>> '{causation,revisionId}' END;
  v_agent_id := CASE WHEN NEW.resource_kind = 'agent' THEN NEW.resource_id
    ELSE v_fact #>> '{subject,id}' END;

  -- Capture historical identity from one MVCC snapshot of immutable ownership.
  -- No row locks or mutable status checks are added here: existing callers own
  -- their admission/currentness/lease locks, including Work-first paths. A
  -- concurrent deletion cannot change an observed immutable association. Missing
  -- ordinary targets remain unknown; a closed fact requires the complete join.
  -- retained_namespace_id alone proves existence of the declared row scope, not
  -- ownership of a missing/mismatched resource or any authorization decision.
  SELECT installation.id, namespace.id, agent.id, revision.id
    INTO NEW.retained_installation_id, NEW.retained_namespace_id,
      NEW.retained_agent_id, NEW.retained_revision_id
  FROM occ.installation AS installation
  LEFT JOIN occ.namespaces AS namespace ON namespace.id = NEW.namespace_id
  LEFT JOIN occ.agent_revisions AS revision ON revision.namespace_id = namespace.id
    AND revision.id = v_revision_id
  LEFT JOIN occ.agents AS agent ON agent.namespace_id = namespace.id
    AND agent.id = COALESCE(v_agent_id, revision.agent_id)
    AND (v_revision_id IS NULL OR revision.agent_id = agent.id);

  IF NEW.retained_installation_id IS NULL THEN
    RAISE EXCEPTION 'audit storage requires the singleton installation' USING ERRCODE = '23514';
  END IF;
  -- A revision-only match without its authentic Agent must never become retained
  -- parentage. A mismatched ordinary target keeps only independently known scope.
  IF NEW.retained_agent_id IS NULL THEN NEW.retained_revision_id := NULL; END IF;
  NEW.received_at := pg_catalog.clock_timestamp();
  IF v_fact IS NULL THEN RETURN NEW; END IF;

  IF (v_fact->>'id' = NEW.id
    AND v_fact->>'installationId' = NEW.retained_installation_id
    AND v_fact->>'namespaceId' = NEW.namespace_id
    AND v_fact->>'namespaceId' = NEW.retained_namespace_id
    AND v_fact #>> '{subject,id}' = NEW.retained_agent_id
    AND (v_revision_id IS NULL OR v_revision_id = NEW.retained_revision_id)
    AND occ.audit_history_timestamp(v_fact->>'occurredAt') = NEW.occurred_at
    AND v_fact->>'action' = NEW.action
    AND v_fact #>> '{resource,kind}' = NEW.resource_kind
    AND v_fact #>> '{resource,id}' = NEW.resource_id
    AND NEW.kind = CASE WHEN v_fact->>'result' = 'denied' THEN 'authorization_denial' ELSE 'mutation' END
    AND NEW.outcome = CASE WHEN v_fact->>'result' = 'denied' THEN 'denied'
      WHEN v_fact->>'result' IN ('failure','unknown') THEN 'failure' ELSE 'success' END
    AND pg_catalog.jsonb_typeof(v_metadata) = 'object' AND v_metadata->>'source' = 'occ'
    AND (NOT (v_metadata ? 'schemaVersion') OR v_metadata->'schemaVersion' = '1'::jsonb)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'audit history does not match its ledger row' USING ERRCODE = '23514';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['requestId','admissionDecisionId'] LOOP
    IF v_metadata ? v_key
      AND (v_metadata->v_key = v_fact->'causation'->v_key) IS NOT TRUE THEN
      RAISE EXCEPTION 'audit history causation differs from its ledger row' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF v_fact #>> '{initiator,kind}' = 'resolved' AND (
    NEW.actor_id = v_fact #>> '{initiator,principalId}'
    AND (v_actor IS NULL OR (pg_catalog.jsonb_typeof(v_actor) = 'object'
      AND (NOT (v_actor ? 'unresolved') OR v_actor->'unresolved' = 'false'::jsonb)
      AND (NOT (v_actor ? 'principalId') OR v_actor->'principalId' = v_fact #> '{initiator,principalId}')
      AND (NOT (v_actor ? 'id') OR v_actor->'id' = v_fact #> '{initiator,principalId}')))
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'audit history initiator differs from its ledger row' USING ERRCODE = '23514';
  END IF;
  IF v_auth->>'kind' = 'decision' AND (
    (NOT (v_metadata ? 'iamDriverId') OR v_metadata->'iamDriverId' = v_auth->'iamDriverId')
    AND (NOT (v_metadata ? 'authorization') OR (
      pg_catalog.jsonb_typeof(v_metadata->'authorization') = 'object'
      AND v_metadata #> '{authorization,principalId}' = v_auth->'principalId'
      AND v_metadata #> '{authorization,action}' = v_auth->'action'
      AND v_metadata #> '{authorization,resource,kind}' = v_auth #> '{resource,kind}'
      AND v_metadata #> '{authorization,resource,id}' = v_auth #> '{resource,id}'
      AND v_metadata #> '{authorization,resource,namespaceId}' = v_auth #> '{resource,namespaceId}'))
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'audit history authorization differs from its ledger row' USING ERRCODE = '23514';
  END IF;
  v_reason := v_metadata->>'reasonCode';
  IF v_reason IS NULL AND NEW.action IN ('openclaw.agents.lifecycle.activate',
    'openclaw.agents.lifecycle.stop','openclaw.agents.lifecycle.supersede') THEN
    v_reason := NEW.details->>'reasonCode';
  END IF;
  -- A known producer reason must agree. Unclassified ordinary details do not
  -- become a fact and cannot widen the closed reason catalog.
  IF occ.audit_history_reason_code(pg_catalog.to_jsonb(v_reason)) IS TRUE
    AND v_reason <> v_fact->>'reasonCode' THEN
    RAISE EXCEPTION 'audit history reason differs from its ledger row' USING ERRCODE = '23514';
  END IF;
  IF NEW.action = 'openclaw.agents.deploy' AND NEW.outcome = 'failure'
    AND v_metadata->>'reasonCode' = 'NAMESPACE_NOT_READY'
    AND (v_fact->>'phase' = 'requested' AND v_fact->>'result' = 'failure') IS NOT TRUE THEN
    RAISE EXCEPTION 'audit history admission phase differs from its ledger row' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_stamp_metadata
BEFORE INSERT ON occ.audit_events
FOR EACH ROW EXECUTE FUNCTION occ.stamp_audit_ledger_metadata();
--> statement-breakpoint
-- Capture the existing success evidence after all refusal gates and before
-- deletion. Every subsequent failure still rolls back this same transaction.
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
BEGIN
  SELECT work.actor_id, work.attempt_count
    INTO v_actor_id, v_attempt_count
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
    )
  );

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

  DELETE FROM occ.controller_work
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.audit_history_safe_text(text),
  occ.audit_history_json_bytes(jsonb, integer),
  occ.audit_history_keys(jsonb, text[], text[]),
  occ.audit_history_id(jsonb, text), occ.audit_history_timestamp(text),
  occ.audit_history_reason_code(jsonb), occ.validate_audit_history_fact(jsonb),
  occ.stamp_audit_ledger_metadata()
FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.finalize_agent_deletion(text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.finalize_agent_deletion(text, text, text, uuid) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON TABLE occ.audit_events FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
  outcome, details, ledger_sequence, received_at, history_fact, retained_installation_id,
  retained_namespace_id, retained_agent_id, retained_revision_id)
ON occ.audit_events FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.audit_events TO occ_app;
--> statement-breakpoint
GRANT INSERT (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind,
  resource_id, outcome, details, history_fact) ON occ.audit_events TO occ_app;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE occ.audit_events_ledger_sequence_seq FROM PUBLIC, occ_app;
--> statement-breakpoint
-- Recheck effective privileges after direct grants, including PUBLIC/default
-- ACL effects. Role separation is checked before mutation, so SET ROLE cannot
-- recover a forbidden owner, helper or sequence privilege through membership.
DO $$
DECLARE
  v_column text;
  v_function regprocedure;
BEGIN
  IF pg_catalog.has_table_privilege('occ_app', 'occ.audit_events', 'INSERT')
    OR pg_catalog.has_table_privilege('occ_app', 'occ.audit_events', 'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    OR pg_catalog.has_any_column_privilege('occ_app', 'occ.audit_events', 'UPDATE,REFERENCES')
    OR pg_catalog.has_sequence_privilege('occ_app', 'occ.audit_events_ledger_sequence_seq', 'USAGE,SELECT,UPDATE')
    OR pg_catalog.has_schema_privilege('occ_app', 'occ', 'CREATE') THEN
    RAISE EXCEPTION 'unexpected effective audit storage privileges' USING ERRCODE = '42501';
  END IF;
  FOREACH v_column IN ARRAY ARRAY['ledger_sequence','received_at','retained_installation_id',
    'retained_namespace_id','retained_agent_id','retained_revision_id'] LOOP
    IF pg_catalog.has_column_privilege('occ_app', 'occ.audit_events', v_column, 'INSERT') THEN
      RAISE EXCEPTION 'trusted audit metadata is writable' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOREACH v_function IN ARRAY ARRAY[
    'occ.audit_history_safe_text(text)'::regprocedure,
    'occ.audit_history_json_bytes(jsonb,integer)'::regprocedure,
    'occ.audit_history_keys(jsonb,text[],text[])'::regprocedure,
    'occ.audit_history_id(jsonb,text)'::regprocedure,
    'occ.audit_history_timestamp(text)'::regprocedure,
    'occ.audit_history_reason_code(jsonb)'::regprocedure,
    'occ.validate_audit_history_fact(jsonb)'::regprocedure,
    'occ.stamp_audit_ledger_metadata()'::regprocedure
  ] LOOP
    IF pg_catalog.has_function_privilege('occ_app', v_function, 'EXECUTE')
      OR (SELECT proowner <> 'occ_migrator'::regrole FROM pg_catalog.pg_proc WHERE oid = v_function)
    THEN RAISE EXCEPTION 'audit helper access is not private' USING ERRCODE = '42501'; END IF;
  END LOOP;
END;
$$;
