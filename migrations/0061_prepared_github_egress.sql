-- Recognize a freshly consented, Agent-isolated repository metadata grant. No rows or grants are rewritten.
CREATE FUNCTION occ.egress_source_is_valid(value jsonb, owner_namespace text, owner_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT occ.static_egress_source_is_valid(value, owner_namespace, owner_source) OR COALESCE(
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
GRANT EXECUTE ON FUNCTION occ.egress_source_is_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources DROP CONSTRAINT credential_sources_egress_valid,
  ADD CONSTRAINT credential_sources_egress_valid CHECK (egress IS NULL OR occ.egress_source_is_valid(egress, namespace_id, id));
--> statement-breakpoint

-- This evidence can identify a committed selection; it is never the credential or a permit to use it.
-- Preserve the historical static branch without rewriting receipts, including uncertain attempts.
CREATE FUNCTION occ.egress_receipt_material_is_valid(material jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT material->>'kind' = 'static' OR COALESCE(
    material->>'kind' = 'prepared_github' AND material ?& fields AND material - fields = '{}'::jsonb
    AND src ?& source_fields AND src - source_fields = '{}'::jsonb
    AND src->>'installationId' ~ '^ins_[0-9a-f-]{36}$' AND length(src->>'namespaceId') > 0
    AND occ.egress_ref_is_valid(src->'source') AND occ.egress_ref_is_valid(src->'backend')
    AND src->'provider' = '{"id":"github-app-metadata","generation":1}'::jsonb
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

-- Bind this prepared receipt to the same execution isolation, enrolled installation, stream and reply custody.
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
ALTER TABLE occ.egress_send_receipts
  DROP CONSTRAINT egress_send_receipts_check_16,
  DROP CONSTRAINT egress_send_receipts_check_17,
  ADD CONSTRAINT egress_send_receipts_check_16 CHECK (feedback IS NULL OR ((observation IS NOT NULL OR (settled AND outcome->>'dispatch' = 'confirmed'))
    AND occ.egress_receipt_material_is_valid(binding->'material')) IS TRUE),
  ADD CONSTRAINT egress_send_receipts_check_17 CHECK (authorized_dispatch IS NULL OR (jsonb_typeof(authorized_dispatch) = 'object'
    AND occ.egress_receipt_material_is_valid(binding->'material')
    AND (binding->'material'->>'kind' = 'static' OR occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material'))
    AND authorized_dispatch->'association'->'installation'->>'instanceId' = instance_id
    AND authorized_dispatch->'association'->'execution'->>'installationId' = binding->'material'->'source'->>'installationId'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz > (authorized_dispatch->>'authorizedAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (authorized_dispatch->>'authorizedAt')::timestamptz + interval '1 second'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->>'deadlineAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->'material'->>'usableUntil')::timestamptz
    AND length(authorized_dispatch->'association'->>'exchangeId') > 0
    AND length(authorized_dispatch->'association'->>'responseId') > 0
    AND length(authorized_dispatch->'association'->>'custodyId') > 0
    AND length(authorized_dispatch->>'requestDigest') = 64
    AND length(authorized_dispatch->>'injectionDigest') = 64) IS TRUE);
