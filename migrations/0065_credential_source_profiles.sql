ALTER TABLE occ.credential_sources
  ADD COLUMN profile jsonb,
  ADD CONSTRAINT credential_sources_profile_valid CHECK (
    profile IS NULL OR (
      jsonb_typeof(profile) = 'object'
      AND (profile - ARRAY['externalUserId', 'email', 'name']) = '{}'::jsonb
      AND NOT jsonb_path_exists(profile, 'strict $.* ? (@.type() != "string")')
    )
  );
--> statement-breakpoint
UPDATE occ.credential_sources AS source
SET profile = connection.profile
FROM occ.agent_connections AS connection
WHERE source.namespace_id = connection.namespace_id
  AND source.id = connection.credential_source_id
  AND connection.profile IS NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.agent_connections DROP COLUMN profile;
