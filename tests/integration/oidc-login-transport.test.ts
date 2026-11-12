import assert from "node:assert/strict";
import test from "node:test";
import { humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import { oidcLoginConfiguration, oidcNonce } from "../../apps/controller/src/auth/oidc.ts";
import {
  assertSafeEqual,
  assertSafeThrows,
  callbackState,
  createIdTokenSigner,
  createLoginFixture,
  expectDenied,
  expectProviderUnavailable,
  loginOrigin as origin,
  loginSecret as secret,
  parseAuthorizationUrl,
  providerAttemptId,
  providerInstanceId,
  readProviderRequestBody,
  redirectProviderFetch,
  responseFields,
  startProviderServer,
  testOversizedProviderBodies,
  type LoginFixtureOptions,
  type ProviderHandler,
} from "../helpers/human-login-transport.ts";
import { refusingPort } from "../helpers/available-port.ts";

const subject = "auth0|65f0c1d2e3a4b5c6d7e8f901";
const environment = {
  OCC_AUTH_OIDC_ISSUER: "https://tenant.idp.example.test/",
  OCC_AUTH_OIDC_AUTHORIZATION_URL: "https://tenant.idp.example.test/authorize",
  OCC_AUTH_OIDC_TOKEN_URL: "https://tenant.idp.example.test/oauth/token",
  OCC_AUTH_OIDC_JWKS_URL: "https://tenant.idp.example.test/.well-known/jwks.json",
  OCC_AUTH_OIDC_CLIENT_ID: "fixture-oidc-client",
  OCC_AUTH_OIDC_CLIENT_SECRET: "fixture-oidc-client-secret",
};
const configuredOidc = oidcLoginConfiguration(environment);
assert.ok(configuredOidc, "OIDC fixture configuration was missing");
const { enrollment, ...oidc } = configuredOidc;
assert.equal(enrollment, undefined, "OIDC fixture must not configure enrollment");
const pinned = new Set([oidc.tokenUrl, oidc.jwksUrl]);

const providerId = providerInstanceId("oidc", { issuer: oidc.issuer, clientId: oidc.clientId });

const signer = createIdTokenSigner();
function idToken(state = callbackState, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign({
    iss: oidc.issuer,
    aud: oidc.clientId,
    sub: subject,
    iat: now - 5,
    exp: now + 3600,
    nonce: oidcNonce(secret, state),
    ...overrides,
  });
}

function loginFixture(providers: LoginFixtureOptions["providers"] = { oidc }) {
  return createLoginFixture({ provider: "oidc", providers });
}

test("OIDC sign-in configuration shares the recovery user with Google", () => {
  const recovery = { OCC_AUTH_RECOVERY_USER_ID: "recovery-user" };
  assertSafeEqual(
    humanLoginConfiguration({ ...environment, ...recovery }),
    {
      oidc: { ...oidc, recoveryUserId: "recovery-user" },
    },
    "sign-in configuration did not match",
  );
  assertSafeThrows(
    () => humanLoginConfiguration(environment),
    /OIDC sign-in requires its provider settings and a recovery user ID/,
  );
  assertSafeThrows(
    () => humanLoginConfiguration({ ...environment, OCC_AUTH_RECOVERY_USER_ID: " " }),
    /OIDC sign-in requires its provider settings and a recovery user ID/,
  );
});

test("OIDC login fetches only its pinned URLs and binds the ID token to the attempt", async (t) => {
  let serve: ProviderHandler = () => {
    throw new Error("Provider handler was not selected");
  };
  const { requests, port } = await startProviderServer(t, (request, response) =>
    serve(request, response),
  );
  const providerOrigin = `http://127.0.0.1:${port}`;
  // Only the pinned destinations are redirected to the fake IdP; anything else fails.
  redirectProviderFetch(t, pinned, providerOrigin);
  let exchange: URLSearchParams | undefined;
  const provider =
    (token = idToken()): ProviderHandler =>
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/oauth/token") {
        const body = await readProviderRequestBody(request);
        exchange = new URLSearchParams(body);
        response.end(JSON.stringify({ access_token: "fixture-access", id_token: token }));
      } else {
        assertSafeEqual(request.url, "/.well-known/jwks.json", "unexpected provider endpoint");
        response.end(JSON.stringify(signer.jwks));
      }
    };

  await t.test("start requests only openid with PKCE, state and nonce", async () => {
    const fixture = loginFixture();
    const response = await fixture.start();
    assert.equal(response.status, 200);
    const url = (await responseFields(response)).get("url");
    const authorization = parseAuthorizationUrl(url);
    assertSafeEqual(
      `${authorization.origin}${authorization.pathname}`,
      oidc.authorizationUrl,
      "authorization attempt did not match",
    );
    const parameters = authorization.searchParams;
    assertSafeEqual(parameters.get("scope"), "openid", "authorization attempt did not match");
    assertSafeEqual(
      parameters.get("client_id"),
      oidc.clientId,
      "authorization attempt did not match",
    );
    assertSafeEqual(parameters.get("response_type"), "code", "authorization attempt did not match");
    assertSafeEqual(
      parameters.get("code_challenge_method"),
      "S256",
      "authorization attempt did not match",
    );
    assertSafeEqual(
      parameters.get("redirect_uri"),
      `${origin}/api/auth/providers/oidc/callback`,
      "authorization attempt did not match",
    );
    const state = parameters.get("state");
    assert.ok(state !== null, "attempt state was missing");
    assertSafeEqual(
      parameters.get("nonce"),
      oidcNonce(secret, state),
      "authorization attempt did not match",
    );
    const [attempt] = fixture.attempts;
    // Rotating the client secret voids pending attempts but keeps enrollment.
    assert.ok(attempt, "start attempt was not recorded");
    assertSafeEqual(
      attempt.providerId,
      providerAttemptId(providerId, oidc.clientSecret),
      "authorization attempt did not match",
    );
    assert.equal(fixture.login.oidcProviderId, providerId);
    assertSafeEqual(
      fixture.login.oidcSignIn,
      {
        label: "single sign-on",
        authorizationUrl: oidc.authorizationUrl,
      },
      "sign-in configuration did not match",
    );
    assert.equal(fixture.login.googleProviderId, undefined);
    assert.equal((await fixture.start("10.0.0.1", "google")).status, 404);
  });

  await t.test("callback exchanges a 4,000-character code and snapshots (iss, sub)", async () => {
    const fixture = loginFixture();
    serve = provider();
    const code = "c".repeat(4000);
    const before = requests.length;
    await expectDenied(await fixture.callback(`state=${callbackState}&code=${code}`));
    // No session here (State is a fixture); the exchange and snapshot are what count.
    assertSafeEqual(
      requests.slice(before),
      ["/oauth/token", "/.well-known/jwks.json"],
      "provider request paths did not match",
    );
    assert.ok(exchange, "provider exchange was not observed");
    assertSafeEqual(exchange.get("code"), code, "exchange code did not match");
    assertSafeEqual(
      exchange.get("client_secret"),
      oidc.clientSecret,
      "exchange client secret did not match",
    );
    assertSafeEqual(
      fixture.subjects,
      [[providerId, subject]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(
      fixture.denials,
      [["EXTERNAL_IDENTITY_REJECTED", "oidc", { subject }]],
      "recorded identity observation did not match",
    );
  });

  await t.test("a code over 4,096 characters is refused before any exchange", async () => {
    const fixture = loginFixture();
    const before = requests.length;
    await expectDenied(await fixture.callback(`state=${callbackState}&code=${"c".repeat(4097)}`));
    assert.equal(requests.length, before);
    assertSafeEqual(fixture.denials, [], "recorded identity observation did not match");
    assert.deepEqual(fixture.unmatched, ["oidc"]);
  });

  await t.test("tokens for another issuer, client or nonce are rejected", async () => {
    for (const overrides of [
      { iss: "https://tenant.idp.example.test" },
      { aud: "other-client" },
      { nonce: "other" },
    ]) {
      const fixture = loginFixture();
      serve = provider(idToken(callbackState, overrides));
      await expectDenied(await fixture.callback());
      assertSafeEqual(fixture.subjects, [], "recorded identity observation did not match");
      assertSafeEqual(
        fixture.denials,
        [["EXTERNAL_IDENTITY_REJECTED", "oidc"]],
        "recorded identity observation did not match",
      );
    }
  });

  await t.test("a redirecting token endpoint is not followed", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(302, { location: `${providerOrigin}/elsewhere` });
      response.end();
    };
    const before = requests.length;
    await expectProviderUnavailable(await fixture.callback());
    assertSafeEqual(
      requests.slice(before),
      ["/oauth/token"],
      "provider request paths did not match",
    );
    assertSafeEqual(
      fixture.denials,
      [["PROVIDER_UNAVAILABLE", "oidc"]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(
      fixture.operationalLogs(),
      [unavailableLog({ step: "token", cause: "redirect" })],
      "operational log did not match",
    );
  });

  await testOversizedProviderBodies(t, {
    endpoints: [
      ["/oauth/token", "token"],
      ["/.well-known/jwks.json", "jwks"],
    ],
    serve: (handler) => {
      serve = handler;
    },
    provider,
    login: loginFixture,
  });

  await t.test("an unavailable JWKS logs one warning with the HTTP status", async () => {
    const fixture = loginFixture();
    serve = (request, response) => {
      if (request.url === "/oauth/token") {
        provider()(request, response);
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "jwks down", detail: "fixture-code" }));
    };
    await expectProviderUnavailable(await fixture.callback());
    assertSafeEqual(
      fixture.denials,
      [["PROVIDER_UNAVAILABLE", "oidc"]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(
      fixture.operationalLogs(),
      [unavailableLog({ step: "jwks", cause: "http_status", status: 503 })],
      "operational log did not match",
    );
    assertNoSecrets(fixture.operationalLogs());
  });

  await t.test("a provider-reported server_error logs the authorization step", async () => {
    const fixture = loginFixture();
    const before = requests.length;
    await expectProviderUnavailable(
      await fixture.callback(`state=${callbackState}&error=server_error&error_description=x`),
    );
    assert.equal(requests.length, before);
    assertSafeEqual(
      fixture.denials,
      [["PROVIDER_UNAVAILABLE", "oidc"]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(
      fixture.operationalLogs(),
      [unavailableLog({ step: "authorization", cause: "provider_error" })],
      "operational log did not match",
    );
  });

  await t.test("a rejected exchange is audited but logs no provider warning", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
    };
    await expectDenied(await fixture.callback());
    assertSafeEqual(
      fixture.denials,
      [["EXTERNAL_IDENTITY_REJECTED", "oidc"]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(fixture.operationalLogs(), [], "operational log did not match");
  });

  await t.test("a refused client secret logs one warning instead of a rejection", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_client", error_description: "fixture-code" }));
    };
    await expectProviderUnavailable(await fixture.callback());
    assertSafeEqual(
      fixture.denials,
      [["PROVIDER_UNAVAILABLE", "oidc"]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(
      fixture.operationalLogs(),
      [unavailableLog({ step: "token", cause: "client_rejected" })],
      "operational log did not match",
    );
    assertNoSecrets(fixture.operationalLogs());
  });

  await t.test("an unreadable 4xx token answer stays a rejection without a warning", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(401, { "content-type": "text/html" });
      response.end("<html>invalid_client</html>");
    };
    await expectDenied(await fixture.callback());
    assertSafeEqual(
      fixture.denials,
      [["EXTERNAL_IDENTITY_REJECTED", "oidc"]],
      "recorded identity observation did not match",
    );
    assertSafeEqual(fixture.operationalLogs(), [], "operational log did not match");
  });

  await t.test("Google and OIDC share the start budget", async () => {
    const fixture = loginFixture({
      oidc,
      google: { clientId: "g.apps.googleusercontent.com", clientSecret: "g", allowedDomains: [] },
    });
    for (let i = 0; i < 15; i += 1) {
      for (const name of ["google", "oidc"]) {
        assert.equal((await fixture.start("10.0.8.1", name)).status, 200);
      }
    }
    for (const name of ["google", "oidc"]) {
      assert.equal((await fixture.start("10.0.8.1", name)).status, 429);
    }
    assert.equal((await fixture.start("10.0.8.2")).status, 200);
  });
});

function unavailableLog(fields: Record<string, string | number>) {
  return {
    severity: "WARN",
    service: "occ-api",
    event: "authentication.provider-unavailable-warning",
    provider: "oidc",
    providerId,
    ...fields,
  };
}

function assertNoSecrets(lines: readonly Record<string, unknown>[]) {
  const text = JSON.stringify(lines);
  for (const value of [
    "fixture-code",
    oidc.clientSecret,
    "fixture-access",
    "tenant.idp.example.test",
    "127.0.0.1",
    "jwks down",
  ]) {
    assert.ok(!text.includes(value), "a credential or provider detail reached logs");
  }
}

test("an unreachable OIDC token endpoint logs connect_refused with its code", async (t) => {
  // A held port refuses connections; a released one could be taken by a parallel test.
  const refusing = await refusingPort();
  t.after(() => refusing.release());
  redirectProviderFetch(t, pinned, `http://127.0.0.1:${refusing.port}`);
  const fixture = loginFixture();
  await expectProviderUnavailable(await fixture.callback());
  assertSafeEqual(
    fixture.denials,
    [["PROVIDER_UNAVAILABLE", "oidc"]],
    "recorded identity observation did not match",
  );
  assertSafeEqual(
    fixture.operationalLogs(),
    [unavailableLog({ step: "token", cause: "connect_refused", code: "ECONNREFUSED" })],
    "operational log did not match",
  );
  assertNoSecrets(fixture.operationalLogs());
});

test("a TLS failure at the OIDC token endpoint logs cause tls", async (t) => {
  // A plain-HTTP listener answers the TLS handshake with garbage.
  const { port } = await startProviderServer(t, (_request, response) => response.end("{}"));
  redirectProviderFetch(t, pinned, `https://127.0.0.1:${port}`);
  const fixture = loginFixture();
  await expectProviderUnavailable(await fixture.callback());
  assertSafeEqual(
    fixture.denials,
    [["PROVIDER_UNAVAILABLE", "oidc"]],
    "recorded identity observation did not match",
  );
  const [line, ...rest] = fixture.operationalLogs();
  assertSafeEqual(rest, [], "operational log did not match");
  assert.ok(line, "provider warning was missing");
  assertSafeEqual(
    line.event,
    "authentication.provider-unavailable-warning",
    "operational log did not match",
  );
  assertSafeEqual(line.step, "token", "operational log did not match");
  assertSafeEqual(line.cause, "tls", "operational log did not match");
  assertNoSecrets(fixture.operationalLogs());
});
