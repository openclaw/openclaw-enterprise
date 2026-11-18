-- A separately scoped pull API family uses the same admitted session as native Git.
ALTER TABLE occ.prepared_github_families DROP CONSTRAINT prepared_github_families_check;
--> statement-breakpoint
ALTER TABLE occ.prepared_github_families ADD CONSTRAINT prepared_github_families_check CHECK ((source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'credential_proxy_shared_github_repository'
   AND source_id ~ '^repository-git-shared:[a-f0-9]{64}$'
   AND NOT (source ? 'session')
   AND source #>> '{enrollment,issuerId}' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(source #> '{enrollment,driver}') = 'object'
   AND length(source #>> '{enrollment,installationId}') > 0
   AND length(source #>> '{enrollment,namespaceId}') > 0
   AND length(source #>> '{enrollment,repositoryBackendId}') > 0
   AND length(source #>> '{enrollment,providerInstanceId}') > 0
   AND source #>> '{issuance,schemaVersion}' = '1'
   AND source #>> '{issuance,kind}' = 'selected'
   AND source #>> '{issuance,appId}' = source #>> '{grant,appId}'
   AND source #>> '{issuance,installationId}' = source #>> '{grant,installationId}'
   AND source #> '{issuance,permissions}' = source #> '{grant,permissions}'
   AND source #>> '{grant,profile}' = 'github-repository'
   AND source #>> '{grant,id}' = source_id
   AND source #>> '{grant,isolationId}' = source #>> '{enrollment,namespaceId}'
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
  OR
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
   OR (source->>'adoption' = 'credential_proxy_github_repository'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'
       AND source #>> '{session,credentialProxyExecution,enforcement,repositoryGitRecipient,deliveryProfile}' = 'github_repository'
       AND source #>> '{session,binding,profile}' = 'github-repository'
       AND source #>> '{grant,profile}' = 'github-repository'
       AND jsonb_typeof(source #> '{grant,repositories}') = 'array'
       AND jsonb_array_length(source #> '{grant,repositories}') BETWEEN 1 AND 16
       AND jsonb_typeof(source #> '{grant,permissions}') = 'object'
       AND source #>> '{grant,permissions,metadata}' = 'read'
       AND jsonb_typeof(source #> '{session,bindings}') = 'array'
       AND jsonb_array_length(source #> '{session,bindings}') = jsonb_array_length(source #> '{grant,repositories}')
       AND NOT jsonb_path_exists(source, '$.session.bindings[*] ? (@.profile != "github-repository")')
       AND jsonb_path_query_array(source, '$.session.bindings[*].grant.repositoryId') @> jsonb_path_query_array(source, '$.grant.repositories[*].repositoryId')
       AND jsonb_path_query_array(source, '$.grant.repositories[*].repositoryId') @> jsonb_path_query_array(source, '$.session.bindings[*].grant.repositoryId')
       AND source #>> '{grant,appId}' ~ '^[1-9][0-9]*$'
       AND source #>> '{grant,installationId}' ~ '^[1-9][0-9]*$')
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
   AND (
     source_id = 'repository-git:' || (source #>> '{session,admissionId}')
     OR (source_id = 'repository-git:' || (source #>> '{session,admissionId}') || ':pull-api'
         AND source->>'adoption' = 'credential_proxy_github_repository'
         AND jsonb_array_length(source #> '{grant,repositories}') = 1
         AND source #> '{grant,permissions}' = '{"metadata":"read","pull_requests":"write"}'::jsonb
         AND source #> '{session,binding}' = source #> '{session,bindings,0}'
         AND source #> '{session,grant}' = source #> '{session,binding,grant}'
         AND jsonb_typeof(source #> '{grant,repositories,0,repositoryId}') = 'string'
         AND source #>> '{grant,repositories,0,repositoryId}' ~ '^[1-9][0-9]{0,15}$'
         AND jsonb_typeof(source #> '{grant,repositories,0,repository}') = 'string'
         AND source #>> '{grant,repositories,0,repository}' ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
   )
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE);
