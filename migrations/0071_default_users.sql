-- RFC-0026 Default users. OCC writes the Roles, Groups, and Group bindings of the Installation
-- `iam` configuration as ordinary rows whose IDs start with role_config_, group_config_, and
-- binding_config_, and changes or deletes only those rows when the configuration changes.
--
-- An Installation Group, such as a configured one, can be bound in one Namespace, as an
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
-- A configured Role is an Installation Role without Installation permissions: Installation
-- authority stays with the administrator Role that bootstrap creates.
ALTER TABLE occ.iam_roles ADD CONSTRAINT iam_roles_configured_scope CHECK (
  id NOT LIKE 'role\_config\_%'
  OR (namespace_id IS NULL AND NOT permissions @> '[{"resourceKind":"installation"}]'::jsonb)
);
--> statement-breakpoint
-- OCC updates a configured Role's name and permissions when the configuration changes, and
-- deletes a configured Group, with its memberships, when the configuration no longer lists it.
-- The application role can change no other Role, Group, or membership; the migrator keeps the
-- access it had.
CREATE FUNCTION occ.reject_unconfigured_iam_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% row is not configured', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER iam_configured_role_update_only
BEFORE UPDATE ON occ.iam_roles
FOR EACH ROW WHEN (OLD.id NOT LIKE 'role\_config\_%' AND current_user = 'occ_app')
EXECUTE FUNCTION occ.reject_unconfigured_iam_mutation();
--> statement-breakpoint
GRANT UPDATE (name, permissions) ON occ.iam_roles TO occ_app;
--> statement-breakpoint
CREATE TRIGGER iam_configured_group_delete_only
BEFORE DELETE ON occ.iam_groups
FOR EACH ROW WHEN (OLD.id NOT LIKE 'group\_config\_%' AND current_user = 'occ_app')
EXECUTE FUNCTION occ.reject_unconfigured_iam_mutation();
--> statement-breakpoint
DROP TRIGGER iam_group_membership_is_immutable ON occ.iam_group_memberships;
--> statement-breakpoint
CREATE TRIGGER iam_group_membership_is_immutable
BEFORE UPDATE ON occ.iam_group_memberships
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER iam_configured_group_membership_delete_only
BEFORE DELETE ON occ.iam_group_memberships
FOR EACH ROW WHEN (OLD.group_id NOT LIKE 'group\_config\_%')
EXECUTE FUNCTION occ.reject_unconfigured_iam_mutation();
--> statement-breakpoint
GRANT DELETE ON occ.iam_groups, occ.iam_group_memberships TO occ_app;
