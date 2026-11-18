-- Leave legacy rows unchanged. Older binaries must refuse the new owner kind.
ALTER TABLE occ.credential_sources
  ADD COLUMN credential_gateway_owner_id text,
  DROP CONSTRAINT credential_sources_owner_capability_valid,
  ADD CONSTRAINT credential_sources_owner_capability_valid CHECK (
    (driver_id IS NOT NULL AND (owner_capability IN ('credential_gateway', 'packaged_credential_gateway') OR
      (owner_capability = 'credential_proxy' AND egress IS NOT NULL))) OR
    (owner_capability = 'token_service' AND driver_id IS NULL AND type = 'oauth2-refresh-token' AND egress IS NULL)
  ),
  ADD CONSTRAINT credential_sources_gateway_owner_valid CHECK (
    CASE WHEN owner_capability = 'packaged_credential_gateway' THEN
      credential_gateway_owner_id IS NOT NULL AND credential_gateway_owner_id ~ '^[a-f0-9]{64}$'
    ELSE credential_gateway_owner_id IS NULL END
  );
--> statement-breakpoint
CREATE TRIGGER credential_source_gateway_owner_is_immutable
BEFORE UPDATE OF credential_gateway_owner_id ON occ.credential_sources
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
