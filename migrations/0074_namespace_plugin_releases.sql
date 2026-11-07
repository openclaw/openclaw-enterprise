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
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid,
  ADD CONSTRAINT iam_restrictions_action_valid CHECK (action IN ('create','read','update','delete','deploy','operate','administer','read_logs','manage_policy','publish_plugins'));
--> statement-breakpoint
ALTER TABLE occ.credential_sources ADD COLUMN plugin_release_digest text, ADD COLUMN plugin_server_name text,
  ADD CONSTRAINT credential_source_template_release FOREIGN KEY (namespace_id, plugin_release_digest)
    REFERENCES occ.plugin_releases(namespace_id, digest),
  ADD CONSTRAINT credential_source_template_provenance CHECK (
    (plugin_release_digest IS NULL AND plugin_server_name IS NULL) OR
    (plugin_release_digest IS NOT NULL AND plugin_server_name IS NOT NULL AND char_length(plugin_server_name) BETWEEN 1 AND 128
      AND type = 'bearer-token' AND owner_capability = 'credential_gateway' AND config @> '{"protocol":"mcp"}'::jsonb AND egress IS NULL)
  );
--> statement-breakpoint
CREATE TRIGGER credential_source_template_is_immutable
BEFORE UPDATE OF plugin_release_digest, plugin_server_name ON occ.credential_sources
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
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
