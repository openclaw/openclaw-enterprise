import assert from "node:assert/strict";
import test from "node:test";
import {
  pollHarnessDeviceAuthorization,
  startHarnessDeviceAuthorization,
} from "../../apps/controller/src/drivers/compute/device-auth.ts";

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const now = Date.parse("2026-09-28T00:00:00Z");
const userCodeResponse = {
  device_auth_id: "device-authorization-fixture",
  user_code: "CODE-12345",
  interval: "5",
};
const authorizationResponse = {
  authorization_code: "code-with+reserved&characters",
  code_verifier: "verifier-with+reserved&characters",
  code_challenge: "challenge-fixture",
};
const idToken = [
  Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      email: "user@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-fixture" },
    }),
  ).toString("base64url"),
  "signature-fixture",
].join(".");

test("device authorization follows the native protocol and returns the complete bundle for Secret storage", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const responses = [
    Response.json(userCodeResponse),
    new Response(null, { status: 403 }),
    new Response(null, { status: 404 }),
    Response.json(authorizationResponse),
    Response.json({
      id_token: idToken,
      access_token: "access-token-fixture",
      refresh_token: "refresh-token-fixture",
    }),
  ];
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options });
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, false);
    assert.ok(responses.length > 0, "the one-time authorization code must not be retried");
    return responses.shift();
  });

  const started = await startHarnessDeviceAuthorization("codex");
  assert.equal(started.verificationUrl, `${issuer}/codex/device`);
  assert.equal(started.userCode, "CODE-12345");
  assert.equal(started.intervalSeconds, 5);
  assert.equal(started.expiresAt, "2026-09-28T00:15:00.000Z");
  assert.equal(requests[0].url, `${issuer}/api/accounts/deviceauth/usercode`);
  assert.deepEqual(JSON.parse(requests[0].body), { client_id: clientId });

  // Both statuses mean approval is still pending in the supported device protocol.
  assert.deepEqual(await pollHarnessDeviceAuthorization(started.privateState), {
    status: "pending",
  });
  assert.deepEqual(await pollHarnessDeviceAuthorization(started.privateState), {
    status: "pending",
  });
  const completed = await pollHarnessDeviceAuthorization(started.privateState);
  for (const request of requests.slice(1, 4)) {
    assert.equal(request.url, `${issuer}/api/accounts/deviceauth/token`);
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(request.body), {
      device_auth_id: "device-authorization-fixture",
      user_code: "CODE-12345",
    });
  }
  const exchange = requests[4];
  assert.equal(exchange.url, `${issuer}/oauth/token`);
  assert.equal(exchange.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.body)), {
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: `${issuer}/deviceauth/callback`,
    code: "code-with+reserved&characters",
    code_verifier: "verifier-with+reserved&characters",
  });
  assert.equal(completed.status, "ready");
  assert.deepEqual(JSON.parse(completed.credential), {
    version: 1,
    provider: "codex",
    state: "ready",
    auth: {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: "access-token-fixture",
        refresh_token: "refresh-token-fixture",
        account_id: "workspace-fixture",
      },
      last_refresh: "2026-09-28T00:00:00.000Z",
    },
  });
  assert.equal(responses.length, 0);
});

test("provider expiry prevents another poll and unsupported Harnesses make no provider request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const transport = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ...userCodeResponse, expires_at: "2026-09-28T00:02:00Z" }),
  );
  const started = await startHarnessDeviceAuthorization("codex");
  assert.equal(started.expiresAt, "2026-09-28T00:02:00.000Z");
  t.mock.timers.setTime(now + 2 * 60 * 1000);
  await assert.rejects(pollHarnessDeviceAuthorization(started.privateState), /Start sign-in again/);
  await assert.rejects(startHarnessDeviceAuthorization("other"), /not supported/);
  assert.equal(transport.mock.callCount(), 1);
});

test("failed one-time exchanges are not retried and never expose provider bodies or transport errors", async (t) => {
  for (const failure of ["rejected", "transport", "malformed", "oversized"]) {
    await t.test(failure, async (t) => {
      const sensitive = "private-provider-response-fixture";
      let requests = 0;
      t.mock.method(globalThis, "fetch", async () => {
        requests++;
        if (requests === 1) {
          return Response.json(userCodeResponse);
        }
        if (requests === 2) {
          return Response.json(authorizationResponse);
        }
        if (failure === "transport") {
          throw new Error(sensitive);
        }
        if (failure === "malformed") {
          return new Response(sensitive);
        }
        if (failure === "oversized") {
          return new Response(sensitive, { headers: { "Content-Length": "1048577" } });
        }
        return Response.json({ error: sensitive }, { status: 401 });
      });
      const started = await startHarnessDeviceAuthorization("codex");
      await assert.rejects(pollHarnessDeviceAuthorization(started.privateState), (error) => {
        assert.equal(
          error.message,
          "Could not complete device authorization. Start sign-in again.",
        );
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(requests, 3);
    });
  }
});
