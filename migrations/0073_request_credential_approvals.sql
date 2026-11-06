-- Match the two authenticated requests without recording the outbound HTTP request or token.
CREATE TABLE occ.request_credential_approvals (
  recipient_id text NOT NULL,
  request_id text NOT NULL,
  binding_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  policy_digest text NOT NULL,
  driver_ref jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (recipient_id, request_id),
  CONSTRAINT request_credential_approval_revision FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE,
  CONSTRAINT request_credential_approval_digest CHECK (policy_digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX request_credential_approvals_expiry ON occ.request_credential_approvals(expires_at);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE, UPDATE (consumed) ON occ.request_credential_approvals TO occ_app;
