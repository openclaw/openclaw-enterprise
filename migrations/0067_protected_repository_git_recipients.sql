-- Keep the original family and every attempt intact. Older discovery and retirement workers
-- cannot interpret the new adoption as their own. Reusing an admission id cannot open a second family.
ALTER TABLE occ.prepared_github_families
  DROP CONSTRAINT prepared_github_families_check,
  ADD CONSTRAINT prepared_github_families_check CHECK ((source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'prepared' AND source #>> '{grant,profile}' = 'metadata-read'
   AND admission->>'familyId' = source_id AND jsonb_typeof(issuer->'backendRef') = 'object')
  OR
  ((source->>'adoption' = 'prepared_repository_git' OR (
       source->>'adoption' = 'credential_proxy_repository_git'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'))
   AND source_id = 'repository-git:' || (source #>> '{session,admissionId}')
   AND ((source #>> '{grant,profile}' = 'git-ref-write' AND NOT (source->'grant' ? 'pullRequestBase'))
       OR (source #>> '{grant,profile}' = 'git-ref-draft-pr' AND length(source #>> '{grant,pullRequestBase}') > 0))
   AND source #>> '{grant,pushRef}' LIKE 'refs/heads/%'
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,repositoryId}' = source #>> '{session,grant,repositoryId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.prepared_github_families VALIDATE CONSTRAINT prepared_github_families_check;
--> statement-breakpoint
-- The selected Driver observes the released installation before the first material exists.
-- A conditional install advances the fence before its effect; an unknown outcome stays installing.
-- OpenShell continues using its own more detailed durable observations.
ALTER TABLE occ.prepared_github_attempts ADD CONSTRAINT prepared_github_attempt_version UNIQUE (id, material_version);
--> statement-breakpoint
CREATE TABLE occ.protected_repository_git_recipients (
  revision_id text PRIMARY KEY REFERENCES occ.agent_revisions(id) ON DELETE CASCADE,
  installation jsonb NOT NULL,
  fence bigint NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'observed',
  attempt_id uuid,
  material_version uuid,
  FOREIGN KEY (attempt_id, material_version) REFERENCES occ.prepared_github_attempts(id, material_version),
  CHECK (fence >= 1 AND state IN ('observed', 'installing', 'installed')
    AND (state = 'observed') = (attempt_id IS NULL)
    AND (attempt_id IS NULL) = (material_version IS NULL)
    AND (installation#>>'{plan,execution,revisionId}' = revision_id) IS TRUE)
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(fence, state, attempt_id, material_version)
ON occ.protected_repository_git_recipients TO occ_app;

--> statement-breakpoint
-- Through 0066 the Gateway admitted every source, including prepared and credential-free
-- sources. Set that historical owner once, then require every new admission to name its owner.
-- Driver IDs are scoped to a capability; a matching Proxy ID or backend cannot adopt a source.
ALTER TABLE occ.credential_sources
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
-- Existing revisions keep their exact Gateway owner. Prepared and credential-free sources
-- admitted by the selected Proxy record that owner instead; no stored authority is converted.
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
-- An issuer supplies only its closed, non-secret scope. OCC owns isolation and the source key.
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
GRANT EXECUTE ON FUNCTION occ.prepared_token_source_is_valid(jsonb,text,text) TO occ_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.egress_source_is_valid(value jsonb, owner_namespace text, owner_source text)
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
CREATE OR REPLACE FUNCTION occ.egress_receipt_material_is_valid(material jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
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
