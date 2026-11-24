CREATE TABLE occ.human_authentication_results (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  attempt_id text NOT NULL CONSTRAINT human_authentication_result_attempt CHECK (attempt_id ~ '^[A-Za-z0-9_-]{43}$'),
  session_id text NOT NULL REFERENCES occ.human_authentication_sessions(session_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  provider_id text NOT NULL CONSTRAINT human_authentication_result_provider CHECK (char_length(provider_id) BETWEEN 1 AND 200 AND provider_id <> 'credential'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, attempt_id)
);
--> statement-breakpoint
CREATE INDEX human_authentication_result_expiry ON occ.human_authentication_results (installation_id, expires_at);
--> statement-breakpoint
REVOKE ALL ON occ.human_authentication_results FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.human_authentication_results TO occ_app;
