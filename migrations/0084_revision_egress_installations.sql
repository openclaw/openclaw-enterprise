ALTER TABLE occ.egress_installations ADD COLUMN retired boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE occ.egress_installations DROP CONSTRAINT egress_installations_pkey;
ALTER TABLE occ.egress_installations ADD PRIMARY KEY (sender_id, sandbox_id, revision_id);
--> statement-breakpoint
CREATE UNIQUE INDEX egress_installations_current_sandbox
  ON occ.egress_installations (sender_id, sandbox_id) WHERE NOT retired;
--> statement-breakpoint
GRANT UPDATE(retired) ON occ.egress_installations TO occ_app;
