import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import { oidcLoginConfiguration, oidcNonce } from "../../apps/controller/src/auth/oidc.ts";
import {
  callbackState,
  createIdTokenSigner,
  createLoginFixture,
  expectDenied,
  loginOrigin as origin,
  loginSecret as secret,
  redirectProviderFetch,
  startProviderServer,
} from "../helpers/human-login-transport.mjs";
import { availablePort } from "../helpers/available-port.mjs";

const subject = "auth0|65f0c1d2e3a4b5c6d7e8f901";
const environment = {
  OCC_AUTH_OIDC_ISSUER: "https://tenant.idp.example.test/",
  OCC_AUTH_OIDC_AUTHORIZATION_URL: "https://tenant.idp.example.test/authorize",
  OCC_AUTH_OIDC_TOKEN_URL: "https://tenant.idp.example.test/oauth/token",
  OCC_AUTH_OIDC_JWKS_URL: "https://tenant.idp.example.test/.well-known/jwks.json",
  OCC_AUTH_OIDC_CLIENT_ID: "fixture-oidc-client",
  OCC_AUTH_OIDC_CLIENT_SECRET: "fixture-oidc-client-secret",
};
const oidc = oidcLoginConfiguration(environment);
const pinned = new Set([oidc.tokenUrl, oidc.jwksUrl]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
const providerId = `oidc:${digest(`${oidc.issuer}\0${oidc.clientId}`)}`;

const signer = createIdTokenSigner();
function idToken(state = callbackState, overrides = {}) {
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

function loginFixture(providers = { oidc }) {
  return createLoginFixture({ provider: "oidc", providers });
}

test("OIDC sign-in configuration shares the recovery user with GitHub and Google", () => {
  const recovery = { OCC_AUTH_GITHUB_RECOVERY_USER_ID: "recovery-user" };
  assert.deepEqual(humanLoginConfiguration({ ...environment, ...recovery }), {
    oidc: { ...oidc, recoveryUserId: "recovery-user" },
  });
  assert.throws(
    () => humanLoginConfiguration(environment),
    /OIDC sign-in requires its provider settings and a recovery user ID/,
  );
  assert.throws(
    () => humanLoginConfiguration({ ...environment, OCC_AUTH_GITHUB_RECOVERY_USER_ID: " " }),
    /OIDC sign-in requires its provider settings and a recovery user ID/,
  );
});

test("OIDC login fetches only its pinned URLs and binds the ID token to the attempt", async (t) => {
  let serve;
  const { requests, port } = await startProviderServer(t, (request, response) =>
    serve(request, response),
  );
  const providerOrigin = `http://127.0.0.1:${port}`;
  // Only the pinned destinations are redirected to the fake IdP; anything else fails.
  redirectProviderFetch(t, pinned, providerOrigin);
  let exchange;
  const provider =
    (token = idToken()) =>
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/oauth/token") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        exchange = new URLSearchParams(body);
        response.end(JSON.stringify({ access_token: "fixture-access", id_token: token }));
      } else {
        assert.equal(request.url, "/.well-known/jwks.json");
        response.end(JSON.stringify(signer.jwks));
      }
    };

  await t.test("start requests only openid with PKCE, state and nonce", async () => {
    const fixture = loginFixture();
    const response = await fixture.start();
    assert.equal(response.status, 200);
    const { url } = await response.json();
    const authorization = new URL(url);
    assert.equal(`${authorization.origin}${authorization.pathname}`, oidc.authorizationUrl);
    const parameters = authorization.searchParams;
    assert.equal(parameters.get("scope"), "openid");
    assert.equal(parameters.get("client_id"), oidc.clientId);
    assert.equal(parameters.get("response_type"), "code");
    assert.equal(parameters.get("code_challenge_method"), "S256");
    assert.equal(parameters.get("redirect_uri"), `${origin}/api/auth/providers/oidc/callback`);
    assert.equal(parameters.get("nonce"), oidcNonce(secret, parameters.get("state")));
    const [attempt] = fixture.attempts;
    // Rotating the client secret voids pending attempts but keeps enrollment.
    assert.equal(attempt.providerId, `${providerId}:${digest(oidc.clientSecret)}`);
    assert.equal(fixture.login.oidcProviderId, providerId);
    assert.deepEqual(fixture.login.oidcSignIn, {
      label: "single sign-on",
      authorizationUrl: oidc.authorizationUrl,
    });
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
    assert.deepEqual(requests.slice(before), ["/oauth/token", "/.well-known/jwks.json"]);
    assert.equal(exchange.get("code"), code);
    assert.equal(exchange.get("client_secret"), oidc.clientSecret);
    assert.deepEqual(fixture.subjects, [[providerId, subject]]);
    assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
  });

  await t.test("a code over 4,096 characters is refused before any exchange", async () => {
    const fixture = loginFixture();
    const before = requests.length;
    await expectDenied(await fixture.callback(`state=${callbackState}&code=${"c".repeat(4097)}`));
    assert.equal(requests.length, before);
    assert.deepEqual(fixture.denials, []);
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
      assert.deepEqual(fixture.subjects, []);
      assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
    }
  });

  await t.test("a redirecting token endpoint is not followed", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(302, { location: `${providerOrigin}/elsewhere` });
      response.end();
    };
    const before = requests.length;
    await expectDenied(await fixture.callback());
    assert.deepEqual(requests.slice(before), ["/oauth/token"]);
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.operationalLogs(), [
      unavailableLog({ step: "token", cause: "redirect" }),
    ]);
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
    await expectDenied(await fixture.callback());
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.operationalLogs(), [
      unavailableLog({ step: "jwks", cause: "http_status", status: 503 }),
    ]);
    assertNoSecrets(fixture.operationalLogs());
  });

  await t.test("a provider-reported server_error logs the authorization step", async () => {
    const fixture = loginFixture();
    const before = requests.length;
    await expectDenied(
      await fixture.callback(`state=${callbackState}&error=server_error&error_description=x`),
    );
    assert.equal(requests.length, before);
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.operationalLogs(), [
      unavailableLog({ step: "authorization", cause: "provider_error" }),
    ]);
  });

  await t.test("a rejected exchange is audited but logs no provider warning", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
    };
    await expectDenied(await fixture.callback());
    assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
    assert.deepEqual(fixture.operationalLogs(), []);
  });

  await t.test("a refused client secret logs one warning instead of a rejection", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_client", error_description: "fixture-code" }));
    };
    await expectDenied(await fixture.callback());
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.operationalLogs(), [
      unavailableLog({ step: "token", cause: "client_rejected" }),
    ]);
    assertNoSecrets(fixture.operationalLogs());
  });

  await t.test("an unreadable 4xx token answer stays a rejection without a warning", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(401, { "content-type": "text/html" });
      response.end("<html>invalid_client</html>");
    };
    await expectDenied(await fixture.callback());
    assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
    assert.deepEqual(fixture.operationalLogs(), []);
  });

  await t.test("GitHub, Google and OIDC share the start budget", async () => {
    const fixture = loginFixture({
      oidc,
      github: { clientId: "github-client", clientSecret: "github-secret" },
      google: { clientId: "g.apps.googleusercontent.com", clientSecret: "g", allowedDomains: [] },
    });
    for (let i = 0; i < 10; i += 1) {
      for (const name of ["github", "google", "oidc"]) {
        assert.equal((await fixture.start("10.0.8.1", name)).status, 200);
      }
    }
    for (const name of ["github", "google", "oidc"]) {
      assert.equal((await fixture.start("10.0.8.1", name)).status, 429);
    }
    assert.equal((await fixture.start("10.0.8.2")).status, 200);
  });
});

function unavailableLog(fields) {
  return {
    severity: "WARN",
    service: "occ-api",
    event: "authentication.provider-unavailable-warning",
    provider: "oidc",
    providerId,
    ...fields,
  };
}

function assertNoSecrets(lines) {
  const text = JSON.stringify(lines);
  for (const value of [
    "fixture-code",
    oidc.clientSecret,
    "fixture-access",
    "tenant.idp.example.test",
    "127.0.0.1",
    "jwks down",
  ]) {
    assert.ok(!text.includes(value), `log leaked ${value}`);
  }
}

test("an unreachable OIDC token endpoint logs connect_refused with its code", async (t) => {
  // A port that was just released refuses connections.
  const port = await availablePort();
  redirectProviderFetch(t, pinned, `http://127.0.0.1:${port}`);
  const fixture = loginFixture();
  await expectDenied(await fixture.callback());
  assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
  assert.deepEqual(fixture.operationalLogs(), [
    unavailableLog({ step: "token", cause: "connect_refused", code: "ECONNREFUSED" }),
  ]);
  assertNoSecrets(fixture.operationalLogs());
});

test("a TLS failure at the OIDC token endpoint logs cause tls", async (t) => {
  // A plain-HTTP listener answers the TLS handshake with garbage.
  const { port } = await startProviderServer(t, (_request, response) => response.end("{}"));
  redirectProviderFetch(t, pinned, `https://127.0.0.1:${port}`);
  const fixture = loginFixture();
  await expectDenied(await fixture.callback());
  assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
  const [line, ...rest] = fixture.operationalLogs();
  assert.deepEqual(rest, []);
  assert.equal(line.event, "authentication.provider-unavailable-warning");
  assert.equal(line.step, "token");
  assert.equal(line.cause, "tls");
  assertNoSecrets(fixture.operationalLogs());
});
