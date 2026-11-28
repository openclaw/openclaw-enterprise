import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { TestContext } from "node:test";
import type { OAuthClientAuthMethod } from "../../packages/contracts/src/index.ts";
import {
  fetchOAuthTokenEndpoint,
  revalidateOAuthTokenEndpoint,
  verifyOAuthTemplateIssuer,
} from "../../apps/controller/src/connections/oauth-issuer.ts";
import type { OAuthTransportOptions } from "../../apps/controller/src/connections/mcp-discovery.ts";
import { caAndLeaf } from "./certificates.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

/** Inject controlled DNS or issuer responses while still running OCC's production verifier. */
export function oauthIssuerWithTransport(options: OAuthTransportOptions) {
  return {
    verifyTemplate: (
      version: Parameters<typeof verifyOAuthTemplateIssuer>[0],
      signal: AbortSignal,
    ) => verifyOAuthTemplateIssuer(version, signal, options),
    revalidate: (
      version: Parameters<typeof revalidateOAuthTokenEndpoint>[0],
      signal: AbortSignal,
    ) => revalidateOAuthTokenEndpoint(version, signal, options),
    fetchToken: (version: Parameters<typeof fetchOAuthTokenEndpoint>[0], init: RequestInit) =>
      fetchOAuthTokenEndpoint(version, init, options),
  };
}

/** Fixed metadata fixture for unrelated CRUD tests; proposed endpoints never define the answer. */
export function fixtureOAuthIssuer(
  template: { issuer: string; authorizationUrl: string; tokenUrl: string; revocationUrl?: string },
  methods: readonly OAuthClientAuthMethod[] = ["client_secret_basic"],
  fetchToken?: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const issuer = new URL(template.issuer);
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const discovery = `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`;
  return oauthIssuerWithTransport({
    resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
    async fetchMetadata(value, init) {
      if (String(value) === template.tokenUrl && fetchToken) {
        return fetchToken(template.tokenUrl, init);
      }
      if (String(value) !== discovery) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        issuer: template.issuer,
        authorization_endpoint: template.authorizationUrl,
        token_endpoint: template.tokenUrl,
        ...(template.revocationUrl && { revocation_endpoint: template.revocationUrl }),
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: methods,
      });
    },
  });
}

export interface ControlledTokenRequest {
  readonly authorization: string | undefined;
  readonly parameters: URLSearchParams;
}

/** Disposable HTTPS issuer with a real trusted CA, mapped private DNS and cross-origin token URL. */
export async function controlledOAuthIssuer(t: TestContext) {
  const directory = await temporaryDirectory(t, "oauth-issuer-");
  const material = await caAndLeaf(directory, {
    caName: "Disposable OAuth issuer test CA",
    commonName: "issuer.oauth.test",
    subjectAltName: "DNS:issuer.oauth.test,DNS:token.oauth.test",
  });
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, await readFile(material.caPath, "utf8")]);
  t.after(() => setDefaultCACertificates(previous));
  const requests: ControlledTokenRequest[] = [];
  let metadataTokenUrl: string | undefined;
  let metadataCapabilities: Record<string, readonly string[]> = {};
  let answerToken: (request: ControlledTokenRequest) => Promise<Response> | Response = () =>
    Response.json({ error: "invalid_grant" }, { status: 400 });
  const server = createServer(
    { key: await readFile(material.keyPath), cert: await readFile(material.certPath) },
    async (request, response) => {
      const host = request.headers.host ?? "";
      if (
        request.method === "GET" &&
        host.startsWith("issuer.oauth.test:") &&
        request.url === "/.well-known/oauth-authorization-server"
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: authorizationUrl,
            token_endpoint: metadataTokenUrl ?? tokenUrl,
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: [
              "none",
              "client_secret_basic",
              "client_secret_post",
            ],
            ...metadataCapabilities,
          }),
        );
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
      }
      const entry = {
        authorization: request.headers.authorization,
        parameters: new URLSearchParams(body),
      };
      requests.push(entry);
      if (host !== new URL(tokenUrl).host || request.url !== "/token") {
        response.writeHead(404).end();
        return;
      }
      const result = await answerToken(entry);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const issuer = `https://issuer.oauth.test:${address.port}`;
  const authorizationUrl = `${issuer}/authorize`;
  const tokenUrl = `https://token.oauth.test:${address.port}/token`;
  const operations = oauthIssuerWithTransport({
    resolveHost: async (host) => {
      assert.ok(host === "issuer.oauth.test" || host === "token.oauth.test");
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  return {
    issuer,
    authorizationUrl,
    tokenUrl,
    operations,
    requests,
    setMetadataTokenUrl(value: string | undefined) {
      metadataTokenUrl = value;
    },
    setMetadataCapabilities(value: Record<string, readonly string[]>) {
      metadataCapabilities = value;
    },
    setTokenHandler(handler: typeof answerToken) {
      answerToken = handler;
    },
  };
}
