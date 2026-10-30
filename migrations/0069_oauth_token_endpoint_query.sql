-- RFC 6749 section 3.2 permits a query on the token endpoint and forbids a fragment.
ALTER TABLE occ.connection_template_versions
  DROP CONSTRAINT connection_template_versions_urls_https,
  ADD CONSTRAINT connection_template_versions_urls_https CHECK (
    authorization_url ~ '^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$'
    AND token_url ~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'
    AND length(authorization_url) <= 2048 AND length(token_url) <= 2048
  );
