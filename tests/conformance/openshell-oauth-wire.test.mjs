import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { PENDING_OAUTH_CONNECTION } from "../../packages/contracts/src/index.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  exchangeAuthorizationCode,
  startBrowserAuthorization,
} from "../../apps/controller/src/drivers/credential-refresh/browser-authorization.ts";
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
    resource: "https://mcp.example.test/mcp",
    tokenUrl: "https://issuer.example.test/token",
    oauthClientId: "registration",
    tokenEndpointAuthMethod: "none",
    clientId: "test-client",
    redirectUri: "https://oce.example.test/callback",
  };
  const started = startBrowserAuthorization("source", {
    ...request,
    authorizationUrl: "https://issuer.example.test/auth",
    authorizationParameters: {},
  });
  assert.equal(new URL(started.authorizationUrl).searchParams.get("resource"), request.resource);
  let responseScope;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.has("authorization"), false);
    assert.equal(init.body.get("client_id"), request.clientId);
    assert.equal(init.body.has("client_secret"), false);
    assert.equal(init.body.get("resource"), request.resource);
    return Response.json({
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 120,
      refresh_token: "test-refresh",
      scope: responseScope,
    });
  });
  const exchange = () =>
    exchangeAuthorizationCode(request, "test-verifier", "test-code", undefined, t.signal);

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
  const service = new OAuthConnectionTokens(driver, refreshPinnedOAuthGrant);
  const worker = new OAuthConnectionTokens(driver, refreshPinnedOAuthGrant);
  return { driver, custody, service, worker };
}

test("the Token Service keeps the first access token in custody and serializes rotation", async (t) => {
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
  const nonce = randomUUID();
  const clientSecret = "test :+" + nonce;
  const rotatedClientSecret = randomUUID();
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) {
      body.push(chunk);
    }
    const parameters = new URLSearchParams(Buffer.concat(body).toString());
    assert.equal(parameters.get("resource"), "https://mcp.example.test/mcp");
    const expected = Buffer.from(
      requests.length === 0
        ? "test%3Aclient:test+%3A%2B" + nonce
        : "test%3Aclient:" + rotatedClientSecret,
    ).toString("base64");
    assert.ok(
      req.headers.authorization === "Basic " + expected,
      "OAuth Basic encodes both client credentials",
    );
    assert.equal(parameters.has("client_secret"), false);
    requests.push(parameters);
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
    oauthClientId: "registration",
    requestedScopes: ["read", "write"],
    tokenEndpointAuthMethod: "client_secret_basic",
    clientId: "test:client",
    scopes: ["read", "write"],
    resource: "https://mcp.example.test/mcp",
    tokenUrl: issuer + "/token",
    redirectUri: "https://oce.example.test/callback",
  };
  const { driver, custody, service, worker } = await oauthCustody();
  const grant = await exchangeAuthorizationCode(
    request,
    "test-verifier",
    "test-code",
    clientSecret,
    t.signal,
  );
  await service.accept(custody, grant, t.signal);
  const resolveClient = async () => ({
    registration: request,
    readSecret: async () => rotatedClientSecret,
  });
  const stored = driver.valueFor(custody.secret);
  assert.ok(!stored.includes(clientSecret));
  assert.equal(Object.hasOwn(JSON.parse(stored), "clientSecret"), false);
  const accepted = await worker.warm(custody, t.signal);
  assert.equal(accepted.accessToken, first);
  assert.deepEqual(Object.keys(accepted).sort(), [
    "accessToken",
    "expiresAt",
    "grantedScopes",
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
  const renewing = service.renew(custody, t.signal, resolveClient);
  await renewalSent.promise;
  t.mock.timers.tick(12_000);
  assert.equal((await worker.renew(custody, t.signal, resolveClient)).state, "pending");
  respond.resolve();
  assert.equal((await renewing).state, "ready");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get("refresh_token"), originalGrant);
  assert.equal(requests[1].get("scope"), "read write");
  const renewed = await service.warm(custody, t.signal);
  assert.equal(renewed.accessToken, second);
  assert.notEqual(renewed.version, accepted.version);

  // The sender recovers after the successor's scheduled renewal time. Its earlier published
  // version still identifies a delivery retry, so the worker can project the unexpired successor.
  t.mock.timers.tick(65_000);
  assert.equal(
    (await worker.renew(custody, t.signal, resolveClient, accepted.version)).state,
    "ready",
  );
  assert.equal((await worker.warm(custody, t.signal)).version, renewed.version);
  assert.equal(requests.length, 2);

  // A grant rotation persists across service instances. The issuer tries to add write back on the next refresh.
  t.mock.timers.tick(60_000);
  assert.equal(await worker.warm(custody, t.signal), undefined);
  assert.equal(
    (await worker.renew(custody, t.signal, resolveClient)).failureCode,
    "grant_scope_mismatch",
  );
  assert.equal(requests[2].get("refresh_token"), rotatedGrant);
  assert.equal(requests[2].get("scope"), "read");
  assert.equal(await service.warm(custody, t.signal), undefined);
  assert.deepEqual(await service.status(custody, t.signal), {
    state: "failed",
    failureCode: "grant_scope_mismatch",
    recoveryAction: "fix_configuration",
  });
  await worker.renew(custody, t.signal, resolveClient, renewed.version);
  assert.equal(requests.length, 3, "even an operator rotation cannot replay a refused grant");
  await service.retire(custody, t.signal);
  assert.equal(driver.has(custody.secret), false);
});

function connectionGrant(issuer) {
  return {
    issuer,
    tokenUrl: issuer + "/token",
    clientId: "test-client",
    oauthClientId: "registration",
    requestedScopes: ["read", "write"],
    tokenEndpointAuthMethod: "none",
    refreshToken: randomUUID(),
    accessToken: randomUUID(),
    scope: "read",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

test("OAuth renewal retries cancellation before dispatch and quarantines a lost issuer reply", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const requests = [];
  const server = createServer(async (req) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    requests.push(new URLSearchParams(Buffer.concat(chunks).toString()));
    // The issuer received the grant, but the worker cannot know whether it rotated.
    req.socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const grant = connectionGrant("http://127.0.0.1:" + server.address().port);
  const { driver, custody, service, worker } = await oauthCustody();
  const resolveClient = async () => ({
    registration: grant,
    readSecret: async () => assert.fail("public clients have no secret"),
  });
  await service.accept(custody, grant, t.signal);
  const accepted = await service.warm(custody, t.signal);
  t.mock.timers.setTime(Date.parse(accepted.nextRefreshAt));
  const stop = new AbortController();
  const swap = driver.compareAndSwap.bind(driver);
  // The control plane cancels while the Secret Driver is committing the intent.
  t.mock.method(
    driver,
    "compareAndSwap",
    async (...args) => {
      stop.abort(new Error("Worker stopped during the custody claim."));
      return swap(...args);
    },
    { times: 1 },
  );
  await assert.rejects(worker.renew(custody, stop.signal, resolveClient), {
    message: "Worker stopped during the custody claim.",
  });
  assert.deepEqual(requests, []);
  assert.deepEqual(await service.warm(custody, t.signal), accepted);

  const failed = await worker.renew(custody, t.signal, resolveClient);
  assert.equal(failed.failureCode, "refresh_outcome_unknown");
  assert.deepEqual(await service.renew(custody, t.signal, resolveClient), failed);
  assert.deepEqual(
    requests.map((body) => body.get("refresh_token")),
    [grant.refreshToken],
  );
});

test("client authentication can recover with the same grant and a repaired registration", async (t) => {
  const currentSecret = randomUUID();
  let storedSecret = randomUUID();
  let revoked = false;
  let requests = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) {
      chunks.push(part);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    requests++;
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.ok(form.get("refresh_token") === grant.refreshToken);
    assert.equal(form.get("client_id"), "test-client");
    assert.equal(req.headers.authorization, undefined);
    const wrongClient = form.get("client_secret") !== currentSecret;
    res.writeHead(wrongClient ? 401 : revoked ? 400 : 200, { "Content-Type": "application/json" });
    if (wrongClient) {
      res.end(JSON.stringify({ error: requests === 1 ? "invalid_client" : "unauthorized_client" }));
    } else if (revoked) {
      res.end(JSON.stringify({ error: "invalid_grant" }));
    } else {
      res.end(
        JSON.stringify({ access_token: randomUUID(), token_type: "Bearer", expires_in: 120 }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const grant = {
    ...connectionGrant("http://127.0.0.1:" + server.address().port),
    tokenEndpointAuthMethod: "client_secret_post",
  };
  const { custody, driver, service, worker } = await oauthCustody();
  await service.accept(custody, grant, t.signal);
  const material = driver.valueFor(custody.secret);
  const { version } = await service.warm(custody, t.signal);
  const readSecret = t.mock.fn(async () => storedSecret);
  const resolveClient = async () => ({ registration: grant, readSecret });
  // Changing the private custody reference cannot export another client's secret or redirect
  // the issuer request. The controller supplies an independent registration for this source.
  for (const edited of [
    { oauthClientId: "another-registration" },
    { tokenUrl: grant.tokenUrl + "/unapproved" },
    { resource: "https://unapproved.test" },
  ]) {
    await driver.update(custody.secret, JSON.stringify({ ...JSON.parse(material), ...edited }));
    const refused = await service.renew(custody, t.signal, resolveClient, version);
    assert.equal(refused.failureCode, "client_registration_mismatch");
    assert.equal(await service.warm(custody, t.signal), undefined);
  }
  assert.equal(requests, 0);
  assert.equal(readSecret.mock.callCount(), 0);
  await driver.update(custody.secret, material);
  // A registration store outage keeps the same upstream grant. Re-observing the old SQL due
  // version after interruption must recover the persisted retry without making another read.
  const unavailable = t.mock.fn(async () => {
    throw new Error("Registration credentials unavailable");
  });
  const down = await service.renew(
    custody,
    t.signal,
    async () => ({ registration: grant, readSecret: unavailable }),
    version,
  );
  assert.equal(down.failureCode, "client_unavailable");
  assert.equal(down.recoveryAction, "retry");
  assert.ok(Date.parse(down.schedule.nextRefreshAt) > Date.now());
  assert.notEqual(down.schedule.version, version);
  const previousDue = await worker.renew(
    custody,
    t.signal,
    async () => ({ registration: grant, readSecret: unavailable }),
    version,
  );
  assert.deepEqual(previousDue, down);
  assert.equal(unavailable.mock.callCount(), 1);
  assert.equal(requests, 0);
  const refused = await service.renew(custody, t.signal, resolveClient, down.schedule.version);
  assert.equal(refused.state, "failed");
  assert.equal(refused.failureCode, "client_refused");
  assert.equal(refused.recoveryAction, "fix_configuration");
  assert.ok(refused.schedule.nextRefreshAt);
  assert.equal(await service.warm(custody, t.signal), undefined);
  const refusedAgain = await worker.renew(
    custody,
    t.signal,
    resolveClient,
    refused.schedule.version,
  );
  assert.equal(refusedAgain.failureCode, "client_refused");
  assert.equal(refusedAgain.recoveryAction, "fix_configuration");
  storedSecret = currentSecret;
  assert.equal(
    (await worker.renew(custody, t.signal, resolveClient, refusedAgain.schedule.version)).state,
    "ready",
  );
  assert.ok(!driver.valueFor(custody.secret).includes(currentSecret));
  // A definitive grant refusal is terminal, even with a working client credential.
  revoked = true;
  const result = await worker.renew(
    custody,
    t.signal,
    resolveClient,
    (await worker.warm(custody, t.signal)).version,
  );
  assert.equal(result.failureCode, "grant_refused");
  assert.equal(result.recoveryAction, "reauthorize");
  assert.deepEqual(await service.renew(custody, t.signal, resolveClient, version), result);
  assert.equal(requests, 4);
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
  const grant = connectionGrant(issuer);
  const resolveClient = async () => ({ registration: grant });
  await service.accept(custody, grant, t.signal);
  assert.equal((await worker.status(custody, t.signal)).state, "ready");
  const refreshing = worker.renew(
    custody,
    t.signal,
    resolveClient,
    (await worker.warm(custody, t.signal)).version,
  );
  await received.promise;
  // Retire the exact custody identity after the issuer consumed the old refresh token and before its reply.
  await service.retire(custody, t.signal);
  respond.resolve();
  await assert.rejects(refreshing, { message: "Secret does not exist." });
  assert.equal(driver.has(custody.secret), false);
});

test(
  "a delayed OAuth client rotation cannot overwrite the acknowledged rotation",
  { timeout: 10_000 },
  async (t) => {
    const proto = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-oauth-poc-wire.proto"),
      { keepCase: true, longs: String, defaults: false },
    );
    const service = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
    const server = new grpc.Server();
    t.after(() => server.forceShutdown());
    const workspace = "oauth-clients";
    const registrationId = randomUUID();
    const labels = {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/client-registration-id": registrationId,
    };
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const late = Promise.withResolvers();
    const first = randomUUID();
    const second = randomUUID();
    let current = randomUUID();
    let version = 1;
    let name;
    const provider = () => ({
      metadata: { name, resource_version: String(version), labels },
      type: name,
    });
    server.addService(service.service, {
      GetProvider(call, reply) {
        name = call.request.name;
        reply(null, { provider: provider() });
      },
      async UpdateProvider(call, reply) {
        const incoming = call.request.provider;
        const value = incoming.credentials.OCE_CLIENT_SECRET;
        // Hold dispatched work past caller cancellation so the second rotation can commit first.
        if (value === first) {
          started.resolve();
          await release.promise;
        }
        const expected = incoming.metadata.resource_version;
        if (expected && expected !== String(version)) {
          late.resolve("conflict");
          reply({ code: grpc.status.ABORTED, details: "resource version conflict" });
          return;
        }
        current = value;
        version++;
        if (value === first) {
          late.resolve("overwritten");
        }
        reply(null, { provider: provider() });
      },
      GetProviderCredentials(call, reply) {
        assert.equal(call.request.name, name);
        assert.equal(call.request.workspace_scope.workspace, workspace);
        reply(null, { credentials: { OCE_CLIENT_SECRET: { value: current } } });
      },
    });
    const port = await new Promise((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const configuration = { endpoint: `http://127.0.0.1:${port}` };
    const client = new GrpcOpenShellGatewayClient(configuration);
    t.after(() => client.close());
    const backend = createOpenShellBackend(
      {
        id: "openshell-test",
        type: "openshell",
        configuration,
        drivers: { credential_refresh: "openshell-refresh" },
      },
      { gatewayClient: client },
    );
    const driver = new OpenShellCredentialRefreshDriver(
      { clientWorkspace: workspace },
      { id: "openshell-refresh", backend },
    );
    const signal = t.signal;
    const context = { registrationId, issuer: "https://issuer.example", clientId: "app", signal };
    const abort = new AbortController();
    const interrupted = driver.rotateClientSecret({ ...context, signal: abort.signal }, first);
    await started.promise;
    abort.abort();
    await assert.rejects(interrupted, { name: "AbortError" });
    await driver.rotateClientSecret(context, second);
    release.resolve();
    assert.equal(await late.promise, "conflict");
    assert.equal(
      (await client.getProviderCredential(workspace, name, "OCE_CLIENT_SECRET", signal)).value,
      second,
    );
  },
);

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
