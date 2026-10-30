ALTER TABLE occ.connection_template_versions
  ADD COLUMN revocation_url text COLLATE "C",
  ADD CONSTRAINT connection_template_versions_revocation_url_https CHECK (
    revocation_url ~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'
    AND length(revocation_url) <= 2048
  );
