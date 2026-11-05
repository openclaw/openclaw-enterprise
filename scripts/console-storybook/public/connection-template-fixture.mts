import { fixtureError as error, fixtureResponse as response } from "./preview-rules.mts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createConnectionTemplateFixture(
  mode: string | undefined,
  createdAt: string,
  namespaceId: string,
  nextId: (prefix: string) => string,
) {
  const issuer = "https://identity.example.com";
  const templateId = "ctp_00000000-0000-4000-8000-000000000004";
  const oauthTemplates: Record<string, unknown>[] =
    mode === "ready"
      ? [
          {
            id: templateId,
            displayName: "Support MCP",
            namespaceId,
            createdAt,
            current: {
              templateId,
              version: 1,
              mode: "mcp_discovery",
              issuer,
              authorizationUrl: issuer + "/authorize",
              tokenUrl: issuer + "/token",
              scopes: ["messages.read"],
              authorizationParameters: {},
              destinations: [{ host: "mcp.example.com", port: 443, path: "/mcp" }],
              mcp: {
                serverUrl: "https://mcp.example.com/mcp",
                resource: "https://mcp.example.com/mcp",
              },
              observed: {
                issuer,
                issuers: [issuer],
                authorizationUrl: issuer + "/authorize",
                tokenUrl: issuer + "/token",
                requestedScopes: ["messages.read"],
                serverUrl: "https://mcp.example.com/mcp",
                resource: "https://mcp.example.com/mcp",
                tokenEndpointAuthMethods: ["none", "client_secret_basic"],
              },
              oauthClientId: "ccr_00000000-0000-4000-8000-000000000006",
              createdAt,
            },
          },
        ]
      : [];
  const googleTemplateId = "ctp_00000000-0000-4000-8000-000000000003";
  oauthTemplates.unshift({
    id: googleTemplateId,
    displayName: "Google OAuth",
    createdAt,
    current: {
      templateId: googleTemplateId,
      version: 1,
      mode: "manual",
      issuer: "https://accounts.google.com",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      scopes: [],
      authorizationParameters: { access_type: "offline", prompt: "consent" },
      destinations: [
        { host: "gmail.googleapis.com", port: 443, path: "/gmail/**" },
        { host: "www.googleapis.com", port: 443, path: "/calendar/**" },
        { host: "www.googleapis.com", port: 443, path: "/drive/**" },
      ],
      createdAt,
    },
  });
  const oauthClients: object[] =
    mode === "ready"
      ? [
          {
            id: "ccr_00000000-0000-4000-8000-000000000006",
            displayName: "Support service",
            namespaceId,
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
        const selected = oauthTemplates.find((t) => t.id === body.connectionTemplateId);
        const version = selected?.current;
        if (
          !selected ||
          !isRecord(version) ||
          version.version !== body.connectionTemplateVersion ||
          typeof version.version !== "number"
        ) {
          return error(409, "RESOURCE_STATE_CONFLICT", "Reload the selected connection template.");
        }
        const client = {
          id: nextId("ccr"),
          displayName: body.displayName,
          clientId: body.clientId,
          tokenEndpointAuthMethod: body.tokenEndpointAuthMethod,
          namespaceId: selected.namespaceId,
          issuer: version.issuer,
          tokenUrl: version.tokenUrl,
          revocationUrl: version.revocationUrl,
          createdAt,
        };
        if (!version.oauthClientId) {
          selected.current = { ...version, oauthClientId: client.id, version: version.version + 1 };
        }
        oauthClients.push(client);
        return response(client, 201);
      }
      if (path.startsWith("/connection-templates/") && method === "PATCH") {
        const template = oauthTemplates.find((item) => path === "/connection-templates/" + item.id);
        if (
          !template ||
          !isRecord(template.current) ||
          typeof template.current.version !== "number"
        ) {
          return error(404, "RESOURCE_NOT_FOUND", "Connection template unavailable.");
        }
        const { displayName, ...config } = body;
        template.displayName = displayName;
        template.current = {
          ...config,
          templateId: template.id,
          version: template.current.version + 1,
          createdAt,
        };
        return response(template);
      }
      if (path === "/connection-templates" && method === "POST") {
        const { displayName, namespaceId, ...config } = body;
        const id = nextId("ctp");
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
                destinations: [{ host: "mcp.example.com", port: 443, path: "/mcp" }],
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
