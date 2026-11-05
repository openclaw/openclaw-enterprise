import type { ConnectionTemplate, OAuthClient } from "./connection-templates.ts";

/** The Installation registrations used by the native Codex device flow. */
export const CODEX_HARNESS_TEMPLATE_ID = "ctp_f6597ac3-e4cc-477e-9403-6f3919fbc268";
export const CODEX_HARNESS_OAUTH_CLIENT_ID = "ccr_2214406d-8a56-46ff-ae8a-86ed41151cf6";
export const CODEX_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const codexDeviceAuthorization = {
  issuer: "https://auth.openai.com",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  pollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  tokenUrl: "https://auth.openai.com/oauth/token",
} as const;

export function builtInCodexConnection(createdAt: string): {
  client: OAuthClient;
  template: ConnectionTemplate;
} {
  const client: OAuthClient = {
    id: CODEX_HARNESS_OAUTH_CLIENT_ID,
    displayName: "Codex native client",
    issuer: codexDeviceAuthorization.issuer,
    tokenUrl: codexDeviceAuthorization.tokenUrl,
    clientId: CODEX_PUBLIC_CLIENT_ID,
    tokenEndpointAuthMethod: "none",
    createdAt,
  };
  return {
    client,
    template: {
      id: CODEX_HARNESS_TEMPLATE_ID,
      displayName: "ChatGPT for Codex",
      createdAt,
      current: {
        templateId: CODEX_HARNESS_TEMPLATE_ID,
        version: 1,
        mode: "manual",
        issuer: client.issuer,
        tokenUrl: client.tokenUrl,
        authorizationUrl: codexDeviceAuthorization.verificationUrl,
        oauthClientId: client.id,
        scopes: [],
        authorizationParameters: {},
        destinations: [
          { host: "api.openai.com", port: 443, path: "/v1/**" },
          { host: "chatgpt.com", port: 443, path: "/backend-api/**" },
        ],
        createdAt,
      },
    },
  };
}
