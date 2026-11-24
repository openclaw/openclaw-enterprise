DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.authentication_states WHERE kind = 'device_authorization') THEN
    RAISE EXCEPTION 'Codex device-login cutover requires disposition of residual temporary device authorization rows' USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE occ.authentication_states ADD COLUMN credential_source_id text;
ALTER TABLE occ.authentication_states ADD CONSTRAINT authentication_states_device_source_owner CHECK (kind = 'device_authorization' OR credential_source_id IS NULL);
GRANT UPDATE (credential_source_id) ON occ.authentication_states TO occ_app;
ALTER TABLE occ.authentication_states DROP CONSTRAINT authentication_states_device_shape;
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
