DO $$
BEGIN
  IF EXISTS (
    SELECT FROM occ.agent_revisions
    WHERE admitted_spec #>> '{execution_admission,mode}' = 'standalone'
      AND admitted_spec #> '{execution_admission,version}' = '8'::jsonb
      AND admitted_spec ? 'repository_credentials'
      AND admitted_spec #> '{repository_credentials,authorization}' IS DISTINCT FROM '"credential_source"'::jsonb
  ) THEN
    RAISE EXCEPTION 'Source-backed Repository authorization requires disposition of retained standalone Repository revisions'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
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
  IF credentials ? 'authorization' THEN
    IF credentials->'authorization' IS DISTINCT FROM '"credential_source"'::jsonb
      OR NOT (credentials ?& ARRAY['authorization', 'driver', 'bindings'])
      OR credentials - 'authorization' - 'driver' - 'bindings' <> '{}'::jsonb
      OR jsonb_typeof(credentials->'driver') IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
  ELSIF NOT (credentials ?& ARRAY['driver', 'deadlineWallMs', 'bindings'])
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
  IF credentials ? 'authorization' THEN
    RETURN occ.repository_bindings_are_valid(credentials->'bindings', true);
  END IF;
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
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_source_backed_repository_authorization CHECK (
  CASE WHEN admitted_spec #>> '{execution_admission,mode}' = 'standalone'
    AND admitted_spec #> '{execution_admission,version}' = '8'::jsonb
    AND admitted_spec ? 'repository_credentials'
  THEN COALESCE(
    admitted_spec #> '{repository_credentials,authorization}' = '"credential_source"'::jsonb
    AND admitted_spec #>> '{harness,id}' IN ('codex', 'openclaw'), false)
  ELSE NOT COALESCE((admitted_spec->'repository_credentials') ? 'authorization', false)
  END
) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_source_backed_repository_authorization;
