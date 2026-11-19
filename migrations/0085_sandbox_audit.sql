-- A Sandbox can report decisions only while its revision is enrolled for audit.
CREATE TABLE occ.sandbox_runtime_audit_bindings (
  sandbox_id uuid PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  CONSTRAINT sandbox_runtime_audit_bindings_revision_unique UNIQUE (namespace_id, agent_id, revision_id),
  CONSTRAINT sandbox_runtime_audit_bindings_revision_owner FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.gateway_runtime_audit_grants(namespace_id, agent_id, revision_id) ON DELETE CASCADE ON UPDATE RESTRICT
);
--> statement-breakpoint
REVOKE ALL ON occ.sandbox_runtime_audit_bindings FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (sandbox_id), DELETE ON occ.sandbox_runtime_audit_bindings TO occ_app;
