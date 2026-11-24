ALTER TABLE occ.credential_sources
  DROP CONSTRAINT credential_sources_oauth_shape,
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
);
