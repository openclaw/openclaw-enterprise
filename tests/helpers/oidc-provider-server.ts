import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import type { OidcProviderConfig } from "./oidc-provider-material.ts";
import { createOidcProvider } from "./oidc-provider.ts";

// Test-only IdP: grants its single synthetic subject without a login screen. Keep it
// on the disposable test network. No controller or real identity state lives here.
export async function startOidcProvider(directory: string, { host = "127.0.0.1", port = 0 } = {}) {
  const config = JSON.parse(
    await readFile(join(directory, "config.json"), "utf8"),
  ) as OidcProviderConfig;
  const provider = createOidcProvider({ ...config, issuer: config, recordHistory: false });
  const origin = new URL(config.issuer).origin;
  const server = createServer({
    key: await readFile(join(directory, "server.key")),
    cert: await readFile(join(directory, "server.pem")),
    minVersion: "TLSv1.2",
    requestTimeout: 10_000,
  });
  server.on("request", async (request, response) => {
    try {
      response.setHeader("cache-control", "no-store");
      if (request.headers.host !== new URL(origin).host) {
        response.writeHead(400).end();
        return;
      }
      const url = new URL(String(request.url), origin);
      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            issuer: config.issuer,
            authorization_endpoint: config.authorizationUrl,
            token_endpoint: config.tokenUrl,
            jwks_uri: config.jwksUrl,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: [config.tokenAuth],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["openid"],
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        const query = url.searchParams;
        const state = query.get("state");
        if (
          new Set(query.keys()).size !== [...query.keys()].length ||
          query.get("client_id") !== config.clientId ||
          query.get("redirect_uri") !== config.redirectUri ||
          query.get("response_type") !== "code" ||
          query.get("scope") !== "openid" ||
          query.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "") ||
          !query.get("nonce") ||
          !state
        ) {
          response.writeHead(400).end();
          return;
        }
        const code = provider.authorize(url, { subject: config.subject });
        const callback = new URL(config.redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        response.writeHead(302, { location: callback.href }).end();
        return;
      }
      let body = "";
      for await (const chunk of request as AsyncIterable<Buffer>) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 16_384) {
          response.writeHead(413).end();
          return;
        }
      }
      const result = await provider.answer(
        new Request(url, {
          method: request.method ?? "GET",
          headers: Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch {
      // Provider errors can contain codes, credentials, or tokens. Do not log them.
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    }
  });
  const close = async () => {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, config, close };
}

// Node identifies the entrypoint even through projected-volume symlinks.
if (import.meta.main) {
  const directory = process.argv[2];
  if (directory === undefined) {
    throw new Error("OIDC provider material directory is required");
  }
  const { server, close } = await startOidcProvider(directory, {
    host: process.env.OIDC_LISTEN_HOST ?? "127.0.0.1",
    port: Number(process.env.OIDC_LISTEN_PORT ?? "0"),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("OIDC provider did not open a TCP listener");
  }
  process.stdout.write(JSON.stringify({ ready: true, port: address.port }) + "\n");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void close();
    });
  }
}
