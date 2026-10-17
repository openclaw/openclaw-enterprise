-- A distinct repository-session family, never an upgrade of a metadata source.
ALTER TABLE occ.prepared_github_families DROP CONSTRAINT prepared_github_families_check,
ADD CONSTRAINT prepared_github_families_check CHECK ((source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'prepared' AND source #>> '{grant,profile}' = 'metadata-read'
   AND admission->>'familyId' = source_id AND jsonb_typeof(issuer->'backendRef') = 'object')
  OR
  (source->>'adoption' = 'prepared_repository_git' AND source_id = 'repository-git:' || (source #>> '{session,admissionId}')
   AND source #>> '{grant,profile}' = 'git-ref-write' AND source #>> '{grant,pushRef}' LIKE 'refs/heads/%'
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,repositoryId}' = source #>> '{session,grant,repositoryId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE);
--> statement-breakpoint

-- Existence is a possible credential disclosure, not a Git outcome. Reusing its exchange ID fails.
CREATE TABLE occ.prepared_repository_git_uses (
  exchange_id uuid PRIMARY KEY,
  admission_id text NOT NULL REFERENCES occ.repository_session_attempts(admission_id),
  attempt_id uuid NOT NULL REFERENCES occ.prepared_github_attempts(id),
  material_version uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('advertise-upload-pack','upload-pack','advertise-receive-pack','receive-pack')),
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  send_start_by timestamptz NOT NULL
);
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.prepared_repository_git_uses TO occ_app;
