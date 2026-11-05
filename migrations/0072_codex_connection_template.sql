-- The native Codex public client uses the provider's device flow and callback.
-- An administrator may already have registered this public client for another template.
-- Its saved endpoint and credentials stay distinct from the provider-owned native registration.
ALTER TABLE occ.oauth_clients DROP CONSTRAINT oauth_clients_pair_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_clients_pair_unique
  ON occ.oauth_clients (coalesce(namespace_id, ''), issuer, client_id)
  WHERE id <> 'ccr_2214406d-8a56-46ff-ae8a-86ed41151cf6';
--> statement-breakpoint
INSERT INTO occ.oauth_clients (id, display_name, issuer, token_url, client_id,
  token_endpoint_auth_method, created_at)
VALUES ('ccr_2214406d-8a56-46ff-ae8a-86ed41151cf6', 'Codex native client',
  'https://auth.openai.com', 'https://auth.openai.com/oauth/token',
  'app_EMoamEEZ73f0CkXaXp7hrann', 'none', now());

--> statement-breakpoint
WITH template AS (
  INSERT INTO occ.connection_templates (id, display_name, current_version, created_at)
  VALUES ('ctp_f6597ac3-e4cc-477e-9403-6f3919fbc268', 'ChatGPT for Codex', 1, now())
  RETURNING id, created_at
)
INSERT INTO occ.oauth_connection_template_versions (template_id, version, oauth_client_id,
  issuer, mode, authorization_url, token_url, scopes, authorization_parameters, destinations, created_at)
SELECT id, 1, 'ccr_2214406d-8a56-46ff-ae8a-86ed41151cf6',
  'https://auth.openai.com', 'manual', 'https://auth.openai.com/codex/device',
  'https://auth.openai.com/oauth/token', '{}', '{}',
  '[{"host":"api.openai.com","port":443,"path":"/v1/**"},{"host":"chatgpt.com","port":443,"path":"/backend-api/**"}]',
  created_at FROM template;
