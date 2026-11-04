CREATE TABLE occ.namespace_agent_operator_profiles (
  namespace_id text PRIMARY KEY REFERENCES occ.namespaces (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  generation uuid NOT NULL,
  status text NOT NULL,
  group_id text,
  CONSTRAINT namespace_agent_operator_profiles_status_check CHECK (
    (status = 'staged' AND group_id IS NOT NULL) OR (status = 'withdrawn' AND group_id IS NULL)
  ),
  CONSTRAINT namespace_agent_operator_profiles_group_fk FOREIGN KEY (namespace_id, group_id)
    REFERENCES occ.iam_groups (namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE occ.namespace_agent_operator_profiles TO occ_app;
--> statement-breakpoint
GRANT UPDATE (generation, status, group_id)
ON TABLE occ.namespace_agent_operator_profiles TO occ_app;
