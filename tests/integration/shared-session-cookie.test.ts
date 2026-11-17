import assert from "node:assert/strict";
import test from "node:test";
import { createControllerAuth } from "../helpers/password-hasher.mjs";

const options = {
  mode: "development" as const,
  installationId: "ins_shared_cookie",
  baseURL: "https://console.oce.example.com",
  agentDomain: "agents.oce.example.com",
  secret: "shared-session-cookie-proof-at-least-32-bytes",
};

test("browser sessions derive their narrowest shared DNS scope and require HTTPS", () => {
  const auth = createControllerAuth(options);
  assert.equal(auth.sharedCookieDomain, "oce.example.com");
  assert.equal(auth.sessionCookieName, "__Secure-openclaw_occ_shared.session_token");
  assert.equal(
    createControllerAuth({
      ...options,
      baseURL: "https://console.BÜCHER.example",
      agentDomain: "agents.bücher.example.",
    }).sharedCookieDomain,
    "xn--bcher-kva.example",
  );
  for (const invalid of [
    { baseURL: "http://console.oce.example.com" },
    { baseURL: "https://127.0.0.1" },
    { agentDomain: "127.0.0.1" },
    { agentDomain: "" },
    { agentDomain: "agents.other.com" },
    { agentDomain: "com" },
    { baseURL: "https://console.github.io", agentDomain: "agents.github.io" },
    { sharedCookieDomain: "example.com" },
  ]) {
    assert.throws(
      () => createControllerAuth({ ...options, ...invalid }),
      {
        message:
          /shared session cookies|sharedCookieDomain|OCC_AGENT_NATIVE_ADMIN_DOMAIN|Console and Agent hostnames/i,
      },
      JSON.stringify(invalid),
    );
  }
});

test("shared sessions reach Agent admission but do not authorize sibling Console mutations", async () => {
  const auth = createControllerAuth(options);
  const email = "session@example.com";
  const password = "shared-cookie-proof-password";
  const account = await auth.createAccount({ email, password });
  const signedIn = await auth.auth.api.signInEmail({
    body: { email, password },
    headers: new Headers({ origin: options.baseURL }),
    returnHeaders: true,
  });
  const cookie = signedIn.headers
    .getSetCookie()
    .find((value: string) => value.startsWith(`${auth.sessionCookieName}=`));
  assert.ok(cookie);
  assert.match(cookie, /; Domain=oce\.example\.com(?:;|$)/i);
  assert.match(cookie, /; Secure(?:;|$)/i);
  assert.match(cookie, /; HttpOnly(?:;|$)/i);
  assert.match(cookie, /; SameSite=Lax(?:;|$)/i);
  const headers = {
    cookie: cookie.split(";")[0]!,
    origin: "https://agent.agents.oce.example.com",
    host: "agent.agents.oce.example.com",
  };
  const request = {
    headers,
    requestId: "req_shared_session",
    routeId: "native-agent",
    transport: { remoteAddress: "127.0.0.1" },
    method: "POST",
    requestedScope: { installationId: options.installationId },
  };
  // Native routing validates its exact Agent origin before using this admission path.
  const admitted = await auth.admissionVerifier.verify(request);
  assert.equal(admitted.externalIdentity.subject, account.id);
  await assert.rejects(auth.admissionVerifier.verifyControllerRequest(request), /origin/i);
  await assert.rejects(
    auth.admissionVerifier.verify({
      ...request,
      headers: { ...headers, cookie: `${headers.cookie}; ${headers.cookie}` },
    }),
    /ambiguous/i,
  );
});
