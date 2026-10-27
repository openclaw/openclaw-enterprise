-- Extend both existing custody checks without rewriting an admitted revision or receipt.
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((admitted_spec->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
        AND (
          (admitted_spec->'execution_admission'->>'mode' = 'unprotected'
            AND admitted_spec #> '{execution_admission,version}' = '2'::jsonb
            AND NOT (admitted_spec ? 'egress_plan')
            AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion'))
          OR (admitted_spec->'execution_admission'->>'mode' = 'protected'
            AND admitted_spec ? 'egress_plan'
            AND admitted_spec #> '{harness_auth,protectedExecutionVersion}'
              = admitted_spec #> '{execution_admission,version}'
            AND (
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7','8')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' IN ('7','8')
                  THEN (admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb OR
                    (admitted_spec #>> '{execution_admission,version}' = '8'
                     AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '3'::jsonb
                     AND admitted_spec #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                     AND jsonb_array_length(admitted_spec #> '{egress_plan,repositoryGit,bindings}') = 1
                     AND jsonb_array_length(admitted_spec #> '{egress_plan,routes}') > 0
                     AND NOT ((admitted_spec->'egress_plan') ? 'harnessCredentialSource')))
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7','8'))
                  = ((admitted_spec->'egress_plan') ? 'repositoryGit')
                AND (NOT ((admitted_spec->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(admitted_spec->'repository_credentials')='object'
                    AND admitted_spec #> '{egress_plan,repositoryGit}' = admitted_spec->'repository_credentials'))
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' IN ('5','8')
                    THEN admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    WHEN admitted_spec #>> '{execution_admission,version}' = '6' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'request-hook-observed'
                      AND admitted_spec #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                      AND jsonb_array_length(admitted_spec #> '{egress_plan,repositoryGit,bindings}') = 1
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
        ), false)) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
ALTER TABLE occ.credential_delivery_reductions DROP CONSTRAINT credential_delivery_reductions_policy_check;
--> statement-breakpoint
ALTER TABLE occ.credential_delivery_reductions ADD CONSTRAINT credential_delivery_reductions_policy_check CHECK (CASE WHEN policy_request IS NULL THEN
    recipient IS NOT NULL AND material_version IS NOT NULL AND retained_policy_hash IS NOT NULL AND policy_observed IS NULL
  ELSE COALESCE(
    recipient IS NULL AND material_version IS NULL AND retained_policy_hash IS NULL
    AND (policy_request->>'version' IN ('1','2') OR (
        policy_request->'version' = '3'::jsonb AND
        policy_request #>> '{condition,predecessorKeySha256}' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(policy_request #> '{condition,remainingPolicy}') = 'object'
        AND policy_request #> '{condition,remainingPolicy}' <> '{}'::jsonb
        AND jsonb_typeof(policy_request #> '{condition,grant}') = 'object'
        AND (policy_request #> '{condition,grant}') ?& ARRAY['id','generation','scope','recipient']
        AND (policy_request #>> '{condition,grant,generation}') ~ '^[1-9][0-9]*$'
        AND length(policy_request #>> '{condition,grant,id}') > 0
        AND length(policy_request #>> '{condition,grant,scope}') > 0
        AND length(policy_request #>> '{condition,grant,recipient}') > 0))
    AND policy_request->>'operationId' = request_id::text
    AND policy_request #>> '{expected,plan,execution,revisionId}' = revision_id
    AND policy_request #>> '{expected,plan,generation}' = expected_version
    AND jsonb_typeof(policy_request #> '{retained,routes}') = 'array'
    AND (policy_observed IS NULL OR (
      policy_observed->'plan' = policy_request->'retained'
      AND policy_observed #>> '{plan,generation}' = observed_generation)), false)
  END) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.credential_delivery_reductions VALIDATE CONSTRAINT credential_delivery_reductions_policy_check;
--> statement-breakpoint
-- Reserve each effect before dispatch. Only its original receipt may be added later.
CREATE TABLE occ.credential_policy_effects (
 revision_id text NOT NULL REFERENCES occ.agent_revisions(id) ON DELETE CASCADE,
 step text NOT NULL CHECK (step <> ''),
 request_id uuid NOT NULL,
 identity text NOT NULL CHECK (identity ~ '^[a-f0-9]{64}$'),
 expected_version text NOT NULL CHECK (expected_version <> ''),
 receipt text CHECK (receipt <> ''),
 PRIMARY KEY (revision_id,step)
);
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE(receipt) ON occ.credential_policy_effects TO occ_app;
