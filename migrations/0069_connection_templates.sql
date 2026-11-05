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
  secret_driver_id text COLLATE "C",
  CONSTRAINT oauth_clients_secret_owner CHECK (
    (token_endpoint_auth_method = 'none') = (secret_driver_id IS NULL) AND
    (secret_driver_id IS NULL OR length(secret_driver_id) > 0)
  ),
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
-- Canonical order makes equality of two stored lists equality of their approved routes.
CREATE FUNCTION occ.valid_connection_destinations(destinations jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  endpoint jsonb;
  previous jsonb;
BEGIN
  IF jsonb_typeof(destinations) <> 'array' OR destinations = '[]'::jsonb THEN RETURN false; END IF;
  FOR endpoint IN SELECT value FROM jsonb_array_elements(destinations) LOOP
    IF jsonb_typeof(endpoint) <> 'object' THEN RETURN false; END IF;
    IF NOT (endpoint ?& ARRAY['host','port','path'])
      OR endpoint - ARRAY['host','port','path'] <> '{}'::jsonb
      OR jsonb_typeof(endpoint->'host') <> 'string'
      OR (endpoint->>'host') COLLATE "C" !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
      OR length(endpoint->>'host') > 253
      OR jsonb_typeof(endpoint->'port') <> 'number' OR endpoint->>'port' !~ '^[1-9][0-9]{0,4}$'
      OR jsonb_typeof(endpoint->'path') <> 'string'
      OR length(endpoint->>'path') > 512 OR (endpoint->>'path') COLLATE "C" !~ '^/[!-~]*$'
      OR endpoint->>'path' ~ '[?#\\]'
    THEN RETURN false; END IF;
    IF (endpoint->>'port')::integer > 65535 OR
      ROW((previous->>'host') COLLATE "C", (previous->>'port')::integer, (previous->>'path') COLLATE "C") >=
      ROW((endpoint->>'host') COLLATE "C", (endpoint->>'port')::integer, (endpoint->>'path') COLLATE "C")
    THEN RETURN false; END IF;
    previous := endpoint;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.valid_connection_destinations(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.valid_connection_destinations(jsonb) TO occ_app;
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
  destinations jsonb NOT NULL,
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
  CONSTRAINT oauth_connection_template_versions_destinations_valid CHECK (
    occ.valid_connection_destinations(destinations)
  ),
  CONSTRAINT oauth_connection_template_versions_discovery CHECK (
    (mode = 'manual' AND observed_metadata IS NULL) OR
    (mode = 'mcp_discovery' AND observed_metadata IS NOT NULL
      AND jsonb_typeof(observed_metadata) = 'object'
      AND observed_metadata ?& ARRAY['resource','serverUrl','issuer','authorizationUrl','tokenUrl']
      AND observed_metadata->>'issuer' = issuer
      AND observed_metadata->>'authorizationUrl' = authorization_url
      AND observed_metadata->>'tokenUrl' = token_url
      AND jsonb_array_length(destinations) = 1)
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
--> statement-breakpoint
-- Seed one ordinary Installation-wide template when this feature is installed. Its
-- initial destinations come from the bundled google-install-v1 operation catalog.
WITH template AS (
  INSERT INTO occ.connection_templates (id, display_name, current_version, created_at)
  VALUES ('ctp_' || gen_random_uuid(), 'Google OAuth', 1, now())
  RETURNING id, created_at
), routes (host, path) AS (
  VALUES
    ('admin.googleapis.com', '/admin/**'),
    ('adsense.googleapis.com', '/v2/**'),
    ('analyticsadmin.googleapis.com', '/v1beta/**'),
    ('analyticsdata.googleapis.com', '/v1beta/**'),
    ('chat.googleapis.com', '/v1/**'),
    ('classroom.googleapis.com', '/v1/**'),
    ('cloudidentity.googleapis.com', '/v1/**'),
    ('docs.googleapis.com', '/v1/**'),
    ('driveactivity.googleapis.com', '/v2/**'),
    ('drivelabels.googleapis.com', '/v2/**'),
    ('forms.googleapis.com', '/v1/**'),
    ('gmail.googleapis.com', '/gmail/**'),
    ('keep.googleapis.com', '/v1/**'),
    ('meet.googleapis.com', '/v2/**'),
    ('people.googleapis.com', '/v1/**'),
    ('photoslibrary.googleapis.com', '/v1/**'),
    ('photospicker.googleapis.com', '/v1/**'),
    ('script.googleapis.com', '/v1/**'),
    ('searchconsole.googleapis.com', '/v1/**'),
    ('searchconsole.googleapis.com', '/webmasters/**'),
    ('sheets.googleapis.com', '/v4/**'),
    ('slides.googleapis.com', '/v1/**'),
    ('tasks.googleapis.com', '/tasks/**'),
    ('www.googleapis.com', '/calendar/**'),
    ('www.googleapis.com', '/drive/**'),
    ('youtube.googleapis.com', '/youtube/**')
)
INSERT INTO occ.oauth_connection_template_versions (
  template_id, version, issuer, mode, authorization_url, token_url, revocation_url,
  scopes, authorization_parameters, destinations, created_at
)
SELECT id, 1, 'https://accounts.google.com', 'manual',
  'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token',
  'https://oauth2.googleapis.com/revoke', '{}', '{"access_type":"offline","prompt":"consent"}',
  (SELECT jsonb_agg(jsonb_build_object('host', host, 'port', 443, 'path', path)
                    ORDER BY host COLLATE "C", path COLLATE "C") FROM routes),
  created_at
FROM template;
