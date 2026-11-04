import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { PENDING_OAUTH_CONNECTION } from "../../packages/contracts/src/index.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { exchangeAuthorizationCode } from "../../apps/controller/src/drivers/credential-refresh/browser-authorization.ts";
import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

// Real TLS proves client identity and header separation; the RPC bodies below are
// controlled protocol fixtures, not proof of OpenShell's refresh implementation.
async function wireCertificates(t) {
  const directory = await temporaryDirectory(t, "openshell-oauth-wire-");
  const ca = await certificateAuthority(directory, { caName: "OpenShell wire test CA", days: 1 });
  const server = await signedLeaf(directory, ca, {
    name: "server",
    commonName: "localhost",
    subjectAltName: "DNS:localhost,IP:127.0.0.1",
    days: 1,
  });
  const operator = await signedLeaf(directory, ca, {
    name: "operator",
    subject: "/CN=wire-client/OU=operator",
    usage: "clientAuth",
    days: 1,
  });
  // The gateway accepts ordinary bearer clients as well as authenticated operator
  // certificates on one endpoint; require a certificate only on the export RPC.
  const provider = new grpc.experimental.FileWatcherCertificateProvider({
    caCertificateFile: ca.caPath,
    certificateFile: server.certPath,
    privateKeyFile: server.keyPath,
    refreshIntervalMs: 60_000,
  });
  return {
    rootCertificatePath: ca.caPath,
    operatorTls: { certificatePath: operator.certPath, privateKeyPath: operator.keyPath },
    serverCredentials: grpc.experimental.createCertificateProviderServerCredentials(
      provider,
      provider,
      false,
    ),
    bearerPath: join(directory, "bearer"),
  };
}

test("the browser code exchange passes only granted scopes to refresh", async (t) => {
  const request = {
    scopes: ["read", "write"],
    tokenUrl: "https://issuer.example.test/token",
    clientId: "test-client",
    redirectUri: "https://oce.example.test/callback",
  };
  let responseScope;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 120,
      refresh_token: "test-refresh",
      scope: responseScope,
    }),
  );
  const exchange = () =>
    exchangeAuthorizationCode(request, "test-verifier", "test-code", "test-secret", t.signal);

  assert.equal((await exchange()).scope, "read write");
  responseScope = "read";
  assert.equal((await exchange()).scope, "read");
  for (responseScope of ["read admin", ["read"], ""]) {
    await assert.rejects(exchange(), {
      name: "BrowserAuthorizationError",
      code: "grant_scope_mismatch",
      recoveryAction: "fix_configuration",
    });
  }
});

async function oauthCustody() {
  const driver = createTestSecretDriver();
  const identity = { id: "sec_custody", namespaceId: "ns_test", name: "Private OAuth custody" };
  const custody = {
    sourceId: "source",
    secret: {
      ...identity,
      driverId: driver.id,
      backendRef: await driver.create(identity, PENDING_OAUTH_CONNECTION),
    },
  };
  const service = new OAuthConnectionTokens(driver);
  const worker = new OAuthConnectionTokens(driver);
  return { driver, custody, service, worker };
}

test("the Token Service publishes the first access token and serializes refresh-token rotation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const requests = [];
  const first = randomUUID();
  const second = randomUUID();
  const originalGrant = randomUUID();
  const rotatedGrant = randomUUID();
  const issuerResponses = [
    { access_token: first, refresh_token: originalGrant, scope: "read write" },
    { access_token: second, refresh_token: rotatedGrant, scope: "read" },
    { access_token: randomUUID(), scope: "read write" },
  ];
  const renewalSent = Promise.withResolvers();
  const respond = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) {
      body.push(chunk);
    }
    requests.push(new URLSearchParams(Buffer.concat(body).toString()));
    if (requests.length === 2) {
      renewalSent.resolve();
      await respond.promise;
    }
    const result = issuerResponses[requests.length - 1];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...result, token_type: "Bearer", expires_in: 120 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    respond.resolve();
    server.close();
  });
  const issuer = "http://127.0.0.1:" + server.address().port;
  const request = {
    issuer,
    clientRegistrationId: "registration",
    clientId: "test-client",
    scopes: ["read", "write"],
    tokenUrl: issuer + "/token",
    redirectUri: "https://oce.example.test/callback",
  };
  const { driver, custody, service, worker } = await oauthCustody();
  const grant = await exchangeAuthorizationCode(
    request,
    "test-verifier",
    "test-code",
    randomUUID(),
    t.signal,
  );
  await service.accept(custody, grant, t.signal);
  const accepted = await worker.warm(custody, t.signal);
  assert.equal(accepted.accessToken, first);
  assert.deepEqual(Object.keys(accepted).sort(), [
    "accessToken",
    "expiresAt",
    "nextRefreshAt",
    "version",
  ]);
  assert.equal(
    requests.length,
    1,
    "publishing and reading the first token must not consume the refresh grant",
  );

  // The custody CAS takes four seconds, then the issuer takes twelve. A second worker must
  // neither replay the grant nor fence its owner at the shorter issuer-only timeout.
  t.mock.timers.tick(65_000);
  const compareAndSwap = driver.compareAndSwap.bind(driver);
  t.mock.method(
    driver,
    "compareAndSwap",
    (...args) => {
      t.mock.timers.tick(4_000);
      return compareAndSwap(...args);
    },
    { times: 1 },
  );
  const renewing = service.renew(custody, t.signal);
  await renewalSent.promise;
  t.mock.timers.tick(12_000);
  assert.equal((await worker.renew(custody, t.signal)).state, "pending");
  respond.resolve();
  assert.equal((await renewing).state, "ready");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get("refresh_token"), originalGrant);
  assert.equal(requests[1].get("scope"), "read write");
  const renewed = await service.warm(custody, t.signal);
  assert.equal(renewed.accessToken, second);
  assert.notEqual(renewed.version, accepted.version);

  // A grant rotation persists across service instances. The issuer tries to add write back on the next refresh.
  t.mock.timers.tick(125_000);
  assert.equal(await worker.warm(custody, t.signal), undefined);
  assert.equal((await worker.renew(custody, t.signal)).failureCode, "grant_scope_mismatch");
  assert.equal(requests[2].get("refresh_token"), rotatedGrant);
  assert.equal(requests[2].get("scope"), "read");
  assert.equal(await service.warm(custody, t.signal), undefined);
  assert.deepEqual(await service.status(custody, t.signal), {
    state: "failed",
    failureCode: "grant_scope_mismatch",
    recoveryAction: "fix_configuration",
  });
  await worker.renew(custody, t.signal, true);
  assert.equal(requests.length, 3, "even an operator rotation cannot replay a refused grant");
  await service.retire(custody, t.signal);
  assert.equal(driver.has(custody.secret), false);
});

function connectionGrant(issuer) {
  return {
    issuer,
    tokenUrl: issuer + "/token",
    clientId: "test-client",
    clientRegistrationId: "registration",
    clientSecret: randomUUID(),
    refreshToken: randomUUID(),
    accessToken: randomUUID(),
    scope: "read",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

test("a retired OAuth client secret requires fresh consent for an existing connection", async (t) => {
  const issuer = "https://issuer.example.test";
  const { custody, service } = await oauthCustody();
  const grant = connectionGrant(issuer);
  await service.accept(custody, grant, t.signal);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "invalid_client" }, { status: 401 }),
  );
  const failed = await service.renew(custody, t.signal, true);
  assert.deepEqual(failed, {
    state: "failed",
    failureCode: "client_refused",
    recoveryAction: "reauthorize",
  });
  assert.deepEqual(await service.status(custody, t.signal), failed);
  assert.equal(await service.warm(custody, t.signal), undefined);
  // During a new exchange the same refusal concerns the configured registration instead.
  await assert.rejects(
    exchangeAuthorizationCode(
      { ...grant, scopes: ["read"], redirectUri: "https://oce.example.test/callback" },
      "verifier",
      "code",
      grant.clientSecret,
      t.signal,
    ),
    { code: "client_refused", recoveryAction: "fix_configuration" },
  );
});

test("disconnect fences an in-flight OAuth refresh response", async (t) => {
  const received = Promise.withResolvers();
  const respond = Promise.withResolvers();
  const server = createServer(async (_req, res) => {
    received.resolve();
    await respond.promise;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: randomUUID(),
        refresh_token: randomUUID(),
        token_type: "Bearer",
        expires_in: 120,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    respond.resolve();
    server.close();
  });
  const issuer = "http://127.0.0.1:" + server.address().port;
  const { driver, custody, service, worker } = await oauthCustody();
  await service.accept(custody, connectionGrant(issuer), t.signal);
  assert.equal((await worker.status(custody, t.signal)).state, "ready");
  const refreshing = worker.renew(custody, t.signal, true);
  await received.promise;
  // Retire the exact custody identity after the issuer consumed the old refresh token and before its reply.
  await service.retire(custody, t.signal);
  respond.resolve();
  await assert.rejects(refreshing, { message: "Secret does not exist." });
  assert.equal(driver.has(custody.secret), false);
});

test(
  "OpenShell OAuth RPCs preserve workspace/key scope and isolate operator credential reads",
  { timeout: 20_000 },
  async (t) => {
    const certificates = await wireCertificates(t);
    await writeFile(certificates.bearerPath, "synthetic-bearer");
    const assertBearer = (call) => {
      assert.deepEqual(call.metadata.get("authorization"), ["Bearer synthetic-bearer"]);
      assert.equal(call.getAuthContext().sslPeerCertificate, undefined);
    };
    const proto = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-oauth-poc-wire.proto"),
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true,
      },
    );
    const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
    const workspace = "oauth-poc";
    const sourceId = "source-fixture";
    const provider = openShellProviderName(sourceId);
    const key = "CODEX_ACCESS_TOKEN";
    const expiry = new Date(Date.now() + 3_600_000);
    const expiryWire = { seconds: String(Math.floor(expiry.getTime() / 1000)), nanos: 0 };
    let current = "synthetic-access-first";
    let denyRead = false;
    let readResponse;
    let pendingRead = false;
    const received = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    let rotations = 0;
    const requests = [];
    const status = {
      provider,
      credential_key: key,
      status: "refreshed",
      expiration_time: expiryWire,
    };
    const server = new grpc.Server();
    server.addService(OpenShell.service, {
      ConfigureProviderRefresh(call, callback) {
        assertBearer(call);
        requests.push(call.request);
        callback(null, { status: { ...status, status: "configured" } });
      },
      RotateProviderCredential(call, callback) {
        assertBearer(call);
        assert.equal(call.request.workspace_scope.workspace, workspace);
        assert.equal(call.request.provider, provider);
        assert.equal(call.request.credential_key, key);
        rotations++;
        callback(null, { status });
      },
      GetProviderRefreshStatus(call, callback) {
        assertBearer(call);
        assert.equal(call.request.credential_key, key);
        callback(null, { credentials: [status] });
      },
      GetProvider(call, callback) {
        assertBearer(call);
        assert.equal(call.request.workspace_scope.workspace, workspace);
        callback(null, {
          provider: {
            type: provider,
            metadata: {
              name: provider,
              resource_version: "7",
              labels: {
                "app.kubernetes.io/managed-by": "openclaw-enterprise",
                "openclaw.dev/credential-source-id": sourceId,
              },
            },
            config: {
              "oce.codex.account": JSON.stringify({
                accountId: "account-fixture",
                planType: "plus",
              }),
            },
          },
        });
      },
      GetProviderCredentials(call, callback) {
        assert.equal(call.getAuthContext().sslPeerCertificate?.subject.OU, "operator");
        assert.deepEqual(call.metadata.get("authorization"), []);
        assert.deepEqual(call.request, {
          workspace_scope: { workspace },
          name: provider,
          credential_keys: [key],
        });
        if (pendingRead) {
          call.once("cancelled", () => cancelled.resolve());
          received.resolve();
          return;
        }
        if (denyRead) {
          callback({
            code: grpc.status.PERMISSION_DENIED,
            details: "synthetic-private-provider-error",
          });
        } else {
          callback(null, {
            credentials: readResponse ?? { [key]: { value: current, expiration_time: expiryWire } },
          });
        }
      },
    });
    const port = await new Promise((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", certificates.serverCredentials, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const configuration = {
      endpoint: `https://localhost:${port}`,
      auth: { mode: "bearerTokenFile", path: certificates.bearerPath },
      rootCertificatePath: certificates.rootCertificatePath,
      operatorTls: certificates.operatorTls,
    };
    const client = new GrpcOpenShellGatewayClient(configuration);
    t.after(() => {
      client.close();
      server.forceShutdown();
    });
    const signal = AbortSignal.timeout(10_000);
    await client.configureProviderRefresh(
      {
        workspace,
        provider,
        credentialKey: key,
        strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
        material: { client_id: "synthetic-client", refresh_token: "synthetic-refresh" },
        requestId: randomUUID(),
        expirationTime: expiry.toISOString(),
      },
      signal,
    );
    assert.equal(requests[0].strategy, "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN");
    assert.equal(requests[0].workspace_scope.workspace, workspace);
    assert.equal(requests[0].credential_key, key);
    assert.equal(requests[0].material.refresh_token, "synthetic-refresh");
    assert.equal(requests[0].expiration_time.seconds, String(Math.floor(expiry.getTime() / 1000)));
    await client.rotateProviderCredential(workspace, provider, key, randomUUID(), signal);
    assert.equal(
      (await client.getProviderRefreshStatus(workspace, provider, key, signal)).status,
      "refreshed",
    );

    const backend = createOpenShellBackend({
      id: "openshell",
      implementation: "openshell",
      configuration,
      drivers: {
        sandbox: "sandbox",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    });
    t.after(() => backend.client.close());
    assert.deepEqual(
      await backend.client
        .credentialClientForNamespace(workspace)
        .getProviderCredential(workspace, provider, key, signal),
      { value: current, expirationTime: `${expiry.toISOString().slice(0, 19)}.000000000Z` },
    );
    const driver = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/codex"] },
      { backend },
    );
    // Incoming IP-SAN transport must also carry the operator identity without SNI or bearer headers.
    const ipBackend = createOpenShellBackend({
      id: "openshell-ip",
      implementation: "openshell",
      configuration: { ...configuration, endpoint: `https://127.0.0.1:${port}` },
      drivers: {
        sandbox: "sandbox",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    });
    t.after(() => ipBackend.client.close());
    const ipDriver = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/codex"] },
      { backend: ipBackend },
    );
    const context = {
      signal,
      namespace: { id: "namespace", name: workspace },
      source: { id: sourceId, namespaceId: "namespace", driverId: driver.id, type: "codex-oauth" },
    };
    assert.equal(
      await ipDriver.withSourceToken(context, async ({ accessToken }) => accessToken),
      current,
    );
    const seen = [];
    const consume = async (token) => {
      seen.push(token);
      return "catalog-result";
    };
    assert.equal(await driver.withSourceToken(context, consume), "catalog-result");
    // The fake server represents an already-published replacement. This proves a fresh RPC read,
    // not OAuth rotation; the separate real-gateway test proves refresh and committed storage.
    current = "synthetic-access-replacement";
    await driver.withSourceToken(context, consume);
    assert.deepEqual(
      seen.map(({ accessToken }) => accessToken),
      ["synthetic-access-first", "synthetic-access-replacement"],
    );
    assert.equal(seen[1].accountId, "account-fixture");
    assert.equal(rotations, 1, "source reads leave refresh coordination to GetProviderCredentials");
    denyRead = true;
    await assert.rejects(driver.withSourceToken(context, consume), (error) => {
      assert.equal(error.grpcStatus, grpc.status.PERMISSION_DENIED);
      assert.match(error.message, /GetProviderCredentials failed/);
      assert.equal(error.message.includes("synthetic-private-provider-error"), false);
      return true;
    });
    denyRead = false;
    // Fail closed on unexpected selection, unusable values, and malformed declared expiry.
    // These are decoder/adapter checks; this fixture does not simulate gateway refresh decisions.
    for (const [credentials, error] of [
      [{}, /unexpected credential selection/],
      [{ OTHER_TOKEN: { value: "synthetic-unrequested" } }, /unexpected credential selection/],
      [
        { [key]: { value: current }, OTHER_TOKEN: { value: "synthetic-unrequested" } },
        /unexpected credential selection/,
      ],
      [{ [key]: {} }, /must be a nonempty string/],
      [{ [key]: { value: "" } }, /must be a nonempty string/],
      [
        { [key]: { value: current, expiration_time: { seconds: "1", nanos: -1 } } },
        /invalid credential expiration/,
      ],
      [{ [key]: { value: current, expiration_time: { seconds: "1" } } }, /expired/],
    ]) {
      readResponse = credentials;
      await assert.rejects(driver.withSourceToken(context, consume), error);
    }
    assert.equal(seen.length, 2, "denied and unusable values never reach plugin discovery");
    readResponse = { [key]: { value: current } };
    const exported = await backend.client
      .credentialClientForNamespace(workspace)
      .getProviderCredential(workspace, provider, key, signal);
    assert.deepEqual(
      exported,
      { value: current },
      "credentials without declared expiry remain valid",
    );

    // Cancellation still bounds a read that may be waiting on gateway-owned refresh.
    pendingRead = true;
    const abort = new AbortController();
    const reason = new Error("credential discovery cancelled");
    const pending = driver.withSourceToken({ ...context, signal: abort.signal }, consume);
    const rejection = assert.rejects(pending, (error) => error === reason);
    await received.promise;
    abort.abort(reason);
    await Promise.all([rejection, cancelled.promise]);
    assert.equal(seen.length, 2, "cancelled exports never reach plugin discovery");
  },
);

test("OpenShell mutual TLS rejects insecure endpoints and relative identity paths", () => {
  const options = {
    endpoint: "https://gateway.example.test:443",
    auth: { mode: "mutualTls", certificatePath: "/operator.crt", privateKeyPath: "/operator.key" },
  };
  for (const endpoint of ["http://gateway.example.test:80", "gateway.example.test:80"]) {
    assert.throws(() => new GrpcOpenShellGatewayClient({ ...options, endpoint }), /HTTPS/);
  }
  for (const path of ["certificatePath", "privateKeyPath"]) {
    assert.throws(
      () =>
        new GrpcOpenShellGatewayClient({
          ...options,
          auth: { ...options.auth, [path]: "relative" },
        }),
      /must be absolute/,
    );
  }
});
