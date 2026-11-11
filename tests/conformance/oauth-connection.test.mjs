import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  OAuthAccountTokens,
  OAuthGrantStore,
} from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  startBrowserAuthorization,
  exchangeAuthorizationCode,
} from "../../packages/occ/src/browser-authorization.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  refreshPinnedOAuthGrant,
} from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
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

test("access-token-only grants deliver usable tokens, omit renewal schedules, and guide reconnect on expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const requests = [];
  const accessToken = randomUUID();
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) {
      body.push(chunk);
    }
    requests.push(new URLSearchParams(Buffer.concat(body).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    // Issuer returns an access token without a refresh token.
    res.end(
      JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 120,
        scope: "read",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const issuer = "http://127.0.0.1:" + server.address().port;
  const request = {
    issuer,
    oauthClientId: "registration",
    requestedScopes: ["read"],
    tokenEndpointAuthMethod: "none",
    clientId: "test-client",
    scopes: ["read"],
    resource: "https://mcp.example.test/mcp",
    tokenUrl: issuer + "/token",
    redirectUri: "https://oce.example.test/callback",
  };

  const grant = await exchangeAuthorizationCode(
    request,
    "test-verifier",
    "test-code",
    undefined,
    t.signal,
  );
  assert.equal(grant.accessToken, accessToken);
  assert.equal(grant.refreshToken, undefined);
  assert.deepEqual(grant.grantedScopes, ["read"]);

  const { driver, custody, service, worker } = await oauthCustody();
  const resolveClient = async () => ({
    registration: request,
    readSecret: async () => assert.fail("public clients have no secret"),
  });

  await service.storeInitialGrant(custody, { ...request, ...grant }, t.signal);
  const stored = JSON.parse(driver.valueFor(custody.secret));
  assert.equal(Object.hasOwn(stored, "refreshToken"), false);
  assert.equal(Object.hasOwn(stored, "renewAt"), false);

  const initial = await worker.observe(custody, t.signal, 0);
  assert.equal(initial.status.state, "ready");
  assert.equal(initial.status.schedule, undefined);
  assert.equal(initial.token.accessToken, accessToken);
  assert.equal(initial.token.nextRefreshAt, undefined);
  assert.deepEqual(Object.keys(initial.token).sort(), [
    "accessToken",
    "expiresAt",
    "grantedScopes",
    "version",
  ]);

  // Before expiry, renewal attempts make no issuer requests and preserve the ready status.
  const beforeExpiry = await worker.renew(custody, t.signal, resolveClient);
  assert.equal(beforeExpiry.state, "ready");
  assert.equal(beforeExpiry.schedule, undefined);
  assert.equal(requests.length, 1);

  // Fast-forward past expiry: the token is no longer delivered and guides reconnect.
  t.mock.timers.tick(130_000);
  const expiredObservation = await worker.observe(custody, t.signal, 0);
  assert.equal(expiredObservation.token, undefined);
  assert.equal(expiredObservation.status.state, "failed");
  assert.equal(expiredObservation.status.failureCode, "access_token_expired");
  assert.equal(expiredObservation.status.recoveryAction, "reauthorize");

  // Renewal after expiry records the failure in custody without sending upstream requests.
  const expiredRenew = await service.renew(custody, t.signal, resolveClient);
  assert.equal(expiredRenew.state, "failed");
  assert.equal(expiredRenew.failureCode, "access_token_expired");
  assert.equal(expiredRenew.recoveryAction, "reauthorize");
  assert.equal(requests.length, 1, "no renewal request must be sent for non-renewable grants");

  const postRenewObservation = await worker.observe(custody, t.signal, 0);
  assert.equal(postRenewObservation.token, undefined);
  assert.equal(postRenewObservation.status.state, "failed");
  assert.equal(postRenewObservation.status.failureCode, "access_token_expired");
  assert.equal(postRenewObservation.status.recoveryAction, "reauthorize");
});

test("pre-upgrade renewable OAuth custody JSON remains readable, resolvable, and renewable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const refreshedToken = randomUUID();
  const rotatedGrant = randomUUID();
  let upstreamCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    upstreamCalls++;
    return Response.json({
      access_token: refreshedToken,
      token_type: "Bearer",
      expires_in: 300,
      refresh_token: rotatedGrant,
      scope: "read",
    });
  });

  const driver = { ...createTestSecretDriver(), capability: "secret" };
  const store = new OAuthGrantStore(driver, refreshPinnedOAuthGrant);
  const custody = await store.reserve({ namespaceId: "ns_legacy", sourceId: "src_legacy" });
  const resolveClient = async () => ({
    registration: {
      issuer: "https://issuer.example.test",
      tokenUrl: "https://issuer.example.test/token",
      oauthClientId: "oac_legacy",
      tokenEndpointAuthMethod: "none",
      clientId: "legacy-client",
    },
    readSecret: async () => assert.fail("public clients have no secret"),
  });

  // Seed pre-upgrade renewable ready custody JSON directly to verify schema compatibility.
  const preUpgradeReady = {
    issuer: "https://issuer.example.test",
    oauthClientId: "oac_legacy",
    clientId: "legacy-client",
    tokenUrl: "https://issuer.example.test/token",
    tokenEndpointAuthMethod: "none",
    requestedScopes: ["read"],
    grantedScopes: ["read"],
    accessToken: "legacy-access-token",
    refreshToken: "legacy-refresh-token",
    renewAt: new Date(Date.now() + 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    phase: "ready",
    sourceId: custody.sourceId,
    namespaceId: custody.secret.namespaceId,
    version: "legacy-version-1",
  };
  await driver.update(custody.secret, JSON.stringify(preUpgradeReady));

  const readyObs = await store.observe(custody, t.signal, 30_000);
  assert.equal(readyObs.renewable, true);
  assert.equal(readyObs.status.state, "ready");
  assert.equal(readyObs.status.schedule?.version, "legacy-version-1");
  assert.equal(readyObs.token?.accessToken, "legacy-access-token");

  // Pre-upgrade renewing JSON stays pending without clearing schedule or replaying the grant.
  await driver.update(
    custody.secret,
    JSON.stringify({
      ...preUpgradeReady,
      phase: "renewing",
      renewalDeadline: new Date(Date.now() + 30_000).toISOString(),
    }),
  );
  const renewingObs = await store.observe(custody, t.signal, 0);
  assert.equal(renewingObs.renewable, true);
  assert.equal(renewingObs.status.state, "pending");
  // An in-flight renewal keeps delivering the unexpired access token until terminal commit.
  assert.equal(renewingObs.token?.accessToken, "legacy-access-token");

  // Pre-upgrade client retry and terminal failed phases preserve their recovery semantics.
  await driver.update(
    custody.secret,
    JSON.stringify({
      ...preUpgradeReady,
      phase: "client_unavailable",
      renewAt: new Date(Date.now() + 10_000).toISOString(),
    }),
  );
  const retryObs = await store.observe(custody, t.signal, 0);
  assert.equal(retryObs.renewable, true);
  assert.deepEqual(retryObs.status, {
    state: "failed",
    failureCode: "client_unavailable",
    recoveryAction: "retry",
    nextRefreshAt: retryObs.status.nextRefreshAt,
    schedule: {
      version: "legacy-version-1",
      nextRefreshAt: retryObs.status.nextRefreshAt,
      grantedScopes: ["read"],
    },
    expiresAt: preUpgradeReady.expiresAt,
  });

  // Restore ready state inside the renewal window and confirm pre-upgrade grants still renew cleanly.
  await driver.update(
    custody.secret,
    JSON.stringify({
      ...preUpgradeReady,
      renewAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  const renewed = await store.renew(custody, t.signal, resolveClient);
  assert.equal(renewed.state, "ready");
  assert.equal(upstreamCalls, 1);
  assert.equal((await store.observe(custody, t.signal, 0)).token?.accessToken, refreshedToken);

  await driver.update(
    custody.secret,
    JSON.stringify({
      phase: "failed",
      namespaceId: custody.secret.namespaceId,
      sourceId: custody.sourceId,
      failureCode: "grant_refused",
    }),
  );
  const failedObs = await store.observe(custody, t.signal, 0);
  assert.equal(failedObs.renewable, false);
  assert.deepEqual(failedObs.status, {
    state: "failed",
    failureCode: "grant_refused",
    recoveryAction: "reauthorize",
  });
});

test("OAuthAccountTokens stops resolution immediately for short non-renewable lifetimes and clears due schedules", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const secretDriver = { ...createTestSecretDriver(), capability: "secret" };
  const adminId = "principal-nonrenewable-admin";
  const adminPrincipal = {
    kind: "principal",
    id: adminId,
    subject: adminId,
    issuer: "https://console.oce.localhost",
    displayName: "Non-renewable Test Admin",
  };
  const iamState = {
    identities: [adminPrincipal],
    groups: [],
    memberships: [],
    roles: [
      {
        id: "role-admin",
        name: "Administrator",
        permissions: [
          { resourceKind: "installation", action: "administer" },
          { resourceKind: "namespace", action: "create" },
          { resourceKind: "namespace", action: "read" },
          { resourceKind: "credential_source", action: "create" },
          { resourceKind: "credential_source", action: "read" },
          { resourceKind: "credential_source", action: "operate" },
          { resourceKind: "credential_source", action: "update" },
        ],
      },
    ],
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: adminId,
        roleId: "role-admin",
      },
    ],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "iam-oauth-direct-test" },
  );
  const state = new InMemoryPlatformState({ iamIdentities: [adminPrincipal] });
  const installation = {
    id: "ins_" + randomUUID(),
    name: "Non-renewable maintenance test",
    createdAt: new Date().toISOString(),
  };
  const preparedTokens = new TokenService();
  const controller = new OpenClawController(installation, { state, preparedTokens });
  controller.registerDriver(iamDriver);
  controller.selectDriver("iam", iamDriver.id);
  controller.registerDriver(secretDriver);
  controller.selectDriver("secret", secretDriver.id);
  controller.registerDriver(createTestConfigurationDriver({ id: "cfg-direct-oauth" }));
  controller.selectDriver("configuration", "cfg-direct-oauth");
  controller.registerDriver(createReadyComputeDriver("compute-direct-oauth"));
  controller.selectDriver("compute", "compute-direct-oauth");

  let resolveCalls = 0;
  let allowResolve = true;
  const resolveClient = async (...args) => {
    resolveCalls++;
    assert.ok(allowResolve, "non-renewable grant maintenance must not resolve an upstream client");
    return controller.resolveConnectionClient(...args);
  };
  const tokens = new OAuthAccountTokens(state, secretDriver, resolveClient);
  preparedTokens.registerIssuer(tokens);

  await state.transact((unit) => unit.installations.createInstallation(installation));
  const namespace = await controller.createNamespace(adminId, { name: "Tokens" });
  await controller.handleNamespaceLifecycle(adminId, namespace.id, "ready");
  const namespaceId = namespace.id;

  const issuer = "https://issuer.example.test";
  const template = await controller.createConnectionTemplate(adminId, {
    namespaceId,
    displayName: "Short-lived OAuth",
    mode: "manual",
    issuer,
    authorizationUrl: `${issuer}/authorize`,
    tokenUrl: `${issuer}/token`,
    destinations: [{ host: "api.issuer.example.test", port: 443, path: "/v1/**" }],
    scopes: ["read"],
  });
  await controller.createOAuthClient(adminId, {
    connectionTemplateId: template.id,
    connectionTemplateVersion: template.current.version,
    displayName: "Public Client",
    clientId: "test-client",
    tokenEndpointAuthMethod: "none",
  });

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      access_token: "short-lived-access",
      token_type: "Bearer",
      expires_in: 120,
      scope: "read",
    }),
  );
  const sessionId = "sess-" + randomUUID();
  const started = await controller.startNamespaceConnection(adminId, {
    namespaceId,
    connectionTemplateId: template.id,
    redirectUri: "https://console.oce.localhost/oauth/callback",
    sessionId,
  });
  const stateParam = new URL(started.authorizationUrl).searchParams.get("state");
  assert.ok(stateParam);
  const connected = await controller.completeNamespaceConnection(adminId, {
    state: stateParam,
    sessionId,
    code: "code-1",
  });
  const sourceId = connected.credentialSourceId;
  const ref = { kind: "oauth_refresh_token", namespaceId, sourceId };
  assert.equal(resolveCalls, 1);
  allowResolve = false;

  // Move to 20s remaining while caller requests 30s minimum validity: must return undefined
  // in a single pass with zero maintenance transactions or renewal loop iterations.
  t.mock.timers.tick(100_000);
  const withValueSpy = t.mock.method(secretDriver, "withValue");
  const transactSpy = t.mock.method(state, "transact");
  const insufficient = await tokens.resolve(ref, {
    signal: t.signal,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    minimumValidityMs: 30_000,
  });
  assert.equal(insufficient, undefined);
  assert.equal(withValueSpy.mock.callCount(), 1);
  assert.equal(transactSpy.mock.callCount(), 0);
  withValueSpy.mock.restore();
  transactSpy.mock.restore();

  // Marking a non-renewable grant due must be cleared by maintenance so workers do not re-poll it.
  await state.transact((unit) =>
    unit.savedConnections.recordTokenSchedule(namespaceId, sourceId, "due"),
  );
  const beforeMaintain = await state.read((view) =>
    view.savedConnections.listDueConnectionTokens(installation.id, 10),
  );
  assert.equal(beforeMaintain.length, 1);

  const maintained = await tokens.maintain(ref, t.signal);
  assert.equal(maintained?.state, "ready");
  assert.equal(maintained?.schedule, undefined);
  const afterMaintain = await state.read((view) =>
    view.savedConnections.listDueConnectionTokens(installation.id, 10),
  );
  assert.deepEqual(afterMaintain, []);
});

test("shipped OCC HTTP routes enforce callback session custody, non-renewable lifecycle, rotation refusal, expiry reconnect, and disconnect fencing", async (t) => {
  const origin = "https://console.oce.localhost";
  const now = new Date("2026-01-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });

  const installationId = `ins_${randomUUID()}`;
  const adminAuth = await createTestAuthPrincipal({
    installationId,
    baseURL: origin,
    email: `admin-${randomUUID()}@example.com`,
    password: `generated-password-${randomUUID()}`,
    name: "OAuth Test Administrator",
  });
  const intruderEmail = `intruder-${randomUUID()}@example.com`;
  const intruderPassword = `generated-password-${randomUUID()}`;
  const intruderAccount = await adminAuth.auth.createAccount({
    email: intruderEmail,
    password: intruderPassword,
    name: "Wrong Session User",
  });
  const intruderSeed = adminAuth.auth.principalSeed(intruderAccount, { grant: "none" });
  const iamState = {
    identities: [adminAuth.seed.principal, intruderSeed.principal],
    groups: [],
    memberships: [],
    roles: adminAuth.seed.roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: adminAuth.seed.principal.id,
        roleId: adminAuth.seed.roles[0].id,
      },
    ],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "iam-oauth-http-test" },
  );
  const auditSink = new InMemoryAuditSink();
  const secretDriver = {
    ...createTestSecretDriver({ id: "secret-oauth-http" }),
    capability: "secret",
  };
  const state = new InMemoryPlatformState({
    auditSink,
    iamIdentities: [adminAuth.seed.principal, intruderSeed.principal],
  });
  const preparedTokens = new TokenService();
  let controller;

  const app = createControllerApp({
    createController(installation) {
      controller = new OpenClawController(installation, {
        state,
        preparedTokens,
        recordOperations: false,
      });
      preparedTokens.registerIssuer(
        new OAuthAccountTokens(
          state,
          secretDriver,
          controller.resolveConnectionClient.bind(controller),
        ),
      );
      return controller;
    },
    iamDriver,
    computeDriver: createReadyComputeDriver("compute-oauth-http"),
    configurationDriver: createTestConfigurationDriver({ id: "config-oauth-http" }),
    secretDriver,
    resolveHarness: resolveApprovedDevelopmentHarness,
    auditSink,
    publicOrigin: origin,
    development: {
      enabled: true,
      installationId,
      browserOrigin: origin,
    },
    auth: adminAuth.auth,
  });
  const adminSession = await signInToControllerApp(app, adminAuth, { origin });
  const intruderSession = await signInToControllerApp(
    app,
    { email: intruderEmail, password: intruderPassword },
    { origin },
  );

  const callAs =
    (session) =>
    async (method, url, payload, extraHeaders = {}) => {
      const hasBody = payload !== undefined;
      const response = await app.fetch(
        new Request(`${origin}${url}`, {
          method,
          headers: {
            ...authenticatedHeaders(session),
            ...(hasBody ? { "content-type": "application/json" } : {}),
            ...extraHeaders,
          },
          ...(hasBody ? { body: JSON.stringify(payload) } : {}),
        }),
      );
      const body = response.status === 204 ? "" : await response.text();
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        json() {
          return JSON.parse(body);
        },
      };
    };
  const admin = callAs(adminSession);
  const intruder = callAs(intruderSession);

  // Bootstrap installation, create a ready namespace, manual template, and public OAuth client.
  const bootstrapRes = await admin("POST", "/installation/bootstrap", {
    name: "Non-renewable OAuth Installation",
  });
  assert.equal(bootstrapRes.statusCode, 201, bootstrapRes.body);
  const nsRes = await admin("POST", "/namespaces", { name: "Non-renewable OAuth" });
  assert.equal(nsRes.statusCode, 201, nsRes.body);
  const namespaceId = nsRes.json().data.id;
  await controller.handleNamespaceLifecycle(adminAuth.seed.principal.id, namespaceId, "ready");

  const issuer = "https://provider.example.test";
  const tplRes = await admin("POST", "/connection-templates", {
    namespaceId,
    displayName: "Access-token-only provider",
    mode: "manual",
    issuer,
    authorizationUrl: `${issuer}/authorize`,
    tokenUrl: `${issuer}/token`,
    destinations: [{ host: "api.provider.example.test", port: 443, path: "/v1/**" }],
    scopes: ["read"],
  });
  assert.equal(tplRes.statusCode, 201, tplRes.body);
  const templateId = tplRes.json().data.id;

  const clientRes = await admin("POST", "/oauth-clients", {
    connectionTemplateId: templateId,
    connectionTemplateVersion: tplRes.json().data.current.version,
    displayName: "Public client",
    clientId: "public-client-1",
    tokenEndpointAuthMethod: "none",
  });
  assert.equal(clientRes.statusCode, 201, clientRes.body);

  // External OAuth token endpoint issues access-token-only grants (no refresh_token).
  const issuedTokens = [];
  let nextToken = "access-token-initial-" + randomUUID();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) !== `${issuer}/token`) {
      throw new Error(`Unexpected upstream URL: ${String(url)}`);
    }
    issuedTokens.push({ url: String(url), body: init?.body?.toString?.() });
    return Response.json({
      access_token: nextToken,
      token_type: "Bearer",
      expires_in: 120,
      scope: "read",
    });
  });

  // 1) Wrong-session callback must be rejected without redeeming the code or creating custody.
  const firstAttempt = await admin("POST", `/namespaces/${namespaceId}/connections`, {
    connectionTemplateId: templateId,
  });
  assert.equal(firstAttempt.statusCode, 201, firstAttempt.body);
  const firstState = new URL(firstAttempt.json().data.authorizationUrl).searchParams.get("state");
  assert.ok(firstState);

  const hijackedCallback = await intruder(
    "GET",
    `/oauth/callback?state=${encodeURIComponent(firstState)}&code=auth-code-1`,
  );
  assert.equal(hijackedCallback.statusCode, 303);
  assert.match(String(hijackedCallback.headers.location), /reason=unknown_session/);
  assert.equal(issuedTokens.length, 0, "wrong session callback must not redeem authorization code");
  assert.deepEqual((await admin("GET", `/namespaces/${namespaceId}/connections`)).json().data, []);

  // 2) Legitimate owner consent stores the access-token-only grant without a due schedule.
  const firstCallback = await admin(
    "GET",
    `/oauth/callback?state=${encodeURIComponent(firstState)}&code=auth-code-1`,
  );
  assert.equal(firstCallback.statusCode, 303);
  assert.match(String(firstCallback.headers.location), /connection=connected/);
  assert.equal(issuedTokens.length, 1);

  const listed = (await admin("GET", `/namespaces/${namespaceId}/connections`)).json().data;
  assert.equal(listed.length, 1);
  const sourceId = listed[0].credentialSourceId;
  const sourceDetail = (
    await admin("GET", `/namespaces/${namespaceId}/credential-sources/${sourceId}`)
  ).json().data;
  assert.equal(sourceDetail.ownerCapability, "token_service");
  assert.equal(sourceDetail.state, "ready");
  assert.equal(sourceDetail.status.state, "ready");
  assert.equal(sourceDetail.status.refresh.state, "ready");
  assert.equal(sourceDetail.status.refresh.schedule, undefined);
  assert.deepEqual(
    await state.read((view) => view.savedConnections.listDueConnectionTokens(installationId, 10)),
    [],
  );

  // 3) TokenService resolves the non-renewable bearer while remaining lifetime suffices,
  // and immediately refuses without contacting upstream when remaining lifetime is shorter.
  const ref = { kind: "oauth_refresh_token", namespaceId, sourceId };
  const resolvedInitial = await preparedTokens.resolve(ref, {
    signal: t.signal,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    minimumValidityMs: 0,
  });
  assert.equal(resolvedInitial?.accessToken, nextToken);
  assert.equal(resolvedInitial?.nextRefreshAt, undefined);

  const unrefreshableShort = await preparedTokens.resolve(ref, {
    signal: t.signal,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    minimumValidityMs: 150_000,
  });
  assert.equal(unrefreshableShort, undefined);
  assert.equal(issuedTokens.length, 1);

  // 4) Manual rotation on an unexpired non-renewable account retires any due schedule, rejects
  // with 409 reconnect guidance, and logs a failure audit rather than falsely reporting 200 OK.
  const auditCountBeforeRotate = auditSink.events.length;
  const rotateRes = await admin(
    "POST",
    `/namespaces/${namespaceId}/credential-sources/${sourceId}/rotate`,
  );
  assert.equal(rotateRes.statusCode, 409, rotateRes.body);
  assert.match(rotateRes.body, /no refresh grant.*reconnect/i);
  assert.equal(
    auditSink.events
      .slice(auditCountBeforeRotate)
      .some(
        (entry) =>
          entry.resource.id === sourceId &&
          entry.outcome === "failure" &&
          entry.reasonCode === "CREDENTIAL_REFRESH_ROTATION_FAILED",
      ),
    true,
  );
  assert.equal(JSON.stringify(auditSink.events).includes(nextToken), false);
  assert.deepEqual(
    await state.read((view) => view.savedConnections.listDueConnectionTokens(installationId, 10)),
    [],
  );

  // 5) After access token expiry, status reports access_token_expired/reauthorize, rotation still
  // rejects 409 with cleared schedule, and reconnecting replaces the grant cleanly.
  t.mock.timers.tick(130_000);
  const expiredDetail = (
    await admin("GET", `/namespaces/${namespaceId}/credential-sources/${sourceId}`)
  ).json().data;
  assert.equal(expiredDetail.status.state, "failed");
  assert.equal(expiredDetail.status.refresh.failureCode, "access_token_expired");
  assert.equal(expiredDetail.status.refresh.recoveryAction, "reauthorize");
  assert.equal(
    await preparedTokens.resolve(ref, {
      signal: t.signal,
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      minimumValidityMs: 0,
    }),
    undefined,
  );
  const expiredRotate = await admin(
    "POST",
    `/namespaces/${namespaceId}/credential-sources/${sourceId}/rotate`,
  );
  assert.equal(expiredRotate.statusCode, 409, expiredRotate.body);
  assert.deepEqual(
    await state.read((view) => view.savedConnections.listDueConnectionTokens(installationId, 10)),
    [],
  );

  // Reconnect produces a fresh access-token-only account that resolves the replacement bearer.
  nextToken = "access-token-reconnected-" + randomUUID();
  const reconnectAttempt = await admin("POST", `/namespaces/${namespaceId}/connections`, {
    connectionTemplateId: templateId,
  });
  assert.equal(reconnectAttempt.statusCode, 201, reconnectAttempt.body);
  const reconnectState = new URL(reconnectAttempt.json().data.authorizationUrl).searchParams.get(
    "state",
  );
  const reconnectCallback = await admin(
    "GET",
    `/oauth/callback?state=${encodeURIComponent(reconnectState)}&code=auth-code-2`,
  );
  assert.equal(reconnectCallback.statusCode, 303);
  assert.match(String(reconnectCallback.headers.location), /connection=connected/);

  const reconnectedList = (await admin("GET", `/namespaces/${namespaceId}/connections`)).json()
    .data;
  const freshId = reconnectedList.find(
    (row) => row.credentialSourceId !== sourceId,
  )?.credentialSourceId;
  assert.ok(freshId);
  const freshRef = { kind: "oauth_refresh_token", namespaceId, sourceId: freshId };
  assert.equal(
    (
      await preparedTokens.resolve(freshRef, {
        signal: t.signal,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        minimumValidityMs: 0,
      })
    )?.accessToken,
    nextToken,
  );

  // 6) Disconnect commits mid-read must withhold releasing the already-read access token.
  const custodyBeforeDisconnect = await state.read((view) =>
    view.savedConnections.findTokenCustody(namespaceId, freshId),
  );
  assert.ok(custodyBeforeDisconnect);
  assert.equal(secretDriver.has(custodyBeforeDisconnect.secret), true);

  const readStarted = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const originalWithValue = secretDriver.withValue.bind(secretDriver);
  t.mock.method(
    secretDriver,
    "withValue",
    async (...args) => {
      const value = await originalWithValue(...args);
      readStarted.resolve();
      await releaseRead.promise;
      return value;
    },
    { times: 1 },
  );

  const inFlightResolve = preparedTokens.resolve(freshRef, {
    signal: t.signal,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    minimumValidityMs: 0,
  });
  await readStarted.promise;

  const disconnected = await admin("DELETE", `/namespaces/${namespaceId}/connections/${freshId}`);
  assert.equal(disconnected.statusCode, 204, disconnected.body);
  releaseRead.resolve();

  assert.equal(
    await inFlightResolve,
    undefined,
    "concurrent disconnect must fence an in-flight resolve before bearer release",
  );
  assert.equal(secretDriver.has(custodyBeforeDisconnect.secret), false);
});
