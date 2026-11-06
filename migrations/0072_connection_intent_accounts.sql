CREATE FUNCTION occ.connection_intent_account_ids_are_valid(ids jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, occ, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(ids) = 'array' THEN
    jsonb_array_length(ids) <= 64 AND (
      SELECT count(*) = count(DISTINCT id)
        AND coalesce(bool_and(jsonb_typeof(id) = 'string' AND id #>> '{}' ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'), true)
      FROM jsonb_array_elements(ids) AS items(id)
    ) ELSE false END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.connection_intent_account_ids_are_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.connection_sessions DROP CONSTRAINT connection_sessions_attachment_target;
--> statement-breakpoint
UPDATE occ.connection_sessions
SET attachment_intent = (attachment_intent - 'expectedCredentialSourceId') ||
  jsonb_build_object('expectedCredentialSourceIds', CASE WHEN attachment_intent->'expectedCredentialSourceId' = 'null'::jsonb
    THEN '[]'::jsonb ELSE jsonb_build_array(attachment_intent->'expectedCredentialSourceId') END)
WHERE attachment_intent IS NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.connection_sessions
  ADD CONSTRAINT connection_sessions_attachment_target CHECK (
    attachment_intent IS NULL OR (
      jsonb_typeof(attachment_intent) = 'object'
      AND attachment_intent ?& ARRAY['agentId', 'pluginId', 'slotId', 'releaseSha256',
        'expectedCredentialSourceIds', 'connectionTemplateId', 'connectionTemplateVersion']
      AND jsonb_typeof(attachment_intent->'agentId') = 'string' AND attachment_intent->>'agentId' <> ''
      AND jsonb_typeof(attachment_intent->'pluginId') = 'string' AND attachment_intent->>'pluginId' <> ''
      AND jsonb_typeof(attachment_intent->'slotId') = 'string' AND attachment_intent->>'slotId' <> ''
      AND jsonb_typeof(attachment_intent->'releaseSha256') = 'string' AND attachment_intent->>'releaseSha256' ~ '^[a-f0-9]{64}$'
      AND occ.connection_intent_account_ids_are_valid(attachment_intent->'expectedCredentialSourceIds')
      AND attachment_intent->'connectionTemplateId' = to_jsonb(connection_template_id)
      AND attachment_intent->'connectionTemplateVersion' = to_jsonb(connection_template_version)
    )
  );
