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
