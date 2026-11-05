-- Only the initiating browser may consume this saved target, together with its consent attempt.
ALTER TABLE occ.connection_sessions
  ADD COLUMN attachment_intent jsonb,
  ADD CONSTRAINT connection_sessions_attachment_target CHECK (
    attachment_intent IS NULL OR (
      jsonb_typeof(attachment_intent) = 'object'
      AND attachment_intent ?& ARRAY['agentId', 'pluginId', 'slotId', 'releaseSha256',
        'expectedCredentialSourceId', 'connectionTemplateId', 'connectionTemplateVersion']
      AND jsonb_typeof(attachment_intent->'agentId') = 'string' AND attachment_intent->>'agentId' <> ''
      AND jsonb_typeof(attachment_intent->'pluginId') = 'string' AND attachment_intent->>'pluginId' <> ''
      AND jsonb_typeof(attachment_intent->'slotId') = 'string' AND attachment_intent->>'slotId' <> ''
      AND jsonb_typeof(attachment_intent->'releaseSha256') = 'string' AND attachment_intent->>'releaseSha256' ~ '^[a-f0-9]{64}$'
      AND (attachment_intent->'expectedCredentialSourceId' = 'null'::jsonb
        OR (jsonb_typeof(attachment_intent->'expectedCredentialSourceId') = 'string' AND attachment_intent->>'expectedCredentialSourceId' <> ''))
      AND attachment_intent->'connectionTemplateId' = to_jsonb(connection_template_id)
      AND attachment_intent->'connectionTemplateVersion' = to_jsonb(connection_template_version)
    )
  );

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
    OR jsonb_array_length(snapshots) > 64 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(snapshots) LOOP
    owner_key := CASE WHEN entry ? 'credentialProxyId' THEN 'credentialProxyId' ELSE 'credentialGatewayId' END;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT (entry ?& ARRAY['sourceId', owner_key, 'sourceType'])
      OR entry - 'sourceId' - owner_key - 'sourceType' - 'accountDelivery' <> '{}'::jsonb
      OR (entry ? 'accountDelivery' AND (
        owner_key <> 'credentialGatewayId'
        OR jsonb_typeof(entry->'accountDelivery') IS DISTINCT FROM 'object'
        OR NOT ((entry->'accountDelivery') ?& ARRAY['profileId','refreshDriverId','config'])
        OR (entry->'accountDelivery') - 'profileId' - 'refreshDriverId' - 'config' <> '{}'::jsonb
        OR jsonb_typeof(entry#>'{accountDelivery,profileId}') IS DISTINCT FROM 'string'
        OR (entry#>>'{accountDelivery,profileId}') !~ '^account-[0-9a-f]{64}$'
        OR jsonb_typeof(entry#>'{accountDelivery,refreshDriverId}') IS DISTINCT FROM 'string'
        OR btrim(entry#>>'{accountDelivery,refreshDriverId}') = ''
        OR jsonb_typeof(entry#>'{accountDelivery,config}') IS DISTINCT FROM 'object'
        OR (entry#>>'{accountDelivery,config,oauth_owner}') IS DISTINCT FROM 'token_service'
      ))
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
-- A profile can outlive every Agent that used it. Disconnect retires it before deleting the account.
CREATE TABLE occ.saved_connection_profiles (
  namespace_id text NOT NULL,
  credential_source_id text NOT NULL,
  profile_id text NOT NULL CHECK (profile_id ~ '^account-[0-9a-f]{64}$'),
  gateway_id text NOT NULL CHECK (btrim(gateway_id) <> ''),
  source_type text NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9-]{0,63}$'),
  PRIMARY KEY (namespace_id, credential_source_id, profile_id),
  CONSTRAINT saved_connection_profiles_owner FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.saved_connections(namespace_id, credential_source_id) ON DELETE CASCADE
);
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.saved_connection_profiles TO occ_app;
