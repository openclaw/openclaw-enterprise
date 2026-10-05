ALTER TABLE occ.iam_access_bindings ADD COLUMN runtime_role text;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ADD CONSTRAINT iam_access_bindings_runtime_role CHECK (
  runtime_role IS NULL OR (
    namespace_id IS NOT NULL AND identity_subject_id IS NOT NULL AND resource_kind = 'agent'
    AND resource_id IS NOT NULL AND runtime_role = btrim(runtime_role)
    AND char_length(runtime_role) BETWEEN 1 AND 128 AND runtime_role !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX iam_access_bindings_runtime_assignment
  ON occ.iam_access_bindings (namespace_id, identity_subject_id, resource_id)
  WHERE runtime_role IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION occ.validate_runtime_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  IF NEW.runtime_role IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM occ.iam_identities WHERE id = NEW.identity_subject_id AND kind = 'principal')
    OR NOT EXISTS (SELECT 1 FROM occ.iam_roles WHERE id = NEW.role_id
      AND permissions @> '[{"action":"use","resourceKind":"agent"}]'::jsonb)
  ) THEN
    RAISE EXCEPTION 'runtime assignment requires a human and Agent entry Role' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.validate_runtime_assignment() FROM PUBLIC, occ_app;
--> statement-breakpoint
CREATE TRIGGER iam_runtime_assignment_is_valid BEFORE INSERT OR UPDATE ON occ.iam_access_bindings
  FOR EACH ROW EXECUTE FUNCTION occ.validate_runtime_assignment();
--> statement-breakpoint
GRANT UPDATE (runtime_role) ON occ.iam_access_bindings TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_action_valid CHECK (
  action IN ('create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer', 'read_logs', 'use')
);
--> statement-breakpoint
-- Preserve current human native administrators as explicit, revocable assignments.
-- Core stores the standard opaque administrator role; Compute supplies its native policy.
WITH eligible AS (
  SELECT DISTINCT a.namespace_id, a.id AS agent_id, i.id AS principal_id
  FROM occ.agents a
  JOIN occ.iam_access_bindings b ON (b.namespace_id IS NULL OR b.namespace_id = a.namespace_id)
    AND (b.resource_kind IS NULL OR (b.resource_kind = 'agent' AND b.resource_id = a.id))
  JOIN occ.iam_roles r ON r.id = b.role_id AND (r.namespace_id IS NULL OR r.namespace_id = a.namespace_id)
    AND r.permissions @> '[{"action":"administer","resourceKind":"agent"}]'::jsonb
  JOIN occ.iam_identities i ON i.kind = 'principal' AND (
    i.id = b.identity_subject_id OR EXISTS (
      SELECT 1 FROM occ.iam_group_memberships m
      WHERE m.group_id = b.group_subject_id AND m.principal_id = i.id
        AND (m.namespace_id IS NULL OR m.namespace_id = a.namespace_id)
    )
  )
  WHERE NOT EXISTS (
    SELECT 1 FROM occ.iam_restrictions d WHERE d.action = 'administer' AND d.resource_kind = 'agent'
      AND (d.namespace_id IS NULL OR d.namespace_id = a.namespace_id)
      AND (d.resource_id IS NULL OR d.resource_id = a.id)
  )
), entry_role AS (
  INSERT INTO occ.iam_roles (id, name, permissions)
  SELECT 'role_' || gen_random_uuid()::text, 'Agent runtime entry',
    '[{"action":"read","resourceKind":"agent"},{"action":"use","resourceKind":"agent"}]'::jsonb
  WHERE EXISTS (SELECT 1 FROM eligible)
  RETURNING id
)
INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id, runtime_role)
SELECT 'binding_' || gen_random_uuid()::text, e.namespace_id, e.principal_id, r.id, 'agent', e.agent_id, 'platform-administrator'
FROM eligible e CROSS JOIN entry_role r;
