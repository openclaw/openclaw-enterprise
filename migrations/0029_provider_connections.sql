CREATE TABLE occ.provider_connections (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C" NOT NULL,
  provider_id text NOT NULL,
  auth_method_id text NOT NULL,
  source_secret_id text,
  base_url text,
  created_at timestamptz NOT NULL,
  CONSTRAINT provider_connections_namespace_id_id_unique UNIQUE (namespace_id, id),
  CONSTRAINT provider_connections_namespace_id_name_unique UNIQUE (namespace_id, name),
  CONSTRAINT provider_connections_id_format CHECK (
    id ~ '^pco_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT provider_connections_name_valid CHECK (
    char_length(name) BETWEEN 1 AND 200 AND name = btrim(name) AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT provider_connections_provider_id_valid CHECK (
    char_length(provider_id) BETWEEN 1 AND 200 AND provider_id = btrim(provider_id) AND provider_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT provider_connections_auth_method_id_valid CHECK (
    char_length(auth_method_id) BETWEEN 1 AND 200 AND auth_method_id = btrim(auth_method_id) AND auth_method_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT provider_connections_base_url_valid CHECK (
    base_url IS NULL OR (char_length(base_url) BETWEEN 1 AND 2048 AND base_url = btrim(base_url) AND base_url !~ '[[:cntrl:]]')
  ),
  CONSTRAINT provider_connections_source_secret_owner FOREIGN KEY (namespace_id, source_secret_id)
    REFERENCES occ.secrets(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER provider_connection_is_immutable
BEFORE UPDATE ON occ.provider_connections
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE binding->>'method'
      WHEN 'runtime' THEN binding = '{"method":"runtime"}'::jsonb
      WHEN 'provider_connection' THEN CASE WHEN resolved THEN
        (binding ?& ARRAY['method', 'connection'])
        AND (binding - 'method' - 'connection' - 'credential') = '{}'::jsonb
        AND jsonb_typeof(binding->'connection') = 'object'
        AND ((binding->'connection') ?& ARRAY['id', 'providerId', 'authMethodId'])
        AND ((binding->'connection') - 'id' - 'providerId' - 'authMethodId' - 'baseUrl') = '{}'::jsonb
        AND jsonb_typeof(binding #> '{connection,id}') = 'string'
        AND (binding #>> '{connection,id}') ~ '^pco_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(binding #> '{connection,providerId}') = 'string'
        AND btrim(binding #>> '{connection,providerId}') <> ''
        AND jsonb_typeof(binding #> '{connection,authMethodId}') = 'string'
        AND btrim(binding #>> '{connection,authMethodId}') <> ''
        AND (NOT ((binding->'connection') ? 'baseUrl') OR (
          jsonb_typeof(binding #> '{connection,baseUrl}') = 'string'
          AND char_length(binding #>> '{connection,baseUrl}') BETWEEN 1 AND 2048
          AND (binding #>> '{connection,baseUrl}') = btrim(binding #>> '{connection,baseUrl}')
          AND (binding #>> '{connection,baseUrl}') !~ '[[:cntrl:]]'
        ))
        AND (NOT (binding ? 'credential') OR (
          jsonb_typeof(binding->'credential') = 'object'
          AND ((binding->'credential') ?& ARRAY['source', 'secretDriverId'])
          AND ((binding->'credential') - 'source' - 'secretDriverId') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{credential,source}') = 'object'
          AND ((binding #> '{credential,source}') ?& ARRAY['kind', 'namespaceId', 'id'])
          AND ((binding #> '{credential,source}') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
          AND binding #>> '{credential,source,kind}' = 'secret'
          AND binding #>> '{credential,source,namespaceId}' = owner_namespace
          AND (binding #>> '{credential,source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND jsonb_typeof(binding #> '{credential,secretDriverId}') = 'string'
          AND btrim(binding #>> '{credential,secretDriverId}') <> ''
        ))
      ELSE
        (binding ?& ARRAY['method', 'connectionId'])
        AND (binding - 'method' - 'connectionId') = '{}'::jsonb
        AND jsonb_typeof(binding->'connectionId') = 'string'
        AND (binding->>'connectionId') ~ '^pco_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      END
      WHEN 'api_key' THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source' - CASE WHEN resolved THEN 'secretDriverId' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'secret'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (jsonb_typeof(binding->'secretDriverId') = 'string' AND btrim(binding->>'secretDriverId') <> ''))
      WHEN 'chatgpt_service_account' THEN
        (binding ?& ARRAY['method', 'serviceAccountId'])
        AND (binding - 'method' - 'serviceAccountId'
          - CASE WHEN resolved THEN 'credential' ELSE 'method' END
          - CASE WHEN resolved THEN 'providerBinding' ELSE 'method' END) = '{}'::jsonb
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
          AND jsonb_typeof(binding->'providerBinding') = 'object'
          AND ((binding->'providerBinding') ?& ARRAY['providerId', 'driverId', 'workspaceId', 'credentialIssued'])
          AND ((binding->'providerBinding') - 'providerId' - 'driverId' - 'workspaceId' - 'credentialIssued') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{providerBinding,providerId}') = 'string'
          AND btrim(binding #>> '{providerBinding,providerId}') <> ''
          AND jsonb_typeof(binding #> '{providerBinding,driverId}') = 'string'
          AND btrim(binding #>> '{providerBinding,driverId}') <> ''
          AND jsonb_typeof(binding #> '{providerBinding,workspaceId}') = 'string'
          AND btrim(binding #>> '{providerBinding,workspaceId}') <> ''
          AND binding #> '{providerBinding,credentialIssued}' = 'true'::jsonb
        ))
      ELSE false
    END, false);
$$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN harness_auth_provider_connection_id text
  GENERATED ALWAYS AS (CASE WHEN harness_auth->>'method' = 'provider_connection' THEN harness_auth->>'connectionId' END) STORED;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_harness_auth_provider_connection_owner
  FOREIGN KEY (namespace_id, harness_auth_provider_connection_id)
  REFERENCES occ.provider_connections(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_resource_kind_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (
  resource_kind IN ('installation', 'namespace', 'configuration', 'preset', 'provider_connection', 'service_account', 'secret', 'agent', 'agent_revision')
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
  ELSIF checked_resource_kind = 'provider_connection' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.provider_connections
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'preset' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.presets
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
    OR EXISTS (SELECT 1 FROM occ.provider_connections WHERE namespace_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON occ.provider_connections FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.provider_connections TO occ_app;
--> statement-breakpoint
-- Row locking requires an UPDATE privilege; the immutable-row trigger rejects every write.
GRANT UPDATE (name) ON occ.provider_connections TO occ_app;
--> statement-breakpoint
-- Extend only the unchanged built-in Installation administrator. Custom roles,
-- including reduced or extended copies of that role, retain their exact grants.
WITH legacy_administrator AS (
  SELECT jsonb_agg(jsonb_build_object('action', action, 'resourceKind', resource_kind)) AS permissions
  FROM (VALUES
    ('installation', ARRAY['administer', 'read']),
    ('namespace', ARRAY['create', 'read', 'delete']),
    ('configuration', ARRAY['create', 'read', 'update', 'delete']),
    ('preset', ARRAY['create', 'read', 'update', 'delete']),
    ('service_account', ARRAY['create', 'read', 'update', 'delete']),
    ('secret', ARRAY['create', 'read', 'update', 'delete', 'operate']),
    ('agent', ARRAY['create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer']),
    ('agent_revision', ARRAY['read'])
  ) AS legacy(resource_kind, actions)
  CROSS JOIN LATERAL unnest(actions) AS action
)
UPDATE occ.iam_roles AS role
SET permissions = role.permissions || '[
  {"action":"create","resourceKind":"provider_connection"},
  {"action":"read","resourceKind":"provider_connection"},
  {"action":"delete","resourceKind":"provider_connection"},
  {"action":"operate","resourceKind":"provider_connection"}
]'::jsonb
FROM legacy_administrator AS legacy
WHERE role.namespace_id IS NULL
  AND role.name = 'Installation administrator'
  AND role.id ~ '^role_admin_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_array_length(role.permissions) = jsonb_array_length(legacy.permissions)
  AND role.permissions @> legacy.permissions
  AND legacy.permissions @> role.permissions;
