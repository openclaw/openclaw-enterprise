-- A distinct repository-session family, never an upgrade of a metadata source.
ALTER TABLE occ.prepared_github_families DROP CONSTRAINT prepared_github_families_check,
ADD CONSTRAINT prepared_github_families_check CHECK ((source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'prepared' AND source #>> '{grant,profile}' = 'metadata-read'
   AND admission->>'familyId' = source_id AND jsonb_typeof(issuer->'backendRef') = 'object')
  OR
  (source->>'adoption' = 'prepared_repository_git' AND source_id = 'repository-git:' || (source #>> '{session,admissionId}')
   AND ((source #>> '{grant,profile}' = 'git-ref-write' AND NOT (source->'grant' ? 'pullRequestBase'))
       OR (source #>> '{grant,profile}' = 'git-ref-draft-pr' AND length(source #>> '{grant,pullRequestBase}') > 0))
   AND source #>> '{grant,pushRef}' LIKE 'refs/heads/%'
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,repositoryId}' = source #>> '{session,grant,repositoryId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE);
--> statement-breakpoint

-- One admitted draft per explicitly selected grant (repository, review ref and base).
-- No expiry, retry, cascading deletion, or result from an untrusted caller.
CREATE TABLE occ.prepared_repository_draft_pulls (
  grant_id text PRIMARY KEY,
  operation_id uuid NOT NULL,
  receipt_id uuid NOT NULL UNIQUE,
  admission_id text NOT NULL REFERENCES occ.repository_session_attempts(admission_id),
  attempt_id uuid NOT NULL REFERENCES occ.prepared_github_attempts(id),
  material_version uuid NOT NULL,
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  scope jsonb NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  send_start_by timestamptz NOT NULL,
  settled_at timestamptz,
  outcome text NOT NULL DEFAULT 'outcome_unknown'
    CHECK (outcome IN ('created', 'not-submitted', 'outcome_unknown')),
  projection jsonb,
  CHECK ((outcome = 'created') = (projection IS NOT NULL)),
  CHECK (settled_at IS NOT NULL OR outcome = 'outcome_unknown')
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(outcome, projection, settled_at)
ON occ.prepared_repository_draft_pulls TO occ_app;
