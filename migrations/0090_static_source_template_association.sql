CREATE TABLE occ.static_credential_source_templates (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  connection_template_id text NOT NULL,
  connection_template_version integer NOT NULL,
  PRIMARY KEY (namespace_id, credential_source_id),
  CONSTRAINT static_credential_source_templates_source FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT static_credential_source_templates_version FOREIGN KEY (connection_template_id, connection_template_version)
    REFERENCES occ.static_key_template_versions(template_id, version) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION occ.check_static_source_template_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.credential_sources s JOIN occ.connection_templates t ON t.id=NEW.connection_template_id
    WHERE s.namespace_id=NEW.namespace_id AND s.id=NEW.credential_source_id
      AND s.owner_capability='token_service' AND s.token_service_instance_id IS NOT NULL AND s.type='static'
      AND NOT (s.config ? 'provider_preset')
      AND (t.namespace_id IS NULL OR t.namespace_id=NEW.namespace_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'static Source Template association has invalid owner, scope, or provider preset' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER static_source_template_checks_scope BEFORE INSERT ON occ.static_credential_source_templates
  FOR EACH ROW EXECUTE FUNCTION occ.check_static_source_template_scope();
--> statement-breakpoint
CREATE FUNCTION occ.reject_template_source_provider_preset() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.static_credential_source_templates a
      WHERE a.namespace_id=NEW.namespace_id AND a.credential_source_id=NEW.id) THEN
    RAISE EXCEPTION 'a Template-associated Source cannot use a provider preset' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER template_source_rejects_provider_preset BEFORE UPDATE OF config ON occ.credential_sources
  FOR EACH ROW WHEN (NEW.config ? 'provider_preset') EXECUTE FUNCTION occ.reject_template_source_provider_preset();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.reject_template_source_provider_preset() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER static_source_template_is_immutable BEFORE UPDATE ON occ.static_credential_source_templates
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.check_static_source_template_scope() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON occ.static_credential_source_templates FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.static_credential_source_templates TO occ_app;
