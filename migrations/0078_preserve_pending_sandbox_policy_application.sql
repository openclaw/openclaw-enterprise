CREATE OR REPLACE FUNCTION occ.guard_sandbox_policy_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.version NOT IN (OLD.version, OLD.version + 1)
    OR (NEW.version = OLD.version AND NEW.document->'additions' IS DISTINCT FROM OLD.document->'additions')
    OR (NEW.version <> OLD.version AND (OLD.document#>>'{application,state}' = 'pending' OR NEW.document ? 'application'))
    OR (OLD.document#>>'{application,state}' = 'pending' AND NOT (NEW.document ? 'application')) THEN
    RAISE EXCEPTION 'Invalid sandbox policy version transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.document ? 'application' THEN
    IF NOT EXISTS (SELECT 1 FROM occ.agent_revisions WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id AND id = NEW.document#>>'{application,revisionId}') THEN
      RAISE EXCEPTION 'Sandbox policy application revision has a different owner' USING ERRCODE = '23514';
    END IF;
    IF NEW.document#>>'{application,id}' = OLD.document#>>'{application,id}' THEN
      IF (NEW.document->'application') - 'state' - 'expectedProviderVersion' - 'providerVersion' - 'reason'
          IS DISTINCT FROM (OLD.document->'application') - 'state' - 'expectedProviderVersion' - 'providerVersion' - 'reason'
        OR (OLD.document#>>'{application,expectedProviderVersion}' IS NOT NULL AND NEW.document#>>'{application,expectedProviderVersion}' IS DISTINCT FROM OLD.document#>>'{application,expectedProviderVersion}')
        OR (OLD.document#>>'{application,state}' <> 'pending' AND NEW.document->'application' IS DISTINCT FROM OLD.document->'application') THEN
        RAISE EXCEPTION 'Sandbox policy application identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.document#>>'{application,state}' = 'pending' OR NEW.document#>>'{application,state}' <> 'pending' OR NEW.document->'application' ? 'expectedProviderVersion' THEN
      RAISE EXCEPTION 'Invalid sandbox policy application transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.document->'applied' IS DISTINCT FROM OLD.document->'applied' AND (
    NEW.document#>>'{application,state}' IS DISTINCT FROM 'applied'
    OR NEW.document#>'{applied,policyVersion}' IS DISTINCT FROM NEW.document#>'{application,policyVersion}'
    OR NEW.document#>'{applied,revisionId}' IS DISTINCT FROM NEW.document#>'{application,revisionId}'
    OR NEW.document#>'{applied,providerVersion}' IS DISTINCT FROM NEW.document#>'{application,providerVersion}'
  ) THEN
    RAISE EXCEPTION 'Applied policy requires confirmed application evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
