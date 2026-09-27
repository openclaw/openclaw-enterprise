-- Credential sources record gateway-held credentials; OCC stores metadata and Secret references only.
CREATE FUNCTION occ.credential_source_config_is_valid(config jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(config) = 'object'
    AND (SELECT count(*) FROM jsonb_each(config)) <= 32
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(config) AS entry(field, value)
      WHERE field !~ '^[a-z][a-z0-9_]{0,63}$'
        OR jsonb_typeof(value) IS DISTINCT FROM 'string'
        OR char_length(value #>> '{}') NOT BETWEEN 1 AND 2048
    ), false);
$$;
--> statement-breakpoint
CREATE TABLE occ.credential_sources (
  id text PRIMARY KEY,
  namespace_id text NOT NULL,
  name text COLLATE "C" NOT NULL,
  type text NOT NULL,
  config jsonb NOT NULL,
  driver_id text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT credential_sources_namespace_id_id_unique UNIQUE (namespace_id, id),
  CONSTRAINT credential_sources_namespace_id_name_unique UNIQUE (namespace_id, name),
  CONSTRAINT credential_sources_namespace_owner
    FOREIGN KEY (namespace_id)
    REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_sources_id_format CHECK (
    id ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT credential_sources_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT credential_sources_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT credential_sources_type_valid CHECK (type ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT credential_sources_config_valid CHECK (occ.credential_source_config_is_valid(config)),
  CONSTRAINT credential_sources_driver_id_valid CHECK (
    char_length(driver_id) BETWEEN 1 AND 200 AND driver_id = btrim(driver_id)
  ),
  CONSTRAINT credential_sources_state_valid CHECK (state IN ('registering', 'ready', 'deleting'))
);
--> statement-breakpoint
CREATE TRIGGER credential_source_metadata_is_immutable
BEFORE UPDATE OF id, namespace_id, name, type, config, driver_id, created_at
ON occ.credential_sources
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- Deletion is one-way: a deleting source never returns to ready.
CREATE TRIGGER credential_source_deletion_is_final
BEFORE UPDATE OF state ON occ.credential_sources
FOR EACH ROW WHEN (OLD.state = 'deleting' AND NEW.state IS DISTINCT FROM OLD.state)
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- Registration is recorded before the gateway write; no source returns to registering.
CREATE TRIGGER credential_source_registration_is_initial
BEFORE UPDATE OF state ON occ.credential_sources
FOR EACH ROW WHEN (NEW.state = 'registering' AND OLD.state IS DISTINCT FROM 'registering')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TABLE occ.credential_source_secrets (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  field text COLLATE "C" NOT NULL,
  secret_id text NOT NULL,
  CONSTRAINT credential_source_secrets_pkey PRIMARY KEY (credential_source_id, field),
  CONSTRAINT credential_source_secrets_source_owner
    FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- A referenced Secret cannot be deleted while any credential source uses it.
  CONSTRAINT credential_source_secrets_secret_owner
    FOREIGN KEY (namespace_id, secret_id)
    REFERENCES occ.secrets(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_source_secrets_field_format CHECK (field ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE INDEX credential_source_secrets_secret_idx
ON occ.credential_source_secrets (namespace_id, secret_id);
--> statement-breakpoint
CREATE TRIGGER credential_source_secrets_are_immutable
BEFORE UPDATE ON occ.credential_source_secrets
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE
      WHEN binding->>'method' = 'runtime' THEN binding = '{"method":"runtime"}'::jsonb
      WHEN binding->>'method' IN ('api_key', 'codex_pat') THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source' - CASE WHEN resolved THEN 'secretDriverId' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'secret'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (jsonb_typeof(binding->'secretDriverId') = 'string' AND btrim(binding->>'secretDriverId') <> ''))
      WHEN binding->>'method' = 'chatgpt_service_account' THEN
        (binding ?& ARRAY['method', 'serviceAccountId'])
        AND (binding - 'method' - 'serviceAccountId'
          - CASE WHEN resolved THEN 'credential' ELSE 'method' END
          - CASE WHEN resolved THEN 'backendBinding' ELSE 'method' END) = '{}'::jsonb
        AND (binding->>'serviceAccountId') ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (
          jsonb_typeof(binding->'credential') = 'object'
          AND ((binding->'credential') ?& ARRAY['kind', 'secretRef'])
          AND ((binding->'credential') - 'kind' - 'secretRef') = '{}'::jsonb
          AND binding #>> '{credential,kind}' = 'access_token'
          AND jsonb_typeof(binding #> '{credential,secretRef}') = 'object'
          AND ((binding #> '{credential,secretRef}') ?& ARRAY['name', 'key'])
          AND ((binding #> '{credential,secretRef}') - 'name' - 'key') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{credential,secretRef,name}') = 'string'
          AND char_length(binding #>> '{credential,secretRef,name}') BETWEEN 1 AND 253
          AND (binding #>> '{credential,secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
          AND jsonb_typeof(binding #> '{credential,secretRef,key}') = 'string'
          AND char_length(binding #>> '{credential,secretRef,key}') BETWEEN 1 AND 253
          AND (binding #>> '{credential,secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
          AND (binding #>> '{credential,secretRef,key}') NOT IN ('.', '..')
          AND jsonb_typeof(binding->'backendBinding') = 'object'
          AND ((binding->'backendBinding') ?& ARRAY['backendId', 'driverId', 'workspaceId', 'credentialIssued'])
          AND ((binding->'backendBinding') - 'backendId' - 'driverId' - 'workspaceId' - 'credentialIssued') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{backendBinding,backendId}') = 'string'
          AND btrim(binding #>> '{backendBinding,backendId}') <> ''
          AND jsonb_typeof(binding #> '{backendBinding,driverId}') = 'string'
          AND btrim(binding #>> '{backendBinding,driverId}') <> ''
          AND jsonb_typeof(binding #> '{backendBinding,workspaceId}') = 'string'
          AND btrim(binding #>> '{backendBinding,workspaceId}') <> ''
          AND binding #> '{backendBinding,credentialIssued}' = 'true'::jsonb
        ))
      WHEN binding->>'method' = 'credential_source' THEN
        (binding ?& ARRAY['method', 'sourceId'])
        AND jsonb_typeof(binding->'sourceId') = 'string'
        AND (binding->>'sourceId') ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND CASE WHEN resolved THEN
          (binding - 'method' - 'sourceId' - 'credentialGatewayId' - 'sourceType' - 'loginMode') = '{}'::jsonb
          AND jsonb_typeof(binding->'credentialGatewayId') = 'string'
          AND btrim(binding->>'credentialGatewayId') <> ''
          AND jsonb_typeof(binding->'sourceType') = 'string'
          AND (binding->>'sourceType') ~ '^[a-z][a-z0-9-]{0,63}$'
          AND jsonb_typeof(binding->'loginMode') = 'string'
          AND binding->>'loginMode' = 'api_key'
        ELSE (binding - 'method' - 'sourceId') = '{}'::jsonb END
      ELSE false
    END, false);
$$;
--> statement-breakpoint
-- Agent drafts retain an exact same-Namespace credential source; retired revisions keep their snapshot.
ALTER TABLE occ.agents
  ADD COLUMN harness_auth_credential_source_id text GENERATED ALWAYS AS (
    CASE WHEN harness_auth->>'method' = 'credential_source' THEN harness_auth->>'sourceId' END
  ) STORED,
  ADD CONSTRAINT agents_harness_auth_credential_source_owner
    FOREIGN KEY (namespace_id, harness_auth_credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_resource_kind_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (
  resource_kind IN (
    'installation', 'namespace', 'configuration', 'preset', 'service_account', 'secret',
    'credential_source', 'agent', 'agent_revision'
  )
);
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
CREATE OR REPLACE FUNCTION occ.validate_namespace_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a deleted namespace is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'provisioning' AND NEW.status IN ('ready', 'failed', 'deleting'))
    OR (OLD.status IN ('ready', 'failed') AND NEW.status = 'deleting')
  ) THEN
    RAISE EXCEPTION 'invalid namespace lifecycle transition' USING ERRCODE = '23514';
  END IF;

  IF NEW.deleted_at IS NOT NULL AND (
    NEW.status <> 'deleting' OR NEW.deleted_at < NEW.created_at
  ) THEN
    RAISE EXCEPTION 'invalid namespace tombstone' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND (
    EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.configurations WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.service_accounts WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.secrets WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.presets WHERE namespace_id = NEW.id)
    OR EXISTS (SELECT 1 FROM occ.credential_sources WHERE namespace_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON occ.credential_sources FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.credential_sources TO occ_app;
--> statement-breakpoint
GRANT UPDATE (state) ON occ.credential_sources TO occ_app;
--> statement-breakpoint
REVOKE ALL ON occ.credential_source_secrets FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.credential_source_secrets TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.credential_source_config_is_valid(jsonb) TO occ_app;
