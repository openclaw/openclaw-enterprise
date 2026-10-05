-- Bring an unchanged built-in Installation administrator up to the current seed's
-- credential_source grants. Installations bootstrapped before the seed gained them
-- (2026-09-27) or gained credential_source update (2026-10-01) otherwise cannot
-- update, or at all manage, credential sources: the Installation Role has no edit API.
-- Custom roles, including reduced or extended copies of that role, keep their exact grants.
WITH base(resource_kind, action) AS (
  SELECT resource_kind, action
  FROM (VALUES
    ('installation', ARRAY['administer', 'read']),
    ('namespace', ARRAY['create', 'read', 'delete']),
    ('configuration', ARRAY['create', 'read', 'update', 'delete']),
    ('service_account', ARRAY['create', 'read', 'update', 'delete']),
    ('secret', ARRAY['create', 'read', 'update', 'delete', 'operate']),
    ('preset', ARRAY['create', 'read', 'update', 'delete']),
    ('agent', ARRAY['create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer']),
    ('agent_revision', ARRAY['read'])
  ) AS seed(resource_kind, actions)
  CROSS JOIN LATERAL unnest(actions) AS action
), legacy AS (
  -- Before credential sources (after 0024 added Presets).
  SELECT jsonb_agg(jsonb_build_object('action', action, 'resourceKind', resource_kind)) AS permissions
  FROM base
  UNION ALL
  -- Credential sources without update (the 2026-09-28 release).
  SELECT jsonb_agg(jsonb_build_object('action', action, 'resourceKind', resource_kind))
  FROM (
    SELECT resource_kind, action FROM base
    UNION ALL
    SELECT 'credential_source', action
    FROM unnest(ARRAY['create', 'read', 'delete', 'operate']) AS action
  ) AS release_seed
), current_grants AS (
  SELECT jsonb_agg(jsonb_build_object('action', action, 'resourceKind', 'credential_source')
    ORDER BY ordinality) AS permissions
  FROM unnest(ARRAY['create', 'read', 'update', 'delete', 'operate'])
    WITH ORDINALITY AS grants(action, ordinality)
)
UPDATE occ.iam_roles AS role
SET permissions = role.permissions || (
  SELECT COALESCE(jsonb_agg(grant_value ORDER BY ordinality), '[]'::jsonb)
  FROM current_grants
  CROSS JOIN LATERAL jsonb_array_elements(current_grants.permissions)
    WITH ORDINALITY AS missing(grant_value, ordinality)
  WHERE NOT role.permissions @> jsonb_build_array(grant_value)
)
FROM legacy
WHERE role.namespace_id IS NULL
  AND role.name = 'Installation administrator'
  AND role.id ~ '^role_admin_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_array_length(role.permissions) = jsonb_array_length(legacy.permissions)
  AND role.permissions @> legacy.permissions
  AND legacy.permissions @> role.permissions;
