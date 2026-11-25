DROP TRIGGER service_accounts_issued_source_guard ON occ.service_accounts;
--> statement-breakpoint
ALTER TABLE occ.service_accounts ALTER COLUMN credential_source_id DROP EXPRESSION;
--> statement-breakpoint
ALTER TABLE occ.service_accounts DROP COLUMN credential;
--> statement-breakpoint
GRANT UPDATE (credential_source_id) ON occ.service_accounts TO occ_app;
--> statement-breakpoint
CREATE TRIGGER service_accounts_issued_source_guard AFTER INSERT OR UPDATE OF credential_source_id
  ON occ.service_accounts FOR EACH ROW EXECUTE FUNCTION occ.guard_service_account_credential_source();
