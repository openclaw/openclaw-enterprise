-- Connection templates are Installation resources. Each edit of an approved value inserts an
-- immutable version, so a connection keeps the values its owner approved.
CREATE TABLE occ.connection_client_registrations (
  id text PRIMARY KEY,
  issuer text COLLATE "C" NOT NULL,
  client_id text COLLATE "C" NOT NULL,
  credential_refresh_driver_id text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT connection_client_registrations_id_format CHECK (
    id ~ '^ccr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT connection_client_registrations_issuer_https CHECK (
    issuer ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$' AND length(issuer) <= 2048
  ),
  CONSTRAINT connection_client_registrations_client_id_valid CHECK (
    client_id ~ '^[!-~]+$' AND length(client_id) <= 256
  ),
  CONSTRAINT connection_client_registrations_pair_unique UNIQUE (issuer, client_id),
  CONSTRAINT connection_client_registrations_identity UNIQUE (id, issuer, client_id)
);
--> statement-breakpoint
CREATE TABLE occ.connection_templates (
  id text PRIMARY KEY,
  display_name text COLLATE "C" NOT NULL,
  current_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT connection_templates_id_format CHECK (
    id ~ '^ctp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT connection_templates_display_name_valid CHECK (
    length(display_name) BETWEEN 1 AND 200 AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT connection_templates_current_version_positive CHECK (current_version >= 1)
);
--> statement-breakpoint
CREATE TABLE occ.connection_template_versions (
  template_id text NOT NULL REFERENCES occ.connection_templates(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  version integer NOT NULL,
  client_registration_id text NOT NULL REFERENCES occ.connection_client_registrations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  issuer text COLLATE "C" NOT NULL,
  client_id text COLLATE "C" NOT NULL,
  authorization_url text COLLATE "C" NOT NULL,
  token_url text COLLATE "C" NOT NULL,
  scopes text[] NOT NULL,
  authorization_parameters jsonb NOT NULL,
  endpoint_host text COLLATE "C" NOT NULL,
  endpoint_port integer NOT NULL,
  endpoint_path text COLLATE "C" NOT NULL,
  env_var text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, version),
  CONSTRAINT connection_template_versions_version_positive CHECK (version >= 1),
  CONSTRAINT connection_template_versions_urls_https CHECK (
    authorization_url ~ '^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$'
    AND token_url ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$'
    AND length(authorization_url) <= 2048 AND length(token_url) <= 2048
  ),
  CONSTRAINT connection_template_versions_scopes_valid CHECK (
    cardinality(scopes) BETWEEN 1 AND 32
    AND array_position(scopes, NULL) IS NULL
    -- RFC 6749 scope tokens: printable ASCII except space, double quote, and backslash.
    AND array_to_string(scopes, ' ') ~ '^[!#-[\]-~]+( [!#-[\]-~]+)*$'
  ),
  CONSTRAINT connection_template_versions_parameters_object CHECK (
    jsonb_typeof(authorization_parameters) = 'object'
  ),
  CONSTRAINT connection_template_versions_endpoint_valid CHECK (
    -- A DNS name whose last label starts with a letter, so an IPv4 address never matches.
    endpoint_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
    AND length(endpoint_host) <= 253
    AND endpoint_port BETWEEN 1 AND 65535
    AND endpoint_path ~ '^/[!-~]*$' AND length(endpoint_path) <= 512
  ),
  CONSTRAINT connection_template_versions_env_var_valid CHECK (
    env_var ~ '^[A-Z_][A-Z0-9_]{0,63}$'
    AND env_var NOT IN ('OPENAI_API_KEY', 'PATH', 'HOME', 'USER', 'SHELL', 'LANG')
    AND env_var !~ '^(CODEX_|OCE_|OPENCLAW_|OPENSHELL_)'
  ),
  CONSTRAINT connection_template_versions_registration_pair FOREIGN KEY
    (client_registration_id, issuer, client_id)
    REFERENCES occ.connection_client_registrations(id, issuer, client_id)
);
--> statement-breakpoint
ALTER TABLE occ.connection_templates
  ADD CONSTRAINT connection_templates_current_version_exists FOREIGN KEY (id, current_version)
    REFERENCES occ.connection_template_versions(template_id, version)
    DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION occ.guard_connection_template_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'connection template identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_version <> OLD.current_version AND NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'connection template versions advance by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_template_update_is_guarded
BEFORE UPDATE ON occ.connection_templates
FOR EACH ROW EXECUTE FUNCTION occ.guard_connection_template_update();
--> statement-breakpoint
CREATE TRIGGER connection_template_version_is_immutable
BEFORE UPDATE ON occ.connection_template_versions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER connection_client_registration_is_immutable
BEFORE UPDATE ON occ.connection_client_registrations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- An Installation binding may name only an existing connection template.
CREATE OR REPLACE FUNCTION occ.resource_belongs_to_namespace(
  checked_namespace_id text,
  checked_resource_kind text,
  checked_resource_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF checked_resource_kind = 'connection_template' THEN
    RETURN checked_namespace_id IS NULL AND (checked_resource_id IS NULL OR EXISTS (
      SELECT 1 FROM occ.connection_templates WHERE id = checked_resource_id
    ));
  END IF;
  IF checked_namespace_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'installation' THEN
    RETURN false;
  END IF;
  IF checked_resource_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'namespace' THEN
    RETURN checked_resource_id = checked_namespace_id;
  ELSIF checked_resource_kind = 'configuration' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.configurations
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'service_account' THEN
    RETURN checked_resource_id = checked_namespace_id OR EXISTS (
      SELECT 1 FROM occ.service_accounts
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'preset' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.presets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'credential_source' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.credential_sources
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'sandbox_policy' THEN
    RETURN EXISTS (SELECT 1 FROM occ.sandbox_policies WHERE namespace_id = checked_namespace_id AND id = checked_resource_id);
  ELSIF checked_resource_kind = 'secret' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.secrets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agents
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent_revision' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agent_revisions
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  END IF;
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.remove_connection_template_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
BEGIN
  DELETE FROM occ.iam_access_bindings
  WHERE resource_kind = 'connection_template' AND resource_id = OLD.id;
  DELETE FROM occ.iam_restrictions
  WHERE resource_kind = 'connection_template' AND resource_id = OLD.id;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_template_access_is_removed
AFTER DELETE ON occ.connection_templates
FOR EACH ROW EXECUTE FUNCTION occ.remove_connection_template_access();
--> statement-breakpoint
REVOKE ALL ON occ.connection_client_registrations, occ.connection_templates,
  occ.connection_template_versions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.connection_client_registrations TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.connection_templates TO occ_app;
--> statement-breakpoint
GRANT UPDATE (display_name, current_version) ON occ.connection_templates TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.connection_template_versions TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_connection_template_update(),
  occ.remove_connection_template_access() FROM PUBLIC;
