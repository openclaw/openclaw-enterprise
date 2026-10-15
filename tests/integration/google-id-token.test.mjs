import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  exchangeGoogleSubject,
  googleLoginConfiguration,
  googleNonce,
  verifyGoogleIdToken,
} from "../../apps/controller/src/auth/google.ts";
import { idTokenSigner, rsaSigningKey } from "../helpers/id-token.mjs";

// verifyGoogleIdToken delegates every generic ID-token check to verifyIdToken, which
// oidc-id-token.test.mjs pins. This file covers only what Google adds: its issuer
// spellings, the hosted-domain restriction, its nonce and its fixed endpoints.
const clientId = "fixture-client.apps.googleusercontent.com";
const nonce = googleNonce("test-only-authentication-secret", "s".repeat(43));
const now = Date.UTC(2030, 0, 1);
const seconds = Math.floor(now / 1000);

const current = rsaSigningKey("current-kid");
const other = rsaSigningKey("other-kid");
const jwks = { keys: [other.jwk, current.jwk] };
const sign = idTokenSigner(current);

function claims(overrides = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: clientId,
    azp: clientId,
    sub: "110169484474386276334",
    email: "person@example.test",
    email_verified: true,
    hd: "example.test",
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
  return verifyGoogleIdToken(value, {
    clientId,
    nonce,
    allowedDomains: [],
    jwks,
    now,
    ...expected,
  });
}

test("valid Google ID token yields the sub claim, never the email", () => {
  assert.equal(verified(token()), "110169484474386276334");
});

test("only Google's two issuer spellings are accepted", () => {
  assert.equal(verified(token(claims({ iss: "accounts.google.com" }))), "110169484474386276334");
  assert.equal(verified(token(claims({ iss: "https://evil.example.test" }))), undefined);
  assert.equal(verified(token(claims({ iss: "http://accounts.google.com" }))), undefined);
  assert.equal(verified(token(claims({ iss: undefined }))), undefined);
});

test("the nonce is derived from the attempt state", () => {
  assert.notEqual(googleNonce("test-only-authentication-secret", "t".repeat(43)), nonce);
  assert.equal(
    nonce,
    createHmac("sha256", "test-only-authentication-secret")
      .update(`oce-google-nonce\0${"s".repeat(43)}`)
      .digest("base64url"),
  );
});

test("hosted-domain restriction requires hd and a verified email", () => {
  const allowedDomains = ["example.test"];
  assert.equal(verified(token(), { allowedDomains }), "110169484474386276334");
  assert.equal(
    verified(token(claims({ hd: "Example.TEST" })), { allowedDomains }),
    "110169484474386276334",
  );
  assert.equal(verified(token(claims({ hd: undefined })), { allowedDomains }), undefined);
  assert.equal(verified(token(claims({ hd: "other.test" })), { allowedDomains }), undefined);
  assert.equal(verified(token(claims({ email_verified: false })), { allowedDomains }), undefined);
  assert.equal(verified(token(claims({ email_verified: "true" })), { allowedDomains }), undefined);
  // Without a restriction, hd and email_verified are not identity inputs.
  assert.equal(
    verified(token(claims({ hd: undefined, email_verified: false }))),
    "110169484474386276334",
  );
});

test("Google configuration is both-or-neither with validated domains", () => {
  assert.equal(googleLoginConfiguration({}), undefined);
  assert.deepEqual(
    googleLoginConfiguration({
      OCC_AUTH_GOOGLE_CLIENT_ID: clientId,
      OCC_AUTH_GOOGLE_CLIENT_SECRET: "s",
    }),
    { clientId, clientSecret: "s", allowedDomains: [] },
  );
  assert.deepEqual(
    googleLoginConfiguration({
      OCC_AUTH_GOOGLE_CLIENT_ID: clientId,
      OCC_AUTH_GOOGLE_CLIENT_SECRET: "s",
      OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: " Example.TEST , corp.example.org",
    }).allowedDomains,
    ["example.test", "corp.example.org"],
  );
  for (const environment of [
    { OCC_AUTH_GOOGLE_CLIENT_ID: clientId },
    { OCC_AUTH_GOOGLE_CLIENT_SECRET: "s" },
    { OCC_AUTH_GOOGLE_CLIENT_ID: " ", OCC_AUTH_GOOGLE_CLIENT_SECRET: "s" },
    { OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: "example.test" },
  ]) {
    assert.throws(() => googleLoginConfiguration(environment), /client ID and client secret/);
  }
  for (const domains of [
    "",
    "example.test,",
    "localhost",
    "exa mple.test",
    "-a.test",
    "*.example.test",
    "a.1",
  ]) {
    assert.throws(
      () =>
        googleLoginConfiguration({
          OCC_AUTH_GOOGLE_CLIENT_ID: clientId,
          OCC_AUTH_GOOGLE_CLIENT_SECRET: "s",
          OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: domains,
        }),
      /OCC_AUTH_GOOGLE_ALLOWED_DOMAINS/,
    );
  }
});

test("code exchange posts to the fixed token endpoint and verifies against fixed certs", async (t) => {
  const config = { clientId, clientSecret: "fixture-secret", allowedDomains: [] };
  const redirectURI = "https://console.example.test/api/auth/providers/google/callback";
  const live = claims({
    iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  let respond;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", redirect: init.redirect, body: init.body });
    return respond(url);
  });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  respond = (url) =>
    url === "https://oauth2.googleapis.com/token"
      ? json({ access_token: "ya29.fixture", id_token: token(live), token_type: "Bearer" })
      : json(jwks);
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    { subject: live.sub },
  );
  assert.deepEqual(
    requests.map(({ url, method, redirect }) => [url, method, redirect]),
    [
      ["https://oauth2.googleapis.com/token", "POST", "error"],
      ["https://www.googleapis.com/oauth2/v3/certs", "GET", "error"],
    ],
  );
  const exchange = new URLSearchParams(String(requests[0].body));
  assert.equal(exchange.get("code"), "code-1");
  assert.equal(exchange.get("code_verifier"), "v".repeat(43));
  assert.equal(exchange.get("redirect_uri"), redirectURI);
  assert.equal(exchange.get("grant_type"), "authorization_code");

  const rejectedIdentity = { denial: "EXTERNAL_IDENTITY_REJECTED" };
  // The bounded failure is what the callback logs for operators.
  const unavailable = (failure) => ({ denial: "PROVIDER_UNAVAILABLE", failure });
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, "other"),
    rejectedIdentity,
  );
  respond = (url) =>
    url === "https://oauth2.googleapis.com/token"
      ? json({ access_token: "ya29.fixture" })
      : json(jwks);
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    rejectedIdentity,
  );
  respond = () => json({ error: "invalid_grant" }, 400);
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    rejectedIdentity,
  );
  respond = (url) =>
    url === "https://oauth2.googleapis.com/token"
      ? json({ id_token: token(live) })
      : new Response("x".repeat(64 * 1024 + 1));
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    unavailable({ step: "jwks", cause: "oversized_response" }),
  );
  respond = () => json({}, 503);
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    unavailable({ step: "token", cause: "http_status", status: 503 }),
  );
  respond = () => Promise.reject(new TypeError("fetch failed"));
  assert.deepEqual(
    await exchangeGoogleSubject(config, "code-1", "v".repeat(43), redirectURI, nonce),
    unavailable({ step: "token", cause: "network" }),
  );
});
