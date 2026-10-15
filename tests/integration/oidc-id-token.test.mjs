import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyIdToken } from "../../apps/controller/src/auth/id-token.ts";
import {
  exchangeOidcSubject,
  oidcLoginConfiguration,
  oidcNonce,
  oidcProviderId,
} from "../../apps/controller/src/auth/oidc.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { encodeSegment as encode, idTokenSigner, rsaSigningKey } from "../helpers/id-token.mjs";

// An Auth0-shaped issuer: the trailing slash is part of `iss`.
const issuer = "https://tenant.idp.example.test/";
const clientId = "fixture-oidc-client";
const subject = "auth0|65f0c1d2e3a4b5c6d7e8f901";
const nonce = oidcNonce("test-only-authentication-secret", "s".repeat(43));
const now = Date.UTC(2030, 0, 1);
const seconds = Math.floor(now / 1000);
const environment = {
  OCC_AUTH_OIDC_ISSUER: issuer,
  OCC_AUTH_OIDC_AUTHORIZATION_URL: "https://tenant.idp.example.test/authorize",
  OCC_AUTH_OIDC_TOKEN_URL: "https://tenant.idp.example.test/oauth/token",
  OCC_AUTH_OIDC_JWKS_URL: "https://tenant.idp.example.test/.well-known/jwks.json",
  OCC_AUTH_OIDC_CLIENT_ID: clientId,
  OCC_AUTH_OIDC_CLIENT_SECRET: "fixture-oidc-secret",
};

const current = rsaSigningKey("current-kid");
const other = rsaSigningKey("other-kid");
const weak = rsaSigningKey("weak-kid", 1024);
const jwks = { keys: [other.jwk, current.jwk, weak.jwk] };
const sign = idTokenSigner(current);

function claims(overrides = {}) {
  return {
    iss: issuer,
    aud: clientId,
    sub: subject,
    iat: seconds - 10,
    exp: seconds + 3600,
    nonce,
    ...overrides,
  };
}

function token(payload = claims(), options) {
  return sign(payload, options);
}

function verified(value, expected = {}) {
  return verifyIdToken(value, {
    issuers: new Set([issuer]),
    clientId,
    nonce,
    jwks,
    now,
    ...expected,
  })?.sub;
}

test("OIDC configuration is all or none and pins every URL to the issuer's host", () => {
  assert.equal(oidcLoginConfiguration({}), undefined);
  assert.deepEqual(oidcLoginConfiguration(environment), {
    issuer,
    authorizationUrl: "https://tenant.idp.example.test/authorize",
    tokenUrl: "https://tenant.idp.example.test/oauth/token",
    jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
    clientId,
    clientSecret: "fixture-oidc-secret",
    tokenAuth: "client_secret_post",
    displayName: "single sign-on",
  });
  const keycloak = oidcLoginConfiguration({
    ...environment,
    OCC_AUTH_OIDC_ISSUER: "https://sso.example.test/realms/acme",
    OCC_AUTH_OIDC_AUTHORIZATION_URL:
      "https://sso.example.test:443/realms/acme/protocol/openid-connect/auth",
    OCC_AUTH_OIDC_TOKEN_URL: "https://SSO.example.test/realms/acme/protocol/openid-connect/token",
    OCC_AUTH_OIDC_JWKS_URL: "https://sso.example.test/realms/acme/protocol/openid-connect/certs",
    OCC_AUTH_OIDC_TOKEN_AUTH: "client_secret_basic",
    OCC_AUTH_OIDC_DISPLAY_NAME: "Acme SSO",
  });
  // The issuer stays the configured string; the URLs are normalized.
  assert.equal(keycloak.issuer, "https://sso.example.test/realms/acme");
  assert.equal(
    keycloak.authorizationUrl,
    "https://sso.example.test/realms/acme/protocol/openid-connect/auth",
  );
  assert.equal(
    keycloak.tokenUrl,
    "https://sso.example.test/realms/acme/protocol/openid-connect/token",
  );
  assert.equal(keycloak.tokenAuth, "client_secret_basic");
  assert.equal(keycloak.displayName, "Acme SSO");

  for (const name of Object.keys(environment)) {
    assert.throws(
      () => oidcLoginConfiguration({ ...environment, [name]: undefined }),
      /OIDC sign-in requires issuer/,
      name,
    );
    assert.throws(
      () => oidcLoginConfiguration({ ...environment, [name]: " " }),
      /OIDC sign-in requires issuer/,
      name,
    );
  }
  assert.throws(
    () => oidcLoginConfiguration({ OCC_AUTH_OIDC_DISPLAY_NAME: "SSO" }),
    /OIDC sign-in requires issuer/,
  );
  for (const value of [
    "http://tenant.idp.example.test/",
    "https://tenant.idp.example.test:8443/",
    // `iss` is compared with the configured string, so even the default port is refused.
    "https://tenant.idp.example.test:443/",
    syntheticCredentialUrl({
      username: "user",
      password: "pass",
      host: "tenant.idp.example.test",
      pathname: "/",
    }),
    "https://tenant.idp.example.test/?tenant=1",
    "https://tenant.idp.example.test/#x",
    "https://203.0.113.10/",
    "https://[2001:db8::1]/",
    "https://localhost/",
    "not a url",
  ]) {
    assert.throws(
      () => oidcLoginConfiguration({ ...environment, OCC_AUTH_OIDC_ISSUER: value }),
      /OCC_AUTH_OIDC_ISSUER must be an https URL/,
      value,
    );
  }
  for (const variable of [
    "OCC_AUTH_OIDC_AUTHORIZATION_URL",
    "OCC_AUTH_OIDC_TOKEN_URL",
    "OCC_AUTH_OIDC_JWKS_URL",
  ]) {
    for (const value of [
      "http://tenant.idp.example.test/x",
      "https://other.idp.example.test/x",
      "https://idp.example.test/x",
      "https://tenant.idp.example.test:444/x",
      "https://tenant.idp.example.test/x?y=1",
      "https://tenant.idp.example.test/x?",
      "https://tenant.idp.example.test/x#",
      "https://u@tenant.idp.example.test/x",
    ]) {
      assert.throws(
        () => oidcLoginConfiguration({ ...environment, [variable]: value }),
        new RegExp(`${variable} must be an https URL on port 443 on the issuer's host`),
        `${variable}=${value}`,
      );
    }
  }
  assert.throws(
    () => oidcLoginConfiguration({ ...environment, OCC_AUTH_OIDC_TOKEN_AUTH: "private_key_jwt" }),
    /OCC_AUTH_OIDC_TOKEN_AUTH must be client_secret_post or client_secret_basic/,
  );
  for (const value of ["x".repeat(41), "Acme\nSSO", "Acme‮SSO"]) {
    assert.throws(
      () => oidcLoginConfiguration({ ...environment, OCC_AUTH_OIDC_DISPLAY_NAME: value }),
      /OCC_AUTH_OIDC_DISPLAY_NAME must be 1 to 40 printable characters/,
    );
  }
});

test("the provider instance is the exact issuer and client pair", () => {
  const id = oidcProviderId({ issuer, clientId });
  assert.match(id, /^oidc:[0-9a-f]{64}$/);
  assert.notEqual(oidcProviderId({ issuer: issuer.slice(0, -1), clientId }), id);
  assert.notEqual(oidcProviderId({ issuer, clientId: `${clientId}2` }), id);
  // The separator keeps (issuer, client) pairs from colliding by concatenation.
  assert.notEqual(
    oidcProviderId({ issuer: "https://a.example.test/x", clientId: "y" }),
    oidcProviderId({ issuer: "https://a.example.test/", clientId: "xy" }),
  );
});

test("a valid ID token yields its subject", () => {
  assert.equal(verified(token()), subject);
  assert.equal(verified(token(claims({ azp: clientId }))), subject);
  assert.equal(verified(token(claims({ aud: [clientId], azp: clientId }))), subject);
  assert.equal(verified(token(claims({ aud: [clientId] }))), subject);
  assert.equal(verified(token(claims({ nbf: seconds + 60 }))), subject);
  assert.equal(verified(token(claims({ sub: "~".repeat(255) }))), "~".repeat(255));
});

test("issuer, audience and nonce must match exactly", () => {
  // The configured issuer is compared byte for byte, trailing slash included.
  assert.equal(verified(token(claims({ iss: issuer.slice(0, -1) }))), undefined);
  assert.equal(verified(token(claims({ iss: `${issuer}/` }))), undefined);
  assert.equal(verified(token(claims({ iss: "https://TENANT.idp.example.test/" }))), undefined);
  assert.equal(verified(token(claims({ iss: "https://accounts.google.com" }))), undefined);
  assert.equal(verified(token(claims({ aud: "other" }))), undefined);
  assert.equal(verified(token(claims({ aud: [clientId, "api"] }))), undefined);
  // The client is the only trusted audience: an extra one is refused even when azp names
  // the client, and so are empty, malformed or duplicate lists.
  assert.equal(verified(token(claims({ aud: [clientId, "api"], azp: clientId }))), undefined);
  assert.equal(verified(token(claims({ aud: ["api", clientId], azp: clientId }))), undefined);
  assert.equal(verified(token(claims({ aud: [clientId, clientId], azp: clientId }))), undefined);
  assert.equal(verified(token(claims({ aud: [clientId, 7], azp: clientId }))), undefined);
  assert.equal(verified(token(claims({ aud: [] }))), undefined);
  assert.equal(verified(token(claims({ aud: [[clientId]] }))), undefined);
  assert.equal(verified(token(claims({ aud: undefined }))), undefined);
  assert.equal(verified(token(claims({ azp: "other" }))), undefined);
  assert.equal(verified(token(claims({ aud: [clientId], azp: "other" }))), undefined);
  assert.equal(verified(token(claims({ nonce: "other" }))), undefined);
  assert.equal(verified(token(claims({ nonce: undefined }))), undefined);
  assert.equal(verified(token(claims({ nonce: "" })), { nonce: "" }), undefined);
  assert.equal(
    nonce,
    createHmac("sha256", "test-only-authentication-secret")
      .update(`oce-oidc-nonce\0${"s".repeat(43)}`)
      .digest("base64url"),
  );
});

test("exp, iat and nbf are enforced", () => {
  assert.equal(verified(token(claims({ exp: seconds }))), undefined);
  assert.equal(verified(token(claims({ exp: undefined }))), undefined);
  assert.equal(verified(token(claims({ iat: seconds + 61 }))), undefined);
  assert.equal(verified(token(claims({ iat: seconds + 60 }))), subject);
  assert.equal(verified(token(claims({ iat: seconds - 3601 }))), undefined);
  assert.equal(verified(token(claims({ iat: seconds - 3600 }))), subject);
  assert.equal(verified(token(claims({ iat: String(seconds) }))), undefined);
  assert.equal(verified(token(claims({ nbf: seconds + 61 }))), undefined);
  assert.equal(verified(token(claims({ nbf: String(seconds) }))), undefined);
  assert.equal(verified(token(claims({ nbf: null }))), undefined);
});

test("only RS256 from a 2,048-bit JWKS key named by kid verifies", () => {
  const payload = claims();
  const unsigned = `${encode({ alg: "none", kid: current.kid })}.${encode(payload)}.`;
  assert.equal(verified(unsigned), undefined);
  assert.equal(verified(`${unsigned}AA`), undefined);
  const hsInput = `${encode({ alg: "HS256", kid: current.kid })}.${encode(payload)}`;
  for (const secret of ["fixture-oidc-secret", current.jwk.n]) {
    // HS256 under the client secret or the published RSA modulus is never a signature.
    const hs = createHmac("sha256", secret).update(hsInput).digest("base64url");
    assert.equal(verified(`${hsInput}.${hs}`), undefined);
  }
  assert.equal(
    verified(token(payload, { header: { alg: "RS512", kid: current.kid }, algorithm: "sha512" })),
    undefined,
  );
  // The header's alg is checked itself, not only implied by the signature that verifies.
  assert.equal(verified(token(payload, { header: { alg: "RS512", kid: current.kid } })), undefined);
  assert.equal(verified(token(payload, { header: { alg: "RS256" } })), undefined);
  assert.equal(verified(token(payload, { header: { alg: "RS256", kid: "unknown" } })), undefined);
  // A correctly signed token is refused when its key is below the floor.
  assert.equal(
    verified(token(payload, { header: { alg: "RS256", kid: weak.kid }, key: weak.privateKey })),
    undefined,
  );
  // Signed by a key the JWKS does not name for this kid.
  assert.equal(
    verified(token(payload, { header: { alg: "RS256", kid: current.kid }, key: other.privateKey })),
    undefined,
  );
  // Keys carried or located by the header are refused even when the JWKS key verifies.
  for (const member of ["jwk", "jku", "x5c", "x5u", "crit"]) {
    assert.equal(
      verified(token(payload, { header: { alg: "RS256", kid: current.kid, [member]: "x" } })),
      undefined,
      member,
    );
  }
  // A signature never carries over to another payload.
  const [header, , signature] = token(payload).split(".");
  assert.equal(verified(`${header}.${encode(claims({ sub: "1" }))}.${signature}`), undefined);
  // The JWKS key must itself be an RS256 signing key.
  assert.equal(
    verified(token(payload), { jwks: { keys: [{ ...current.jwk, alg: "RS512" }] } }),
    undefined,
  );
  assert.equal(
    verified(token(payload), { jwks: { keys: [{ ...current.jwk, use: "enc" }] } }),
    undefined,
  );
  assert.equal(
    verified(token(payload), { jwks: { keys: [{ ...current.jwk, kty: "EC" }] } }),
    undefined,
  );
  // A header without kid never selects a JWKS key, even one that has no kid either.
  assert.equal(
    verified(token(payload, { header: { alg: "RS256" } }), {
      jwks: { keys: [{ ...current.jwk, kid: undefined }] },
    }),
    undefined,
  );
  for (const unusable of [{ keys: [] }, {}, null, "not a jwks"]) {
    assert.equal(verified(token(payload), { jwks: unusable }), undefined);
  }
});

test("malformed tokens are rejected", () => {
  const valid = token();
  assert.equal(verified(`${valid}.AAAA`), undefined);
  assert.equal(verified(valid.split(".").slice(0, 2).join(".")), undefined);
  const [header, payload, signature] = valid.split(".");
  // Segments are unpadded base64url: padding and the standard alphabet are refused.
  assert.equal(verified(`${header}.${payload}.${signature}=`), undefined);
  assert.equal(verified(`${header}.${payload.slice(0, -1)}+.${signature}`), undefined);
  assert.equal(verified(`${encode("not json")}.${payload}.${signature}`), undefined);
  assert.equal(verified(""), undefined);
});

test("subject must be 1-255 printable ASCII characters", () => {
  assert.equal(verified(token(claims({ sub: undefined }))), undefined);
  assert.equal(verified(token(claims({ sub: "" }))), undefined);
  assert.equal(verified(token(claims({ sub: "1".repeat(256) }))), undefined);
  assert.equal(verified(token(claims({ sub: "has space" }))), undefined);
  assert.equal(verified(token(claims({ sub: "é" }))), undefined);
  assert.equal(verified(token(claims({ sub: 42 }))), undefined);
});

test("code exchange fetches only the pinned token and JWKS URLs", async (t) => {
  const config = oidcLoginConfiguration(environment);
  const redirectURI = "https://console.example.test/api/auth/providers/oidc/callback";
  const live = claims({
    iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  let respond;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      method: init.method ?? "GET",
      redirect: init.redirect,
      body: init.body,
      authorization: new Headers(init.headers).get("authorization"),
    });
    return respond(url);
  });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const valid = (url) =>
    url === environment.OCC_AUTH_OIDC_TOKEN_URL
      ? json({ access_token: "fixture-access", id_token: token(live), token_type: "Bearer" })
      : json(jwks);

  respond = valid;
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    { subject },
  );
  assert.deepEqual(
    requests.map(({ url, method, redirect }) => [url, method, redirect]),
    [
      [environment.OCC_AUTH_OIDC_TOKEN_URL, "POST", "error"],
      [environment.OCC_AUTH_OIDC_JWKS_URL, "GET", "error"],
    ],
  );
  const post = new URLSearchParams(String(requests[0].body));
  assert.equal(post.get("client_id"), clientId);
  assert.equal(post.get("client_secret"), "fixture-oidc-secret");
  assert.equal(post.get("code"), "code-1");
  assert.equal(post.get("code_verifier"), "v".repeat(43));
  assert.equal(post.get("redirect_uri"), redirectURI);
  assert.equal(requests[0].authorization, null);

  // client_secret_basic moves the credentials into the Authorization header.
  requests.length = 0;
  assert.deepEqual(
    await exchangeOidcSubject(
      { ...config, tokenAuth: "client_secret_basic" },
      "code-1",
      "v".repeat(43),
      redirectURI,
      nonce,
    ),
    { subject },
  );
  const basic = new URLSearchParams(String(requests[0].body));
  assert.equal(basic.has("client_secret"), false);
  assert.equal(
    requests[0].authorization,
    `Basic ${Buffer.from(`${clientId}:fixture-oidc-secret`).toString("base64")}`,
  );

  const rejectedIdentity = { denial: "EXTERNAL_IDENTITY_REJECTED" };
  // The bounded failure is what the callback logs for operators.
  const unavailable = (failure) => ({ denial: "PROVIDER_UNAVAILABLE", failure });
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, "other"),
    rejectedIdentity,
  );
  respond = (url) =>
    url === environment.OCC_AUTH_OIDC_TOKEN_URL ? json({ access_token: "x" }) : json(jwks);
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    rejectedIdentity,
  );
  respond = () => json({ error: "invalid_grant" }, 400);
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    rejectedIdentity,
  );
  // Key rotation: the JWKS is read for each callback, so a new key verifies at once.
  const rotated = rsaSigningKey("rotated-kid");
  respond = (url) =>
    url === environment.OCC_AUTH_OIDC_TOKEN_URL
      ? json({
          id_token: token(live, {
            header: { alg: "RS256", kid: rotated.kid },
            key: rotated.privateKey,
          }),
        })
      : json({ keys: [rotated.jwk] });
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    { subject },
  );
  respond = (url) =>
    url === environment.OCC_AUTH_OIDC_TOKEN_URL
      ? json({ id_token: token(live) })
      : new Response("x".repeat(64 * 1024 + 1));
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    unavailable({ step: "jwks", cause: "oversized_response" }),
  );
  respond = () => json({}, 503);
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    unavailable({ step: "token", cause: "http_status", status: 503 }),
  );
  respond = () => Promise.reject(new TypeError("fetch failed"));
  assert.deepEqual(
    await exchangeOidcSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    unavailable({ step: "token", cause: "network" }),
  );
});
