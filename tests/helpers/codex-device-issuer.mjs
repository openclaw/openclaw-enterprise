import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  codexDeviceAuthorization,
  CODEX_PUBLIC_CLIENT_ID,
} from "../../packages/contracts/src/index.ts";

/** Simulates only the external Codex issuer. OCC and the selected Token Service run normally. */
export function installCodexDeviceIssuer(
  t,
  { accountId = "workspace-test", emailVerified = false } = {},
) {
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
  const jwt = (payload) => [encode({ alg: "none" }), encode(payload), "fixture"].join(".");
  const claims = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: "plus",
    chatgpt_user_id: "fixture-person",
  };
  const accessToken = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": claims,
  });
  const refreshToken = `test-refresh-${randomUUID()}`;
  const provider = {
    accountId,
    accessToken,
    refreshToken,
    polls: 0,
    exchanges: 0,
    /** @type {Array<Response | Error>} */ pendingReplies: [],
    /** @type {Response | Error | undefined} */ startFailure: undefined,
    loseExchange: false,
    /** @type {(() => Promise<void>) | undefined} */ beforeStart: undefined,
    /** @type {(() => Promise<void>) | undefined} */ beforeExchange: undefined,
  };
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const address = new URL(url).href;
    if (!address.startsWith(codexDeviceAuthorization.issuer + "/")) {
      return original(url, init);
    }
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "error");
    if (address === codexDeviceAuthorization.userCodeUrl) {
      await provider.beforeStart?.();
      assert.deepEqual(JSON.parse(init.body), { client_id: CODEX_PUBLIC_CLIENT_ID });
      if (provider.startFailure instanceof Error) {
        throw provider.startFailure;
      }
      return (
        provider.startFailure ??
        Response.json({
          device_auth_id: "private-device-attempt",
          user_code: "TEST-CODE",
          interval: 1,
        })
      );
    }
    if (address === codexDeviceAuthorization.pollUrl) {
      provider.polls++;
      assert.deepEqual(JSON.parse(init.body), {
        device_auth_id: "private-device-attempt",
        user_code: "TEST-CODE",
      });
      const pending = provider.pendingReplies.shift();
      if (pending instanceof Error) {
        throw pending;
      }
      return (
        pending ??
        Response.json({ authorization_code: "private-code", code_verifier: "private-verifier" })
      );
    }
    assert.equal(address, codexDeviceAuthorization.tokenUrl);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
      grant_type: "authorization_code",
      client_id: CODEX_PUBLIC_CLIENT_ID,
      code: "private-code",
      code_verifier: "private-verifier",
      redirect_uri: codexDeviceAuthorization.redirectUri,
    });
    provider.exchanges++;
    await provider.beforeExchange?.();
    if (provider.loseExchange) {
      throw new TypeError("lost token exchange");
    }
    return Response.json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: jwt({
        "https://api.openai.com/auth": claims,
        email: "fixture@example.test",
        email_verified: emailVerified,
      }),
    });
  });
  return provider;
}
