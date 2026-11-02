-- RFC-0026 built-in Roles and the Default users Group. Their ids and permissions match
-- BUILT_IN_ROLES in packages/contracts/src/index.ts.
INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES
  ('role_builtin_agent_creator', NULL, 'Agent Creator', '[
    {"action":"create","resourceKind":"agent"},
    {"action":"create","resourceKind":"configuration"},
    {"action":"create","resourceKind":"secret"},
    {"action":"create","resourceKind":"credential_source"},
    {"action":"read","resourceKind":"namespace"},
    {"action":"read","resourceKind":"preset"}
  ]'::jsonb),
  ('role_builtin_namespace_creator', NULL, 'Namespace Creator',
    '[{"action":"create","resourceKind":"namespace"}]'::jsonb),
  ('role_builtin_namespace_member', NULL, 'Namespace member', '[
    {"action":"create","resourceKind":"agent"},
    {"action":"read","resourceKind":"agent"},
    {"action":"update","resourceKind":"agent"},
    {"action":"delete","resourceKind":"agent"},
    {"action":"deploy","resourceKind":"agent"},
    {"action":"operate","resourceKind":"agent"},
    {"action":"administer","resourceKind":"agent"},
    {"action":"read_logs","resourceKind":"agent"},
    {"action":"manage_policy","resourceKind":"agent"},
    {"action":"read","resourceKind":"agent_revision"},
    {"action":"read","resourceKind":"sandbox_policy"},
    {"action":"update","resourceKind":"sandbox_policy"},
    {"action":"create","resourceKind":"configuration"},
    {"action":"read","resourceKind":"configuration"},
    {"action":"update","resourceKind":"configuration"},
    {"action":"delete","resourceKind":"configuration"},
    {"action":"create","resourceKind":"preset"},
    {"action":"read","resourceKind":"preset"},
    {"action":"update","resourceKind":"preset"},
    {"action":"delete","resourceKind":"preset"},
    {"action":"create","resourceKind":"service_account"},
    {"action":"read","resourceKind":"service_account"},
    {"action":"update","resourceKind":"service_account"},
    {"action":"delete","resourceKind":"service_account"},
    {"action":"create","resourceKind":"secret"},
    {"action":"read","resourceKind":"secret"},
    {"action":"update","resourceKind":"secret"},
    {"action":"delete","resourceKind":"secret"},
    {"action":"operate","resourceKind":"secret"},
    {"action":"create","resourceKind":"credential_source"},
    {"action":"read","resourceKind":"credential_source"},
    {"action":"update","resourceKind":"credential_source"},
    {"action":"delete","resourceKind":"credential_source"},
    {"action":"operate","resourceKind":"credential_source"},
    {"action":"read","resourceKind":"namespace"}
  ]'::jsonb);
--> statement-breakpoint
INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
SELECT 'role_builtin_owner', NULL, 'Owner',
  permissions || '[{"action":"delete","resourceKind":"namespace"}]'::jsonb
FROM occ.iam_roles WHERE id = 'role_builtin_namespace_member';
--> statement-breakpoint
INSERT INTO occ.iam_groups (id, namespace_id, name)
VALUES ('group_builtin_default_users', NULL, 'Default users');
--> statement-breakpoint
CREATE TRIGGER iam_built_in_role_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_roles
FOR EACH ROW WHEN (OLD.id IN (
  'role_builtin_agent_creator', 'role_builtin_namespace_creator',
  'role_builtin_namespace_member', 'role_builtin_owner'
))
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_built_in_group_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_groups
FOR EACH ROW WHEN (OLD.id = 'group_builtin_default_users')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- An Installation Group, such as Default users, can be bound in one Namespace, as an
-- Installation identity already can. A Namespace Group stays bound only in its Namespace.
CREATE OR REPLACE FUNCTION occ.validate_access_binding_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  role_scope text;
  identity_scope text;
  group_scope text;
BEGIN
  SELECT namespace_id INTO role_scope FROM occ.iam_roles WHERE id = NEW.role_id;
  IF NOT FOUND OR (role_scope IS NOT NULL AND role_scope IS DISTINCT FROM NEW.namespace_id) THEN
    RAISE EXCEPTION 'access binding role scope is invalid' USING ERRCODE = '23514';
  END IF;

  IF NEW.identity_subject_id IS NOT NULL THEN
    SELECT namespace_id INTO identity_scope
    FROM occ.iam_identities WHERE id = NEW.identity_subject_id;
    IF NOT FOUND OR (
      identity_scope IS NOT NULL AND identity_scope IS DISTINCT FROM NEW.namespace_id
    ) THEN
      RAISE EXCEPTION 'access binding identity scope is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT namespace_id INTO group_scope FROM occ.iam_groups WHERE id = NEW.group_subject_id;
    IF NOT FOUND OR (
      group_scope IS NOT NULL AND group_scope IS DISTINCT FROM NEW.namespace_id
    ) THEN
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
-- Each built-in Role has one binding shape. Agent Creator binds Default users in one Namespace
-- and Namespace Creator binds them Installation-wide, each under one fixed id. Owner binds one
-- creator in the creator's Namespace, to one resource or Namespace-wide. Namespace member binds
-- Namespace-wide.
ALTER TABLE occ.iam_access_bindings ADD CONSTRAINT iam_access_bindings_built_in_role_shape
CHECK (
  CASE role_id
    WHEN 'role_builtin_agent_creator' THEN
      id = 'binding_builtin_default_users_agent_create'
      AND group_subject_id = 'group_builtin_default_users'
      AND namespace_id IS NOT NULL AND resource_kind IS NULL
    WHEN 'role_builtin_namespace_creator' THEN
      id = 'binding_builtin_default_users_namespace_create'
      AND group_subject_id = 'group_builtin_default_users'
      AND namespace_id IS NULL AND resource_kind IS NULL
    WHEN 'role_builtin_owner' THEN
      namespace_id IS NOT NULL AND identity_subject_id IS NOT NULL
      AND resource_kind IS DISTINCT FROM 'namespace'
    WHEN 'role_builtin_namespace_member' THEN
      namespace_id IS NOT NULL AND resource_kind IS NULL
    ELSE true
  END
);
--> statement-breakpoint
-- Default users create Agents in the Namespace named default, which bootstrap creates. OCC
-- writes this binding when it creates that Namespace; this statement covers an existing one.
-- Namespace names stay reserved after deletion, so the binding is written at most once.
INSERT INTO occ.iam_access_bindings
  (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
SELECT 'binding_builtin_default_users_agent_create', id, NULL, 'group_builtin_default_users',
  'role_builtin_agent_creator', NULL, NULL
FROM occ.namespaces WHERE name = 'default' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER iam_built_in_binding_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_access_bindings
FOR EACH ROW WHEN (OLD.id = 'binding_builtin_default_users_agent_create')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- Administrators remove Default users members; memberships stay otherwise immutable.
DROP TRIGGER iam_group_membership_is_immutable ON occ.iam_group_memberships;
--> statement-breakpoint
CREATE TRIGGER iam_group_membership_is_immutable
BEFORE UPDATE ON occ.iam_group_memberships
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
GRANT DELETE ON occ.iam_group_memberships TO occ_app;
