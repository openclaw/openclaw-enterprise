ALTER TABLE occ.oauth_clients
  DROP CONSTRAINT oauth_clients_kind_shape,
  ADD CONSTRAINT oauth_clients_kind_shape CHECK (
  CASE WHEN kind='oauth2' THEN issuer IS NOT NULL AND client_id IS NOT NULL AND token_url IS NOT NULL
    AND token_endpoint_auth_method IN ('none','client_secret_basic','client_secret_post') AND app_id IS NULL
    AND ((token_endpoint_auth_method='none')=(token_service_instance_id IS NULL))
  WHEN kind='github-app' THEN issuer IS NULL AND client_id IS NULL AND token_url IS NULL
    AND revocation_url IS NULL AND token_endpoint_auth_method IS NULL
    AND CASE WHEN app_id ~ '^[1-9][0-9]{0,15}$' THEN app_id::numeric<=9007199254740991 ELSE false END
    AND token_service_instance_id IS NOT NULL
  ELSE false END IS TRUE
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_source_consent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.connection_template_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM occ.connection_templates t WHERE t.id=NEW.connection_template_id
      AND (t.namespace_id IS NULL OR t.namespace_id=NEW.namespace_id)
      AND ((NEW.type='static' AND t.static_key) OR (NEW.type='oauth2-refresh-token' AND NOT t.static_key))) THEN
      RAISE EXCEPTION 'Source Template is unavailable or has the wrong mode' USING ERRCODE='23514';
    END IF;
    IF NEW.type='oauth2-refresh-token' AND NOT occ.oauth_client_matches_template(NEW.namespace_id,NEW.connection_template_id,NEW.oauth_consent_version,NEW.oauth_client_id) THEN
      RAISE EXCEPTION 'OAuth Source consent does not match its Template version and client' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.connection_template_id IS DISTINCT FROM OLD.connection_template_id OR NEW.oauth_provenance IS DISTINCT FROM OLD.oauth_provenance
      OR NEW.oauth_account IS DISTINCT FROM OLD.oauth_account OR NEW.oauth_consent_version IS DISTINCT FROM OLD.oauth_consent_version
      OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id OR NEW.github_app_client_id IS DISTINCT FROM OLD.github_app_client_id
      OR NEW.oauth_owner_principal_id IS DISTINCT FROM OLD.oauth_owner_principal_id OR NEW.oauth_requested_scopes IS DISTINCT FROM OLD.oauth_requested_scopes
      OR (OLD.oauth_granted_scopes IS NOT NULL AND NOT (NEW.oauth_granted_scopes <@ OLD.oauth_granted_scopes))
      OR (OLD.oauth_revocation_requested_by IS NOT NULL AND NEW.oauth_revocation_requested_by IS DISTINCT FROM OLD.oauth_revocation_requested_by)
      OR (OLD.oauth_revoked_at IS NOT NULL AND NEW.oauth_revoked_at IS DISTINCT FROM OLD.oauth_revoked_at)
      OR (OLD.oauth_revocation_requested_by IS NULL AND NEW.oauth_revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Source association and OAuth consent are immutable except ordered revocation and scope reduction' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.github_app_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM occ.oauth_clients c WHERE c.id=NEW.github_app_client_id AND c.kind='github-app' AND c.cleanup_after IS NULL
      AND (c.namespace_id IS NULL OR c.namespace_id=NEW.namespace_id)
      AND c.app_id=(NEW.github_app_scope->>'appId') AND c.token_service_instance_id=NEW.token_service_instance_id
  ) THEN
    RAISE EXCEPTION 'Git Source requires a ready GitHub App client' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
