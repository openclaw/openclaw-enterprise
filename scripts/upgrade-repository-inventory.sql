-- Observe the predecessor on its original database. None of these projections
-- authorize replacing a sender, even when the result contains no current work.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL client_encoding = 'UTF8';
SELECT NOT pg_is_in_recovery()
   AND current_user = session_user
   AND NOT EXISTS (
     SELECT FROM pg_roles
     WHERE (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
       AND pg_has_role(current_user, oid, 'MEMBER'))
   AND NOT pg_has_role(current_user,
     (SELECT relowner FROM pg_class WHERE oid = 'occ.installation'::regclass), 'MEMBER')
   AS ordinary_primary \gset
\if :ordinary_primary
\else
\echo ordinary-role-on-primary-required
ROLLBACK;
\quit
\endif
SELECT count(*) = 1 AND bool_and(id = :'installation') AS matches FROM occ.installation \gset
\if :matches
\else
\echo installation-mismatch
ROLLBACK;
\quit
\endif

-- Each line is one record. The original Agent or revision can already be gone.
SELECT json_build_object('record','snapshot','installationId',id,'observedAt',transaction_timestamp())
FROM occ.installation;

-- Record the live Agent and its selected revision together. Draft bindings
-- and an admitted revision's bindings can differ and must stay distinguishable.
SELECT json_build_object('record','agent','namespaceId',a.namespace_id,'agentId',a.id,
    'status',a.status,'desiredRuntimeState',a.desired_runtime_state,'executionMode',a.execution_mode,
    'revisionId',a.active_revision_id,'workspaceSetupId',w.id,'workspaceSetupCompleted',w.completed,
    'draftBindings',coalesce((SELECT json_agg(json_build_object(
      'repositoryRef',b->>'repositoryRef','profile',b->>'profile'))
      FROM jsonb_array_elements(a.repository_bindings) AS b),'[]'::json),
    'revisionBindings',coalesce((SELECT json_agg(json_build_object(
      'repositoryRef',b->>'repositoryRef','profile',b->>'profile','backendId',b->>'backendId'))
      FROM jsonb_array_elements(r.admitted_spec #> '{repository_credentials,bindings}') AS b),'[]'::json),
    'approvalId',r.admitted_spec #>> '{repository_credentials,standingApprovalId}',
    'approvalGeneration',r.admitted_spec #>> '{repository_credentials,standingApprovalGeneration}',
    'approvalFingerprint',r.admitted_spec #>> '{repository_credentials,standingApprovalScopeFingerprint}',
    'deadlineWallMs',r.admitted_spec #>> '{repository_credentials,deadlineWallMs}')
FROM occ.agents a
LEFT JOIN occ.agent_revisions r ON (r.namespace_id,r.agent_id,r.id)=(a.namespace_id,a.id,a.active_revision_id)
LEFT JOIN occ.workspace_setups w ON (w.namespace_id,w.agent_id)=(a.namespace_id,a.id);

SELECT json_build_object('record','approval','namespaceId',namespace_id,'agentId',agent_id,
    'repositoryRef',repository_ref,'approvalId',id,'generation',generation,
    'scopeFingerprint',scope_fingerprint,'revokedAt',revoked_at)
FROM occ.repository_standing_approvals;

SELECT json_build_object('record','execution','namespaceId',namespace_id,'agentId',agent_id,
    'revisionId',revision_id,'approvalId',approval_id,'generation',approval_generation,
    'fingerprint',fingerprint,'closed',closed)
FROM occ.repository_standing_executions;

SELECT json_build_object('record','session','namespaceId',s.namespace_id,'agentId',s.agent_id,
    'revisionId',s.revision_id,'detached',s.live_revision_id IS NULL,
    'repositoryRef',s.repository_ref,'admissionId',s.admission_id,'protocol',s.broker_protocol,
    'phase',s.phase,'deadlineWallMs',s.deadline_wall_ms,'driverId',s.cleanup_context #>> '{driver,id}',
    'implementation',s.cleanup_context #>> '{driver,implementation}',
    'backendId',s.cleanup_context #>> '{binding,backendId}',
    'grantId',s.cleanup_context #>> '{binding,grant,grantId}','brokerReceipt',b.state)
FROM occ.repository_session_attempts s LEFT JOIN occ.repository_broker_receipts b USING (admission_id);

SELECT json_build_object('record','prepared','namespaceId',f.source #>> '{session,namespaceId}',
    'agentId',f.source #>> '{session,agentId}','revisionId',f.source #>> '{session,revisionId}',
    'admissionId',f.source #>> '{session,admissionId}','adoption',f.source->>'adoption',
    'repositoryRef',f.source #>> '{session,binding,repositoryRef}',
    'issuerKind',f.issuer->>'kind','grantId',f.source #>> '{grant,id}',
    'senderId',f.source #>> '{session,credentialProxyExecution,sender,id}',
    'executionId',f.source #>> '{session,credentialProxyExecution,executionId}',
    'sandboxId',f.source #>> '{session,credentialProxyExecution,sandboxId}',
    'enabled',f.enabled,'attemptId',a.id,'state',a.state,'custody',a.custody,
    'startedAt',a.started_at,'providerExpiresAt',a.provider_expires_at)
FROM occ.prepared_github_families f LEFT JOIN occ.prepared_github_attempts a USING (source_id)
WHERE f.source_id LIKE 'repository-git:%';

SELECT json_build_object('record','delivery','namespaceId',namespace_id,'agentId',agent_id,
    'revisionId',revision_id,'bindingId',binding_id,'detached',live_revision_id IS NULL,
    'transport',target->>'transport','senderId',target #>> '{installation,sender,id}',
    'sandboxId',coalesce(target #>> '{installation,sandboxId}',target->>'sandbox'),
    'settlement',settlement,'operationFence',operation_fence,'writePending',write_pending,'blocked',blocked IS NOT NULL,
    'attemptId',preparation_attempt_id,'targetAttemptId',target_preparation_attempt_id)
FROM occ.credential_deliveries;

SELECT json_build_object('record','reduction','revisionId',revision_id,'bindingId',binding_id,
    'requestId',request_id,'observed',observed_generation IS NOT NULL)
FROM occ.credential_delivery_reductions;

SELECT json_build_object('record','git-use','admissionId',admission_id,'attemptId',attempt_id,
    'exchangeId',exchange_id,'operation',operation,'sendStartBy',send_start_by,
    'authorizationReplyBy',authorization_reply_by)
FROM occ.prepared_repository_git_uses;

SELECT json_build_object('record','draft-pull','admissionId',admission_id,'attemptId',attempt_id,
    'operationId',operation_id,'receiptId',receipt_id,'outcome',outcome,'settledAt',settled_at)
FROM occ.prepared_repository_draft_pulls;

SELECT json_build_object('record','withdrawal','namespaceId',namespace_id,'agentId',agent_id,
    'revisionId',revision_id,'credentialSourceId',credential_source_id,'state',state)
FROM occ.credential_withdrawals WHERE completed_at IS NULL;

SELECT json_build_object('record','work','namespaceId',w.namespace_id,'agentId',coalesce(w.agent_id,p.agent_id),
    'revisionId',coalesce(w.revision_id,p.revision_id),'key',w.idempotency_key,
    'kind',w.work_kind,'state',w.state,'provisioningPhase',p.completed_phase,
    'agentTarget',w.agent_target,'namespaceTarget',w.namespace_target)
FROM occ.controller_work w LEFT JOIN occ.agent_provisioning_work p ON p.work_id=w.idempotency_key
WHERE w.state <> 'succeeded';
COMMIT;
\echo inventory-complete
