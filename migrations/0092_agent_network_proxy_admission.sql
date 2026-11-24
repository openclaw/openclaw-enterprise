ALTER TABLE occ.agent_revisions
  ADD COLUMN network_proxy_admission text,
  ADD CONSTRAINT agent_revisions_network_proxy_admission_shape CHECK (
    (network_proxy_url IS NULL AND network_proxy_admission IS NULL)
    OR (
      network_proxy_url IS NOT NULL
      AND network_proxy_admission IS NOT NULL
      AND length(network_proxy_admission) BETWEEN 1 AND 8192
    )
  );
