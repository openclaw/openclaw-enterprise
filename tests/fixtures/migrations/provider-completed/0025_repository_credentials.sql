CREATE FUNCTION occ.repository_bindings_are_valid(bindings jsonb, admitted boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  binding jsonb;
  identity_value jsonb;
  provider_id text;
  repository_refs text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(bindings) IS DISTINCT FROM 'array' OR admitted IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(bindings) NOT BETWEEN 1 AND 16 THEN
    RETURN false;
  END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(binding->'repositoryRef') IS DISTINCT FROM 'string'
      OR jsonb_typeof(binding->'profile') IS DISTINCT FROM 'string'
      OR (binding->>'repositoryRef') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      OR (binding->>'profile') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      OR (binding->>'repositoryRef') = ANY(repository_refs) THEN
      RETURN false;
    END IF;
    repository_refs := array_append(repository_refs, binding->>'repositoryRef');
    IF NOT admitted THEN
      IF binding - 'repositoryRef' - 'profile' <> '{}'::jsonb THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;
    IF binding - 'repositoryRef' - 'profile' - 'providerId' - 'grant' <> '{}'::jsonb
      OR jsonb_typeof(binding->'providerId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(binding->'grant') IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    provider_id := binding->>'providerId';
    -- Provider IDs retain their existing JavaScript whitespace and UTF-16 bounds.
    IF char_length(provider_id)
        + char_length(regexp_replace(provider_id, U&'[\0001-\FFFF]', '', 'g'))
        NOT BETWEEN 1 AND 200
      OR provider_id <> btrim(provider_id,
        U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      OR provider_id ~ U&'[\0001-\001F\007F\2028\2029]' THEN
      RETURN false;
    END IF;
    IF NOT ((binding->'grant') ?& ARRAY['providerInstanceId', 'repositoryId', 'grantId'])
      OR (binding->'grant') - 'providerInstanceId' - 'repositoryId' - 'grantId' <> '{}'::jsonb THEN
      RETURN false;
    END IF;
    FOR identity_value IN SELECT value FROM jsonb_each(binding->'grant') LOOP
      IF jsonb_typeof(identity_value) IS DISTINCT FROM 'string'
        OR octet_length(identity_value #>> '{}') NOT BETWEEN 1 AND 512
        OR (identity_value #>> '{}') ~ U&'[\0001-\001F\007F]' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.repository_credentials_are_valid(credentials jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  identity_value jsonb;
  deadline numeric;
BEGIN
  IF jsonb_typeof(credentials) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF NOT (credentials ?& ARRAY['driver', 'deadlineWallMs', 'bindings'])
    OR credentials - 'driver' - 'deadlineWallMs' - 'bindings' <> '{}'::jsonb
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
  deadline := (credentials->>'deadlineWallMs')::numeric;
  IF deadline NOT BETWEEN 1 AND 9007199254740991 OR mod(deadline, 1) <> 0 THEN
    RETURN false;
  END IF;
  RETURN occ.repository_bindings_are_valid(credentials->'bindings', true);
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD COLUMN repository_bindings jsonb,
  ADD CONSTRAINT agents_repository_bindings_valid CHECK (
    repository_bindings IS NULL OR occ.repository_bindings_are_valid(repository_bindings, false)
  );
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot,
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute', 'harness_auth'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'plugins' - 'repository_credentials') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
    AND (admitted_spec->>'configuration_id') ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
    AND (admitted_spec->>'configuration_kind') = 'agent'
    AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
    AND (admitted_spec->>'configuration_generation')::numeric BETWEEN 1 AND 9007199254740991
    AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
    AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
    AND jsonb_typeof(admitted_spec->'harness') = 'object'
    AND ((admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode'])
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
    AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
    AND jsonb_typeof(admitted_spec->'compute') = 'object'
    AND ((admitted_spec->'compute') ?& ARRAY['id', 'implementation'])
    AND ((admitted_spec->'compute') - 'id' - 'implementation') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
    AND (
      NOT (admitted_spec ? 'sandbox_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_bindings')
      OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
    )
    AND occ.harness_auth_is_valid(admitted_spec->'harness_auth', namespace_id, true)
    AND (
      NOT (admitted_spec ? 'repository_credentials')
      OR occ.repository_credentials_are_valid(admitted_spec->'repository_credentials')
    )
    AND (
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
  );
--> statement-breakpoint
CREATE TABLE occ.repository_session_attempts (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  repository_ref text NOT NULL,
  admission_id text PRIMARY KEY,
  duration_seconds bigint NOT NULL,
  deadline_wall_ms bigint NOT NULL,
  phase text NOT NULL,
  session_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT repository_session_attempts_revision_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT repository_session_attempts_repository_ref_valid CHECK (
    repository_ref ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  CONSTRAINT repository_session_attempts_admission_id_valid CHECK (
    admission_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  CONSTRAINT repository_session_attempts_session_id_valid CHECK (
    session_id IS NULL OR session_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  CONSTRAINT repository_session_attempts_duration_valid CHECK (
    duration_seconds BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT repository_session_attempts_deadline_valid CHECK (
    deadline_wall_ms BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT repository_session_attempts_phase_valid CHECK (
    phase IN ('opening', 'open', 'closing', 'disposed', 'invalidated')
  ),
  CONSTRAINT repository_session_attempts_phase_session_valid CHECK (
    (phase = 'opening' AND session_id IS NULL)
    OR (phase IN ('open', 'disposed') AND session_id IS NOT NULL)
    OR phase IN ('closing', 'invalidated')
  ),
  CONSTRAINT repository_session_attempts_timestamps_valid CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_session_attempts_active_binding_unique
  ON occ.repository_session_attempts (revision_id, repository_ref)
  WHERE phase IN ('opening', 'open');
--> statement-breakpoint
CREATE UNIQUE INDEX repository_session_attempts_session_id_unique
  ON occ.repository_session_attempts (session_id)
  WHERE session_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX repository_session_attempts_owner
  ON occ.repository_session_attempts (namespace_id, agent_id, revision_id);
--> statement-breakpoint
CREATE FUNCTION occ.guard_repository_session_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credentials jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase IS DISTINCT FROM 'opening' OR NEW.session_id IS NOT NULL THEN
      RAISE EXCEPTION 'Repository session attempts must begin opening without a session ID'
        USING ERRCODE = '23514';
    END IF;
    SELECT admitted_spec->'repository_credentials' INTO credentials
      FROM occ.agent_revisions
      WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id AND id = NEW.revision_id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF NOT occ.repository_credentials_are_valid(credentials) THEN
      RAISE EXCEPTION 'Repository session attempt requires an admitted repository binding'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.deadline_wall_ms IS DISTINCT FROM (credentials->>'deadlineWallMs')::numeric::bigint
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(credentials->'bindings') AS binding
        WHERE binding->>'repositoryRef' = NEW.repository_ref
      ) THEN
      RAISE EXCEPTION 'Repository session attempt must match its admitted binding and deadline'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.namespace_id, NEW.agent_id, NEW.revision_id, NEW.repository_ref,
      NEW.admission_id, NEW.duration_seconds, NEW.deadline_wall_ms, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.namespace_id, OLD.agent_id, OLD.revision_id, OLD.repository_ref,
      OLD.admission_id, OLD.duration_seconds, OLD.deadline_wall_ms, OLD.created_at)
    OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    RAISE EXCEPTION 'Repository session attempt identity and known session ID are immutable'
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
CREATE TRIGGER repository_session_attempts_guard
  BEFORE INSERT OR UPDATE ON occ.repository_session_attempts
  FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_session_attempt();
--> statement-breakpoint
CREATE TRIGGER repository_session_attempts_cannot_be_deleted
  BEFORE DELETE ON occ.repository_session_attempts
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.repository_session_attempts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.repository_session_attempts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (phase, session_id, updated_at) ON occ.repository_session_attempts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (repository_bindings) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_bindings_are_valid(jsonb, boolean) TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_credentials_are_valid(jsonb) TO occ_app;
