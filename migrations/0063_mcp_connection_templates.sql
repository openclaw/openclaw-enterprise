-- An unqualified version retains its configured OAuth endpoints. An MCP version also
-- records the exact transport URL and the RFC 8707 resource approved at consent.
ALTER TABLE occ.connection_template_versions
  ADD COLUMN mcp_server_url text COLLATE "C",
  ADD COLUMN mcp_resource text COLLATE "C",
  ADD CONSTRAINT connection_template_versions_mcp_urls CHECK (
    (mcp_server_url IS NULL AND mcp_resource IS NULL)
    OR (
      mcp_server_url IS NOT NULL AND mcp_resource IS NOT NULL
      AND mcp_server_url ~ '^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$'
      AND mcp_resource ~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'
      AND length(mcp_server_url) <= 2048 AND length(mcp_resource) <= 2048
    )
  );
