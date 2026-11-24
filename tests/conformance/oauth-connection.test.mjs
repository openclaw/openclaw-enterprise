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
import { registerOAuthRenewalRefusalCases } from "./oauth-renewal-refusal-cases.ts";

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

/** @import { OAuthConnectionGrant, OAuthConnectionRegistration } from "@openclaw-enterprise/contracts" */

/**
 * @param {string} issuer
 * @returns {OAuthConnectionRegistration & OAuthConnectionGrant}
 */
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

registerOAuthRenewalRefusalCases({ oauthCustody, connectionGrant });

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
