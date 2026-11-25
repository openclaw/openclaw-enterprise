CREATE TABLE occ.gateway_runtime_audit_replay_verifiers (
  replay_verifier text PRIMARY KEY CHECK (replay_verifier ~ '^[A-Za-z0-9_-]{43}$'),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  runtime_source text NOT NULL CHECK (runtime_source IN ('openclaw', 'codex')),
  endpoint text NOT NULL CHECK (octet_length(endpoint) <= 2048 AND endpoint ~ '^https://[^/?#@[:space:]]+/internal/runtime-audit$'),
  CONSTRAINT gateway_runtime_audit_replay_verifiers_revision_owner FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER gateway_runtime_audit_replay_verifiers_are_immutable
BEFORE UPDATE ON occ.gateway_runtime_audit_replay_verifiers FOR EACH ROW
EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.gateway_runtime_audit_replay_verifiers FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.gateway_runtime_audit_replay_verifiers TO occ_app;
--> statement-breakpoint
-- The immutable row can be locked through COMMIT without permitting changes.
GRANT UPDATE (runtime_source) ON occ.gateway_runtime_audit_replay_verifiers TO occ_app;
