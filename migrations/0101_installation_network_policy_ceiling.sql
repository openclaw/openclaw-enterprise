CREATE TABLE occ.installation_network_policy_ceiling (
  installation_id text PRIMARY KEY REFERENCES occ.installation(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  version integer NOT NULL CONSTRAINT installation_ceiling_version CHECK (version > 0),
  rules jsonb NOT NULL CONSTRAINT installation_ceiling_rules CHECK (occ.sandbox_network_grants_are_valid(rules)),
  management_mode text NOT NULL CONSTRAINT installation_ceiling_mode CHECK (management_mode IN ('console', 'startup')),
  startup_configuration text,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON occ.installation_network_policy_ceiling FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON occ.installation_network_policy_ceiling TO occ_app;
