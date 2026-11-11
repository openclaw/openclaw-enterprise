CREATE TABLE occ.human_authentication_links (
  link_hash text PRIMARY KEY CONSTRAINT human_authentication_link_hash CHECK (link_hash ~ '^[a-f0-9]{64}$'),
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  attempt_id text NOT NULL CONSTRAINT human_authentication_link_attempt CHECK (attempt_id ~ '^[A-Za-z0-9_-]{43}$'),
  provider_id text NOT NULL CONSTRAINT human_authentication_link_provider CHECK (provider_id ~ '^oidc:[a-f0-9]{64}$'),
  provider_binding text NOT NULL CONSTRAINT human_authentication_link_binding CHECK (
    char_length(provider_binding) <= 200 AND starts_with(provider_binding, provider_id || ':')
  ),
  subject text NOT NULL CONSTRAINT human_authentication_link_subject CHECK (char_length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT human_authentication_link_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '5 minutes'
  )
);
--> statement-breakpoint
CREATE INDEX human_authentication_link_expiry ON occ.human_authentication_links (installation_id, expires_at, link_hash);
--> statement-breakpoint
REVOKE ALL ON occ.human_authentication_links FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.human_authentication_links TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.human_authentication_attempts
  ADD COLUMN link_hash text,
  ADD COLUMN link_existing boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT human_authentication_attempt_link CHECK (
    link_hash IS NULL OR (link_hash ~ '^[a-f0-9]{64}$' AND NOT link_existing)
  );
