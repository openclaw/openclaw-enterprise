DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM occ.service_accounts
    WHERE credential->>'kind' = 'access_token' AND credential ? 'secretRef'
  ) THEN
    RAISE EXCEPTION 'Existing issued ServiceAccount credentials must be revoked before cutover' USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM occ.credential_sources WHERE owner_capability='token_service' AND type='oauth2-refresh-token')
    OR EXISTS (SELECT 1 FROM occ.saved_connections)
    OR EXISTS (SELECT 1 FROM occ.connection_token_custody) THEN
    RAISE EXCEPTION 'Existing OAuth custody requires an approved transfer or confirmed reset before the selected TokenService can own OAuth Sources' USING ERRCODE='55000';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.authentication_states WHERE kind = 'device_authorization') THEN
    RAISE EXCEPTION 'Codex device-login cutover requires disposition of residual temporary device authorization rows' USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM occ.oauth_clients WHERE secret_driver_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Existing confidential OAuth client custody requires an approved transfer or confirmed reset before TokenService client custody' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM occ.authentication_states a
    LEFT JOIN occ.oauth_connection_template_versions v
      ON v.template_id=a.connection_template_id AND v.version=a.connection_template_version
    WHERE a.kind='oauth_connection' AND v.oauth_client_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Pending OAuth consent requires its selected client before client association can be removed from Templates' USING ERRCODE='55000';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM occ.agent_revisions
    WHERE admitted_spec #>> '{execution_admission,mode}' = 'standalone'
      AND admitted_spec #> '{execution_admission,version}' = '8'::jsonb
      AND admitted_spec ? 'repository_credentials'
      AND admitted_spec #> '{repository_credentials,authorization}' IS DISTINCT FROM '"credential_source"'::jsonb
  ) THEN
    RAISE EXCEPTION 'Source-backed Repository authorization requires disposition of retained standalone Repository revisions'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
-- Drop Gateway Source records and draft links without changing immutable revisions.
-- Wait for active work to settle. OpenShell Provider cleanup is outside this migration.
DO $$
BEGIN
  IF EXISTS (
    WITH legacy AS (
      SELECT namespace_id, id FROM occ.credential_sources
      WHERE owner_capability = 'credential_gateway'
    ), referenced_revisions AS (
      SELECT r.namespace_id, r.admitted_spec
      FROM occ.agent_revisions r
      WHERE EXISTS (
        SELECT FROM occ.agents a
        WHERE (a.namespace_id, a.id, a.active_revision_id) = (r.namespace_id, r.agent_id, r.id)
      ) OR EXISTS (
        SELECT FROM occ.controller_work w
        WHERE (w.namespace_id, w.agent_id, w.revision_id) = (r.namespace_id, r.agent_id, r.id)
          AND w.state IN ('queued', 'claimed')
      ) OR EXISTS (
        SELECT FROM occ.egress_installations i
        WHERE (i.namespace_id, i.agent_id, i.revision_id) = (r.namespace_id, r.agent_id, r.id)
          AND NOT i.retired
      )
    )
    SELECT FROM legacy s WHERE
      EXISTS (
        SELECT FROM referenced_revisions r WHERE r.namespace_id = s.namespace_id AND (
          (r.admitted_spec #>> '{harness_auth,method}' = 'credential_source'
            AND r.admitted_spec #>> '{harness_auth,sourceId}' = s.id)
          OR r.admitted_spec->'credential_sources' @> jsonb_build_array(jsonb_build_object('sourceId', s.id))
        )
      ) OR EXISTS (
        SELECT FROM occ.agent_provisioning_work w WHERE w.namespace_id = s.namespace_id
          AND w.status IN ('queued', 'running') AND (
            (w.plan #>> '{harnessAuth,method}' = 'credential_source' AND w.plan #>> '{harnessAuth,sourceId}' = s.id)
            OR w.plan->'credentialSources' @> jsonb_build_array(jsonb_build_object('sourceId', s.id))
          )
      ) OR EXISTS (
        SELECT FROM occ.credential_withdrawals w
        WHERE (w.namespace_id, w.credential_source_id) = (s.namespace_id, s.id) AND w.state = 'pending'
      ) OR EXISTS (
        SELECT FROM occ.egress_send_receipts r WHERE r.authorized_dispatch IS NOT NULL AND NOT r.settled
          AND r.binding #>> '{material,source,namespaceId}' = s.namespace_id
          AND r.binding #>> '{material,source,source,id}' = s.id
      )
  ) THEN
    RAISE EXCEPTION 'Credential cutover requires retiring active Gateway credential delivery and settling its pending work'
      USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
WITH gateway_sources AS (
  SELECT namespace_id, id FROM occ.credential_sources WHERE owner_capability = 'credential_gateway'
)
UPDATE occ.agents a
SET harness_auth = CASE
      WHEN EXISTS (
        SELECT FROM gateway_sources s WHERE (s.namespace_id, s.id) =
          (a.namespace_id, a.harness_auth_credential_source_id)
      ) THEN NULL ELSE a.harness_auth END,
    plugins = COALESCE((
      SELECT jsonb_object_agg(plugin_id,
        CASE
          WHEN jsonb_typeof(selection #> '{driverPolicy,credentials}') IS DISTINCT FROM 'object'
            OR filtered.credentials = selection #> '{driverPolicy,credentials}' THEN selection
          -- Discovered tool names and approvals belong to the removed account.
          WHEN filtered.credentials = '{}'::jsonb AND selection->'driverPolicy' ? 'toolNames'
            THEN selection - ARRAY['driverPolicy', 'tools']
          -- CLI tool approvals remain valid when only the account retires.
          WHEN filtered.credentials = '{}'::jsonb THEN selection - 'driverPolicy'
          ELSE jsonb_set(selection, '{driverPolicy,credentials}', filtered.credentials)
        END
      )
      FROM jsonb_each(a.plugins) AS selected(plugin_id, selection)
      CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_object_agg(slot, source_id), '{}'::jsonb) AS credentials
        FROM jsonb_each(
          CASE WHEN jsonb_typeof(selection #> '{driverPolicy,credentials}') = 'object'
            THEN selection #> '{driverPolicy,credentials}' ELSE '{}'::jsonb END
        ) AS account(slot, source_id)
        WHERE NOT EXISTS (
          SELECT FROM gateway_sources s
          WHERE s.namespace_id = a.namespace_id AND source_id = to_jsonb(s.id)
        )
      ) AS filtered
    ), a.plugins),
    credential_sources = (
      SELECT jsonb_agg(binding ORDER BY position)
      FROM jsonb_array_elements(a.credential_sources) WITH ORDINALITY AS selected(binding, position)
      WHERE NOT EXISTS (
        SELECT FROM gateway_sources s WHERE (s.namespace_id, s.id) =
          (a.namespace_id, binding->>'sourceId')
      )
    )
WHERE EXISTS (
  SELECT FROM occ.agent_credential_sources chosen JOIN gateway_sources s
    ON (chosen.namespace_id, chosen.credential_source_id) = (s.namespace_id, s.id)
  WHERE (chosen.namespace_id, chosen.agent_id) = (a.namespace_id, a.id)
);
--> statement-breakpoint
DELETE FROM occ.iam_access_bindings b USING occ.credential_sources s
  WHERE s.owner_capability = 'credential_gateway' AND b.resource_kind = 'credential_source'
    AND (b.namespace_id, b.resource_id) = (s.namespace_id, s.id);
DELETE FROM occ.credential_sources WHERE owner_capability = 'credential_gateway';
--> statement-breakpoint
ALTER TABLE occ.oauth_clients
  DROP CONSTRAINT oauth_clients_secret_owner,
  DROP CONSTRAINT oauth_clients_pair_unique,
  DROP CONSTRAINT oauth_clients_cleanup_confidential,
  DROP CONSTRAINT oauth_clients_token_endpoint_auth_method_check,
  ALTER COLUMN issuer DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL,
  ALTER COLUMN token_url DROP NOT NULL,
  ALTER COLUMN token_endpoint_auth_method DROP NOT NULL,
  ADD COLUMN kind text NOT NULL DEFAULT 'oauth2',
  ADD COLUMN app_id text,
  ADD COLUMN token_service_instance_id text REFERENCES occ.token_service_instances(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP COLUMN secret_driver_id;
ALTER TABLE occ.oauth_clients ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE occ.oauth_clients ADD CONSTRAINT oauth_clients_kind_shape CHECK (
  CASE WHEN kind='oauth2' THEN issuer IS NOT NULL AND client_id IS NOT NULL AND token_url IS NOT NULL
    AND token_endpoint_auth_method IN ('none','client_secret_basic','client_secret_post') AND app_id IS NULL
    AND ((token_endpoint_auth_method='none')=(token_service_instance_id IS NULL))
  WHEN kind='github-app' THEN namespace_id IS NULL AND issuer IS NULL AND client_id IS NULL AND token_url IS NULL
    AND revocation_url IS NULL AND token_endpoint_auth_method IS NULL
    AND CASE WHEN app_id ~ '^[1-9][0-9]{0,15}$' THEN app_id::numeric<=9007199254740991 ELSE false END
    AND token_service_instance_id IS NOT NULL
  ELSE false END IS TRUE
), ADD CONSTRAINT oauth_clients_cleanup_confidential CHECK (cleanup_after IS NULL OR token_service_instance_id IS NOT NULL);
CREATE UNIQUE INDEX oauth_clients_pair_unique ON occ.oauth_clients ((coalesce(namespace_id,'')),issuer,client_id) WHERE kind='oauth2';
--> statement-breakpoint
ALTER TABLE occ.authentication_states
  DROP CONSTRAINT authentication_states_oauth_shape,
  DROP CONSTRAINT authentication_states_device_shape,
  DROP CONSTRAINT authentication_states_source_owner;
DROP TRIGGER authentication_states_update_is_guarded ON occ.authentication_states;
ALTER TABLE occ.authentication_states
  ADD COLUMN oauth_client_id text REFERENCES occ.oauth_clients(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_consumed_at timestamptz;
UPDATE occ.authentication_states a SET oauth_client_id=v.oauth_client_id, credential_source_id=NULL
FROM occ.oauth_connection_template_versions v
WHERE a.kind='oauth_connection' AND v.template_id=a.connection_template_id AND v.version=a.connection_template_version;
ALTER TABLE occ.authentication_states ADD CONSTRAINT authentication_states_client_shape CHECK (
  ((kind='oauth_connection')=(oauth_client_id IS NOT NULL)) AND (kind='oauth_connection' OR oauth_consumed_at IS NULL)
);
CREATE OR REPLACE FUNCTION occ.guard_authentication_state_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF OLD.kind='oauth_connection' AND OLD.oauth_consumed_at IS NULL AND NEW.oauth_consumed_at IS NOT NULL
    AND (to_jsonb(OLD)-'oauth_consumed_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'oauth_consumed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'OAuth connection authentication state is immutable except one-time consumption' USING ERRCODE='55000';
END $$;
CREATE TRIGGER authentication_states_update_is_guarded BEFORE UPDATE ON occ.authentication_states
FOR EACH ROW WHEN (OLD.kind<>'device_authorization') EXECUTE FUNCTION occ.guard_authentication_state_update();
GRANT UPDATE (oauth_consumed_at) ON occ.authentication_states TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.authentication_states ADD CONSTRAINT authentication_states_device_source_owner
  CHECK (kind = 'device_authorization' OR credential_source_id IS NULL);
GRANT UPDATE (credential_source_id) ON occ.authentication_states TO occ_app;
ALTER TABLE occ.authentication_states ADD CONSTRAINT authentication_states_oauth_shape CHECK (kind<>'oauth_connection' OR ((
  id ~ '^[0-9a-f]{64}$' AND connection_template_id IS NOT NULL AND connection_template_version IS NOT NULL
  AND created_at IS NOT NULL AND expires_at>created_at AND phase IS NULL AND next_poll_at IS NULL AND encrypted_challenge IS NULL AND private_state IS NULL AND version IS NULL
  AND jsonb_typeof(binding)='object' AND binding ?& ARRAY['pkceVerifier','selectedScopes','issuerRequired','sessionId','redirectUri']
  AND binding - ARRAY['pkceVerifier','selectedScopes','issuerRequired','sessionId','redirectUri']='{}'::jsonb
  AND jsonb_typeof(binding->'pkceVerifier')='string' AND jsonb_typeof(binding->'sessionId')='string' AND jsonb_typeof(binding->'redirectUri')='string'
  AND jsonb_typeof(binding->'issuerRequired')='boolean' AND jsonb_typeof(binding->'selectedScopes')='array'
  AND NOT jsonb_path_exists(binding,'$.selectedScopes[*] ? (@.type() != "string")')) IS TRUE));
ALTER TABLE occ.authentication_states ADD CONSTRAINT authentication_states_device_shape CHECK (kind <> 'device_authorization' OR ((
  id ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND connection_template_id IS NULL AND connection_template_version IS NULL AND created_at IS NULL AND version > 0
  AND jsonb_typeof(binding) = 'object'
  AND binding ?& ARRAY['harnessId','tokenServiceInstanceId','intervalSeconds']
  AND binding - ARRAY['agentId','harnessId','tokenServiceInstanceId','intervalSeconds'] = '{}'::jsonb
  AND (NOT (binding ? 'agentId') OR jsonb_typeof(binding->'agentId') = 'string')
  AND jsonb_typeof(binding->'harnessId') = 'string' AND jsonb_typeof(binding->'tokenServiceInstanceId') = 'string'
  AND ((phase = 'ready') = (credential_source_id IS NOT NULL))
  AND (credential_source_id IS NULL OR credential_source_id ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  AND CASE WHEN jsonb_typeof(binding->'intervalSeconds') = 'number' THEN
    (binding->>'intervalSeconds')::numeric BETWEEN 1 AND 2147483647
    AND trunc((binding->>'intervalSeconds')::numeric) = (binding->>'intervalSeconds')::numeric ELSE false END
  AND phase IS NOT NULL AND phase IN ('pending','polling','cancelled','ready') AND next_poll_at IS NOT NULL
  AND ((phase IN ('pending','polling')) = (private_state IS NOT NULL))
  AND ((phase <> 'cancelled') = (encrypted_challenge IS NOT NULL))
) IS TRUE));
--> statement-breakpoint
DROP TABLE occ.saved_connections;
DROP FUNCTION occ.guard_saved_connection();
--> statement-breakpoint
-- Only the issuer-verified, nonsecret scope belongs in the Source catalog.
CREATE FUNCTION occ.github_app_source_scope_is_valid(scope jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(scope) = 'object'
    AND jsonb_typeof(scope->'repositories') = 'array'
    AND jsonb_typeof(scope->'permissions') = 'object'
  THEN (
    scope - ARRAY['appId','installationId','repositories','permissions'] = '{}'::jsonb
    AND jsonb_typeof(scope->'appId') = 'string'
    AND scope->>'appId' ~ '^[1-9][0-9]{0,15}$'
    AND (length(scope->>'appId') < 16 OR (scope->>'appId') COLLATE "C" <= '9007199254740991')
    AND jsonb_typeof(scope->'installationId') = 'string'
    AND scope->>'installationId' ~ '^[1-9][0-9]{0,15}$'
    AND (length(scope->>'installationId') < 16 OR (scope->>'installationId') COLLATE "C" <= '9007199254740991')
    AND jsonb_array_length(scope->'repositories') BETWEEN 1 AND 16
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(scope->'repositories') AS entries(repository)
      WHERE CASE WHEN jsonb_typeof(repository) = 'object' THEN (
        repository - ARRAY['repositoryId','repository'] = '{}'::jsonb
        AND jsonb_typeof(repository->'repositoryId') = 'string'
        AND repository->>'repositoryId' ~ '^[1-9][0-9]{0,15}$'
        AND (length(repository->>'repositoryId') < 16 OR (repository->>'repositoryId') COLLATE "C" <= '9007199254740991')
        AND jsonb_typeof(repository->'repository') = 'string'
        AND repository->>'repository' ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
        AND strpos(repository->>'repository', '..') = 0
      ) ELSE false END IS NOT TRUE
    )
    AND (SELECT count(DISTINCT repository->>'repositoryId') = count(*)
                AND count(DISTINCT lower((repository->>'repository') COLLATE "C")) = count(*)
           FROM jsonb_array_elements(scope->'repositories') AS entries(repository))
    AND scope#>'{permissions,metadata}' = '"read"'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(scope->'permissions') AS permissions(name, level)
      WHERE name !~ '^[a-z][a-z0-9_]{0,63}$' OR level NOT IN ('"read"'::jsonb, '"write"'::jsonb)
    )
  ) IS TRUE ELSE false END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.github_app_source_scope_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.github_app_source_scope_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  DROP CONSTRAINT credential_sources_owner_capability_valid,
  ADD COLUMN connection_template_id text REFERENCES occ.connection_templates(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_provenance text,
  ADD COLUMN oauth_account jsonb,
  ADD COLUMN oauth_consent_version integer,
  ADD COLUMN oauth_client_id text REFERENCES occ.oauth_clients(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_owner_principal_id text REFERENCES occ.iam_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_requested_scopes text[],
  ADD COLUMN oauth_granted_scopes text[],
  ADD COLUMN oauth_revocation_requested_by text REFERENCES occ.iam_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN oauth_revoked_at timestamptz,
  ADD CONSTRAINT credential_sources_oauth_template_version FOREIGN KEY (connection_template_id, oauth_consent_version)
    REFERENCES occ.oauth_connection_template_versions(template_id, version) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN github_app_client_id text REFERENCES occ.oauth_clients(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN github_app_scope jsonb;
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
    CASE WHEN owner_capability='token_service' THEN driver_id IS NULL AND egress IS NULL AND token_service_instance_id IS NOT NULL
      AND type IN ('static','oauth2-refresh-token','github-app-installation') AND state IN ('ready','deleting')
    ELSE driver_id IS NOT NULL AND token_service_instance_id IS NULL AND connection_template_id IS NULL
      AND owner_capability='credential_proxy' AND egress IS NOT NULL END IS TRUE
  ),
  ADD CONSTRAINT credential_sources_github_app_scope_valid CHECK (
    CASE WHEN owner_capability='token_service' AND type='github-app-installation' THEN
      github_app_client_id IS NOT NULL AND connection_template_id IS NULL AND config='{}'::jsonb AND occ.github_app_source_scope_is_valid(github_app_scope)
    ELSE github_app_client_id IS NULL AND github_app_scope IS NULL END IS TRUE
  ),
ADD CONSTRAINT credential_sources_oauth_shape CHECK (
  CASE WHEN owner_capability='token_service' AND type='oauth2-refresh-token' THEN
    ((oauth_provenance='connection_template' AND connection_template_id IS NOT NULL AND oauth_consent_version>0
      AND oauth_client_id IS NOT NULL AND oauth_account IS NULL)
     OR (oauth_provenance='builtin_codex' AND connection_template_id IS NULL AND oauth_consent_version IS NULL
      AND oauth_client_id IS NULL AND jsonb_typeof(oauth_account)='object'
      AND oauth_account - ARRAY['accountId','planType','isFedramp','userId','email','accountUserId']::text[]='{}'::jsonb
      AND jsonb_typeof(oauth_account->'accountId')='string' AND char_length(oauth_account->>'accountId') BETWEEN 1 AND 512
      AND jsonb_typeof(oauth_account->'planType')='string' AND char_length(oauth_account->>'planType') BETWEEN 1 AND 512
      AND jsonb_typeof(oauth_account->'isFedramp')='boolean'
      AND (NOT oauth_account ? 'userId' OR (jsonb_typeof(oauth_account->'userId')='string' AND char_length(oauth_account->>'userId') BETWEEN 1 AND 512))
      AND (NOT oauth_account ? 'email' OR (jsonb_typeof(oauth_account->'email')='string' AND char_length(oauth_account->>'email') BETWEEN 1 AND 512))
      AND (NOT oauth_account ? 'accountUserId' OR (jsonb_typeof(oauth_account->'accountUserId')='string' AND char_length(oauth_account->>'accountUserId') BETWEEN 1 AND 512))))
    AND oauth_owner_principal_id IS NOT NULL AND oauth_requested_scopes IS NOT NULL
    AND oauth_granted_scopes IS NOT NULL AND array_position(oauth_requested_scopes,NULL) IS NULL
    AND array_position(oauth_granted_scopes,NULL) IS NULL
    AND (oauth_revoked_at IS NULL OR oauth_revocation_requested_by IS NOT NULL) AND config='{}'::jsonb
  ELSE oauth_provenance IS NULL AND oauth_account IS NULL AND oauth_consent_version IS NULL AND oauth_client_id IS NULL AND oauth_owner_principal_id IS NULL
    AND oauth_requested_scopes IS NULL AND oauth_granted_scopes IS NULL AND oauth_revocation_requested_by IS NULL AND oauth_revoked_at IS NULL END IS TRUE
),
  ADD CONSTRAINT credential_sources_github_app_client_shape CHECK ((type='github-app-installation')=(github_app_client_id IS NOT NULL)),
  ADD CONSTRAINT credential_sources_template_preset_exclusive CHECK (connection_template_id IS NULL OR NOT (config ? 'provider_preset'));
--> statement-breakpoint
CREATE TRIGGER credential_source_github_app_scope_is_immutable
BEFORE UPDATE OF github_app_scope ON occ.credential_sources
FOR EACH ROW WHEN (OLD.github_app_scope IS DISTINCT FROM NEW.github_app_scope)
EXECUTE FUNCTION occ.reject_row_mutation();

--> statement-breakpoint
CREATE FUNCTION occ.oauth_client_matches_template(p_namespace text,p_template text,p_version integer,p_client text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM occ.connection_templates t
    JOIN occ.oauth_connection_template_versions v ON v.template_id=t.id AND v.version=p_version
    JOIN occ.oauth_clients c ON c.id=p_client AND c.kind='oauth2' AND c.cleanup_after IS NULL
    WHERE t.id=p_template AND NOT t.static_key AND (t.namespace_id IS NULL OR t.namespace_id=p_namespace)
      AND (c.namespace_id IS NULL OR c.namespace_id=p_namespace)
      AND c.issuer=v.issuer AND c.token_url=v.token_url
      AND (v.revocation_url IS NULL OR c.revocation_url=v.revocation_url)
      AND (v.observed_metadata IS NULL OR coalesce(v.observed_metadata->'tokenEndpointAuthMethods','["client_secret_basic"]'::jsonb) ? c.token_endpoint_auth_method)
  )
$$;
REVOKE ALL ON FUNCTION occ.oauth_client_matches_template(text,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.oauth_client_matches_template(text,text,integer,text) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.check_pending_oauth_client() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF NOT occ.oauth_client_matches_template(NEW.namespace_id,NEW.connection_template_id,NEW.connection_template_version,NEW.oauth_client_id) THEN
    RAISE EXCEPTION 'Pending OAuth consent must select a compatible OAuth client and Template version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION occ.check_pending_oauth_client() FROM PUBLIC;
CREATE TRIGGER authentication_states_check_oauth_client BEFORE INSERT ON occ.authentication_states
FOR EACH ROW WHEN (NEW.kind='oauth_connection') EXECUTE FUNCTION occ.check_pending_oauth_client();
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
      AND c.app_id=(NEW.github_app_scope->>'appId') AND c.token_service_instance_id=NEW.token_service_instance_id
  ) THEN
    RAISE EXCEPTION 'Git Source requires a ready GitHub App client' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER credential_source_consent_is_guarded BEFORE INSERT OR UPDATE ON occ.credential_sources FOR EACH ROW EXECUTE FUNCTION occ.guard_source_consent();
REVOKE ALL ON FUNCTION occ.guard_source_consent() FROM PUBLIC;
GRANT UPDATE (oauth_granted_scopes,oauth_revocation_requested_by,oauth_revoked_at) ON occ.credential_sources TO occ_app;
CREATE INDEX credential_sources_oauth_revoking_idx ON occ.credential_sources(id) WHERE oauth_revocation_requested_by IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER connection_template_version_checks_registration_scope ON occ.oauth_connection_template_versions;
DROP FUNCTION occ.check_connection_registration_scope();
ALTER TABLE occ.oauth_connection_template_versions DROP COLUMN oauth_client_id;
ALTER TABLE occ.oauth_clients DROP CONSTRAINT oauth_clients_identity;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.credential_source_snapshots_are_valid(snapshots jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  entry jsonb;
  owner_key text;
  template jsonb;
  template_version numeric;
  ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(snapshots) = 0
    OR jsonb_array_length(snapshots) > 64 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    owner_key := CASE
      WHEN entry ? 'tokenServiceInstanceId' THEN 'tokenServiceInstanceId'
      WHEN entry ? 'credentialProxyId' THEN 'credentialProxyId'
      ELSE 'credentialGatewayId'
    END;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT (entry ?& ARRAY['sourceId', owner_key, 'sourceType'])
      OR entry - 'sourceId' - owner_key - 'sourceType' - 'connectionTemplate' <> '{}'::jsonb
      OR jsonb_typeof(entry->'sourceId') IS DISTINCT FROM 'string'
      OR (entry->>'sourceId') !~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (entry->>'sourceId') = ANY(ids)
      OR jsonb_typeof(entry->owner_key) IS DISTINCT FROM 'string'
      OR COALESCE(btrim(entry->>owner_key), '') = ''
      OR (owner_key = 'tokenServiceInstanceId' AND (entry->>owner_key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR jsonb_typeof(entry->'sourceType') IS DISTINCT FROM 'string'
      OR (entry->>'sourceType') !~ '^[a-z][a-z0-9-]{0,63}$' THEN
      RETURN false;
    END IF;
    IF entry ? 'connectionTemplate' THEN
      template := entry->'connectionTemplate';
      IF owner_key <> 'tokenServiceInstanceId' OR jsonb_typeof(template) IS DISTINCT FROM 'object'
        OR template - 'id' - 'version' <> '{}'::jsonb
        OR jsonb_typeof(template->'id') IS DISTINCT FROM 'string'
        OR (template->>'id') !~ '^ctp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(template->'version') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      template_version := (template->>'version')::numeric;
      IF template_version NOT BETWEEN 1 AND 2147483647 OR trunc(template_version) <> template_version THEN RETURN false; END IF;
    END IF;
    ids := array_append(ids, entry->>'sourceId');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.standalone_credential_deployment_is_valid(spec jsonb, owner_namespace text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  policy jsonb := spec->'credential_deployment';
  auth jsonb := spec->'harness_auth';
  snapshots jsonb := spec->'credential_sources';
  snapshot jsonb;
  binding jsonb;
  injection jsonb;
  requested jsonb;
  requested_port jsonb;
  covered boolean;
  binding_refs text[] := '{}';
  environments text[] := '{}';
  model_bindings integer := 0;
  repository_bindings integer := 0;
  repository_grants jsonb := spec #> '{sandbox_policy,repositoryNetworkPolicy,grants}';
  consumer_keys text[] := '{}';
  consumer_key text;
BEGIN
  IF jsonb_typeof(spec->'sandbox_driver_id') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(spec->>'sandbox_driver_id'), '') = ''
    OR jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR NOT (policy ?& ARRAY['driver', 'proxyDriverId', 'networkAccessPolicy', 'bindings', 'injectionPolicies'])
    OR policy - 'driver' - 'proxyDriverId' - 'networkAccessPolicy' - 'bindings' - 'injectionPolicies' <> '{}'::jsonb
    OR jsonb_typeof(policy->'driver') IS DISTINCT FROM 'object'
    OR NOT ((policy->'driver') ?& ARRAY['id', 'implementation', 'configurationId'])
    OR (policy->'driver') - 'id' - 'implementation' - 'configurationId' <> '{}'::jsonb
    OR jsonb_typeof(policy #> '{driver,id}') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy #>> '{driver,id}'), '') = ''
    OR jsonb_typeof(policy #> '{driver,implementation}') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy #>> '{driver,implementation}'), '') = ''
    OR jsonb_typeof(policy #> '{driver,configurationId}') IS DISTINCT FROM 'string'
    OR (policy #>> '{driver,configurationId}') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(policy->'proxyDriverId') IS DISTINCT FROM 'string'
    OR COALESCE(btrim(policy->>'proxyDriverId'), '') = ''
    OR jsonb_typeof(policy->'networkAccessPolicy') IS DISTINCT FROM 'object'
    OR (policy->'networkAccessPolicy') - 'allowed' <> '{}'::jsonb
    OR NOT occ.deployment_request_matches_have_valid_shape(policy #> '{networkAccessPolicy,allowed}')
    OR jsonb_typeof(policy->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(policy->'injectionPolicies') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_typeof(auth) IS DISTINCT FROM 'object'
    OR NOT occ.harness_auth_is_valid(auth, owner_namespace, true)
    OR NOT occ.credential_source_snapshots_are_valid(snapshots) THEN RETURN false; END IF;
  IF jsonb_array_length(policy->'bindings') = 0
    OR jsonb_array_length(policy->'bindings') <> jsonb_array_length(policy->'injectionPolicies') THEN RETURN false; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(policy->'bindings') LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
      OR NOT (binding ?& ARRAY['bindingRef', 'sourceRef', 'consumer', 'projection'])
      OR binding - 'bindingRef' - 'sourceRef' - 'consumer' - 'projection' <> '{}'::jsonb
      OR jsonb_typeof(binding->'bindingRef') IS DISTINCT FROM 'string'
      OR COALESCE(btrim(binding->>'bindingRef'), '') = ''
      OR (binding->>'bindingRef') = ANY(binding_refs)
      OR jsonb_typeof(binding->'sourceRef') IS DISTINCT FROM 'object'
      OR NOT ((binding->'sourceRef') ?& ARRAY['kind', 'namespaceId', 'id'])
      OR (binding->'sourceRef') - 'kind' - 'namespaceId' - 'id' <> '{}'::jsonb
      OR binding #>> '{sourceRef,kind}' IS DISTINCT FROM 'credential_source'
      OR binding #>> '{sourceRef,namespaceId}' IS DISTINCT FROM owner_namespace
      OR jsonb_typeof(binding->'consumer') IS DISTINCT FROM 'object'
      OR jsonb_typeof(binding->'projection') IS DISTINCT FROM 'object'
      OR NOT ((binding->'projection') ?& ARRAY['environment', 'presentation'])
      OR (binding->'projection') - 'environment' - 'presentation' <> '{}'::jsonb
      OR jsonb_typeof(binding #> '{projection,environment}') IS DISTINCT FROM 'string'
      OR COALESCE(binding #>> '{projection,environment}', '') !~ '^[A-Za-z_][A-Za-z0-9_]*$'
      OR (binding #>> '{projection,environment}') = ANY(environments) THEN RETURN false; END IF;
    binding_refs := array_append(binding_refs, binding->>'bindingRef');
    environments := array_append(environments, binding #>> '{projection,environment}');
    SELECT value INTO snapshot FROM jsonb_array_elements(snapshots)
      WHERE value->>'sourceId' = binding #>> '{sourceRef,id}';
    IF snapshot IS NULL OR COALESCE(btrim(snapshot->>'tokenServiceInstanceId'), '') = '' THEN RETURN false; END IF;
    IF binding #>> '{consumer,kind}' = 'model' THEN
      model_bindings := model_bindings + 1;
      IF model_bindings <> 1 OR auth->>'method' IS DISTINCT FROM 'credential_source'
        OR snapshot->>'sourceId' IS DISTINCT FROM auth->>'sourceId'
        OR snapshot->>'sourceType' IS DISTINCT FROM auth->>'sourceType'
        OR snapshot->>'tokenServiceInstanceId' IS DISTINCT FROM auth->>'tokenServiceInstanceId'
        OR NOT ((binding->'consumer') ?& ARRAY['kind', 'providerId'])
        OR (binding->'consumer') - 'kind' - 'providerId' <> '{}'::jsonb
        OR jsonb_typeof(binding #> '{consumer,providerId}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,providerId}'), '') = ''
        OR COALESCE(binding #>> '{projection,presentation}', '') NOT IN ('bearer', 'x-api-key') THEN RETURN false; END IF;
    ELSIF binding #>> '{consumer,kind}' = 'plugin' THEN
      IF snapshot->>'sourceType' NOT IN ('static', 'oauth2-refresh-token')
        OR NOT (snapshot ? 'connectionTemplate')
        OR NOT ((binding->'consumer') ?& ARRAY['kind', 'pluginId', 'requirement', 'connection'])
        OR (binding->'consumer') - 'kind' - 'pluginId' - 'requirement' - 'connection' <> '{}'::jsonb
        OR jsonb_typeof(binding #> '{consumer,pluginId}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,pluginId}'), '') = ''
        OR jsonb_typeof(binding #> '{consumer,requirement}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,requirement}'), '') = ''
        OR jsonb_typeof(binding #> '{consumer,connection}') IS DISTINCT FROM 'string'
        OR COALESCE(btrim(binding #>> '{consumer,connection}'), '') = ''
        OR spec #> ARRAY['plugins','plugins',binding #>> '{consumer,pluginId}','enabled'] IS DISTINCT FROM 'true'::jsonb
        OR binding #>> '{projection,presentation}' IS DISTINCT FROM 'bearer' THEN RETURN false; END IF;
      consumer_key := jsonb_build_array(binding #>> '{consumer,pluginId}', binding #>> '{consumer,requirement}', binding #>> '{consumer,connection}')::text;
      IF consumer_key = ANY(consumer_keys) THEN RETURN false; END IF;
      consumer_keys := array_append(consumer_keys, consumer_key);
    ELSIF binding #>> '{consumer,kind}' = 'repository' THEN
      repository_bindings := repository_bindings + 1;
      IF repository_bindings <> 1
        OR binding->>'bindingRef' IS DISTINCT FROM 'repository'
        OR binding->'consumer' IS DISTINCT FROM '{"kind":"repository"}'::jsonb
        OR binding->'projection' IS DISTINCT FROM '{"environment":"GITHUB_TOKEN","presentation":"github_repository"}'::jsonb
        OR snapshot->>'sourceType' IS DISTINCT FROM 'github-app-installation'
        OR snapshot->>'tokenServiceInstanceId' IS DISTINCT FROM auth->>'tokenServiceInstanceId'
        OR spec #>> '{harness,mode}' IS DISTINCT FROM 'dedicated'
        OR NOT COALESCE(occ.repository_credentials_are_valid(spec->'repository_credentials'), false)
        OR (spec->'repository_credentials') ? 'standingApprovalId'
        OR jsonb_array_length(spec #> '{repository_credentials,bindings}') = 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(spec #> '{repository_credentials,bindings}') AS member(value)
          WHERE value->>'profile' IS DISTINCT FROM 'github-repository')
        OR spec #> '{execution_admission,repositoryNetworkPolicyVersion}' IS DISTINCT FROM '1'::jsonb
        OR spec #> '{sandbox_policy,repositoryNetworkPolicy,version}' IS DISTINCT FROM '1'::jsonb
        OR jsonb_typeof(repository_grants) IS DISTINCT FROM 'array'
        OR jsonb_array_length(repository_grants) = 0
        OR NOT occ.sandbox_repository_grants_are_valid(repository_grants)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(repository_grants) AS g(value)
          WHERE COALESCE(value #>> '{apiLimits,issues}', 'none') <> 'none'
             OR COALESCE(value #>> '{apiLimits,pull_requests}', 'none') <> 'none')
      THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
    SELECT value INTO injection FROM jsonb_array_elements(policy->'injectionPolicies')
      WHERE value->>'bindingRef' = binding->>'bindingRef';
    IF injection IS NULL OR jsonb_typeof(injection) IS DISTINCT FROM 'object'
      OR NOT (injection ?& ARRAY['bindingRef', 'allowedRequests'])
      OR injection - 'bindingRef' - 'allowedRequests' <> '{}'::jsonb
      OR jsonb_typeof(injection->'bindingRef') IS DISTINCT FROM 'string'
      OR NOT occ.deployment_request_matches_have_valid_shape(injection->'allowedRequests')
      OR jsonb_array_length(injection->'allowedRequests') = 0 THEN RETURN false; END IF;
    FOR requested IN SELECT value FROM jsonb_array_elements(injection->'allowedRequests') LOOP
      IF binding #>> '{consumer,kind}' = 'plugin'
        AND NOT (requested ? 'requestPolicy') THEN RETURN false; END IF;
      IF binding #>> '{consumer,kind}' = 'repository' AND (
        requested->>'host' IS DISTINCT FROM 'github.com'
        OR requested->'ports' IS DISTINCT FROM '[{"from":443,"to":443}]'::jsonb
        OR requested #>> '{requestPolicy,type}' IS DISTINCT FROM 'http'
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(repository_grants) AS g(value)
          WHERE (requested #>> '{requestPolicy,method}' = 'GET'
              AND requested #>> '{requestPolicy,path}' = '/' || (value->>'repository') || '.git/info/refs')
            OR (requested #>> '{requestPolicy,method}' = 'POST' AND (
              requested #>> '{requestPolicy,path}' = '/' || (value->>'repository') || '.git/git-upload-pack'
              OR (value->>'access' = 'write'
                AND requested #>> '{requestPolicy,path}' = '/' || (value->>'repository') || '.git/git-receive-pack')))
        )
      ) THEN RETURN false; END IF;
      FOR requested_port IN SELECT value FROM jsonb_array_elements(requested->'ports') LOOP
        SELECT COALESCE(
          range_agg(int4range((allowed_port.value->>'from')::integer,
                              (allowed_port.value->>'to')::integer + 1, '[)'))
            @> int4range((requested_port->>'from')::integer,
                         (requested_port->>'to')::integer + 1, '[)'), false)
        INTO covered
        FROM jsonb_array_elements(policy #> '{networkAccessPolicy,allowed}') AS network(value)
        CROSS JOIN LATERAL jsonb_array_elements(network.value->'ports') AS allowed_port(value)
        WHERE network.value->>'binary' = requested->>'binary'
          AND (
            network.value->>'host' = requested->>'host'
            OR (left(network.value->>'host', 2) = '*.'
              AND left(requested->>'host', 2) <> '*.'
              AND length(requested->>'host') > length(network.value->>'host') - 1
              AND right(requested->>'host', length(network.value->>'host') - 1)
                = substring(network.value->>'host' FROM 2)
              AND position('.' IN left(requested->>'host',
                length(requested->>'host') - length(network.value->>'host') + 1)) = 0)
          )
          AND (
            NOT (network.value ? 'requestPolicy')
            OR (network.value #>> '{requestPolicy,type}' = 'http'
              AND requested #>> '{requestPolicy,type}' = 'http'
              AND network.value #>> '{requestPolicy,method}' = requested #>> '{requestPolicy,method}'
              AND (
                network.value #>> '{requestPolicy,path}' = requested #>> '{requestPolicy,path}'
                OR (right(network.value #>> '{requestPolicy,path}', 3) = '/**'
                  AND (requested #>> '{requestPolicy,path}'
                      = left(network.value #>> '{requestPolicy,path}',
                             length(network.value #>> '{requestPolicy,path}') - 3)
                    OR left(requested #>> '{requestPolicy,path}',
                            length(network.value #>> '{requestPolicy,path}') - 2)
                      = left(network.value #>> '{requestPolicy,path}',
                             length(network.value #>> '{requestPolicy,path}') - 3) || '/'))
              ))
            OR (network.value #>> '{requestPolicy,type}' = 'mcp'
              AND network.value->'requestPolicy' = requested->'requestPolicy')
          );
        IF NOT covered THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF repository_bindings = 0 AND (
    spec ? 'repository_credentials' OR repository_grants IS NOT NULL
    OR (spec->'execution_admission') ? 'repositoryNetworkPolicyVersion'
  ) THEN RETURN false; END IF;
  IF auth->>'method' = 'credential_source' AND auth ? 'tokenServiceInstanceId'
    AND model_bindings <> 1 THEN RETURN false; END IF;
  FOR snapshot IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'bindings') AS b(value)
      WHERE b.value #>> '{sourceRef,id}' = snapshot->>'sourceId') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_execution_admission,
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND occ.repository_git_network_admission_is_valid(admitted_spec)
        AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((admitted_spec->'execution_admission') - 'version' - 'mode' - 'repositoryNetworkPolicyVersion') = '{}'::jsonb
        AND (
          (admitted_spec->'execution_admission'->>'mode' = 'unprotected'
            AND admitted_spec #> '{execution_admission,version}' = '2'::jsonb
            AND NOT (admitted_spec ? 'egress_plan')
            AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion'))
          OR (admitted_spec->'execution_admission'->>'mode' = 'protected'
            AND admitted_spec ? 'egress_plan'
            AND admitted_spec #> '{harness_auth,protectedExecutionVersion}'
              = admitted_spec #> '{execution_admission,version}'
            AND (
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7','9')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '7'
                  THEN admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7','9'))
                  = ((admitted_spec->'egress_plan') ? 'repositoryGit')
                AND (NOT ((admitted_spec->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(admitted_spec->'repository_credentials')='object'
                    AND admitted_spec #> '{egress_plan,repositoryGit}' = admitted_spec->'repository_credentials'))
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '5'
                    THEN admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    WHEN admitted_spec #>> '{execution_admission,version}' = '6' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'request-hook-observed'
                      AND admitted_spec #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                      AND jsonb_array_length(admitted_spec #> '{egress_plan,repositoryGit,bindings}') = 1
                    WHEN admitted_spec #>> '{execution_admission,version}' = '9' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'network-policy'
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
          OR (admitted_spec #>> '{execution_admission,mode}' = 'standalone'
            AND admitted_spec #> '{execution_admission,version}' = '8'::jsonb
            AND NOT (admitted_spec ? 'egress_plan')
            AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion')
            AND occ.standalone_credential_deployment_is_valid(admitted_spec, namespace_id))
        )
        AND (admitted_spec #>> '{execution_admission,mode}' = 'standalone' OR (
          NOT (admitted_spec ? 'credential_deployment')
          AND NOT ((admitted_spec->'harness_auth') ? 'tokenServiceInstanceId')
          AND NOT COALESCE(jsonb_path_exists(admitted_spec->'credential_sources', '$[*] ? (exists(@.tokenServiceInstanceId))'), false)
        )), false)) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
CREATE FUNCTION occ.repository_access_is_valid(access jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  repository jsonb;
  refs text[] := ARRAY[]::text[];
  has_client boolean;
BEGIN
  IF access IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(access) IS DISTINCT FROM 'object'
    OR access - 'defaultProfile' - 'repositories' - 'githubAppClientId' <> '{}'::jsonb
    OR jsonb_typeof(access->'defaultProfile') IS DISTINCT FROM 'string'
    OR (access->>'defaultProfile') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR access->>'defaultProfile' = 'github-installation'
    OR jsonb_typeof(access->'repositories') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  has_client := access ? 'githubAppClientId';
  IF has_client AND (
    jsonb_typeof(access->'githubAppClientId') IS DISTINCT FROM 'string'
    OR (access->>'githubAppClientId') !~ '^ccr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR access->>'defaultProfile' IS DISTINCT FROM 'github-repository'
  ) THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(access->'repositories') > 16 THEN
    RETURN false;
  END IF;
  FOR repository IN SELECT value FROM jsonb_array_elements(access->'repositories') LOOP
    IF jsonb_typeof(repository) IS DISTINCT FROM 'object'
      OR repository - 'repositoryRef' - 'profile' - 'access' <> '{}'::jsonb
      OR jsonb_typeof(repository->'repositoryRef') IS DISTINCT FROM 'string'
      OR (repository->>'repositoryRef') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      OR (repository->>'repositoryRef') = ANY(refs)
      OR (repository ? 'profile' AND (
        jsonb_typeof(repository->'profile') IS DISTINCT FROM 'string'
        OR (repository->>'profile') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      ))
      OR (has_client AND (
        NOT (repository ? 'access')
        OR jsonb_typeof(repository->'access') IS DISTINCT FROM 'string'
        OR repository->>'access' NOT IN ('read','write')
        OR COALESCE(repository->>'profile', access->>'defaultProfile') IS DISTINCT FROM 'github-repository'
      ))
      OR (NOT has_client AND repository ? 'access') THEN
      RETURN false;
    END IF;
    refs := array_append(refs, repository->>'repositoryRef');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Move published Agent selections to their one editable representation. Existing
-- explicit profiles continue to select the same grants, including installation-wide access.
ALTER TABLE occ.agents DROP CONSTRAINT agents_repository_access_valid;
UPDATE occ.agents
  SET repository_access = jsonb_build_object(
    'defaultProfile', CASE WHEN repository_bindings #>> '{0,profile}' = 'github-installation'
      THEN 'git-write' ELSE repository_bindings #>> '{0,profile}' END,
    'repositories', repository_bindings
  )
  WHERE repository_access IS NULL AND repository_bindings IS NOT NULL;
ALTER TABLE occ.agents DROP COLUMN repository_bindings,
  ADD CONSTRAINT agents_repository_access_valid CHECK (occ.repository_access_is_valid(repository_access));
DROP FUNCTION occ.repository_access_is_valid(jsonb, jsonb);
REVOKE ALL ON FUNCTION occ.repository_access_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.repository_access_is_valid(jsonb) TO occ_app;

-- Provisioning plans can still run after the upgrade. Preserve their selected profiles.
ALTER TABLE occ.agent_provisioning_work DISABLE TRIGGER agent_provisioning_work_is_valid;
UPDATE occ.agent_provisioning_work
  SET plan = (plan - 'repositoryBindings') || jsonb_build_object(
    'repositoryAccess', coalesce(plan->'repositoryAccess', jsonb_build_object(
      'defaultProfile', CASE WHEN plan#>>'{repositoryBindings,0,profile}' = 'github-installation'
        THEN 'git-write' ELSE coalesce(plan#>>'{repositoryBindings,0,profile}', 'git-write') END,
      'repositories', plan->'repositoryBindings'
    ))
  )
  WHERE plan ? 'repositoryBindings';
ALTER TABLE occ.agent_provisioning_work ENABLE TRIGGER agent_provisioning_work_is_valid;

-- The Console's former Preset default for an omitted profile was git-write.
UPDATE occ.presets
  SET template = jsonb_set(template, '{agent}',
    ((template->'agent') - 'repositoryBindings') || jsonb_build_object(
      'repositoryAccess', jsonb_build_object(
        'defaultProfile', 'git-write',
        'repositories', template#>'{agent,repositoryBindings}'
      )
    ))
  WHERE (template->'agent') ? 'repositoryBindings';
--> statement-breakpoint
CREATE FUNCTION occ.repository_access_contains_binding(access jsonb, repo_ref text, profile text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(access->'repositories') AS selection
    WHERE selection->>'repositoryRef' = repo_ref
      AND coalesce(selection->>'profile', access->>'defaultProfile') = profile
  )
$$;
REVOKE ALL ON FUNCTION occ.repository_access_contains_binding(jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.repository_access_contains_binding(jsonb, text, text) TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_repository_standing_approval() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE previous_generation bigint;
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM 1 FROM occ.agents a WHERE a.namespace_id=NEW.namespace_id AND a.id=NEW.agent_id AND a.status='active'
   AND occ.repository_access_contains_binding(a.repository_access,NEW.repository_ref,NEW.binding->>'profile') FOR UPDATE;
  IF NOT FOUND OR NEW.revoked_at IS NOT NULL THEN
   RAISE EXCEPTION 'Standing approval requires exact current Agent binding' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(max(generation),0) INTO previous_generation FROM occ.repository_standing_approvals
   WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id AND repository_ref=NEW.repository_ref;
  -- Duplicate request IDs are compared by State; they must not activate an old generation.
  IF NOT EXISTS(SELECT FROM occ.repository_standing_approvals WHERE id=NEW.id) AND NEW.generation <> previous_generation+1 THEN
   RAISE EXCEPTION 'Standing approval generation must advance' USING ERRCODE='23514';
  END IF;
 ELSE
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.generation <> OLD.generation+1 OR
    (to_jsonb(NEW)-'revoked_at'-'generation') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'generation') THEN
   RAISE EXCEPTION 'Standing approval permits only fenced terminal revocation' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_sandbox_repository_policy_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  desired_grants jsonb;
  desired_version integer;
  desired_access jsonb;
  admitted_policy jsonb := NEW.admitted_spec#>'{sandbox_policy,repositoryNetworkPolicy}';
  expected_identity text;
  source_binding jsonb;
  source_scope jsonb;
  desired_repository jsonb;
  admitted_binding jsonb;
  verified_repository jsonb;
  repository_pin text;
  matched integer;
  used_ids text[] := ARRAY[]::text[];
  derived_grants jsonb := '[]'::jsonb;
BEGIN
  -- Follow the normal Agent-before-policy lock order and serialize with policy saves.
  SELECT repository_access INTO desired_access FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id FOR KEY SHARE;
  SELECT document->'repositoryNetworkPolicy', version INTO desired_grants, desired_version
    FROM occ.sandbox_policies
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id FOR SHARE;

  IF desired_access ? 'githubAppClientId' AND jsonb_array_length(desired_access->'repositories') > 0 THEN
    IF desired_grants IS NOT NULL OR admitted_policy IS NULL
      OR jsonb_typeof(NEW.admitted_spec#>'{credential_deployment,bindings}') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.admitted_spec#>'{repository_credentials,bindings}') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Revision repository network policy must match the saved GitHub access' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), (jsonb_agg(value))->0 INTO matched, source_binding
      FROM jsonb_array_elements(NEW.admitted_spec#>'{credential_deployment,bindings}') AS entries(value)
      WHERE value#>>'{consumer,kind}' = 'repository';
    IF matched <> 1 OR source_binding#>>'{sourceRef,kind}' IS DISTINCT FROM 'credential_source'
      OR source_binding#>>'{sourceRef,namespaceId}' IS DISTINCT FROM NEW.namespace_id THEN
      RAISE EXCEPTION 'Revision repository Source must match the saved GitHub access' USING ERRCODE = '23514';
    END IF;
    SELECT github_app_scope INTO source_scope FROM occ.credential_sources
      WHERE namespace_id=NEW.namespace_id AND id=source_binding#>>'{sourceRef,id}'
        AND owner_capability='token_service' AND type='github-app-installation' AND state='ready'
        AND github_app_client_id=desired_access->>'githubAppClientId'
        AND token_service_instance_id=NEW.admitted_spec#>>'{harness_auth,tokenServiceInstanceId}'
      FOR SHARE;
    IF source_scope IS NULL
      OR jsonb_array_length(source_scope->'repositories') <> jsonb_array_length(desired_access->'repositories')
      OR jsonb_array_length(NEW.admitted_spec#>'{repository_credentials,bindings}') <> jsonb_array_length(desired_access->'repositories') THEN
      RAISE EXCEPTION 'Revision repository Source must match the saved GitHub access' USING ERRCODE = '23514';
    END IF;
    FOR desired_repository IN SELECT value FROM jsonb_array_elements(desired_access->'repositories') LOOP
      SELECT count(*), (jsonb_agg(value))->0 INTO matched, admitted_binding
        FROM jsonb_array_elements(NEW.admitted_spec#>'{repository_credentials,bindings}') AS entries(value)
        WHERE value->>'repositoryRef'=desired_repository->>'repositoryRef' AND value->>'profile'='github-repository';
      IF matched <> 1 THEN
        RAISE EXCEPTION 'Revision repository bindings must match the saved GitHub access' USING ERRCODE = '23514';
      END IF;
      repository_pin := admitted_binding#>>'{grant,repositoryId}';
      SELECT count(*), (jsonb_agg(value))->0 INTO matched, verified_repository
        FROM jsonb_array_elements(source_scope->'repositories') AS entries(value)
        WHERE repository_pin=value->>'repositoryId'
          OR repository_pin='github-repository:' || lower((value->>'repository') COLLATE "C")
          OR repository_pin='github-repository:' || split_part(lower((value->>'repository') COLLATE "C"), '/', 2);
      IF matched <> 1 OR verified_repository->>'repositoryId'=ANY(used_ids)
        OR COALESCE(desired_repository->>'access', '') NOT IN ('read','write')
        OR COALESCE(source_scope#>>'{permissions,contents}', '') NOT IN ('read','write')
        OR (desired_repository->>'access'='write' AND source_scope#>>'{permissions,contents}'<>'write') THEN
        RAISE EXCEPTION 'Revision repository grants must match the saved GitHub access' USING ERRCODE = '23514';
      END IF;
      used_ids := array_append(used_ids, verified_repository->>'repositoryId');
      derived_grants := derived_grants || jsonb_build_array(jsonb_build_object(
        'repository', lower((verified_repository->>'repository') COLLATE "C"),
        'access', desired_repository->>'access'
      ));
    END LOOP;
    SELECT jsonb_agg(value ORDER BY value->>'repository' COLLATE "C") INTO desired_grants
      FROM jsonb_array_elements(derived_grants) AS entries(value);
    desired_version := COALESCE(desired_version, 1);
  END IF;

  IF desired_grants IS NULL AND admitted_policy IS NULL THEN
    RETURN NEW;
  END IF;
  IF desired_grants IS NULL OR admitted_policy IS NULL
    OR (CASE WHEN jsonb_typeof(admitted_policy) = 'object' THEN
      admitted_policy - 'version' - 'grants' - 'identity' <> '{}'::jsonb
    ELSE true END)
    OR admitted_policy->'grants' IS DISTINCT FROM desired_grants
    OR admitted_policy->'version' IS DISTINCT FROM '1'::jsonb
    OR NEW.admitted_spec#>'{sandbox_policy,version}' IS DISTINCT FROM to_jsonb(desired_version) THEN
    RAISE EXCEPTION 'Revision repository network policy must match the saved policy' USING ERRCODE = '23514';
  END IF;
  SELECT '{"version":1,"grants":[' || COALESCE(string_agg(
    -- Encode keys in the same order as the Agent contract, independent of jsonb storage order.
    format('{"repository":%s,"access":%s%s}', to_json(grant_entry->>'repository'), to_json(grant_entry->>'access'),
      CASE WHEN grant_entry ? 'apiLimits'
        THEN ',"apiLimits":{' || (
          SELECT string_agg(to_json(resource)::text || ':' || level::text, ',' ORDER BY resource COLLATE "C")
          FROM jsonb_each(grant_entry->'apiLimits') AS limits(resource, level)
        ) || '}'
        ELSE '' END),
    ',' ORDER BY position
  ), '') || ']}' INTO expected_identity
    FROM jsonb_array_elements(desired_grants) WITH ORDINALITY AS entries(grant_entry, position);
  IF admitted_policy->'identity' IS DISTINCT FROM to_jsonb(expected_identity) THEN
    RAISE EXCEPTION 'Revision repository network policy identity is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.repository_credentials_are_valid(credentials jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  identity_value jsonb;
  deadline numeric;
BEGIN
  IF jsonb_typeof(credentials) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF credentials ? 'authorization' THEN
    IF credentials->'authorization' IS DISTINCT FROM '"credential_source"'::jsonb
      OR NOT (credentials ?& ARRAY['authorization', 'driver', 'bindings'])
      OR credentials - 'authorization' - 'driver' - 'bindings' <> '{}'::jsonb
      OR jsonb_typeof(credentials->'driver') IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
  ELSIF NOT (credentials ?& ARRAY['driver', 'deadlineWallMs', 'bindings'])
    OR credentials - 'driver' - 'deadlineWallMs' - 'bindings' - 'standingApprovalId' - 'standingApprovalGeneration' - 'standingApprovalScopeFingerprint' <> '{}'::jsonb
    OR jsonb_typeof(credentials->'driver') IS DISTINCT FROM 'object'
    OR jsonb_typeof(credentials->'deadlineWallMs') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  IF NOT ((credentials->'driver') ?& ARRAY['id', 'implementation'])
    OR (credentials->'driver') - 'id' - 'implementation' <> '{}'::jsonb THEN
    RETURN false;
  END IF;
  FOR identity_value IN SELECT value FROM jsonb_each(credentials->'driver') LOOP
    IF jsonb_typeof(identity_value) IS DISTINCT FROM 'string'
      OR octet_length(identity_value #>> '{}') NOT BETWEEN 1 AND 512
      OR (identity_value #>> '{}') ~ U&'[\0001-\001F\007F]' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF credentials ? 'authorization' THEN
    RETURN occ.repository_bindings_are_valid(credentials->'bindings', true);
  END IF;
  IF credentials ? 'standingApprovalId' AND (
    jsonb_typeof(credentials->'standingApprovalScopeFingerprint') IS DISTINCT FROM 'string'
    OR credentials->>'standingApprovalScopeFingerprint' !~ '^[0-9a-f]{64}$' OR
    jsonb_typeof(credentials->'standingApprovalGeneration') IS DISTINCT FROM 'number'
    OR (credentials->>'standingApprovalGeneration')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR mod((credentials->>'standingApprovalGeneration')::numeric,1) <> 0
    OR
    jsonb_typeof(credentials->'standingApprovalId') IS DISTINCT FROM 'string'
    OR credentials->>'standingApprovalId' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR jsonb_typeof(credentials->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(credentials->'bindings') <> 1) THEN RETURN false; END IF;
  IF (credentials ? 'standingApprovalGeneration' OR credentials ? 'standingApprovalScopeFingerprint') AND NOT credentials ? 'standingApprovalId' THEN RETURN false; END IF;
  deadline := (credentials->>'deadlineWallMs')::numeric;
  IF deadline NOT BETWEEN 1 AND 9007199254740991 OR mod(deadline, 1) <> 0 THEN
    RETURN false;
  END IF;
  RETURN occ.repository_bindings_are_valid(credentials->'bindings', true);
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_source_backed_repository_authorization CHECK (
  CASE WHEN admitted_spec #>> '{execution_admission,mode}' = 'standalone'
    AND admitted_spec #> '{execution_admission,version}' = '8'::jsonb
    AND admitted_spec ? 'repository_credentials'
  THEN COALESCE(
    admitted_spec #> '{repository_credentials,authorization}' = '"credential_source"'::jsonb
    AND admitted_spec #>> '{harness,id}' IN ('codex', 'openclaw'), false)
  ELSE NOT COALESCE((admitted_spec->'repository_credentials') ? 'authorization', false)
  END
) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_source_backed_repository_authorization;
--> statement-breakpoint
ALTER TABLE occ.service_accounts DROP CONSTRAINT service_accounts_credential_valid;
--> statement-breakpoint
ALTER TABLE occ.service_accounts ADD CONSTRAINT service_accounts_credential_valid CHECK (
  credential IS NULL OR (
    jsonb_typeof(credential) = 'object'
    AND credential ?& ARRAY['kind', 'sourceId']
    AND credential - 'kind' - 'sourceId' = '{}'::jsonb
    AND credential->>'kind' = 'access_token'
    AND jsonb_typeof(credential->'sourceId') = 'string'
    AND credential->>'sourceId' ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) OR (
    jsonb_typeof(credential) = 'object'
    AND credential ?& ARRAY['kind', 'secretRef']
    AND credential - 'kind' - 'secretRef' = '{}'::jsonb
    AND jsonb_typeof(credential->'kind') = 'string'
    AND credential->>'kind' IN ('api_key', 'oauth_access_token')
    AND jsonb_typeof(credential->'secretRef') = 'object'
    AND (credential->'secretRef') ?& ARRAY['name', 'key']
    AND (credential->'secretRef') - 'name' - 'key' = '{}'::jsonb
    AND jsonb_typeof(credential #> '{secretRef,name}') = 'string'
    AND char_length(credential #>> '{secretRef,name}') BETWEEN 1 AND 253
    AND (credential #>> '{secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
    AND jsonb_typeof(credential #> '{secretRef,key}') = 'string'
    AND char_length(credential #>> '{secretRef,key}') BETWEEN 1 AND 253
    AND (credential #>> '{secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
    AND (credential #>> '{secretRef,key}') NOT IN ('.', '..')
  )
);
--> statement-breakpoint
ALTER TABLE occ.service_accounts ADD COLUMN credential_source_id text
  GENERATED ALWAYS AS (CASE WHEN credential->>'kind' = 'access_token' THEN credential->>'sourceId' END) STORED;
--> statement-breakpoint
ALTER TABLE occ.service_accounts ADD CONSTRAINT service_accounts_credential_source_unique UNIQUE (namespace_id, credential_source_id);
--> statement-breakpoint
ALTER TABLE occ.service_accounts ADD CONSTRAINT service_accounts_credential_source_owner
  FOREIGN KEY (namespace_id, credential_source_id) REFERENCES occ.credential_sources(namespace_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION occ.guard_service_account_credential_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM occ.credential_sources AS s WHERE s.namespace_id = NEW.namespace_id
      AND s.id = NEW.credential_source_id AND s.owner_capability = 'token_service'
      AND s.type = 'static' AND s.state = 'ready' AND s.config->>'provider_preset' = 'codex-pat'
  ) THEN
    RAISE EXCEPTION 'The managed ServiceAccount Source is invalid' USING ERRCODE = '23514', CONSTRAINT = 'service_accounts_issued_source_valid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER service_accounts_issued_source_guard AFTER INSERT OR UPDATE OF credential
  ON occ.service_accounts FOR EACH ROW EXECUTE FUNCTION occ.guard_service_account_credential_source();
