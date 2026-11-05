import { fixtureError as error, fixtureResponse as response } from "./preview-rules.mts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createConnectionTemplateFixture(
  mode: string | undefined,
  createdAt: string,
  nextId: (prefix: string) => string,
) {
  const oauthTemplates: object[] = [];
  const oauthClients: object[] =
    mode === "ready"
      ? [
          {
            id: "ccr_00000000-0000-4000-8000-000000000006",
            displayName: "Support service",
            issuer: "https://identity.example.com",
            tokenUrl: "https://identity.example.com/token",
            clientId: "support-demo",
            tokenEndpointAuthMethod: "none",
            createdAt,
          },
        ]
      : [];
  return (path: string, method: string, body: unknown): Response | undefined => {
    if (path === "/connection-templates" && method === "GET") {
      return response(oauthTemplates);
    }
    if (path === "/oauth-clients" && method === "GET") {
      return response(oauthClients, 200, undefined, {
        redirectUri: "https://console.example.com/oauth/callback",
      });
    }
    if (mode && isRecord(body)) {
      const issuer = "https://identity.example.com";
      const observed = {
        serverUrl: "https://mcp.example.com/mcp",
        resource: "https://mcp.example.com/mcp",
        issuers: [issuer],
        issuer,
        authorizationUrl: `${issuer}/authorize`,
        tokenUrl: `${issuer}/token`,
        requestedScopes: ["messages.read"],
        supportedScopes: ["messages.read", "messages.write"],
        tokenEndpointAuthMethods: ["none", "client_secret_basic"],
      };
      if (path === "/connection-templates/discover" && method === "POST") {
        return mode === "error"
          ? error(400, "INVALID_REQUEST", "The MCP server did not return supported metadata.")
          : response(observed);
      }
      if (path === "/oauth-clients" && method === "POST") {
        const { clientSecret: _writeOnly, ...publicFields } = body;
        const client = { ...publicFields, id: nextId("ccr"), createdAt };
        oauthClients.push(client);
        return response(client, 201);
      }
      if (path === "/connection-templates" && method === "POST") {
        const { displayName, namespaceId, ...config } = body;
        const id = nextId("ct");
        const current = {
          ...config,
          templateId: id,
          version: 1,
          createdAt,
          ...(config.mode === "mcp_discovery"
            ? {
                issuer: observed.issuer,
                authorizationUrl: observed.authorizationUrl,
                tokenUrl: observed.tokenUrl,
                mcp: { serverUrl: observed.serverUrl, resource: observed.resource },
                recipient: { host: "mcp.example.com", port: 443, path: "/mcp" },
                observed,
              }
            : {}),
        };
        const template = { id, displayName, namespaceId, current, createdAt };
        oauthTemplates.push(template);
        return response(template, 201);
      }
    }
    return undefined;
  };
}
