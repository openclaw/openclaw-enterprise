CREATE TABLE occ.presets (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  name text COLLATE "C" NOT NULL,
  template jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT presets_namespace_id_name_unique UNIQUE (namespace_id, name),
  CONSTRAINT presets_id_format CHECK (
    id ~ '^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT presets_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT presets_name_normalized CHECK (
    name = btrim(name) AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT presets_template_object CHECK (jsonb_typeof(template) = 'object')
);
--> statement-breakpoint
CREATE TRIGGER preset_owner_and_identity_are_immutable
BEFORE UPDATE OF id, namespace_id, created_at ON occ.presets
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_resource_kind_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (
  resource_kind IN (
    'installation', 'namespace', 'configuration', 'preset', 'service_account', 'secret',
    'agent', 'agent_revision'
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
  ) THEN
    RAISE EXCEPTION 'a nonempty namespace cannot be tombstoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON occ.presets FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.presets TO occ_app;
--> statement-breakpoint
GRANT UPDATE (name, template) ON occ.presets TO occ_app;
--> statement-breakpoint
-- Extend only the unchanged built-in Installation administrator. Custom roles,
-- including reduced or extended copies of that role, retain their exact grants.
WITH legacy_administrator AS (
  SELECT jsonb_agg(jsonb_build_object('action', action, 'resourceKind', resource_kind)) AS permissions
  FROM (VALUES
    ('installation', ARRAY['administer', 'read']),
    ('namespace', ARRAY['create', 'read', 'delete']),
    ('configuration', ARRAY['create', 'read', 'update', 'delete']),
    ('service_account', ARRAY['create', 'read', 'update', 'delete']),
    ('secret', ARRAY['create', 'read', 'update', 'delete', 'operate']),
    ('agent', ARRAY['create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer']),
    ('agent_revision', ARRAY['read'])
  ) AS legacy(resource_kind, actions)
  CROSS JOIN LATERAL unnest(actions) AS action
)
UPDATE occ.iam_roles AS role
SET permissions = role.permissions || '[
  {"action":"create","resourceKind":"preset"},
  {"action":"read","resourceKind":"preset"},
  {"action":"update","resourceKind":"preset"},
  {"action":"delete","resourceKind":"preset"}
]'::jsonb
FROM legacy_administrator AS legacy
WHERE role.namespace_id IS NULL
  AND role.name = 'Installation administrator'
  AND role.id ~ '^role_admin_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_array_length(role.permissions) = jsonb_array_length(legacy.permissions)
  AND role.permissions @> legacy.permissions
  AND legacy.permissions @> role.permissions;
