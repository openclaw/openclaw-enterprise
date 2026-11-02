-- RFC-0026 built-in Roles and the Default users Group. Their ids and permissions match
-- BUILT_IN_ROLES in packages/contracts/src/index.ts.
INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES
  ('role_builtin_default_user', NULL, 'Default User',
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
    {"action":"read","resourceKind":"agent_revision"},
    {"action":"read","resourceKind":"namespace"}
  ]'::jsonb);
--> statement-breakpoint
INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
SELECT 'role_builtin_namespace_owner', NULL, 'Namespace owner',
  permissions || '[{"action":"delete","resourceKind":"namespace"}]'::jsonb
FROM occ.iam_roles WHERE id = 'role_builtin_namespace_member';
--> statement-breakpoint
INSERT INTO occ.iam_groups (id, namespace_id, name)
VALUES ('group_builtin_default_users', NULL, 'Default users');
--> statement-breakpoint
INSERT INTO occ.iam_access_bindings
  (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
VALUES ('binding_builtin_default_users', NULL, NULL, 'group_builtin_default_users',
  'role_builtin_default_user', NULL, NULL);
--> statement-breakpoint
CREATE TRIGGER iam_built_in_role_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_roles
FOR EACH ROW WHEN (OLD.id IN (
  'role_builtin_default_user', 'role_builtin_namespace_member', 'role_builtin_namespace_owner'
))
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_built_in_group_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_groups
FOR EACH ROW WHEN (OLD.id = 'group_builtin_default_users')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_built_in_binding_is_immutable
BEFORE UPDATE OR DELETE ON occ.iam_access_bindings
FOR EACH ROW WHEN (OLD.id = 'binding_builtin_default_users')
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- The Default User Role reaches only the Default users Group, Installation-wide. The
-- Namespace Roles reach only one Namespace, never one exact resource: the member Role binds a
-- Principal or a Namespace Group, and the owner Role binds the Namespace's creator.
ALTER TABLE occ.iam_access_bindings ADD CONSTRAINT iam_access_bindings_built_in_role_shape
CHECK (
  CASE role_id
    WHEN 'role_builtin_default_user' THEN
      id = 'binding_builtin_default_users'
      AND group_subject_id = 'group_builtin_default_users'
      AND namespace_id IS NULL AND resource_kind IS NULL
    WHEN 'role_builtin_namespace_member' THEN
      namespace_id IS NOT NULL AND resource_kind IS NULL
    WHEN 'role_builtin_namespace_owner' THEN
      namespace_id IS NOT NULL AND identity_subject_id IS NOT NULL AND resource_kind IS NULL
    ELSE true
  END
);
--> statement-breakpoint
CREATE UNIQUE INDEX iam_access_bindings_one_namespace_owner
ON occ.iam_access_bindings (namespace_id)
WHERE role_id = 'role_builtin_namespace_owner';
--> statement-breakpoint
-- Administrators remove Default users members; memberships stay otherwise immutable.
DROP TRIGGER iam_group_membership_is_immutable ON occ.iam_group_memberships;
--> statement-breakpoint
CREATE TRIGGER iam_group_membership_is_immutable
BEFORE UPDATE ON occ.iam_group_memberships
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
GRANT DELETE ON occ.iam_group_memberships TO occ_app;
--> statement-breakpoint
-- The Principal who created the Namespace through the Default User Role. The application
-- cannot update it.
ALTER TABLE occ.namespaces ADD COLUMN created_by text
  REFERENCES occ.iam_identities(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX namespaces_created_by ON occ.namespaces (created_by)
WHERE created_by IS NOT NULL;
