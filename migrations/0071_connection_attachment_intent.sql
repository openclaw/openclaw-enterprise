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
