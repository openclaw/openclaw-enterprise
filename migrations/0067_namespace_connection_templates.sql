-- NULL retains Installation ownership for every existing template and OAuth client.
ALTER TABLE occ.connection_templates ADD COLUMN namespace_id text
  REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.connection_client_registrations
  ADD COLUMN namespace_id text REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  DROP CONSTRAINT connection_client_registrations_pair_unique,
  ADD CONSTRAINT connection_client_registrations_pair_unique
    UNIQUE NULLS NOT DISTINCT (namespace_id, issuer, client_id);
--> statement-breakpoint
CREATE TRIGGER connection_template_namespace_is_immutable
BEFORE UPDATE OF namespace_id ON occ.connection_templates
FOR EACH ROW WHEN (NEW.namespace_id IS DISTINCT FROM OLD.namespace_id)
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- Lock both immutable owners until the version's foreign keys protect them from deletion.
-- occ_app has no UPDATE privilege on registrations, including for SELECT FOR KEY SHARE.
CREATE FUNCTION occ.check_connection_registration_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.connection_templates t, occ.connection_client_registrations r
  WHERE t.id = NEW.template_id AND r.id = NEW.client_registration_id
    AND r.namespace_id IS NOT DISTINCT FROM t.namespace_id FOR KEY SHARE OF t, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth client registration must belong to the template scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_template_version_checks_registration_scope
BEFORE INSERT ON occ.connection_template_versions
FOR EACH ROW EXECUTE FUNCTION occ.check_connection_registration_scope();
--> statement-breakpoint
-- A pending authorization, issued credential, or explicit Namespace grant can use an
-- Installation template or a template owned by the same Namespace.
CREATE FUNCTION occ.check_connection_template_use_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  template_id text;
  use_namespace text;
BEGIN
  IF TG_TABLE_NAME = 'iam_access_bindings' THEN
    template_id := NEW.resource_id;
    use_namespace := NEW.namespace_subject_id;
  ELSE
    template_id := NEW.connection_template_id;
    use_namespace := NEW.namespace_id;
  END IF;
  PERFORM 1 FROM occ.connection_templates t WHERE t.id = template_id
    AND (t.namespace_id IS NULL OR t.namespace_id = use_namespace) FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection template is outside the Namespace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_session_checks_template_scope
BEFORE INSERT ON occ.connection_sessions
FOR EACH ROW EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
CREATE TRIGGER agent_connection_checks_template_scope
BEFORE INSERT ON occ.agent_connections
FOR EACH ROW EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
CREATE TRIGGER namespace_grant_checks_template_scope
BEFORE INSERT OR UPDATE ON occ.iam_access_bindings
FOR EACH ROW WHEN (NEW.resource_kind = 'connection_template' AND NEW.namespace_subject_id IS NOT NULL)
EXECUTE FUNCTION occ.check_connection_template_use_scope();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.check_connection_registration_scope(),
  occ.check_connection_template_use_scope() FROM PUBLIC;
