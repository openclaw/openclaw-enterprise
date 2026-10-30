ALTER TABLE occ.agent_connections
  ADD COLUMN profile jsonb,
  ADD CONSTRAINT agent_connections_profile_valid CHECK (
    profile IS NULL OR (
      jsonb_typeof(profile) = 'object'
      AND (profile - ARRAY['externalUserId', 'email', 'name']) = '{}'::jsonb
      AND NOT jsonb_path_exists(profile, 'strict $.* ? (@.type() != "string")')
    )
  );
