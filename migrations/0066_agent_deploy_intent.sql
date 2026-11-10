ALTER TABLE occ.agent_revisions
  ADD COLUMN first_deployment_digest text;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD CONSTRAINT agent_revisions_first_deployment_digest CHECK (
    first_deployment_digest IS NULL OR
    (revision_number = 1 AND first_deployment_digest ~ '^[a-f0-9]{64}$')
  );
