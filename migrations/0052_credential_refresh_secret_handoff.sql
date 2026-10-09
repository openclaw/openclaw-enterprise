-- A ready refresh source releases bootstrap references once its Driver owns the material.
-- The referenced user-owned Secrets remain independently managed.
GRANT DELETE ON occ.credential_source_secrets TO occ_app;
