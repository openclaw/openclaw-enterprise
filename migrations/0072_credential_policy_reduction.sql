-- Generic policy reductions belong to their existing source withdrawal, separate
-- from the protected Git registered-installation and delivery witnesses.
ALTER TABLE occ.credential_withdrawals ADD COLUMN policy_reduction jsonb,
  ADD CONSTRAINT credential_withdrawals_policy_reduction CHECK (policy_reduction IS NULL OR COALESCE(
    jsonb_typeof(policy_reduction) = 'object'
    AND policy_reduction->'request'->>'version' = '1'
    AND policy_reduction->'request'->>'operationId' ~ '^[0-9a-f-]{36}$'
    AND policy_reduction #>> '{request,expected,plan,execution,namespaceId}' = namespace_id
    AND policy_reduction #>> '{request,expected,plan,execution,revisionId}' = revision_id
    AND jsonb_typeof(policy_reduction #> '{request,retained,routes}') = 'array', false));
--> statement-breakpoint
GRANT UPDATE(policy_reduction) ON occ.credential_withdrawals TO occ_app;
