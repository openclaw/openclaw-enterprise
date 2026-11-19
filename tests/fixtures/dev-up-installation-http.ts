import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, METHODS, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { Server } from "node:net";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";

const [requestLog, tlsDirectoryFile, scenario, installationId] = process.argv.slice(2);
assert.ok(
  requestLog && tlsDirectoryFile && scenario && installationId,
  "Dev-up Installation fixture arguments are required",
);

const routes = ["/api/auth/session", "/namespaces/namespace_fixture", "/installation"] as const;

function respond(
  log: string,
  inputDirectoryFile: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  // Consume the launcher's retained raw input, not a fixture-issued credential.
  // This checks transport wiring only, not the controller's authentication.
  let serviceKey: string | undefined;
  try {
    const directory = readFileSync(inputDirectoryFile, "utf8");
    serviceKey = readFileSync(join(directory, "initial-admin-service-key"), "utf8");
  } catch {
    // Browser readiness may run before credential preparation.
  }
  const authorized = serviceKey !== undefined && request.headers["x-api-key"] === serviceKey;
  // Record the observed route without persisting arbitrary request targets or query strings.
  const url = routes.find((route) => route === request.url) ?? "unrecognized";
  const method = METHODS.find((verb) => verb === request.method) ?? "unrecognized";
  appendFileSync(log, JSON.stringify({ method, url, authorized }) + "\n");
  response.setHeader("content-type", "application/json");
  if (url === "/api/auth/session") {
    if (scenario === "readiness-blocked") {
      response.writeHead(503);
    }
    response.end("{}");
    return;
  }
  const meta = { requestId: "req_fixture" };
  if (url === "/namespaces/namespace_fixture" && authorized) {
    response.end(
      JSON.stringify({ data: { id: "namespace_fixture", name: "default", status: "ready" }, meta }),
    );
    return;
  }
  if (url !== "/installation" || !authorized || scenario === "api-unauthorized") {
    response.writeHead(401);
    response.end(
      JSON.stringify({
        error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." },
        meta,
      }),
    );
    return;
  }
  response.end(
    JSON.stringify({ data: scenario === "api-mismatch" ? {} : { id: installationId }, meta }),
  );
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject: (error: Error) => void) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Dev-up Installation fixture did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

const handler = (request: IncomingMessage, response: ServerResponse) =>
  respond(requestLog, tlsDirectoryFile, request, response);
const server = createServer(handler);
// Read the launcher's generated key at handshake time, after startup writes it.
const browser = createTlsServer(
  {
    SNICallback(_name: string, done: (error: Error | null, context?: SecureContext) => void) {
      let context: SecureContext;
      try {
        const directory = readFileSync(tlsDirectoryFile, "utf8");
        context = createSecureContext({
          cert: readFileSync(join(directory, "browser-tls.crt")),
          key: readFileSync(join(directory, "browser-tls.key")),
        });
      } catch (error) {
        done(
          error instanceof Error
            ? error
            : new Error("Failed to read fixture TLS material", { cause: error }),
        );
        return;
      }
      done(null, context);
    },
  },
  handler,
);
const http = await listen(server);
const https = await listen(browser);
process.stdout.write(JSON.stringify({ http, https }) + "\n");
