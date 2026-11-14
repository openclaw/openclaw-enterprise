-- Keep the data check valid until the installation column and migration receipt commit.
LOCK TABLE occ.agents, occ.sandbox_policies, occ.controller_work,
  occ.agent_revisions, occ.egress_installations IN SHARE MODE;
--> statement-breakpoint
DO $check_download_upgrade$
DECLARE affected record;
BEGIN
  WITH edits AS (
    SELECT p.namespace_id, p.agent_id, a.active_revision_id, a.status, a.desired_runtime_state,
      CASE WHEN p.document#>>'{applied,kind}' = 'protected_downloads' THEN p.document->'applied' END AS receipt,
      CASE WHEN p.document#>>'{application,kind}' = 'protected_downloads'
             AND (p.document#>>'{application,state}' = 'pending'
               OR (p.document#>>'{application,state}' = 'failed' AND p.document#>>'{application,writeState}' = 'dispatched'))
           THEN p.document->'application' END AS unsettled
    FROM occ.sandbox_policies p JOIN occ.agents a ON (a.namespace_id, a.id) = (p.namespace_id, p.agent_id)
    WHERE p.document#>>'{applied,kind}' = 'protected_downloads'
       OR p.document#>>'{application,kind}' = 'protected_downloads'
  ), incompatible AS (
    -- An outstanding edit against a confirmed predecessor keeps its own operation ID even after retirement.
    SELECT namespace_id, agent_id, unsettled->>'revisionId' AS revision_id, unsettled->>'id' AS operation_id
    FROM edits p WHERE unsettled->'revisionId' = receipt->'revisionId'
      OR (unsettled->>'writeState' = 'dispatched' AND NOT EXISTS (
        -- Only the current model-only operation can publish its first confirmation from the original launch.
        SELECT FROM occ.agent_revisions v
        JOIN occ.egress_installations e ON (e.namespace_id,e.agent_id,e.revision_id) = (v.namespace_id,v.agent_id,v.id)
        JOIN occ.controller_work w ON (w.namespace_id,w.agent_id) = (v.namespace_id,v.agent_id)
        WHERE (v.namespace_id,v.agent_id,v.id) = (p.namespace_id,p.agent_id,unsettled->>'revisionId')
          AND v.id = p.active_revision_id AND p.status = 'active' AND p.desired_runtime_state = 'running'
          AND v.admitted_spec->'execution_admission' = '{"mode":"protected","version":3}'::jsonb
          AND NOT ((v.admitted_spec->'egress_plan') ?| ARRAY['repositoryGit','policyReductionVersion'])
          AND e.installation->'plan' = v.admitted_spec->'egress_plan'
          AND e.sandbox_id = unsettled#>>'{expected,sandboxId}'
          AND e.installation#>>'{enforcement,authorityScope}' = 'execution'
          AND e.installation#>'{enforcement,instanceId}' = unsettled#>'{expected,instanceId}'
          AND e.installation#>'{enforcement,peerKeyId}' = unsettled#>'{expected,peer,keyId}'
          AND e.installation#>'{enforcement,configurationId}' = unsettled#>'{expected,configurationId}'
          AND e.installation#>'{enforcement,policyHash}' = unsettled#>'{expected,effectivePolicyHash}'
          AND e.installation#>'{plan,generation}' = unsettled#>'{expected,policyVersion}'
          AND unsettled->'previousDownloadDestinations' = '[]'::jsonb
          AND w.idempotency_key = 'agent:' || p.agent_id || ':reconcile:sandbox_policy:' || (unsettled->>'id')
          AND w.actor_id = unsettled->>'requestedBy' AND w.agent_target = 'sandbox_policy'
          AND ((unsettled->>'state' = 'pending' AND w.state IN ('queued','claimed'))
            OR (unsettled->>'state' = 'failed' AND w.state = 'failed_permanent'))
      ))
    UNION ALL
    -- A confirmed serving revision has no published successor installation. A follow-on is reported above.
    SELECT namespace_id, agent_id, receipt->>'revisionId', receipt->>'operationId'
    FROM edits WHERE active_revision_id = receipt->>'revisionId'
      AND unsettled->'revisionId' IS DISTINCT FROM receipt->'revisionId'
    UNION ALL
    SELECT namespace_id, agent_id, protected_download_recovery->>'revisionId', protected_download_recovery->>'operationId'
    FROM occ.controller_work
    -- Even a first dispatch may have advanced the superseded Sandbox past launch.
    WHERE protected_download_recovery IS NOT NULL
  )
  SELECT * INTO affected FROM incompatible LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0081', MESSAGE = format(
      'A protected download edit needs its previous controller: %s. Settle the original operation, retire its revision, then rerun --check',
      row_to_json(affected));
  END IF;
END $check_download_upgrade$;
--> statement-breakpoint
ALTER TABLE occ.egress_installations ADD COLUMN download_installation jsonb;
--> statement-breakpoint
ALTER TABLE occ.egress_installations ADD CONSTRAINT egress_installations_download_identity CHECK (
  download_installation IS NULL OR (
    installation->'plan'->'repositoryGit' IS NULL
    AND download_installation - ARRAY['enforcement','downloadPolicyVersion'] = installation - 'enforcement'
    AND (download_installation->'enforcement') - ARRAY['configurationId','policyHash'] =
        (installation->'enforcement') - ARRAY['configurationId','policyHash']
    AND jsonb_typeof(download_installation->'downloadPolicyVersion') = 'number'
    AND (download_installation->>'downloadPolicyVersion')::bigint BETWEEN 1 AND 4294967295
    AND length(download_installation#>>'{enforcement,configurationId}') > 0
    AND download_installation#>>'{enforcement,policyHash}' ~ '^[a-f0-9]{64}$'
  ) IS TRUE
);
--> statement-breakpoint
GRANT UPDATE(download_installation) ON occ.egress_installations TO occ_app;
