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
  const pluginConsent = mode === "plugin-consent" || mode === "plugin-consent-multiple-clients";
  const populated =
    mode === "ready" ||
    pluginConsent ||
    mode === "github-app-verification-failed" ||
    mode === "github-app-namespaces";
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
            issuerVerification: { tokenEndpointAuthMethods: ["none", "client_secret_basic"] },
            scopes: pluginConsent ? [] : ["messages.read"],
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
              ...(pluginConsent && {
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
          clientId: "support-demo",
          tokenEndpointAuthMethod: "none",
          createdAt,
        },
        {
          kind: "oauth2",
          id: "ccr_00000000-0000-4000-8000-000000000007",
          displayName: "Customer operations reporting",
          issuer: "https://identity.example.com/organizations/customer-operations",
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
  if (mode === "plugin-consent-multiple-clients") {
    oauthClients.push({
      ...oauthClients[0],
      id: "ccr_00000000-0000-4000-8000-000000000011",
      displayName: "Support alternate",
      clientId: "support-alternate",
      tokenEndpointAuthMethod: "client_secret_basic",
    });
  }
  if (mode === "github-app-namespaces") {
    oauthClients.push(
      {
        kind: "github-app",
        id: "ccr_00000000-0000-4000-8000-000000000009",
        displayName: "Engineering repository App",
        appId: "12345",
        namespaceId,
        createdAt,
      },
      {
        kind: "github-app",
        id: "ccr_00000000-0000-4000-8000-000000000010",
        displayName: "Research repository App",
        appId: "12345",
        namespaceId: "ns_00000000-0000-4000-8000-000000000002",
        createdAt,
      },
    );
  }
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
      const verification =
        version && isRecord(version.issuerVerification) ? version.issuerVerification : undefined;
      return response(
        oauthClients.filter(
          (client) =>
            client.kind === "oauth2" &&
            (!client.namespaceId || client.namespaceId === namespaceId) &&
            version &&
            client.issuer === version.issuer &&
            Array.isArray(verification?.tokenEndpointAuthMethods) &&
            verification.tokenEndpointAuthMethods.includes(client.tokenEndpointAuthMethod),
        ),
      );
    }
    if (path === "/credential-clients" && method === "GET") {
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
    if (method === "DELETE" && path.startsWith("/credential-clients/")) {
      const index = oauthClients.findIndex((client) => path === "/credential-clients/" + client.id);
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
      if (path === "/credential-clients" && method === "POST") {
        if (body.kind !== "oauth2" && body.kind !== "github-app") {
          return error(400, "INVALID_REQUEST", "Select a credential client kind.");
        }
        if (mode === "github-app-verification-failed" && body.kind === "github-app") {
          return error(404, "NOT_FOUND", "The requested platform resource was not found.");
        }
        const client =
          body.kind === "github-app"
            ? {
                kind: "github-app",
                id: nextId("ccr"),
                displayName: body.displayName,
                appId: body.appId,
                ...(typeof body.namespaceId === "string" && { namespaceId: body.namespaceId }),
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
                createdAt,
              };
        oauthClients.push(client);
        return response(client, 201);
      }
      if (
        method === "POST" &&
        path.startsWith("/credential-clients/") &&
        path.endsWith("/rotate")
      ) {
        const client = oauthClients.find(
          (item) => path === "/credential-clients/" + item.id + "/rotate",
        );
        if (!client) {
          return error(404, "RESOURCE_NOT_FOUND", "The credential client does not exist.");
        }
        return client.kind === body.kind
          ? response(client)
          : error(400, "INVALID_REQUEST", "Select the registered credential client kind.");
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
            ...(config.mode !== "static_bearer" && {
              issuerVerification: {
                tokenEndpointAuthMethods:
                  config.mode === "mcp_discovery"
                    ? observed.tokenEndpointAuthMethods
                    : ["client_secret_basic", "client_secret_post"],
              },
            }),
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
          ...(config.mode !== "static_bearer" && {
            issuerVerification: {
              tokenEndpointAuthMethods:
                config.mode === "mcp_discovery"
                  ? observed.tokenEndpointAuthMethods
                  : ["client_secret_basic", "client_secret_post"],
            },
          }),
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
