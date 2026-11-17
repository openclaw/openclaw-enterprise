import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  startBrowserAuthorization,
  exchangeAuthorizationCode,
} from "../../packages/occ/src/browser-authorization.ts";
import { OAuthGrantStore } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { refreshPinnedOAuthGrant } from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

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
  const started = startBrowserAuthorization({
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
    if (init.body.get("grant_type") === "refresh_token") {
      assert.equal(init.body.has("scope"), false);
    }
    return Response.json({
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 120,
      refresh_token: "test-refresh",
      scope: responseScope,
    });
  });
  const exchange = (scopes = request.scopes) =>
    exchangeAuthorizationCode(
      { ...request, scopes },
      "test-verifier",
      "test-code",
      undefined,
      t.signal,
    );

  assert.deepEqual((await exchange()).grantedScopes, ["read", "write"]);
  responseScope = "read";
  assert.deepEqual((await exchange()).grantedScopes, ["read"]);
  for (responseScope of ["read admin", ["read"], ""]) {
    await assert.rejects(exchange(), {
      name: "BrowserAuthorizationError",
      code: "grant_scope_mismatch",
      recoveryAction: "fix_configuration",
    });
  }
  // Only a default-scope request may adopt a provider-reported initial grant.
  responseScope = "provider.default";
  const defaults = await exchange([]);
  assert.deepEqual(defaults.grantedScopes, ["provider.default"]);
  responseScope = undefined;
  const unreported = await exchange([]);
  assert.deepEqual(unreported.grantedScopes, []);
  const renewed = await refreshPinnedOAuthGrant({ ...request, ...unreported }, t.signal, undefined);
  assert.deepEqual(renewed.grantedScopes, []);
  responseScope = "later.addition";
  await assert.rejects(
    refreshPinnedOAuthGrant({ ...request, ...unreported }, t.signal, undefined),
    {
      code: "grant_scope_mismatch",
    },
  );
});

async function oauthCustody() {
  const driver = createTestSecretDriver();
  const service = new OAuthGrantStore(driver, refreshPinnedOAuthGrant);
  const worker = new OAuthGrantStore(driver, refreshPinnedOAuthGrant);
  const custody = await service.reserve({ namespaceId: "ns_test", sourceId: "source" });
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
  await service.storeInitialGrant(custody, { ...request, ...grant }, t.signal);
  const resolveClient = async () => ({
    registration: request,
    readSecret: async () => rotatedClientSecret,
  });
  const stored = driver.valueFor(custody.secret);
  assert.ok(!stored.includes(clientSecret));
  assert.equal(Object.hasOwn(JSON.parse(stored), "clientSecret"), false);
  const accepted = (await worker.observe(custody, t.signal, 0)).token;
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
  const renewed = (await service.observe(custody, t.signal, 0)).token;
  assert.equal(renewed.accessToken, second);
  assert.notEqual(renewed.version, accepted.version);

  // The sender recovers after the successor's scheduled renewal time. Its earlier published
  // version still identifies a delivery retry, so the worker can project the unexpired successor.
  t.mock.timers.tick(65_000);
  assert.equal(
    (await worker.renew(custody, t.signal, resolveClient, accepted.version)).state,
    "ready",
  );
  assert.equal((await worker.observe(custody, t.signal, 0)).token.version, renewed.version);
  assert.equal(requests.length, 2);

  // A grant rotation persists across service instances. The issuer tries to add write back on the next refresh.
  t.mock.timers.tick(60_000);
  assert.equal((await worker.observe(custody, t.signal, 0)).token, undefined);
  assert.equal(
    (await worker.renew(custody, t.signal, resolveClient)).failureCode,
    "grant_scope_mismatch",
  );
  assert.equal(requests[2].get("refresh_token"), rotatedGrant);
  assert.equal(requests[2].get("scope"), "read");
  assert.equal((await service.observe(custody, t.signal, 0)).token, undefined);
  assert.deepEqual((await service.observe(custody, t.signal)).status, {
    state: "failed",
    failureCode: "grant_scope_mismatch",
    recoveryAction: "fix_configuration",
  });
  await worker.renew(custody, t.signal, resolveClient, renewed.version);
  assert.equal(requests.length, 3, "even an operator rotation cannot replay a refused grant");
  await service.delete(custody, t.signal);
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
    grantedScopes: ["read"],
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
  await service.storeInitialGrant(custody, grant, t.signal);
  const accepted = (await service.observe(custody, t.signal, 0)).token;
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
  assert.deepEqual((await service.observe(custody, t.signal, 0)).token, accepted);

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
  await service.storeInitialGrant(custody, grant, t.signal);
  const material = driver.valueFor(custody.secret);
  const { version } = (await service.observe(custody, t.signal, 0)).token;
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
    assert.equal((await service.observe(custody, t.signal, 0)).token, undefined);
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
  assert.equal((await service.observe(custody, t.signal, 0)).token, undefined);
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
    (await worker.observe(custody, t.signal, 0)).token.version,
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
  await service.storeInitialGrant(custody, grant, t.signal);
  assert.equal((await worker.observe(custody, t.signal)).status.state, "ready");
  const refreshing = worker.renew(
    custody,
    t.signal,
    resolveClient,
    (await worker.observe(custody, t.signal, 0)).token.version,
  );
  await received.promise;
  // Retire the exact custody identity after the issuer consumed the old refresh token and before its reply.
  await service.delete(custody, t.signal);
  respond.resolve();
  await assert.rejects(refreshing, { message: "Secret does not exist." });
  assert.equal(driver.has(custody.secret), false);
});
