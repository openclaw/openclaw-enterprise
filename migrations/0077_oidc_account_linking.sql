CREATE TABLE occ.human_authentication_links (
  browser_hash text PRIMARY KEY CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON DELETE CASCADE,
  policy_id text NOT NULL CHECK (policy_id ~ '^[a-f0-9]{64}$'),
  provider_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  owner_user_id text REFERENCES occ.human_authentication_accounts(user_id) ON DELETE CASCADE,
  owner_method_id text REFERENCES occ.account(id) ON DELETE CASCADE,
  owner_principal_id text REFERENCES occ.iam_identities(id) ON DELETE CASCADE,
  owner_version integer CHECK (owner_version > 0),
  owner_method_version integer CHECK (owner_method_version > 0),
  owner_expires_at timestamptz,
  candidate_subject text CHECK (char_length(candidate_subject) BETWEEN 1 AND 255),
  candidate_expires_at timestamptz,
  CONSTRAINT human_authentication_link_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '5 minutes'
  ),
  CONSTRAINT human_authentication_link_owner CHECK (
    (owner_user_id IS NULL AND owner_method_id IS NULL AND owner_principal_id IS NULL
      AND owner_version IS NULL AND owner_method_version IS NULL AND owner_expires_at IS NULL)
    OR (owner_user_id IS NOT NULL AND owner_method_id IS NOT NULL AND owner_principal_id IS NOT NULL
      AND owner_version IS NOT NULL AND owner_method_version IS NOT NULL AND owner_expires_at IS NOT NULL)
  ),
  CONSTRAINT human_authentication_link_candidate CHECK (
    (candidate_subject IS NULL AND candidate_expires_at IS NULL)
    OR (owner_user_id IS NOT NULL AND candidate_subject IS NOT NULL AND candidate_expires_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX human_authentication_link_expiry ON occ.human_authentication_links (expires_at);
--> statement-breakpoint
ALTER TABLE occ.human_authentication_attempts
  ADD COLUMN link_hash text REFERENCES occ.human_authentication_links(browser_hash) ON DELETE CASCADE,
  ADD COLUMN link_purpose text CHECK (link_purpose IN ('owner', 'candidate')),
  ADD CONSTRAINT human_authentication_attempt_link CHECK ((link_hash IS NULL) = (link_purpose IS NULL));
--> statement-breakpoint
REVOKE ALL ON occ.human_authentication_links FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.human_authentication_links TO occ_app;
--> statement-breakpoint
GRANT UPDATE (owner_user_id, owner_method_id, owner_principal_id, owner_version,
  owner_method_version, owner_expires_at, candidate_subject, candidate_expires_at)
  ON occ.human_authentication_links TO occ_app;
