-- Extend the unchanged built-in administrator with the new policy authority.
-- Custom Roles retain their explicitly configured permissions.
WITH prior(resource_kind, actions) AS (
  VALUES ('installation', ARRAY['administer','read']),
    ('namespace', ARRAY['create','read','delete']),
    ('configuration', ARRAY['create','read','update','delete']),
    ('service_account', ARRAY['create','read','update','delete']),
    ('secret', ARRAY['create','read','update','delete','operate']),
    ('preset', ARRAY['create','read','update','delete']),
    ('credential_source', ARRAY['create','read','update','delete','operate']),
    ('agent', ARRAY['create','read','update','delete','deploy','operate','administer']),
    ('agent_revision', ARRAY['read'])
), unchanged AS (
  SELECT jsonb_agg(jsonb_build_object('action',action,'resourceKind',resource_kind)) AS permissions
  FROM prior CROSS JOIN LATERAL unnest(actions) action
)
UPDATE occ.iam_roles role SET permissions = role.permissions ||
  '[{"action":"manage_policy","resourceKind":"agent"},{"action":"read","resourceKind":"sandbox_policy"},{"action":"update","resourceKind":"sandbox_policy"}]'::jsonb
FROM unchanged WHERE role.namespace_id IS NULL AND role.name = 'Installation administrator'
  AND role.id ~ '^role_admin_[0-9a-f-]{36}$'
  AND jsonb_array_length(role.permissions) = jsonb_array_length(unchanged.permissions)
  AND role.permissions @> unchanged.permissions AND unchanged.permissions @> role.permissions;
