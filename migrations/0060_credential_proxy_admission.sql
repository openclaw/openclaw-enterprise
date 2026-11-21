-- Existing sources retain Gateway ownership and approved material semantics.
ALTER TABLE occ.credential_sources
  ADD COLUMN egress jsonb,
  ADD COLUMN owner_capability text NOT NULL DEFAULT 'credential_gateway',
  ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
    owner_capability = 'credential_gateway' OR (owner_capability = 'credential_proxy' AND egress IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE occ.credential_sources ALTER COLUMN owner_capability DROP DEFAULT;
--> statement-breakpoint
DROP TRIGGER credential_source_metadata_is_immutable ON occ.credential_sources;
--> statement-breakpoint
CREATE TRIGGER credential_source_metadata_is_immutable
BEFORE UPDATE OF id, namespace_id, name, type, config, driver_id, owner_capability, created_at
ON occ.credential_sources FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE FUNCTION occ.egress_ref_is_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['id', 'generation'] AND (value - 'id' - 'generation') = '{}'::jsonb
    AND jsonb_typeof(value->'id') = 'string' AND length(value->>'id') BETWEEN 1 AND 200
    AND jsonb_typeof(value->'generation') = 'number' AND (value->>'generation') ~ '^[1-9][0-9]{0,14}$', false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.static_egress_source_is_valid(value jsonb, owner_namespace text, owner_source text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['key', 'schemaVersion', 'adoption', 'materialRefId', 'secret', 'secretDriver', 'sender', 'resolver', 'retention']
    AND (value - 'key' - 'schemaVersion' - 'adoption' - 'materialRefId' - 'secret' - 'secretDriver' - 'sender' - 'resolver' - 'retention') = '{}'::jsonb
    AND value->'schemaVersion' = '1'::jsonb AND value->>'adoption' = 'live' AND value->>'retention' = 'none'
    AND jsonb_typeof(value->'materialRefId') = 'string' AND length(value->>'materialRefId') BETWEEN 1 AND 200
    AND jsonb_typeof(value->'key') = 'object'
    AND (value->'key') ?& ARRAY['installationId', 'namespaceId', 'source', 'backend', 'provider']
    AND ((value->'key') - 'installationId' - 'namespaceId' - 'source' - 'backend' - 'provider') = '{}'::jsonb
    AND (value->'key'->>'installationId') ~ '^ins_[0-9a-f-]{36}$'
    AND value->'key'->>'namespaceId' = owner_namespace AND value->'key'->'source'->>'id' = owner_source
    AND occ.egress_ref_is_valid(value->'key'->'source') AND occ.egress_ref_is_valid(value->'key'->'backend') AND occ.egress_ref_is_valid(value->'key'->'provider')
    AND jsonb_typeof(value->'secret') = 'object'
    AND (value->'secret') ?& ARRAY['kind', 'namespaceId', 'id'] AND ((value->'secret') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
    AND value->'secret'->>'kind' = 'secret' AND value->'secret'->>'namespaceId' = owner_namespace
    AND (value->'secret'->>'id') ~ '^sec_[0-9a-f-]{36}$'
    AND occ.egress_ref_is_valid(value->'secretDriver') AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver'), false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.prepared_token_source_is_valid(value jsonb, owner_namespace text, owner_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    value ?& fields AND value - fields = '{}'::jsonb
    AND value->'schemaVersion' = '4'::jsonb AND value->>'adoption' = 'prepared' AND value->>'retention' = 'none'
    AND value->>'origin' ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'
    AND key ?& keys AND key - keys = '{}'::jsonb
    AND key->>'installationId' ~ '^ins_[0-9a-f-]{36}$' AND key->>'namespaceId' = owner_namespace
    AND key #>> '{source,id}' = owner_source AND occ.egress_ref_is_valid(key->'source')
    AND occ.egress_ref_is_valid(key->'backend') AND occ.egress_ref_is_valid(key->'provider')
    AND key #>> '{provider,id}' <> 'github-app-metadata'
    AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver')
    AND g ?& grants AND g - grants = '{}'::jsonb AND g->>'kind' = 'prepared_scope'
    AND g->>'isolationId' ~ '^agt_[0-9a-f-]{36}$'
    AND CASE WHEN jsonb_typeof(g->'scope') = 'object' THEN
      (SELECT count(*) BETWEEN 1 AND 16 AND bool_and(
          k ~ '^[a-z][a-z0-9_]{0,63}$' AND jsonb_typeof(v) = 'string' AND length(v #>> '{}') BETWEEN 1 AND 1024)
       FROM jsonb_each(g->'scope') AS scope(k,v))
      ELSE false END, false)
    FROM (SELECT value->'key' AS key, value->'grant' AS g,
      ARRAY['key','schemaVersion','adoption','retention','sender','resolver','origin','grant'] AS fields,
      ARRAY['installationId','namespaceId','source','backend','provider'] AS keys,
      ARRAY['kind','isolationId','scope'] AS grants) source
$$;
--> statement-breakpoint
CREATE FUNCTION occ.egress_source_is_valid(value jsonb, owner_namespace text, owner_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT occ.prepared_token_source_is_valid(value, owner_namespace, owner_source)
    OR occ.static_egress_source_is_valid(value, owner_namespace, owner_source) OR COALESCE(
    jsonb_typeof(value) = 'object'
    AND value ?& fields AND value - fields = '{}'::jsonb
    AND value->'schemaVersion' = '2'::jsonb AND value->>'adoption' = 'prepared' AND value->>'retention' = 'none'
    AND value->>'origin' ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'
    AND jsonb_typeof(key) = 'object' AND key ?& keys AND key - keys = '{}'::jsonb
    AND key->>'installationId' ~ '^ins_[0-9a-f-]{36}$'
    AND key->>'namespaceId' = owner_namespace AND key->'source'->>'id' = owner_source
    AND occ.egress_ref_is_valid(key->'source') AND occ.egress_ref_is_valid(key->'backend')
    AND key->'provider' = '{"id":"github-app-metadata","generation":1}'::jsonb
    AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver')
    AND jsonb_typeof(grant_value) = 'object' AND grant_value ?& grants AND grant_value - grants = '{}'::jsonb
    AND grant_value->>'kind' = 'github_repository_metadata' AND grant_value->>'profile' = 'metadata-read'
    AND grant_value->>'appId' ~ '^[1-9][0-9]*$' AND grant_value->>'installationId' ~ '^[1-9][0-9]*$'
    AND grant_value->>'repositoryId' ~ '^[1-9][0-9]*$'
    AND grant_value->>'repository' ~ '^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$'
    AND grant_value->>'repository' !~ '/[.]{1,2}$'
    AND grant_value->>'isolationId' ~ '^agt_[0-9a-f-]{36}$',
    false)
  FROM (SELECT value->'key' AS key, value->'grant' AS grant_value,
    ARRAY['key','schemaVersion','adoption','retention','sender','resolver','origin','grant'] AS fields,
    ARRAY['installationId','namespaceId','source','backend','provider'] AS keys,
    ARRAY['kind','appId','installationId','repositoryId','repository','isolationId','profile'] AS grants) source
$$;
--> statement-breakpoint
CREATE FUNCTION occ.credential_free_metadata_source_is_valid(value jsonb, owner_namespace text, owner_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    value ?& fields AND value - fields = '{}'::jsonb
    AND value->'schemaVersion' = '3'::jsonb AND value->>'retention' = 'none' AND value->>'adoption' = 'credential_free'
    AND value->>'origin' ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'
    AND key ?& keys AND key - keys = '{}'::jsonb
    AND key->>'installationId' ~ '^ins_[0-9a-f-]{36}$' AND key->>'namespaceId' = owner_namespace
    AND key #>> '{source,id}' = owner_source AND occ.egress_ref_is_valid(key->'source')
    AND occ.egress_ref_is_valid(key->'backend')
    AND key->'provider' = '{"id":"credential-free-repository-metadata","generation":1}'::jsonb
    AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver')
    AND grant_value ?& grants AND grant_value - grants = '{}'::jsonb
    AND grant_value->>'kind' = 'credential_free_repository_metadata' AND grant_value->>'profile' = 'metadata-read'
    AND grant_value->>'isolationId' ~ '^agt_[0-9a-f-]{36}$' AND grant_value->>'repositoryId' ~ '^[1-9][0-9]*$'
    AND grant_value->>'repository' ~ '^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$'
    AND grant_value->>'repository' !~ '/[.]{1,2}$',
    false)
  FROM (SELECT value->'key' AS key, value->'grant' AS grant_value,
    ARRAY['key','schemaVersion','adoption','retention','sender','resolver','origin','grant'] AS fields,
    ARRAY['installationId','namespaceId','source','backend','provider'] AS keys,
    ARRAY['kind','profile','isolationId','repositoryId','repository'] AS grants) source
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.egress_ref_is_valid(jsonb), occ.static_egress_source_is_valid(jsonb,text,text), occ.prepared_token_source_is_valid(jsonb,text,text), occ.egress_source_is_valid(jsonb,text,text), occ.credential_free_metadata_source_is_valid(jsonb,text,text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  ADD CONSTRAINT credential_sources_egress_valid CHECK (CASE WHEN type = 'credential-free-repository-metadata' THEN
      config->'authority' = '"execution"'::jsonb
      AND config->'agent_id' = egress #> '{grant,isolationId}' AND config->'origin' = egress->'origin'
      AND config->'repository_id' = egress #> '{grant,repositoryId}' AND config->'repository' = egress #> '{grant,repository}'
      AND occ.credential_free_metadata_source_is_valid(egress, namespace_id, id)
    ELSE egress IS NULL OR occ.egress_source_is_valid(egress, namespace_id, id) END IS TRUE);
--> statement-breakpoint
GRANT UPDATE (egress) ON occ.credential_sources TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.credential_source_snapshots_are_valid(snapshots jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  entry jsonb;
  owner_key text;
  ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(snapshots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(snapshots) = 0
    OR jsonb_array_length(snapshots) > 8 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    owner_key := CASE WHEN entry ? 'credentialProxyId' THEN 'credentialProxyId' ELSE 'credentialGatewayId' END;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT (entry ?& ARRAY['sourceId', owner_key, 'sourceType'])
      OR entry - 'sourceId' - owner_key - 'sourceType' <> '{}'::jsonb
      OR jsonb_typeof(entry->'sourceId') IS DISTINCT FROM 'string'
      OR (entry->>'sourceId') !~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (entry->>'sourceId') = ANY(ids)
      OR jsonb_typeof(entry->owner_key) IS DISTINCT FROM 'string'
      OR COALESCE(btrim(entry->>owner_key), '') = ''
      OR jsonb_typeof(entry->'sourceType') IS DISTINCT FROM 'string'
      OR (entry->>'sourceType') !~ '^[a-z][a-z0-9-]{0,63}$' THEN
      RETURN false;
    END IF;
    ids := array_append(ids, entry->>'sourceId');
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Strip the protected reader marker only from an object. A JSON scalar must fail
-- the snapshot constraint (23514), not raise an error from the JSON deletion operator.
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot,
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute', 'harness_auth'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id' - 'sandbox_policy'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins' - 'plugin_approvers'
      - 'repository_credentials' - 'egress_plan' - 'execution_admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
    AND (admitted_spec->>'configuration_id') ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
    AND (admitted_spec->>'configuration_kind') = 'agent'
    AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
    AND (admitted_spec->>'configuration_generation')::numeric BETWEEN 1 AND 9007199254740991
    AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
    AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
    AND jsonb_typeof(admitted_spec->'harness') = 'object'
    AND ((admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode'])
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
    AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
    AND jsonb_typeof(admitted_spec->'compute') = 'object'
    AND ((admitted_spec->'compute') ?& ARRAY['id', 'implementation'])
    AND ((admitted_spec->'compute') - 'id' - 'implementation' - 'admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
    AND (
      NOT ((admitted_spec->'compute') ? 'admission')
      OR (jsonb_typeof(admitted_spec #> '{compute,admission}') = 'string'
          AND char_length(admitted_spec #>> '{compute,admission}') BETWEEN 1 AND 1024
          AND (admitted_spec #>> '{compute,admission}') ~ '^[ -~]+$')
    )
    AND (
      NOT (admitted_spec ? 'sandbox_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_bindings')
      OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
    )
    AND CASE WHEN jsonb_typeof(admitted_spec->'harness_auth') = 'object' THEN
      occ.harness_auth_is_valid((admitted_spec->'harness_auth') - 'protectedExecutionVersion', namespace_id, true)
    ELSE false END
    AND (
      NOT (admitted_spec ? 'repository_credentials')
      OR occ.repository_credentials_are_valid(admitted_spec->'repository_credentials')
    )
    AND (
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
    AND (
      NOT (admitted_spec ? 'plugin_approvers')
      OR (jsonb_typeof(admitted_spec->'plugin_approvers') = 'array'
          AND jsonb_array_length(admitted_spec->'plugin_approvers') <= 64)
    )
    AND (
      NOT (admitted_spec ? 'credential_sources')
      OR occ.credential_source_snapshots_are_valid(admitted_spec->'credential_sources')
    )
  );
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_egress_scope CHECK (
  NOT (admitted_spec ? 'egress_plan') OR COALESCE(
    jsonb_typeof(admitted_spec->'egress_plan') = 'object'
    AND admitted_spec->'egress_plan'->'execution'->>'namespaceId' = namespace_id
    AND admitted_spec->'egress_plan'->'execution'->>'agentId' = agent_id
    AND admitted_spec->'egress_plan'->'execution'->>'revisionId' = id
    AND jsonb_typeof(admitted_spec->'egress_plan'->'routes') = 'array',
    false)
);
--> statement-breakpoint
-- Record the pre-proxy decision while the immutable revision rows are transactionally fenced.
ALTER TABLE occ.agent_revisions
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((admitted_spec->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
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
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' = '7'
                  THEN admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7'))
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
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
        ), false)) NOT VALID;
--> statement-breakpoint
DROP TRIGGER agent_revisions_are_immutable ON occ.agent_revisions;
--> statement-breakpoint
UPDATE occ.agent_revisions
SET admitted_spec = admitted_spec || '{"execution_admission":{"version":2,"mode":"unprotected"}}'::jsonb
WHERE NOT (admitted_spec ? 'execution_admission')
  AND NOT (admitted_spec ? 'egress_plan')
  AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion');
--> statement-breakpoint
CREATE TRIGGER agent_revisions_are_immutable
BEFORE UPDATE ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
CREATE TABLE occ.egress_installations (
  sender_id text NOT NULL,
  sandbox_id text NOT NULL,
  namespace_id text NOT NULL,
  revision_id text NOT NULL,
  agent_id text NOT NULL,
  installation jsonb NOT NULL,
  PRIMARY KEY (sender_id, sandbox_id),
  UNIQUE (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, agent_id, revision_id) REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE,
  CHECK (length(sender_id) BETWEEN 1 AND 200 AND length(sandbox_id) BETWEEN 1 AND 200),
  CHECK (COALESCE(installation->'sender'->>'id' = sender_id
    AND installation->>'sandboxId' = sandbox_id
    AND installation->'plan'->'execution'->>'namespaceId' = namespace_id
    AND installation->'plan'->'execution'->>'revisionId' = revision_id
    AND installation->'plan'->'execution'->>'agentId' = agent_id, false))
);
--> statement-breakpoint
CREATE TABLE occ.egress_rejected_material (
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  secret_driver_id text NOT NULL,
  material_id text NOT NULL,
  material_version text NOT NULL,
  PRIMARY KEY (namespace_id, secret_driver_id, material_id, material_version),
  CHECK (length(secret_driver_id) > 0 AND length(material_id) > 0 AND length(material_version) > 0)
);
--> statement-breakpoint
REVOKE ALL ON occ.egress_installations, occ.egress_rejected_material FROM PUBLIC, occ_app;
GRANT SELECT, INSERT, UPDATE(installation) ON occ.egress_installations TO occ_app;
GRANT SELECT, INSERT ON occ.egress_rejected_material TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.egress_receipt_material_is_valid(material jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT material->>'kind' = 'static' OR COALESCE(
    material->>'kind' IN ('prepared_github','prepared_token') AND material ?& fields AND material - fields = '{}'::jsonb
    AND src ?& source_fields AND src - source_fields = '{}'::jsonb
    AND src->>'installationId' ~ '^ins_[0-9a-f-]{36}$' AND length(src->>'namespaceId') > 0
    AND occ.egress_ref_is_valid(src->'source') AND occ.egress_ref_is_valid(src->'backend')
    AND (CASE material->>'kind' WHEN 'prepared_github' THEN
        src->'provider' = '{"id":"github-app-metadata","generation":1}'::jsonb
      ELSE occ.egress_ref_is_valid(src->'provider') AND src #>> '{provider,id}' <> 'github-app-metadata' END)
    AND occ.egress_ref_is_valid(material->'binding') AND occ.egress_ref_is_valid(material->'family')
    AND material->>'grantHash' ~ '^[0-9a-f]{64}$' AND material->>'isolationId' ~ '^agt_[0-9a-f-]{36}$'
    AND jsonb_typeof(material->'ownerEpoch') = 'number' AND material->>'ownerEpoch' ~ '^[1-9][0-9]*$'
    AND NOT EXISTS (SELECT FROM unnest(ARRAY['inputVersion','preparationAttemptId','materialId','materialVersion']) AS t(k)
      WHERE jsonb_typeof(material->k) IS DISTINCT FROM 'string' OR length(material->>k) NOT BETWEEN 1 AND 1024)
    AND material->>'usableUntil' ~ 'Z$' AND material->>'providerExpiresAt' ~ 'Z$'
    AND (material->>'usableUntil')::timestamptz <= (material->>'providerExpiresAt')::timestamptz, false)
  FROM (SELECT material->'source' AS src, ARRAY['installationId','namespaceId','source','backend','provider'] AS source_fields,
    ARRAY['kind','source','binding','grantHash','isolationId','family','ownerEpoch','inputVersion','preparationAttemptId',
          'materialId','materialVersion','providerExpiresAt','usableUntil'] AS fields) evidence
$$;
--> statement-breakpoint
CREATE FUNCTION occ.prepared_github_dispatch_matches(dispatch jsonb, material jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    dispatch ?& dispatch_fields AND dispatch - dispatch_fields = '{}'::jsonb
    AND assoc ?& assoc_fields AND assoc - assoc_fields = '{}'::jsonb
    AND peer ?& peer_fields AND peer - peer_fields = '{}'::jsonb
    AND exec ?& exec_fields AND exec - exec_fields = '{}'::jsonb
    AND peer->>'peerKeyId' ~ '^[A-Za-z0-9_-]{43}$' AND occ.egress_ref_is_valid(peer->'plan')
    AND peer->>'policyHash' ~ '^[0-9a-f]{64}$' AND peer->>'authorityScope' = 'execution'
    AND assoc->>'exchangeId' ~ '^[0-9a-f]{64}$' AND assoc->>'responseId' ~ '^[0-9a-f]{64}$'
    AND assoc->>'custodyId' ~ '^[0-9a-f]{64}$'
    AND length(peer->>'sandboxId') > 0 AND length(peer->>'configurationId') > 0
    AND exec->>'namespaceId' = material->'source'->>'namespaceId' AND exec->>'agentId' = material->>'isolationId'
    AND NOT EXISTS (SELECT FROM unnest(exec_fields) AS t(k)
      WHERE jsonb_typeof(exec->k) IS DISTINCT FROM 'string' OR length(exec->>k) NOT BETWEEN 1 AND 1024)
    AND dispatch->>'requestDigest' ~ '^[0-9a-f]{64}$' AND dispatch->>'injectionDigest' ~ '^[0-9a-f]{64}$',
    false)
  FROM (SELECT dispatch->'association' AS assoc, dispatch #> '{association,installation}' AS peer,
      dispatch #> '{association,execution}' AS exec,
      ARRAY['association','requestDigest','injectionDigest','authorizedAt','sendStartBy'] AS dispatch_fields,
      ARRAY['execution','installation','exchangeId','responseId','custodyId'] AS assoc_fields,
      ARRAY['sandboxId','instanceId','configurationId','peerKeyId','policyHash','authorityScope','plan'] AS peer_fields,
      ARRAY['installationId','namespaceId','agentId','servicePrincipalId','revisionId','executionId'] AS exec_fields) association
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.egress_receipt_material_is_valid(jsonb), occ.prepared_github_dispatch_matches(jsonb,jsonb) TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.egress_send_receipts (
  sender_id text NOT NULL CONSTRAINT egress_send_receipts_check_0 CHECK (length(sender_id) > 0),
  sender_generation bigint NOT NULL CONSTRAINT egress_send_receipts_check_1 CHECK (sender_generation > 0),
  instance_id text NOT NULL CONSTRAINT egress_send_receipts_check_2 CHECK (length(instance_id) > 0),
  use_id text NOT NULL CONSTRAINT egress_send_receipts_check_3 CHECK (length(use_id) > 0),
  attempt_id text NOT NULL CONSTRAINT egress_send_receipts_check_4 CHECK (length(attempt_id) > 0),
  binding jsonb NOT NULL CONSTRAINT egress_send_receipts_check_5 CHECK (jsonb_typeof(binding) = 'object'),
  authorized_dispatch jsonb,
  observation jsonb,
  outcome jsonb NOT NULL CONSTRAINT egress_send_receipts_check_6 CHECK (jsonb_typeof(outcome) = 'object'),
  settled boolean NOT NULL DEFAULT false,
  feedback text CONSTRAINT egress_send_receipts_check_7 CHECK (feedback = 'fenced'),
  PRIMARY KEY (sender_id, sender_generation, instance_id, use_id, attempt_id),
  CONSTRAINT egress_send_receipts_check_8 CHECK ((binding->'sender'->>'id' = sender_id
      AND (binding->'sender'->>'generation')::bigint = sender_generation
      AND binding->>'instanceId' = instance_id
      AND binding->>'useId' = use_id AND binding->>'attemptId' = attempt_id
      AND length(binding->>'deadlineAt') > 0
      AND jsonb_typeof(binding->'material') IN ('object', 'null')) IS TRUE),
  CONSTRAINT egress_send_receipts_check_9 CHECK ((
    (outcome->>'kind' = 'refused' AND outcome->'dispatched' = 'false'::jsonb AND settled)
    OR (outcome->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
        AND outcome->>'dispatch' = 'confirmed' AND settled)
    OR (outcome->>'kind' = 'uncertain' AND outcome->>'dispatch' = 'possible')
  ) IS TRUE),
  CONSTRAINT egress_send_receipts_check_10 CHECK (outcome->>'kind' <> 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'),
  CONSTRAINT egress_send_receipts_check_11 CHECK (outcome->>'kind' <> 'response_blocked' OR (outcome->>'code' = 'response_policy') IS TRUE),
  CONSTRAINT egress_send_receipts_check_12 CHECK (outcome->>'kind' NOT IN ('response', 'provider_rejected')
    OR ((outcome->>'status')::integer BETWEEN 100 AND 599) IS TRUE),
  CONSTRAINT egress_send_receipts_check_13 CHECK (observation IS NULL OR (jsonb_typeof(observation) = 'object'
    AND observation->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
    AND observation->>'dispatch' = 'confirmed'
    AND CASE WHEN observation->>'kind' = 'response_blocked'
      THEN observation->>'code' = 'response_policy'
      ELSE (observation->>'status')::integer BETWEEN 100 AND 599 END) IS TRUE),
  CONSTRAINT egress_send_receipts_check_14 CHECK (observation->>'kind' IS DISTINCT FROM 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'),
  CONSTRAINT egress_send_receipts_check_15 CHECK (observation IS NULL OR NOT settled OR outcome = observation OR outcome->>'kind' = 'uncertain'),
  CONSTRAINT egress_send_receipts_check_16 CHECK (feedback IS NULL OR ((observation IS NOT NULL OR (settled AND outcome->>'dispatch' = 'confirmed'))
    AND occ.egress_receipt_material_is_valid(binding->'material')) IS TRUE),
  CONSTRAINT egress_send_receipts_check_17 CHECK (authorized_dispatch IS NULL OR (
    jsonb_typeof(authorized_dispatch) = 'object'
    AND authorized_dispatch #>> '{association,installation,instanceId}' = instance_id
    AND authorized_dispatch #>> '{association,execution,installationId}' = binding #>> '{material,source,installationId}'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz > (authorized_dispatch->>'authorizedAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (authorized_dispatch->>'authorizedAt')::timestamptz + interval '1 second'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->>'deadlineAt')::timestamptz
    AND CASE WHEN binding #>> '{material,kind}' = 'no_material_required' THEN
      (binding->'material') - ARRAY['kind','source','binding','grantHash','isolationId'] = '{}'::jsonb
      AND binding #>> '{material,grantHash}' ~ '^[0-9a-f]{64}$'
      AND occ.egress_ref_is_valid(binding #> '{material,binding}')
      AND binding #> '{material,source,provider}' = '{"id":"credential-free-repository-metadata","generation":1}'::jsonb
      AND occ.egress_ref_is_valid(binding #> '{material,source,source}') AND occ.egress_ref_is_valid(binding #> '{material,source,backend}')
      AND binding #>> '{material,source,namespaceId}' = authorized_dispatch #>> '{association,execution,namespaceId}'
      AND occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material')
      AND authorized_dispatch->>'injectionDigest' = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ELSE occ.egress_receipt_material_is_valid(binding->'material')
      AND (binding #>> '{material,kind}' = 'static' OR occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material'))
      AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding #>> '{material,usableUntil}')::timestamptz
      AND length(authorized_dispatch #>> '{association,exchangeId}') > 0 AND length(authorized_dispatch #>> '{association,responseId}') > 0
      AND length(authorized_dispatch #>> '{association,custodyId}') > 0 AND length(authorized_dispatch->>'requestDigest') = 64
      AND length(authorized_dispatch->>'injectionDigest') = 64
    END) IS TRUE)
);
--> statement-breakpoint
REVOKE ALL ON occ.egress_send_receipts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (authorized_dispatch, outcome, observation, settled, feedback) ON occ.egress_send_receipts TO occ_app;
