-- Explicit consent to one protected repository identity read. Never migrate a credentialed grant.
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
GRANT EXECUTE ON FUNCTION occ.credential_free_metadata_source_is_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources DROP CONSTRAINT credential_sources_egress_valid,
  ADD CONSTRAINT credential_sources_egress_valid CHECK (CASE WHEN type = 'credential-free-repository-metadata' THEN
      config->'authority' = '"execution"'::jsonb
      AND config->'agent_id' = egress #> '{grant,isolationId}' AND config->'origin' = egress->'origin'
      AND config->'repository_id' = egress #> '{grant,repositoryId}' AND config->'repository' = egress #> '{grant,repository}'
      AND occ.credential_free_metadata_source_is_valid(egress, namespace_id, id)
    ELSE egress IS NULL OR occ.egress_source_is_valid(egress, namespace_id, id) END IS TRUE);
--> statement-breakpoint

-- Keep credential-rejection feedback restricted to actual material. Record a positive no-material
-- selection, never a dummy version/expiry or NULL. The strict same-stream association from 0059
-- applies unchanged. The empty-injection digest is SHA-256 of zero bytes.
ALTER TABLE occ.egress_send_receipts DROP CONSTRAINT egress_send_receipts_check_17,
  ADD CONSTRAINT egress_send_receipts_check_17 CHECK (authorized_dispatch IS NULL OR (
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
    END) IS TRUE);
