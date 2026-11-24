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
  const populated = mode === "ready" || mode === "plugin-consent";
  const templateId = "ctp_00000000-0000-4000-8000-000000000004";
  const templates: Record<string, unknown>[] = populated
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
            scopes: mode === "plugin-consent" ? [] : ["messages.read"],
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
              ...(mode === "plugin-consent" && {
                supportedScopes: ["messages.read", "messages.write"],
              }),
              serverUrl: "https://mcp.example.com/mcp",
              resource: "https://mcp.example.com/mcp",
              tokenEndpointAuthMethods: ["none", "client_secret_basic"],
            },
            createdAt,
          },
        },
        {
          id: "ctp_00000000-0000-4000-8000-000000000005",
          displayName: "Reporting API",
          createdAt,
          current: {
            templateId: "ctp_00000000-0000-4000-8000-000000000005",
            version: 1,
            mode: "static_bearer",
            destinations: [
              { host: "reports.example.com", port: 443, path: "/reports/**", method: "GET" },
            ],
            createdAt,
          },
        },
      ]
    : [];
  const googleTemplateId = "ctp_00000000-0000-4000-8000-000000000003";
  templates.unshift({
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
  const oauthClients: Record<string, unknown>[] = populated
    ? [
        {
          kind: "oauth2",
          id: "ccr_00000000-0000-4000-8000-000000000006",
          displayName: "Support service",
          namespaceId,
          issuer: "https://identity.example.com",
          tokenUrl: "https://identity.example.com/token",
          clientId: "support-demo",
          tokenEndpointAuthMethod: "none",
          createdAt,
        },
        {
          kind: "oauth2",
          id: "ccr_00000000-0000-4000-8000-000000000007",
          displayName: "Customer operations reporting",
          issuer: "https://identity.example.com/organizations/customer-operations",
          tokenUrl: "https://identity.example.com/organizations/customer-operations/token",
          clientId: "customer-reporting-demo",
          tokenEndpointAuthMethod: "client_secret_basic",
          createdAt,
        },
        {
          kind: "github-app",
          id: "ccr_00000000-0000-4000-8000-000000000008",
          displayName: "Repository automation",
          appId: "12345",
          createdAt,
        },
      ]
    : [];
  return (
    path: string,
    method: string,
    body: unknown,
    query?: URLSearchParams,
  ): Response | undefined => {
    if (path === "/connection-templates" && method === "GET") {
      return response(templates);
    }
    if (path === `/namespaces/${namespaceId}/connection-templates` && method === "GET") {
      return response(
        templates.filter(
          (template) =>
            (!template.namespaceId || template.namespaceId === namespaceId) &&
            isRecord(template.current),
        ),
      );
    }
    if (path === `/namespaces/${namespaceId}/connections/oauth-clients` && method === "GET") {
      const template = templates.find(
        (candidate) => candidate.id === query?.get("connectionTemplateId"),
      );
      const version = template && isRecord(template.current) ? template.current : undefined;
      return response(
        oauthClients.filter(
          (client) =>
            client.kind === "oauth2" &&
            (!client.namespaceId || client.namespaceId === namespaceId) &&
            version &&
            client.issuer === version.issuer &&
            client.tokenUrl === version.tokenUrl &&
            (version.revocationUrl === undefined || client.revocationUrl === version.revocationUrl),
        ),
      );
    }
    if (path === "/oauth-clients" && method === "GET") {
      return response(oauthClients, 200, undefined, {
        redirectUri: "https://console.example.com/oauth/callback",
      });
    }
    if (method === "DELETE" && path.startsWith("/connection-templates/")) {
      const index = templates.findIndex((t) => path === "/connection-templates/" + t.id);
      if (index === -1) {
        return error(404, "NOT_FOUND", "The connection template does not exist.");
      }
      templates.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && path.startsWith("/oauth-clients/")) {
      const index = oauthClients.findIndex((client) => path === "/oauth-clients/" + client.id);
      if (index === -1) {
        return error(404, "NOT_FOUND", "The OAuth client does not exist.");
      }
      const client = oauthClients[index]!;
      if (client.id === "ccr_00000000-0000-4000-8000-000000000006") {
        return error(
          409,
          "RESOURCE_STATE_CONFLICT",
          "An active credential Source still references this client.",
        );
      }
      oauthClients.splice(index, 1);
      return new Response(null, { status: 204 });
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
        const client =
          body.kind === "github-app"
            ? {
                kind: "github-app",
                id: nextId("ccr"),
                displayName: body.displayName,
                appId: body.appId,
                createdAt,
              }
            : {
                kind: "oauth2",
                id: nextId("ccr"),
                displayName: body.displayName,
                clientId: body.clientId,
                tokenEndpointAuthMethod: body.tokenEndpointAuthMethod,
                ...(typeof body.namespaceId === "string" && { namespaceId: body.namespaceId }),
                issuer: body.issuer,
                tokenUrl: body.tokenUrl,
                ...(typeof body.revocationUrl === "string" && {
                  revocationUrl: body.revocationUrl,
                }),
                createdAt,
              };
        oauthClients.push(client);
        return response(client, 201);
      }
      if (method === "POST" && path.endsWith("/rotate-secret")) {
        const client = oauthClients.find(
          (item) => path === "/oauth-clients/" + item.id + "/rotate-secret",
        );
        return client
          ? response(client)
          : error(404, "RESOURCE_NOT_FOUND", "The credential client does not exist.");
      }
      if (path.startsWith("/connection-templates/") && method === "PATCH") {
        const template = templates.find((item) => path === "/connection-templates/" + item.id);
        if (
          !template ||
          !isRecord(template.current) ||
          typeof template.current.version !== "number"
        ) {
          return error(404, "RESOURCE_NOT_FOUND", "Connection template unavailable.");
        }
        const { displayName, ...config } = body;
        if (typeof displayName === "string") {
          template.displayName = displayName;
        }
        const sameStaticSettings =
          config.mode === "static_bearer" &&
          template.current.mode === "static_bearer" &&
          JSON.stringify(config.destinations) === JSON.stringify(template.current.destinations);
        if (config.mode !== undefined && !sameStaticSettings) {
          template.current = {
            ...config,
            templateId: template.id,
            version: template.current.version + 1,
            createdAt,
          };
        }
        if (mode === "unconfirmed-save" && isRecord(template.current)) {
          const current = { ...template.current };
          delete current.version;
          return response({ ...template, current });
        }
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
        templates.push(template);
        return response(template, 201);
      }
    }
    return undefined;
  };
}
