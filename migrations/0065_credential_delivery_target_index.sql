-- A registered recipient includes its full admission policy. A hash exclusion
-- constraint stores a bounded index key and rechecks JSONB equality on conflicts.
ALTER TABLE occ.credential_deliveries
  DROP CONSTRAINT credential_deliveries_revision_id_target_key,
  ADD CONSTRAINT credential_deliveries_revision_id_target_key
    EXCLUDE USING hash ((JSON_OBJECT(revision_id VALUE target RETURNING jsonb)) WITH =);
