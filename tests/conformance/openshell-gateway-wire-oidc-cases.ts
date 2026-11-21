import assert from "node:assert/strict";
import http from "node:http";
import { createServer as createHttpsServer } from "node:https";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caAndLeaf } from "../helpers/certificates.ts";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

/** A local token endpoint serving the OIDC client-credentials grant. */
function startTokenEndpoint(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{
  requests: URLSearchParams[];
  authorizations: (string | undefined)[];
  port: number;
  close: () => Promise<void>;
}> {
  const requests: URLSearchParams[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      authorizations.push(request.headers.authorization);
      handler(request, response);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        requests,
        authorizations,
        port: address.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Creates a client with the OIDC auth mode pointed at the local token endpoint. */
function oidcClient(tokenPort: number, secretPath: string, port: number) {
  return new GrpcOpenShellGatewayClient({
    endpoint: `http://127.0.0.1:${port}`,
    auth: {
      mode: "oidcClientCredentials",
      tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
      clientId: "wire-oidc-client",
      clientSecretPath: secretPath,
    },
  });
}

export function registerOidcCases(): void {
  test("OpenShell client presents an OIDC client-credentials token and caches it", async () => {
    const authorizations: unknown[][] = [];
    const server = new grpc.Server();
    addWireService(server, {
      Health(call, callback) {
        authorizations.push(call.metadata.get("authorization"));
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
    });
    let issued = 0;
    const endpoint = await startTokenEndpoint((_request, response) => {
      issued += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: `wire-oidc-token-${issued}`, expires_in: 3600 }));
    });
    const directory = await mkdtemp(join(tmpdir(), "openshell-oidc-"));
    const secretPath = join(directory, "client-secret");
    await writeFile(secretPath, "wire-oidc-secret\n", { mode: 0o600 });
    const port = await bindWireServer(server);
    const client = oidcClient(endpoint.port, secretPath, port);
    try {
      await client.health(AbortSignal.timeout(2_000));
      await client.health(AbortSignal.timeout(2_000));
      // One exchange served both calls: the access token is cached.
      assert.equal(endpoint.requests.length, 1);
      assert.deepEqual(authorizations, [
        ["Bearer wire-oidc-token-1"],
        ["Bearer wire-oidc-token-1"],
      ]);
      const exchange = endpoint.requests[0]!;
      assert.equal(exchange.get("client_id"), "wire-oidc-client");
      assert.equal(exchange.get("client_secret"), "wire-oidc-secret");
    } finally {
      client.close();
      await shutdownWireServer(server);
      await endpoint.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenShell client sends client_secret_basic and audience when selected", async () => {
    const server = new grpc.Server();
    addWireService(server, {
      Health(_call, callback) {
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
    });
    const endpoint = await startTokenEndpoint((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "wire-oidc-basic-token", expires_in: 3600 }));
    });
    const directory = await mkdtemp(join(tmpdir(), "openshell-oidc-"));
    const secretPath = join(directory, "client-secret");
    await writeFile(secretPath, "wire-oidc-basic-secret", { mode: 0o600 });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      auth: {
        mode: "oidcClientCredentials",
        tokenUrl: `http://127.0.0.1:${endpoint.port}/token`,
        clientId: "wire-oidc-client",
        clientSecretPath: secretPath,
        tokenAuth: "client_secret_basic",
        audience: "openshell-cli",
      },
    });
    try {
      await client.health(AbortSignal.timeout(2_000));
      const exchange = endpoint.requests[0]!;
      // RFC 6749 2.3.1: the Basic credentials form-urlencode both values before base64.
      const auth = endpoint.authorizations[0];
      assert.ok(typeof auth === "string" && auth.startsWith("Basic "));
      assert.equal(
        Buffer.from(auth.slice(6), "base64").toString("utf8"),
        `${encodeURIComponent("wire-oidc-client")}:${encodeURIComponent("wire-oidc-basic-secret")}`,
      );
      assert.equal(exchange.get("client_secret"), null);
      assert.equal(exchange.get("audience"), "openshell-cli");
    } finally {
      client.close();
      await shutdownWireServer(server);
      await endpoint.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenShell client re-reads the client secret on every token refresh", async () => {
    const server = new grpc.Server();
    addWireService(server, {
      Health(_call, callback) {
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
    });
    let issued = 0;
    const endpoint = await startTokenEndpoint((_request, response) => {
      issued += 1;
      response.writeHead(200, { "content-type": "application/json" });
      // A short lifetime forces one refresh per call, so each exchange observes
      // the secret file as it is rotated between them.
      response.end(JSON.stringify({ access_token: `wire-oidc-rotated-${issued}`, expires_in: 2 }));
    });
    const directory = await mkdtemp(join(tmpdir(), "openshell-oidc-"));
    const secretPath = join(directory, "client-secret");
    await writeFile(secretPath, "wire-oidc-secret-one\n", { mode: 0o600 });
    const port = await bindWireServer(server);
    const client = oidcClient(endpoint.port, secretPath, port);
    try {
      await client.health(AbortSignal.timeout(2_000));
      await writeFile(secretPath, "wire-oidc-secret-two\n", { mode: 0o600 });
      // Wait past the short token's refresh margin, then require a fresh exchange.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await client.health(AbortSignal.timeout(2_000));
      assert.equal(endpoint.requests.length, 2, "the refresh must exchange again");
      // Rotation applies without a restart: the second exchange carries the new secret.
      assert.equal(endpoint.requests[0]!.get("client_secret"), "wire-oidc-secret-one");
      assert.equal(endpoint.requests[1]!.get("client_secret"), "wire-oidc-secret-two");
    } finally {
      client.close();
      await shutdownWireServer(server);
      await endpoint.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenShell client shares one in-flight token refresh across concurrent calls", async () => {
    const server = new grpc.Server();
    addWireService(server, {
      Health(_call, callback) {
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
    });
    const endpoint = await startTokenEndpoint((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "wire-oidc-shared-token", expires_in: 3600 }));
    });
    const directory = await mkdtemp(join(tmpdir(), "openshell-oidc-"));
    const secretPath = join(directory, "client-secret");
    await writeFile(secretPath, "wire-oidc-shared-secret", { mode: 0o600 });
    const port = await bindWireServer(server);
    const client = oidcClient(endpoint.port, secretPath, port);
    try {
      const calls = Array.from({ length: 5 }, () => client.health(AbortSignal.timeout(5_000)));
      await Promise.all(calls);
      // Five concurrent callers with no cached token share exactly one exchange.
      assert.equal(endpoint.requests.length, 1, "concurrent callers must share one exchange");
    } finally {
      client.close();
      await shutdownWireServer(server);
      await endpoint.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenShell client trusts the root bundle for an https token endpoint", async () => {
    const server = new grpc.Server();
    addWireService(server, {
      Health(_call, callback) {
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "openshell-oidc-"));
    const secretPath = join(directory, "client-secret");
    await writeFile(secretPath, "wire-oidc-tls-secret", { mode: 0o600 });
    const { certPath, keyPath, caPath } = await caAndLeaf(directory, {
      caName: "wire-oidc-issuer-ca",
      commonName: "wire-oidc-issuer",
      subjectAltName: "DNS:localhost,IP:127.0.0.1",
    });
    const requests: URLSearchParams[] = [];
    const tlsServer = createHttpsServer(
      { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8") },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ access_token: "wire-oidc-https-token", expires_in: 3600 }));
        });
      },
    );
    const tlsPort = await new Promise<number>((resolve) => {
      tlsServer.listen(0, "127.0.0.1", () => {
        resolve((tlsServer.address() as { port: number }).port);
      });
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      auth: {
        mode: "oidcClientCredentials",
        tokenUrl: `https://127.0.0.1:${tlsPort}/token`,
        clientId: "wire-oidc-client",
        clientSecretPath: secretPath,
      },
      rootCertificatePath: caPath,
    });
    const untrusting = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      auth: {
        mode: "oidcClientCredentials",
        tokenUrl: `https://127.0.0.1:${tlsPort}/token`,
        clientId: "wire-oidc-client",
        clientSecretPath: secretPath,
      },
    });
    try {
      // With the root bundle mounted as rootCertificatePath the exchange succeeds.
      await client.health(AbortSignal.timeout(2_000));
      assert.equal(requests.length, 1, "one exchange over trusted TLS");
      // Without it the private-CA endpoint fails closed.
      await assert.rejects(
        untrusting.health(AbortSignal.timeout(2_000)),
        /OpenShell OIDC token request failed/,
      );
    } finally {
      client.close();
      untrusting.close();
      await new Promise((resolve) => tlsServer.close(resolve));
      await shutdownWireServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenShell client fails the gateway call when the OIDC token endpoint rejects the client", async () => {
    const server = new grpc.Server();
    addWireService(server, {
      Health(_call, callback) {
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
    });
    const endpoint = await startTokenEndpoint((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_client" }));
    });
    const directory = await mkdtemp(join(tmpdir(), "openshell-oidc-"));
    const secretPath = join(directory, "client-secret");
    await writeFile(secretPath, "wire-oidc-rejected-secret", { mode: 0o600 });
    const port = await bindWireServer(server);
    const client = oidcClient(endpoint.port, secretPath, port);
    try {
      await assert.rejects(
        client.health(AbortSignal.timeout(2_000)),
        /OpenShell OIDC token endpoint rejected the client credentials \(HTTP 401/,
      );
    } finally {
      client.close();
      await shutdownWireServer(server);
      await endpoint.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
