import assert from "node:assert/strict";
import test from "node:test";
import {
  codexDeviceAuthorizationState,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from "../../apps/controller/src/drivers/token-service/codex-device-authorization.ts";
import { redirectProviderFetch, startProviderServer } from "../helpers/provider-http-transport.ts";

test("Codex device authorization validates issuer transport and grant fields", async (t) => {
  const paths = [
    "/api/accounts/deviceauth/usercode",
    "/api/accounts/deviceauth/token",
    "/oauth/token",
  ];
  for (const [phase, redirectPath] of paths.entries()) {
    await t.test(redirectPath, async (t) => {
      // Only the fixed issuer destinations are routed to loopback. Native fetch
      // handles the real 307, so following it would forward a private grant.
      const server = await startProviderServer(t, (request, response) => {
        request.resume();
        if (request.url === redirectPath) {
          response.writeHead(307, { location: "/redirected-grant" }).end();
          return;
        }
        if (request.url === "/redirected-grant") {
          response.writeHead(503).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url === paths[0]
              ? { device_auth_id: "device-fixture", user_code: "USER-CODE", interval: 5 }
              : { authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" },
          ),
        );
      });
      redirectProviderFetch(
        t,
        new Set(paths.map((path) => `https://auth.openai.com${path}`)),
        `http://127.0.0.1:${server.port}`,
      );
      const signal = AbortSignal.timeout(10_000);
      if (phase === 0) {
        await assert.rejects(startCodexDeviceAuthorization(signal), {
          name: "DeviceAuthorizationStartError",
          reason: "unavailable",
          failure: "fetch_failed",
        });
      } else {
        const login = await startCodexDeviceAuthorization(signal);
        const state = codexDeviceAuthorizationState(login.privateState);
        if (phase === 1) {
          // A refused pre-code request retains the existing pending behavior.
          assert.equal(await pollCodexDeviceAuthorization(state, signal), undefined);
        } else {
          // Native fetch refuses the redirect itself (redirect: "error").
          await assert.rejects(
            pollCodexDeviceAuthorization(state, signal),
            (error) => error instanceof TypeError && error.cause?.message === "unexpected redirect",
          );
        }
      }
      assert.deepEqual(
        server.requests,
        paths.slice(0, phase + 1),
        "no issuer redirect may send another request or forward the authorization grant",
      );
    });
  }
  await t.test("successful exchange retains the first usable grant", async (t) => {
    const expirySeconds = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = jwt({
      exp: expirySeconds,
      "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
    });
    const identityToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-fixture",
        chatgpt_plan_type: "business",
      },
    });
    const server = await startProviderServer(t, (request, response) => {
      request.resume();
      response.setHeader("content-type", "application/json");
      if (request.url === paths[0]) {
        response.end(
          JSON.stringify({ device_auth_id: "device-fixture", user_code: "USER-CODE", interval: 5 }),
        );
      } else if (request.url === paths[1]) {
        response.end(
          JSON.stringify({
            authorization_code: "synthetic-code",
            code_verifier: "synthetic-verifier",
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: "synthetic-grant-refresh",
            id_token: identityToken,
            scope: "openid profile openid",
          }),
        );
      }
    });
    redirectProviderFetch(
      t,
      new Set(paths.map((path) => `https://auth.openai.com${path}`)),
      `http://127.0.0.1:${server.port}`,
    );
    const signal = AbortSignal.timeout(10_000);
    const login = await startCodexDeviceAuthorization(signal);
    const state = codexDeviceAuthorizationState(login.privateState);
    const grant = await pollCodexDeviceAuthorization(state, signal);
    assert.deepEqual(grant, {
      accessToken,
      expiresAt: new Date(expirySeconds * 1000).toISOString(),
      refreshToken: "synthetic-grant-refresh",
      requestedScopes: [],
      grantedScopes: ["openid", "profile"],
      account: { accountId: "account-fixture", planType: "business", isFedramp: false },
    });
    assert.deepEqual(server.requests, paths);
  });
});

function jwt(payload) {
  return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}
