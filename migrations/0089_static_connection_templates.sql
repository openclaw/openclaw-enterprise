-- Drizzle can apply seed rows with deferred references in this transaction.
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
ALTER TABLE occ.connection_templates
  DROP CONSTRAINT connection_templates_current_version_exists,
  ADD COLUMN static_key boolean NOT NULL DEFAULT false,
  ADD COLUMN current_oauth_version integer GENERATED ALWAYS AS (CASE WHEN NOT static_key THEN current_version END) STORED,
  ADD COLUMN current_static_version integer GENERATED ALWAYS AS (CASE WHEN static_key THEN current_version END) STORED,
  ADD CONSTRAINT connection_templates_current_oauth_version FOREIGN KEY (id, current_oauth_version)
    REFERENCES occ.oauth_connection_template_versions(template_id, version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- Static credentials approve exact HTTP methods as well as their destinations.
CREATE FUNCTION occ.valid_static_key_destinations(destinations jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  endpoint jsonb;
  previous jsonb;
  host text;
  request_path text;
  base_path text;
  decoded_path text;
  path_bytes bytea;
  segment text;
  normalized text;
  path_index integer;
BEGIN
  IF jsonb_typeof(destinations) <> 'array' OR jsonb_array_length(destinations) NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  FOR endpoint IN SELECT value FROM jsonb_array_elements(destinations) LOOP
    IF jsonb_typeof(endpoint) <> 'object' OR NOT (endpoint ?& ARRAY['host','port','path','method'])
      OR endpoint - ARRAY['host','port','path','method'] <> '{}'::jsonb
      OR jsonb_typeof(endpoint->'host') <> 'string'
      OR jsonb_typeof(endpoint->'port') <> 'number' OR endpoint->>'port' !~ '^[1-9][0-9]{0,4}$'
      OR jsonb_typeof(endpoint->'path') <> 'string' OR length(endpoint->>'path') > 512
      OR (endpoint->>'path') NOT LIKE '/%' OR strpos(endpoint->>'path', '//') > 0
      OR jsonb_typeof(endpoint->'method') <> 'string'
      OR (endpoint->>'method') COLLATE "C" !~ '^[!#$%&''*+.^_`|~0-9A-Z-]{1,16}$'
    THEN RETURN false; END IF;
    request_path := endpoint->>'path';
    base_path := CASE WHEN right(request_path, 3) = '/**' THEN left(request_path, -3) ELSE request_path END;
    IF base_path COLLATE "C" !~ '^([A-Za-z0-9._~!$&''()+,:=@/-]|%20|%[89A-F][0-9A-F])*$' THEN RETURN false; END IF;
    path_bytes := ''::bytea;
    path_index := 1;
    WHILE path_index <= length(base_path) LOOP
      IF substr(base_path, path_index, 1) = '%' THEN
        path_bytes := path_bytes || decode(substr(base_path, path_index + 1, 2), 'hex');
        path_index := path_index + 3;
      ELSE
        path_bytes := path_bytes || convert_to(substr(base_path, path_index, 1), 'UTF8');
        path_index := path_index + 1;
      END IF;
    END LOOP;
    BEGIN
      decoded_path := convert_from(path_bytes, 'UTF8');
    EXCEPTION WHEN character_not_in_repertoire THEN RETURN false;
    END;
    FOREACH segment IN ARRAY string_to_array(decoded_path, '/') LOOP
      normalized := normalize(segment, NFKC);
      IF normalized IN ('.', '..') OR normalized ~ '[%/?#;*[:cntrl:]]'
        OR strpos(normalized, chr(92)) > 0 OR normalized COLLATE "C" ~ U&'[\0080-\009F]'
      THEN RETURN false; END IF;
    END LOOP;
    host := endpoint->>'host';
    IF length(host) > 253 OR NOT (
      host COLLATE "C" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
      OR (host COLLATE "C" ~ '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$'
        AND split_part(host,'.',1)::integer <= 255 AND split_part(host,'.',2)::integer <= 255
        AND split_part(host,'.',3)::integer <= 255 AND split_part(host,'.',4)::integer <= 255
        AND (split_part(host,'.',1)::integer = 10
          OR (split_part(host,'.',1)::integer = 172 AND split_part(host,'.',2)::integer BETWEEN 16 AND 31)
          OR (split_part(host,'.',1)::integer = 192 AND split_part(host,'.',2)::integer = 168)))
    ) THEN RETURN false; END IF;
    IF (endpoint->>'port')::integer > 65535 OR
      ROW((previous->>'host') COLLATE "C", (previous->>'port')::integer, (previous->>'path') COLLATE "C", (previous->>'method') COLLATE "C") >=
      ROW(host COLLATE "C", (endpoint->>'port')::integer, (endpoint->>'path') COLLATE "C", (endpoint->>'method') COLLATE "C")
    THEN RETURN false; END IF;
    previous := endpoint;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.valid_static_key_destinations(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.valid_static_key_destinations(jsonb) TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.static_key_template_versions (
  template_id text NOT NULL REFERENCES occ.connection_templates(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  version integer NOT NULL CONSTRAINT static_key_template_versions_version_positive CHECK (version >= 1),
  destinations jsonb NOT NULL CONSTRAINT static_key_template_versions_destinations_valid CHECK (occ.valid_static_key_destinations(destinations)),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, version)
);
--> statement-breakpoint
ALTER TABLE occ.connection_templates ADD CONSTRAINT connection_templates_current_static_version FOREIGN KEY (id, current_static_version)
  REFERENCES occ.static_key_template_versions(template_id, version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TRIGGER static_key_template_version_is_immutable BEFORE UPDATE ON occ.static_key_template_versions
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.static_key_template_versions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.static_key_template_versions TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_connection_template_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.static_key <> OLD.static_key THEN
    RAISE EXCEPTION 'connection template identity and authentication method are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_version <> OLD.current_version AND NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'connection template versions advance by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A version belongs to the template's immutable authentication method.
CREATE FUNCTION occ.check_connection_template_version_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.connection_templates WHERE id = NEW.template_id
    AND static_key = (TG_TABLE_NAME = 'static_key_template_versions');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection template version has the wrong authentication method' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER oauth_connection_template_version_checks_mode BEFORE INSERT ON occ.oauth_connection_template_versions
  FOR EACH ROW EXECUTE FUNCTION occ.check_connection_template_version_mode();
--> statement-breakpoint
CREATE TRIGGER static_key_template_version_checks_mode BEFORE INSERT ON occ.static_key_template_versions
  FOR EACH ROW EXECUTE FUNCTION occ.check_connection_template_version_mode();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.check_connection_template_version_mode() FROM PUBLIC;
--> statement-breakpoint
SET CONSTRAINTS ALL DEFERRED;
