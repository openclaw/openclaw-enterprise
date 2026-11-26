LOCK TABLE occ.agents, occ.agent_revisions, occ.agent_provisioning_work IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.agents WHERE network_proxy_secret_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM occ.agent_revisions WHERE network_proxy_secret_id IS NOT NULL)
    OR EXISTS (
      SELECT 1 FROM occ.agent_provisioning_work
      WHERE status IN ('queued', 'running') AND (plan->'networkProxy') ? 'credentialSecretId'
    ) THEN
    RAISE EXCEPTION 'Legacy authenticated Network proxy selections require retirement before upgrade. Delete affected Agents and clear their outstanding provisioning work.';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents RENAME COLUMN network_proxy_secret_id TO network_proxy_credential_source_id;
ALTER TABLE occ.agents DROP CONSTRAINT agents_network_proxy_shape;
ALTER TABLE occ.agents ADD CONSTRAINT agents_network_proxy_shape CHECK (
  (network_proxy_url IS NULL AND network_proxy_credential_source_id IS NULL)
  OR (
    network_proxy_url IS NOT NULL
    AND length(network_proxy_url) <= 2048
    AND network_proxy_url ~ '^https?://[^/@[:space:]]+$'
    AND (network_proxy_credential_source_id IS NULL OR network_proxy_credential_source_id
      ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  )
);
--> statement-breakpoint
ALTER TABLE occ.agent_revisions RENAME COLUMN network_proxy_secret_id TO network_proxy_credential_source_id;
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_network_proxy_shape;
ALTER TABLE occ.agent_revisions
  ADD COLUMN network_proxy_token_service_instance_id uuid,
  ADD CONSTRAINT agent_revisions_network_proxy_shape CHECK (
    (network_proxy_url IS NULL AND network_proxy_credential_source_id IS NULL)
    OR (
      network_proxy_url IS NOT NULL
      AND length(network_proxy_url) <= 2048
      AND network_proxy_url ~ '^https?://[^/@[:space:]]+$'
      AND (network_proxy_credential_source_id IS NULL OR network_proxy_credential_source_id
        ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    )
  ),
  ADD CONSTRAINT agent_revisions_network_proxy_source_owner_shape CHECK (
    (network_proxy_credential_source_id IS NULL) = (network_proxy_token_service_instance_id IS NULL)
  );
