ALTER TABLE occ.agents
  ADD COLUMN network_proxy_url text,
  ADD COLUMN network_proxy_secret_id text,
  ADD CONSTRAINT agents_network_proxy_shape CHECK (
    (network_proxy_url IS NULL AND network_proxy_secret_id IS NULL)
    OR (
      network_proxy_url IS NOT NULL
      AND length(network_proxy_url) <= 2048
      AND network_proxy_url ~ '^https?://[^/@[:space:]]+$'
      AND (network_proxy_secret_id IS NULL OR network_proxy_secret_id <> '')
    )
  );
--> statement-breakpoint
GRANT UPDATE (network_proxy_url, network_proxy_secret_id) ON occ.agents TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD COLUMN network_proxy_url text,
  ADD COLUMN network_proxy_secret_id text,
  ADD CONSTRAINT agent_revisions_network_proxy_shape CHECK (
    (network_proxy_url IS NULL AND network_proxy_secret_id IS NULL)
    OR (
      network_proxy_url IS NOT NULL
      AND length(network_proxy_url) <= 2048
      AND network_proxy_url ~ '^https?://[^/@[:space:]]+$'
      AND (network_proxy_secret_id IS NULL OR network_proxy_secret_id <> '')
    )
  );
