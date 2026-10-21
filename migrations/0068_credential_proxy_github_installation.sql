-- No existing family, recipient, grant, possible use, or custody obligation changes scope.
-- One family per admission across both profiles; older workers do not adopt installation custody.
ALTER TABLE occ.prepared_github_families
  DROP CONSTRAINT prepared_github_families_check,
  ADD CONSTRAINT prepared_github_families_check CHECK ((source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'prepared' AND source #>> '{grant,profile}' = 'metadata-read'
   AND admission->>'familyId' = source_id AND jsonb_typeof(issuer->'backendRef') = 'object')
  OR
  (
   (((source->>'adoption' = 'prepared_repository_git' OR (
       source->>'adoption' = 'credential_proxy_repository_git'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'))
   AND ((source #>> '{grant,profile}' = 'git-ref-write' AND NOT (source->'grant' ? 'pullRequestBase'))
       OR (source #>> '{grant,profile}' = 'git-ref-draft-pr' AND length(source #>> '{grant,pullRequestBase}') > 0))
   AND source #>> '{grant,pushRef}' LIKE 'refs/heads/%'
   AND source #>> '{grant,repositoryId}' = source #>> '{session,grant,repositoryId}')
   OR (source->>'adoption' = 'credential_proxy_github_installation'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'
       AND source #>> '{session,credentialProxyExecution,enforcement,repositoryGitRecipient,deliveryProfile}' = 'github_installation'
       AND source #>> '{session,binding,profile}' = 'github-installation'
       AND source #>> '{grant,profile}' = 'github-installation'
       AND (source->'grant') - ARRAY['id','isolationId','appId','installationId','profile'] = '{}'::jsonb
       AND source #>> '{grant,appId}' ~ '^[1-9][0-9]*$'
       AND source #>> '{grant,installationId}' ~ '^[1-9][0-9]*$'
       AND source #>> '{session,grant,repositoryId}' = 'github-installation:' || (source #>> '{grant,installationId}'))
   )
   AND source_id = 'repository-git:' || (source #>> '{session,admissionId}')
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.prepared_github_families VALIDATE CONSTRAINT prepared_github_families_check;
--> statement-breakpoint
-- Installation uses bind the observed recipient fence as well as admission, exact material,
-- exchange, operation, digest and original send deadline. Existing readers keep their narrow wire.
ALTER TABLE occ.prepared_repository_git_uses
  ADD COLUMN recipient_fence bigint,
  DROP CONSTRAINT prepared_repository_git_uses_operation_check,
  ADD CONSTRAINT prepared_repository_git_uses_operation_check CHECK (
      (operation IN ('advertise-upload-pack','upload-pack','advertise-receive-pack','receive-pack')
        OR (recipient_fence IS NULL AND operation = 'create-draft-pull')
        OR (recipient_fence IS NOT NULL AND operation IN ('github-rest','github-graphql')))
      AND (recipient_fence IS NULL OR recipient_fence > 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.prepared_repository_git_uses VALIDATE CONSTRAINT prepared_repository_git_uses_operation_check;
