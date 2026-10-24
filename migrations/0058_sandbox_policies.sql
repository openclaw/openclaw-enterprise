ALTER TABLE occ.agents ADD COLUMN sandbox_policy_editing boolean NOT NULL DEFAULT false;
--> statement-breakpoint
GRANT UPDATE (sandbox_policy_editing) ON occ.agents TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.sandbox_network_grants_are_valid(grants jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE grant_entry jsonb; range_entry jsonb;
BEGIN
  IF jsonb_typeof(grants) IS DISTINCT FROM 'array' OR jsonb_array_length(grants) > 32 THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT entry->>'id') FROM jsonb_array_elements(grants) entry) <> jsonb_array_length(grants) THEN RETURN false; END IF;
  FOR grant_entry IN SELECT * FROM jsonb_array_elements(grants) LOOP
    IF NOT (grant_entry ?& ARRAY['id','binary','host','ports'])
      OR grant_entry - 'id' - 'binary' - 'host' - 'ports' <> '{}'::jsonb
      OR jsonb_typeof(grant_entry->'id') <> 'string' OR grant_entry->>'id' !~ '^[a-z][a-z0-9-]{0,47}$'
      OR jsonb_typeof(grant_entry->'binary') <> 'string' OR char_length(grant_entry->>'binary') NOT BETWEEN 2 AND 512
      OR grant_entry->>'binary' !~ '^/[^[:space:][:cntrl:]]+$'
      OR grant_entry->>'binary' ~ '//|/\.{1,2}(/|$)|/$'
      OR jsonb_typeof(grant_entry->'host') <> 'string' OR char_length(grant_entry->>'host') > 253
      OR grant_entry->>'host' !~ '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
      OR jsonb_typeof(grant_entry->'ports') <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(grant_entry->'ports') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
    FOR range_entry IN SELECT * FROM jsonb_array_elements(grant_entry->'ports') LOOP
      IF NOT (range_entry ?& ARRAY['from','to']) OR range_entry - 'from' - 'to' <> '{}'::jsonb
        OR jsonb_typeof(range_entry->'from') <> 'number' OR jsonb_typeof(range_entry->'to') <> 'number'
        OR (range_entry->>'from')::numeric NOT BETWEEN 1 AND 65535 OR (range_entry->>'to')::numeric NOT BETWEEN 1 AND 65535
        OR mod((range_entry->>'from')::numeric,1) <> 0 OR mod((range_entry->>'to')::numeric,1) <> 0
        OR (range_entry->>'from')::numeric > (range_entry->>'to')::numeric THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION occ.sandbox_policy_is_valid(document jsonb, id text, namespace_id text, agent_id text, version integer) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(
  jsonb_typeof(document) = 'object' AND document ?& ARRAY['id','namespaceId','agentId','version','additions']
  AND document - 'id' - 'namespaceId' - 'agentId' - 'version' - 'additions' - 'application' - 'applied' = '{}'::jsonb
  AND document->>'id' = id AND id = 'sbp_' || substring(agent_id FROM 5)
  AND document->>'namespaceId' = namespace_id AND document->>'agentId' = agent_id
  AND document->'version' = to_jsonb(version) AND version > 0
  AND occ.sandbox_network_grants_are_valid(document->'additions')
  AND (NOT (document ? 'application') OR (
    jsonb_typeof(document->'application') = 'object'
    AND document->'application' ?& ARRAY['id','revisionId','policyVersion','snapshot','state','requestedBy','requestedAt']
    AND (document->'application') - 'id' - 'revisionId' - 'policyVersion' - 'snapshot' - 'state' - 'requestedBy' - 'requestedAt' - 'expectedProviderVersion' - 'providerVersion' - 'reason' = '{}'::jsonb
    AND document#>>'{application,id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND document#>>'{application,revisionId}' ~ '^rev_[0-9a-f-]{36}$'
    AND jsonb_typeof(document#>'{application,requestedBy}') = 'string'
    AND char_length(document#>>'{application,requestedBy}') > 0
    AND jsonb_typeof(document#>'{application,requestedAt}') = 'string'
    AND document#>>'{application,requestedAt}' ~ '^\d{4}-\d{2}-\d{2}T'
    AND document#>>'{application,state}' IN ('pending','applied','failed')
    AND document#>'{application,policyVersion}' = to_jsonb(version)
    AND jsonb_typeof(document#>'{application,snapshot}') = 'object'
    AND document#>'{application,snapshot,additions}' = document->'additions'
    AND document#>'{application,snapshot,version}' = to_jsonb(version)
    AND document#>'{application,snapshot}' ?& ARRAY['driverId','implementation','version','defaults','additions']
    AND (document#>'{application,snapshot}') - 'driverId' - 'implementation' - 'version' - 'defaults' - 'additions' = '{}'::jsonb
    AND jsonb_typeof(document#>'{application,snapshot,defaults}') = 'object'
    AND jsonb_typeof(document#>'{application,snapshot,driverId}') = 'string'
    AND jsonb_typeof(document#>'{application,snapshot,implementation}') = 'string'
    AND (NOT (document->'application' ? 'expectedProviderVersion') OR (jsonb_typeof(document#>'{application,expectedProviderVersion}') = 'string' AND char_length(document#>>'{application,expectedProviderVersion}') BETWEEN 1 AND 256))
    AND (document#>>'{application,state}' <> 'applied' OR (jsonb_typeof(document#>'{application,providerVersion}') = 'string' AND char_length(document#>>'{application,providerVersion}') > 0))
  ))
  AND (NOT (document ? 'applied') OR (
    jsonb_typeof(document->'applied') = 'object'
    AND document->'applied' ?& ARRAY['revisionId','policyVersion','providerVersion','appliedAt']
    AND (document->'applied') - 'revisionId' - 'policyVersion' - 'providerVersion' - 'appliedAt' = '{}'::jsonb
    AND document#>>'{applied,revisionId}' ~ '^rev_[0-9a-f-]{36}$'
    AND jsonb_typeof(document#>'{applied,policyVersion}') = 'number'
    AND (document#>>'{applied,policyVersion}')::numeric BETWEEN 1 AND version
    AND mod((document#>>'{applied,policyVersion}')::numeric,1) = 0
    AND jsonb_typeof(document#>'{applied,providerVersion}') = 'string'
    AND char_length(document#>>'{applied,providerVersion}') > 0
    AND jsonb_typeof(document#>'{applied,appliedAt}') = 'string'
  )), false) $$;
--> statement-breakpoint
CREATE TABLE occ.sandbox_policies (
  id text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  version integer NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT sandbox_policies_agent_unique UNIQUE (namespace_id, agent_id),
  CONSTRAINT sandbox_policies_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id,id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT sandbox_policies_document_valid CHECK (occ.sandbox_policy_is_valid(document,id,namespace_id,agent_id,version))
);
--> statement-breakpoint
CREATE FUNCTION occ.create_agent_sandbox_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
BEGIN
  INSERT INTO occ.sandbox_policies (id,namespace_id,agent_id,version,document)
  VALUES ('sbp_' || substring(NEW.id FROM 5), NEW.namespace_id, NEW.id, 1,
    jsonb_build_object('id','sbp_' || substring(NEW.id FROM 5),'namespaceId',NEW.namespace_id,'agentId',NEW.id,'version',1,'additions','[]'::jsonb));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_sandbox_policy_is_created AFTER INSERT ON occ.agents FOR EACH ROW EXECUTE FUNCTION occ.create_agent_sandbox_policy();
--> statement-breakpoint
INSERT INTO occ.sandbox_policies SELECT 'sbp_' || substring(id FROM 5), namespace_id,id,1,
  jsonb_build_object('id','sbp_' || substring(id FROM 5),'namespaceId',namespace_id,'agentId',id,'version',1,'additions','[]'::jsonb) FROM occ.agents;
--> statement-breakpoint
CREATE TRIGGER sandbox_policy_identity_is_immutable BEFORE UPDATE OF id,namespace_id,agent_id ON occ.sandbox_policies FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.sandbox_policies FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.sandbox_policies TO occ_app;
--> statement-breakpoint
GRANT UPDATE (version,document) ON occ.sandbox_policies TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.create_agent_sandbox_policy() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.sandbox_network_grants_are_valid(jsonb), occ.sandbox_policy_is_valid(jsonb,text,text,text,integer) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid,
  ADD CONSTRAINT iam_restrictions_action_valid CHECK (action IN ('create','read','update','delete','deploy','operate','administer','read_logs','manage_policy')),
  DROP CONSTRAINT iam_restrictions_resource_kind_valid,
  ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (resource_kind IN ('installation','namespace','configuration','preset','service_account','secret','credential_source','sandbox_policy','agent','agent_revision'));
--> statement-breakpoint
ALTER TABLE occ.controller_work DROP CONSTRAINT controller_work_agent_target_valid,
  ADD CONSTRAINT controller_work_agent_target_valid CHECK (agent_target IS NULL OR agent_target IN ('stopped','deleted','credentials_withdrawn','sandbox_policy'));
--> statement-breakpoint
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid = 'occ.controller_work'::regclass AND conname = 'controller_work_namespace_target_valid';
  ALTER TABLE occ.controller_work DROP CONSTRAINT controller_work_namespace_target_valid;
  EXECUTE 'ALTER TABLE occ.controller_work ADD CONSTRAINT controller_work_namespace_target_valid ' || replace(definition, '''stopped''::text, ''deleted''::text', '''stopped''::text, ''deleted''::text, ''sandbox_policy''::text');
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid = 'occ.agent_revisions'::regclass AND conname = 'agent_revisions_admitted_snapshot';
  ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
  EXECUTE 'ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot ' || replace(definition, '- ''sandbox_driver_id''::text', '- ''sandbox_driver_id''::text - ''sandbox_policy''::text');
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.resource_belongs_to_namespace(
  checked_namespace_id text,
  checked_resource_kind text,
  checked_resource_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF checked_namespace_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'installation' THEN
    RETURN false;
  END IF;
  IF checked_resource_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'namespace' THEN
    RETURN checked_resource_id = checked_namespace_id;
  ELSIF checked_resource_kind = 'configuration' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.configurations
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'service_account' THEN
    RETURN checked_resource_id = checked_namespace_id OR EXISTS (
      SELECT 1 FROM occ.service_accounts
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'preset' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.presets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'credential_source' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.credential_sources
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'sandbox_policy' THEN
    RETURN EXISTS (SELECT 1 FROM occ.sandbox_policies WHERE namespace_id = checked_namespace_id AND id = checked_resource_id);
  ELSIF checked_resource_kind = 'secret' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.secrets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agents
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent_revision' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agent_revisions
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  END IF;
  RETURN false;
END;
$$;

--> statement-breakpoint
CREATE FUNCTION occ.remove_sandbox_policy_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
BEGIN
  DELETE FROM occ.iam_access_bindings WHERE resource_kind = 'sandbox_policy' AND resource_id = OLD.id;
  DELETE FROM occ.iam_restrictions WHERE resource_kind = 'sandbox_policy' AND resource_id = OLD.id;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER sandbox_policy_access_is_removed AFTER DELETE ON occ.sandbox_policies FOR EACH ROW EXECUTE FUNCTION occ.remove_sandbox_policy_access();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.remove_sandbox_policy_access() FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION occ.guard_sandbox_policy_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.version NOT IN (OLD.version, OLD.version + 1)
    OR (NEW.version = OLD.version AND NEW.document->'additions' IS DISTINCT FROM OLD.document->'additions')
    OR (NEW.version <> OLD.version AND (OLD.document#>>'{application,state}' = 'pending' OR NEW.document ? 'application')) THEN
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
--> statement-breakpoint
CREATE TRIGGER sandbox_policy_transition_valid BEFORE UPDATE ON occ.sandbox_policies FOR EACH ROW EXECUTE FUNCTION occ.guard_sandbox_policy_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_sandbox_policy_update(), occ.sandbox_network_grants_are_valid(jsonb), occ.sandbox_policy_is_valid(jsonb,text,text,text,integer) FROM PUBLIC;
