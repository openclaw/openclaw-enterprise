DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM occ.credential_sources WHERE oauth_provenance='connection_template')
    OR EXISTS (SELECT 1 FROM occ.authentication_states WHERE kind='oauth_connection') THEN
    RAISE EXCEPTION 'Retire Template-backed OAuth Sources and pending consent before endpoint authority cutover' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM occ.oauth_clients WHERE kind='oauth2' AND token_service_instance_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Remove confidential OAuth Clients and complete private-material cleanup before dropping their token-URL addresses' USING ERRCODE='55000';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE occ.oauth_connection_template_versions
  ADD COLUMN issuer_verification jsonb,
  ADD CONSTRAINT oauth_connection_template_versions_issuer_verification_valid CHECK (
    issuer_verification IS NULL OR ((jsonb_typeof(issuer_verification)='object'
      AND issuer_verification ? 'tokenEndpointAuthMethods'
      AND issuer_verification - 'tokenEndpointAuthMethods'='{}'::jsonb
      AND jsonb_typeof(issuer_verification->'tokenEndpointAuthMethods')='array'
      AND issuer_verification->'tokenEndpointAuthMethods' <@ '["none","client_secret_basic","client_secret_post"]'::jsonb) IS TRUE)
  );
--> statement-breakpoint
ALTER TABLE occ.oauth_clients
  DROP CONSTRAINT oauth_clients_kind_shape,
  DROP CONSTRAINT oauth_clients_token_url_check,
  DROP CONSTRAINT oauth_clients_revocation_url_check,
  DROP COLUMN token_url,
  DROP COLUMN revocation_url,
  ADD CONSTRAINT oauth_clients_kind_shape CHECK (
    CASE WHEN kind='oauth2' THEN issuer IS NOT NULL AND client_id IS NOT NULL
      AND token_endpoint_auth_method IN ('none','client_secret_basic','client_secret_post') AND app_id IS NULL
      AND ((token_endpoint_auth_method='none')=(token_service_instance_id IS NULL))
    WHEN kind='github-app' THEN issuer IS NULL AND client_id IS NULL AND token_endpoint_auth_method IS NULL
      AND CASE WHEN app_id ~ '^[1-9][0-9]{0,15}$' THEN app_id::numeric<=9007199254740991 ELSE false END
      AND token_service_instance_id IS NOT NULL
    ELSE false END IS TRUE
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.oauth_client_matches_template(p_namespace text,p_template text,p_version integer,p_client text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM occ.connection_templates t
    JOIN occ.oauth_connection_template_versions v ON v.template_id=t.id AND v.version=p_version
    JOIN occ.oauth_clients c ON c.id=p_client AND c.kind='oauth2' AND c.cleanup_after IS NULL
    WHERE t.id=p_template AND NOT t.static_key AND (t.namespace_id IS NULL OR t.namespace_id=p_namespace)
      AND (c.namespace_id IS NULL OR c.namespace_id=p_namespace)
      AND c.issuer=v.issuer
      AND v.issuer_verification->'tokenEndpointAuthMethods' ? c.token_endpoint_auth_method
  )
$$;
