DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM occ.credential_sources WHERE owner_capability='token_service' AND type='oauth2-refresh-token')
    OR EXISTS (SELECT 1 FROM occ.saved_connections)
    OR EXISTS (SELECT 1 FROM occ.connection_token_custody) THEN
    RAISE EXCEPTION 'Existing OAuth custody requires an approved transfer or confirmed reset before the selected TokenService can own OAuth Sources' USING ERRCODE='55000';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  DROP CONSTRAINT credential_sources_owner_capability_valid,
  ADD COLUMN connection_template_id text REFERENCES occ.connection_templates(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_consent_version integer,
  ADD COLUMN oauth_client_id text REFERENCES occ.oauth_clients(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_owner_principal_id text REFERENCES occ.iam_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_requested_scopes text[],
  ADD COLUMN oauth_granted_scopes text[],
  ADD COLUMN oauth_revocation_requested_by text REFERENCES occ.iam_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_revoked_at timestamptz,
  ADD CONSTRAINT credential_sources_oauth_template_version FOREIGN KEY (connection_template_id, oauth_consent_version)
    REFERENCES occ.oauth_connection_template_versions(template_id, version) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.authentication_states DROP CONSTRAINT authentication_states_oauth_shape,
  DROP CONSTRAINT authentication_states_device_shape, DROP CONSTRAINT authentication_states_source_owner;
DROP TRIGGER authentication_states_update_is_guarded ON occ.authentication_states;
--> statement-breakpoint
ALTER TABLE occ.authentication_states DROP COLUMN credential_source_id;
--> statement-breakpoint
DROP TABLE occ.saved_connections;
DROP FUNCTION occ.guard_saved_connection();
--> statement-breakpoint
ALTER TABLE occ.credential_sources ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
  CASE WHEN owner_capability='token_service' THEN driver_id IS NULL AND egress IS NULL AND token_service_instance_id IS NOT NULL
    AND type IN ('static','oauth2-refresh-token') AND state IN ('ready','deleting')
  ELSE driver_id IS NOT NULL AND token_service_instance_id IS NULL AND connection_template_id IS NULL
    AND (owner_capability='credential_gateway' OR (owner_capability='credential_proxy' AND egress IS NOT NULL)) END IS TRUE
), ADD CONSTRAINT credential_sources_oauth_shape CHECK (
  CASE WHEN owner_capability='token_service' AND type='oauth2-refresh-token' THEN
    connection_template_id IS NOT NULL AND oauth_consent_version IS NOT NULL AND oauth_consent_version>0
    AND oauth_client_id IS NOT NULL AND oauth_owner_principal_id IS NOT NULL AND oauth_requested_scopes IS NOT NULL
    AND oauth_granted_scopes IS NOT NULL AND array_position(oauth_requested_scopes,NULL) IS NULL
    AND array_position(oauth_granted_scopes,NULL) IS NULL
    AND (cardinality(oauth_requested_scopes)=0 OR oauth_granted_scopes <@ oauth_requested_scopes)
    AND (oauth_revoked_at IS NULL OR oauth_revocation_requested_by IS NOT NULL) AND config='{}'::jsonb
  ELSE oauth_consent_version IS NULL AND oauth_client_id IS NULL AND oauth_owner_principal_id IS NULL
    AND oauth_requested_scopes IS NULL AND oauth_granted_scopes IS NULL AND oauth_revocation_requested_by IS NULL AND oauth_revoked_at IS NULL END IS TRUE
), ADD CONSTRAINT credential_sources_template_preset_exclusive CHECK (connection_template_id IS NULL OR NOT (config ? 'provider_preset'));
--> statement-breakpoint
CREATE FUNCTION occ.guard_source_consent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.connection_template_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM occ.connection_templates t WHERE t.id=NEW.connection_template_id
      AND (t.namespace_id IS NULL OR t.namespace_id=NEW.namespace_id)
      AND ((NEW.type='static' AND t.static_key) OR (NEW.type='oauth2-refresh-token' AND NOT t.static_key))) THEN
      RAISE EXCEPTION 'Source Template is unavailable or has the wrong mode' USING ERRCODE='23514';
    END IF;
    IF NEW.type='oauth2-refresh-token' AND NOT EXISTS (SELECT 1 FROM occ.oauth_connection_template_versions v
      WHERE v.template_id=NEW.connection_template_id AND v.version=NEW.oauth_consent_version AND v.oauth_client_id=NEW.oauth_client_id) THEN
      RAISE EXCEPTION 'OAuth Source consent does not match its Template version and client' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.connection_template_id IS DISTINCT FROM OLD.connection_template_id OR NEW.oauth_consent_version IS DISTINCT FROM OLD.oauth_consent_version
      OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id OR NEW.oauth_owner_principal_id IS DISTINCT FROM OLD.oauth_owner_principal_id
      OR NEW.oauth_requested_scopes IS DISTINCT FROM OLD.oauth_requested_scopes
      OR (OLD.oauth_granted_scopes IS NOT NULL AND NOT (NEW.oauth_granted_scopes <@ OLD.oauth_granted_scopes))
      OR (OLD.oauth_revocation_requested_by IS NOT NULL AND NEW.oauth_revocation_requested_by IS DISTINCT FROM OLD.oauth_revocation_requested_by)
      OR (OLD.oauth_revoked_at IS NOT NULL AND NEW.oauth_revoked_at IS DISTINCT FROM OLD.oauth_revoked_at)
      OR (OLD.oauth_revocation_requested_by IS NULL AND NEW.oauth_revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Source association and OAuth consent are immutable except ordered revocation and scope reduction' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER credential_source_consent_is_guarded BEFORE INSERT OR UPDATE ON occ.credential_sources FOR EACH ROW EXECUTE FUNCTION occ.guard_source_consent();
REVOKE ALL ON FUNCTION occ.guard_source_consent() FROM PUBLIC;
GRANT UPDATE (oauth_granted_scopes,oauth_revocation_requested_by,oauth_revoked_at) ON occ.credential_sources TO occ_app;
CREATE INDEX credential_sources_oauth_revoking_idx ON occ.credential_sources(id) WHERE oauth_revocation_requested_by IS NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.authentication_states ADD CONSTRAINT authentication_states_oauth_shape CHECK (kind<>'oauth_connection' OR ((
  id ~ '^[0-9a-f]{64}$' AND connection_template_id IS NOT NULL AND connection_template_version IS NOT NULL
  AND created_at IS NOT NULL AND expires_at>created_at AND phase IS NULL AND next_poll_at IS NULL AND encrypted_challenge IS NULL AND private_state IS NULL AND version IS NULL
  AND jsonb_typeof(binding)='object' AND binding ?& ARRAY['pkceVerifier','selectedScopes','issuerRequired','sessionId','redirectUri']
  AND binding - ARRAY['pkceVerifier','selectedScopes','issuerRequired','sessionId','redirectUri']='{}'::jsonb
  AND jsonb_typeof(binding->'pkceVerifier')='string' AND jsonb_typeof(binding->'sessionId')='string' AND jsonb_typeof(binding->'redirectUri')='string'
  AND jsonb_typeof(binding->'issuerRequired')='boolean' AND jsonb_typeof(binding->'selectedScopes')='array'
  AND NOT jsonb_path_exists(binding,'$.selectedScopes[*] ? (@.type() != "string")')) IS TRUE)),
  ADD CONSTRAINT authentication_states_device_shape CHECK (kind<>'device_authorization' OR ((
  id ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND connection_template_id IS NULL AND connection_template_version IS NULL AND created_at IS NULL AND version>0
  AND jsonb_typeof(binding)='object' AND binding ?& ARRAY['harnessId','credentialGatewayId','credentialRefreshId','sourceId','intervalSeconds']
  AND binding - ARRAY['agentId','harnessId','credentialGatewayId','credentialRefreshId','sourceId','intervalSeconds']='{}'::jsonb
  AND (NOT (binding ? 'agentId') OR jsonb_typeof(binding->'agentId')='string') AND jsonb_typeof(binding->'harnessId')='string'
  AND jsonb_typeof(binding->'credentialGatewayId')='string' AND jsonb_typeof(binding->'credentialRefreshId')='string' AND jsonb_typeof(binding->'sourceId')='string'
  AND CASE WHEN jsonb_typeof(binding->'intervalSeconds')='number' THEN (binding->>'intervalSeconds')::numeric BETWEEN 1 AND 2147483647 AND trunc((binding->>'intervalSeconds')::numeric)=(binding->>'intervalSeconds')::numeric ELSE false END
  AND phase IS NOT NULL AND phase IN ('pending','polling','cancelled','ready') AND next_poll_at IS NOT NULL
  AND ((phase IN ('pending','polling'))=(private_state IS NOT NULL)) AND ((phase<>'cancelled')=(encrypted_challenge IS NOT NULL))) IS TRUE));
CREATE TRIGGER authentication_states_update_is_guarded BEFORE UPDATE ON occ.authentication_states FOR EACH ROW WHEN (OLD.kind<>'device_authorization') EXECUTE FUNCTION occ.guard_authentication_state_update();
