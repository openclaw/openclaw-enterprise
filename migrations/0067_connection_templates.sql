-- Templates are Installation-wide or limited to a Namespace. Each edit of an approved value inserts an
-- immutable version, so a connection keeps the values its owner approved.
CREATE TABLE occ.oauth_clients (
  id text PRIMARY KEY,
  namespace_id text REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  issuer text COLLATE "C" NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200 AND display_name = btrim(display_name)),
  cleanup_after timestamptz,
  token_endpoint_auth_method text NOT NULL CHECK (token_endpoint_auth_method IN ('none','client_secret_basic','client_secret_post')),
  token_url text NOT NULL CHECK (token_url ~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'),
  revocation_url text CHECK (revocation_url ~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'),
  client_id text COLLATE "C" NOT NULL,
  credential_refresh_driver_id text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT oauth_clients_id_format CHECK (
    id ~ '^ccr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT oauth_clients_issuer_https CHECK (
    issuer ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$' AND length(issuer) <= 2048
  ),
  CONSTRAINT oauth_clients_cleanup_confidential CHECK (cleanup_after IS NULL OR token_endpoint_auth_method <> 'none'),
  CONSTRAINT oauth_clients_client_id_valid CHECK (
    client_id ~ '^[!-~]+$' AND length(client_id) <= 256
  ),
  CONSTRAINT oauth_clients_pair_unique UNIQUE NULLS NOT DISTINCT (namespace_id, issuer, client_id),
  CONSTRAINT oauth_clients_identity UNIQUE (id, issuer, token_url)
);
--> statement-breakpoint
CREATE TABLE occ.connection_templates (
  id text PRIMARY KEY,
  namespace_id text REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
CREATE TABLE occ.oauth_connection_template_versions (
  template_id text NOT NULL REFERENCES occ.connection_templates(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  version integer NOT NULL,
  oauth_client_id text REFERENCES occ.oauth_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  issuer text COLLATE "C" NOT NULL,
  mode text NOT NULL CHECK (mode IN ('manual','mcp_discovery')),
  revocation_url text,
  observed_metadata jsonb,
  authorization_url text COLLATE "C" NOT NULL,
  token_url text COLLATE "C" NOT NULL,
  scopes text[] NOT NULL,
  authorization_parameters jsonb NOT NULL,
  recipient_kind text NOT NULL,
  recipient_host text COLLATE "C",
  recipient_port integer,
  recipient_path text COLLATE "C",

  created_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, version),
  CONSTRAINT oauth_connection_template_versions_version_positive CHECK (version >= 1),
  CONSTRAINT oauth_connection_template_versions_urls_https CHECK (
    authorization_url ~ '^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$'
    AND token_url ~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'
    AND length(authorization_url) <= 2048 AND length(token_url) <= 2048
  ),
  CONSTRAINT oauth_connection_template_versions_scopes_valid CHECK (
    array_position(scopes, NULL) IS NULL
    -- RFC 6749 scope tokens: printable ASCII except space, double quote, and backslash.
    AND (cardinality(scopes) = 0 OR array_to_string(scopes, ' ') ~ '^[!#-[\]-~]+( [!#-[\]-~]+)*$')
  ),
  CONSTRAINT oauth_connection_template_versions_parameters_object CHECK (
    jsonb_typeof(authorization_parameters) = 'object'
  ),
  CONSTRAINT oauth_connection_template_versions_recipient_valid CHECK (
    (recipient_kind = 'endpoint'
      AND recipient_host IS NOT NULL AND recipient_port IS NOT NULL AND recipient_path IS NOT NULL
      AND recipient_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
      AND length(recipient_host) <= 253
      AND recipient_port BETWEEN 1 AND 65535
      AND recipient_path ~ '^/[!-~]*$' AND length(recipient_path) <= 512) OR
    (recipient_kind = 'google_apis' AND mode = 'manual'
      AND recipient_host IS NULL AND recipient_port IS NULL AND recipient_path IS NULL
      AND issuer = 'https://accounts.google.com'
      AND authorization_url = 'https://accounts.google.com/o/oauth2/v2/auth'
      AND token_url = 'https://oauth2.googleapis.com/token'
      AND (revocation_url IS NULL OR revocation_url = 'https://oauth2.googleapis.com/revoke'))
  ),
  CONSTRAINT oauth_connection_template_versions_discovery CHECK (
    (mode = 'manual' AND observed_metadata IS NULL) OR
    (mode = 'mcp_discovery' AND observed_metadata IS NOT NULL
      AND jsonb_typeof(observed_metadata) = 'object'
      AND observed_metadata ?& ARRAY['resource','serverUrl','issuer','authorizationUrl','tokenUrl']
      AND observed_metadata->>'issuer' = issuer
      AND observed_metadata->>'authorizationUrl' = authorization_url
      AND observed_metadata->>'tokenUrl' = token_url)
  ),
  CONSTRAINT oauth_connection_template_versions_client_issuer FOREIGN KEY
    (oauth_client_id, issuer, token_url)
    REFERENCES occ.oauth_clients(id, issuer, token_url)
);
--> statement-breakpoint
ALTER TABLE occ.connection_templates
  ADD CONSTRAINT connection_templates_current_version_exists FOREIGN KEY (id, current_version)
    REFERENCES occ.oauth_connection_template_versions(template_id, version)
    DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION occ.guard_connection_template_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id THEN
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
BEFORE UPDATE ON occ.oauth_connection_template_versions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.oauth_clients, occ.connection_templates,
  occ.oauth_connection_template_versions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.oauth_clients TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.connection_templates TO occ_app;
--> statement-breakpoint
GRANT UPDATE (display_name, current_version) ON occ.connection_templates TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.oauth_connection_template_versions TO occ_app;
--> statement-breakpoint
-- Hold both scoped rows until foreign-key checks take over. The application role
-- cannot lock registrations itself because they are immutable.
CREATE FUNCTION occ.check_connection_registration_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.oauth_client_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM occ.connection_templates AS t, occ.oauth_clients AS r
  WHERE t.id = NEW.template_id AND r.id = NEW.oauth_client_id AND r.cleanup_after IS NULL
    AND (r.namespace_id IS NULL OR r.namespace_id = t.namespace_id)
    AND (NEW.revocation_url IS NULL OR NEW.revocation_url = r.revocation_url)
    FOR KEY SHARE OF t, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth client registration must belong to the template scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connection_template_version_checks_registration_scope
BEFORE INSERT ON occ.oauth_connection_template_versions
FOR EACH ROW EXECUTE FUNCTION occ.check_connection_registration_scope();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_connection_template_update(), occ.check_connection_registration_scope() FROM PUBLIC;

--> statement-breakpoint
GRANT UPDATE (cleanup_after) ON occ.oauth_clients TO occ_app;
