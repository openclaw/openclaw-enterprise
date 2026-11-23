CREATE TABLE occ.plugin_releases (
  namespace_id text NOT NULL REFERENCES occ.namespaces(id),
  digest text NOT NULL,
  actor_id text NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (namespace_id, digest),
  CONSTRAINT plugin_releases_digest_valid CHECK (
    digest ~ '^[a-f0-9]{64}$' AND document @> jsonb_build_object('digest', digest)
  )
);
--> statement-breakpoint
REVOKE ALL ON occ.plugin_releases FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.plugin_releases TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.purge_namespace_plugin_releases(p_namespace_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.namespaces
    WHERE id = p_namespace_id AND status = 'deleting' AND deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id = p_namespace_id) THEN
    RAISE EXCEPTION 'plugin release purge requires a deleting Namespace without Agents'
      USING ERRCODE = '23514';
  END IF;
  DELETE FROM occ.plugin_releases WHERE namespace_id = p_namespace_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.purge_namespace_plugin_releases(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.purge_namespace_plugin_releases(text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid,
  ADD CONSTRAINT iam_restrictions_action_valid CHECK (action IN ('create','read','update','delete','deploy','operate','administer','read_logs','manage_policy','read_audit','publish_plugins'));
--> statement-breakpoint
-- Extend only the unchanged built-in administrator. Customized Roles retain their grants.
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
  '[{"action":"publish_plugins","resourceKind":"namespace"}]'::jsonb
FROM unchanged WHERE role.namespace_id IS NULL AND role.name = 'Installation administrator'
  AND role.id ~ '^role_admin_[0-9a-f-]{36}$'
  AND jsonb_array_length(role.permissions) = jsonb_array_length(unchanged.permissions)
  AND role.permissions @> unchanged.permissions AND unchanged.permissions @> role.permissions;
