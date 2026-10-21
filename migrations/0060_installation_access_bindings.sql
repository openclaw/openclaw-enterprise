-- Installation access bindings grant an Installation Role on one Installation resource to a
-- person or to anyone acting for a Namespace. Deleting that Namespace removes its bindings.
ALTER TABLE occ.iam_access_bindings ADD COLUMN namespace_subject_id text
  REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings DROP CONSTRAINT iam_access_bindings_one_subject,
  ADD CONSTRAINT iam_access_bindings_one_subject
    CHECK (num_nonnulls(identity_subject_id, group_subject_id, namespace_subject_id) = 1),
  ADD CONSTRAINT iam_access_bindings_namespace_subject_installation CHECK (
    namespace_subject_id IS NULL OR (namespace_id IS NULL AND resource_kind = 'connection_template')
  ),
  ADD CONSTRAINT iam_access_bindings_installation_resource_unscoped CHECK (
    resource_kind IS DISTINCT FROM 'connection_template' OR namespace_id IS NULL
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.validate_access_binding_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
DECLARE
  role_scope text;
  role_permissions jsonb;
  identity_scope text;
  identity_kind text;
  group_scope text;
BEGIN
  SELECT namespace_id, permissions INTO role_scope, role_permissions
  FROM occ.iam_roles WHERE id = NEW.role_id;
  IF NOT FOUND OR (role_scope IS NOT NULL AND role_scope IS DISTINCT FROM NEW.namespace_id) THEN
    RAISE EXCEPTION 'access binding role scope is invalid' USING ERRCODE = '23514';
  END IF;

  -- An Installation resource binding grants only actions on that resource's kind.
  IF NEW.resource_kind = 'connection_template' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(role_permissions) permission
    WHERE permission->>'resourceKind' IS DISTINCT FROM NEW.resource_kind
  ) THEN
    RAISE EXCEPTION 'access binding role exceeds its Installation resource'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.identity_subject_id IS NOT NULL THEN
    SELECT namespace_id, kind INTO identity_scope, identity_kind
    FROM occ.iam_identities WHERE id = NEW.identity_subject_id;
    IF NOT FOUND OR (
      identity_scope IS NOT NULL AND identity_scope IS DISTINCT FROM NEW.namespace_id
    ) OR (NEW.resource_kind = 'connection_template' AND (
      identity_kind <> 'principal' OR identity_scope IS NOT NULL
    )) THEN
      RAISE EXCEPTION 'access binding identity scope is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.group_subject_id IS NOT NULL THEN
    SELECT namespace_id INTO group_scope FROM occ.iam_groups WHERE id = NEW.group_subject_id;
    IF NOT FOUND OR group_scope IS DISTINCT FROM NEW.namespace_id THEN
      RAISE EXCEPTION 'access binding group scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT occ.resource_belongs_to_namespace(
    NEW.namespace_id, NEW.resource_kind, NEW.resource_id
  ) THEN
    RAISE EXCEPTION 'access binding resource scope is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid,
  ADD CONSTRAINT iam_restrictions_action_valid CHECK (action IN ('create','read','update','delete','deploy','operate','administer','read_logs','manage_policy','use')),
  DROP CONSTRAINT iam_restrictions_resource_kind_valid,
  ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (resource_kind IN ('installation','namespace','configuration','preset','service_account','secret','credential_source','sandbox_policy','agent','agent_revision','connection_template'));
--> statement-breakpoint
-- Extend the unchanged built-in administrator with connection template authority.
-- Custom Roles retain their explicitly configured permissions.
WITH prior(resource_kind, actions) AS (
  VALUES ('installation', ARRAY['administer','read']),
    ('namespace', ARRAY['create','read','delete']),
    ('configuration', ARRAY['create','read','update','delete']),
    ('service_account', ARRAY['create','read','update','delete']),
    ('secret', ARRAY['create','read','update','delete','operate']),
    ('preset', ARRAY['create','read','update','delete']),
    ('credential_source', ARRAY['create','read','update','delete','operate']),
    ('agent', ARRAY['create','read','update','delete','deploy','operate','administer','manage_policy']),
    ('agent_revision', ARRAY['read']),
    ('sandbox_policy', ARRAY['read','update'])
), unchanged AS (
  SELECT jsonb_agg(jsonb_build_object('action',action,'resourceKind',resource_kind)) AS permissions
  FROM prior CROSS JOIN LATERAL unnest(actions) action
)
UPDATE occ.iam_roles role SET permissions = role.permissions ||
  '[{"action":"create","resourceKind":"connection_template"},{"action":"read","resourceKind":"connection_template"},{"action":"update","resourceKind":"connection_template"},{"action":"delete","resourceKind":"connection_template"},{"action":"use","resourceKind":"connection_template"}]'::jsonb
FROM unchanged WHERE role.namespace_id IS NULL AND role.name = 'Installation administrator'
  AND role.id ~ '^role_admin_[0-9a-f-]{36}$'
  AND jsonb_array_length(role.permissions) = jsonb_array_length(unchanged.permissions)
  AND role.permissions @> unchanged.permissions AND unchanged.permissions @> role.permissions;
--> statement-breakpoint
-- Bootstrap seeds this Role for a new Installation; existing Installations receive it here.
INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
SELECT 'role_connection_template_user', NULL, 'Connection template user',
  '[{"action":"use","resourceKind":"connection_template"}]'::jsonb
WHERE EXISTS (SELECT 1 FROM occ.installation);
