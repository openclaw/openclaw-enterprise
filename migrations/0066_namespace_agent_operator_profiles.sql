CREATE TABLE occ.namespace_agent_operator_profiles (
  namespace_id text PRIMARY KEY REFERENCES occ.namespaces (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  generation uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('staged', 'withdrawn')),
  provider_id text NOT NULL CHECK (provider_id ~ '^github:[0-9a-f]{64}$'),
  organization_id text NOT NULL CHECK (organization_id ~ '^[1-9][0-9]{0,19}$'),
  team_id text NOT NULL CHECK (team_id ~ '^[1-9][0-9]{0,19}$')
);
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE occ.namespace_agent_operator_profiles TO occ_app;
--> statement-breakpoint
GRANT UPDATE (generation, status, provider_id, organization_id, team_id)
ON TABLE occ.namespace_agent_operator_profiles TO occ_app;
