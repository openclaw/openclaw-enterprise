import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { BUILTIN_CODEX_OAUTH_PRESET } from "../../apps/controller/src/backends/token-service/codex-oauth-preset.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { administrator, fixture } from "./credential-source-occ-fixture.ts";
import {
  codexDeviceAuthorizationState,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from "../../apps/controller/src/drivers/token-service/codex-device-authorization.ts";
import {
  readProviderRequestBody,
  redirectProviderFetch,
  startProviderServer,
} from "../helpers/provider-http-transport.ts";

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
    let tokenType = "Bearer";
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
            token_type: tokenType,
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
    tokenType = undefined;
    const withoutType = await startCodexDeviceAuthorization(signal);
    assert.ok(
      await pollCodexDeviceAuthorization(
        codexDeviceAuthorizationState(withoutType.privateState),
        signal,
      ),
      "the fixed issuer may omit the token type as the existing login client permits",
    );
    tokenType = "DPoP";
    const unsupported = await startCodexDeviceAuthorization(signal);
    await assert.rejects(
      pollCodexDeviceAuthorization(codexDeviceAuthorizationState(unsupported.privateState), signal),
      /unsupported token type/,
    );
  });
});

test("the selected TokenService refreshes the fixed Codex grant using the provider response", async (t) => {
  const f = await fixture({ withoutGateway: true });
  await installTokenServiceDriver(
    f.controller,
    {
      installation: { drivers: { token_service: { id: "codex-refresh-owner" } } },
      secretDriver: f.secretDriver,
    },
    f.state,
  );
  const owner = f.controller.selectedDriver("token_service");
  const instanceId = f.controller.currentTokenServiceInstanceId();
  await f.makeReady();
  const signal = AbortSignal.timeout(10_000);
  const initialRefresh = randomUUID();
  const rotatedRefresh = randomUUID();
  const rotatedAgain = randomUUID();
  const scopedRefresh = randomUUID();
  const clientRotatedRefresh = randomUUID();
  const initialExpiry = Math.floor(Date.now() / 1000) + 3600;
  const renewedExpiry = initialExpiry + 3600;
  const renewedAccess = jwt({
    exp: renewedExpiry,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
  });
  const registerSource = (name, refreshToken, scopes = []) =>
    owner.createSource(
      {
        kind: "oauth_refresh_token",
        namespaceId: f.namespace.id,
        name,
        consent: {
          kind: "builtin_codex",
          ownerPrincipalId: administrator,
          account: { accountId: "account-fixture", planType: "plus", isFedramp: false },
        },
        grant: {
          accessToken: jwt({ exp: initialExpiry }),
          refreshToken,
          expiresAt: new Date(initialExpiry * 1000).toISOString(),
          requestedScopes: scopes,
          grantedScopes: scopes,
        },
      },
      signal,
    );
  const source = await registerSource("Codex refresh fixture", initialRefresh, [
    "openid",
    "profile",
  ]);
  const sourceInstance = {
    sourceRef: { kind: "credential_source", namespaceId: f.namespace.id, id: source.id },
    tokenServiceInstanceId: instanceId,
  };
  const received = [];
  let responseIndex = 0;
  const privateIssuerMessage = "provider diagnostic must remain private";
  const server = await startProviderServer(t, async (request, response) => {
    const raw = await readProviderRequestBody(request);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    received.push({ contentType: request.headers["content-type"], body });
    response.setHeader("content-type", "application/json");
    const index = responseIndex++;
    if (index === 6) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }
    if (index === 7) {
      response.end(JSON.stringify({ refresh_token: clientRotatedRefresh }));
      return;
    }
    if (index === 8) {
      response.end(JSON.stringify({ access_token: renewedAccess }));
      return;
    }
    if (index === 5) {
      response.end(JSON.stringify({ refresh_token: scopedRefresh, scope: "openid" }));
      return;
    }
    if (index === 4) {
      response.end(
        JSON.stringify({ message: privateIssuerMessage, padding: "x".repeat(64 * 1024) }),
      );
      return;
    }
    if (index === 3) {
      response.statusCode = 403;
      response.end(
        JSON.stringify({ error: { code: "refresh_token_reused", message: privateIssuerMessage } }),
      );
      return;
    }
    response.end(
      JSON.stringify(
        [
          { access_token: renewedAccess, refresh_token: rotatedRefresh, scope: "openid" },
          { refresh_token: rotatedAgain },
          { access_token: renewedAccess, token_type: "DPoP" },
        ][index],
      ),
    );
  });
  redirectProviderFetch(
    t,
    new Set([BUILTIN_CODEX_OAUTH_PRESET.tokenUrl]),
    `http://127.0.0.1:${server.port}`,
  );

  // Codex supplies expiry in the access JWT rather than generic OAuth expires_in.
  const first = await owner.forceRefresh(sourceInstance, signal);
  const refreshed = await owner.getRefreshStatus(first, signal);
  assert.equal(
    refreshed.state,
    "ready",
    `Codex refresh failed: ${refreshed.failureCode ?? refreshed.state}`,
  );
  const access = await owner.resolveCredential(sourceInstance, signal);
  assert.ok(
    access.credential === renewedAccess,
    "only the selected owner resolves the refreshed access token",
  );
  assert.equal(access.expiresAt, new Date(renewedExpiry * 1000).toISOString());
  const settled = await f.state.read(({ credentialSources }) =>
    credentialSources.findCredentialSource(f.namespace.id, source.id),
  );
  assert.deepEqual(settled.consent.grantedScopes, ["openid"]);
  assert.deepEqual(settled.consent.account, {
    accountId: "account-fixture",
    planType: "plus",
    isFedramp: false,
  });
  assert.ok(
    !JSON.stringify(source).includes(initialRefresh),
    "the Source response has no refresh token",
  );
  assert.match(received[0].contentType, /^application\/json(?:;|$)/i);
  assert.deepEqual(Object.keys(received[0].body).sort(), [
    "client_id",
    "grant_type",
    "refresh_token",
  ]);
  assert.equal(received[0].body.grant_type, "refresh_token");
  assert.equal(received[0].body.client_id, BUILTIN_CODEX_OAUTH_PRESET.clientId);
  assert.ok(
    received[0].body.refresh_token === initialRefresh,
    "the issuer receives the private grant from custody",
  );

  // A partial Codex grant may rotate only the refresh token. It must not
  // manufacture a new delivery credential while the existing access token is usable.
  const partial = await owner.forceRefresh(sourceInstance, signal);
  assert.equal((await owner.getRefreshStatus(partial, signal)).state, "ready");
  const retained = await owner.resolveCredential(sourceInstance, signal);
  assert.ok(
    retained.credential === access.credential,
    "partial renewal preserves the usable access token",
  );
  assert.equal(retained.expiresAt, access.expiresAt);
  assert.equal(retained.version, access.version);
  assert.ok(
    received[1].body.refresh_token === rotatedRefresh,
    "partial renewal consumes the rotated grant from custody",
  );

  // The next refresh uses the second rotated grant and refuses an explicit
  // token type that the selected Proxy cannot inject.
  const second = await owner.forceRefresh(sourceInstance, signal);
  const refused = await owner.getRefreshStatus(second, signal);
  assert.equal(refused.state, "failed");
  assert.equal(refused.failureCode, "invalid_access_token");
  assert.ok(
    received[2].body.refresh_token === rotatedAgain,
    "renewal retained the partial grant rotation in custody",
  );

  // A nested provider refusal on a non-401 response needs a new consent;
  // its private diagnostic must not become public refresh status.
  const reusedSource = await registerSource("Codex reused grant fixture", randomUUID());
  const reusedOperation = await owner.forceRefresh(
    {
      ...sourceInstance,
      sourceRef: { ...sourceInstance.sourceRef, id: reusedSource.id },
    },
    signal,
  );
  const reused = await owner.getRefreshStatus(reusedOperation, signal);
  assert.equal(reused.state, "failed");
  assert.equal(reused.failureCode, "grant_refused");
  assert.equal(reused.recoveryAction, "reauthorize");
  assert.ok(
    !JSON.stringify(reused).includes(privateIssuerMessage),
    "issuer diagnostics stay private",
  );

  // The issuer may have consumed a rotating grant before sending an oversized
  // response. Quarantine it without exposing diagnostics or issuing an access token.
  const oversizedSource = await registerSource("Codex oversized response fixture", randomUUID());
  const oversizedInstance = {
    ...sourceInstance,
    sourceRef: { ...sourceInstance.sourceRef, id: oversizedSource.id },
  };
  const oversizedOperation = await owner.forceRefresh(oversizedInstance, signal);
  const oversized = await owner.getRefreshStatus(oversizedOperation, signal);
  assert.equal(oversized.state, "failed");
  assert.equal(oversized.failureCode, "refresh_outcome_unknown");
  assert.ok(
    !JSON.stringify(oversized).includes(privateIssuerMessage),
    "oversized issuer diagnostics stay private",
  );
  await assert.rejects(owner.resolveCredential(oversizedInstance, signal), {
    name: "ResourceStateConflictError",
  });

  // Codex's partial refresh response does not carry scope authority. Refuse a changed scope
  // without a replacement access token instead of publishing an unsupported narrowing.
  const scopedSource = await registerSource("Codex malformed scope fixture", randomUUID(), [
    "openid",
    "profile",
  ]);
  const scopedInstance = {
    ...sourceInstance,
    sourceRef: { ...sourceInstance.sourceRef, id: scopedSource.id },
  };
  const scopedOperation = await owner.forceRefresh(scopedInstance, signal);
  const scopedFailure = await owner.getRefreshStatus(scopedOperation, signal);
  assert.equal(scopedFailure.state, "failed");
  assert.equal(scopedFailure.failureCode, "grant_scope_mismatch");
  assert.equal(scopedFailure.recoveryAction, "reauthorize");
  const unchanged = await f.state.read(({ credentialSources }) =>
    credentialSources.findCredentialSource(f.namespace.id, scopedSource.id),
  );
  assert.deepEqual(unchanged.consent.grantedScopes, ["openid", "profile"]);
  await assert.rejects(owner.resolveCredential(scopedInstance, signal), {
    name: "ResourceStateConflictError",
  });

  // A 401 client-authentication error does not consume the grant. Keep it in custody so
  // a later attempt can recover without asking the user to authorize again.
  const clientRefresh = randomUUID();
  const clientSource = await registerSource("Codex refused client fixture", clientRefresh);
  const clientInstance = {
    ...sourceInstance,
    sourceRef: { ...sourceInstance.sourceRef, id: clientSource.id },
  };
  const clientOperation = await owner.forceRefresh(clientInstance, signal);
  const clientFailure = await owner.getRefreshStatus(clientOperation, signal);
  assert.equal(clientFailure.state, "failed");
  assert.equal(clientFailure.failureCode, "client_refused");
  assert.equal(clientFailure.recoveryAction, "fix_configuration");
  // A partial retry retains the rotated grant but cannot restore previously unavailable access.
  const clientRetry = await owner.forceRefresh(clientInstance, signal);
  const pending = await owner.getRefreshStatus(clientRetry, signal);
  assert.equal(pending.state, "pending");
  assert.equal(received[7].body.refresh_token, clientRefresh);
  await assert.rejects(owner.resolveCredential(clientInstance, signal), {
    name: "ResourceStateConflictError",
  });
  const recovered = await owner.forceRefresh(clientInstance, signal);
  assert.equal((await owner.getRefreshStatus(recovered, signal)).state, "ready");
  assert.equal(received[8].body.refresh_token, clientRotatedRefresh);
});

function jwt(payload) {
  return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}
