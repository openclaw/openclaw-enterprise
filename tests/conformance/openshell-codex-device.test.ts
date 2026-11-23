import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CredentialSourceContext } from "../../packages/contracts/src/index.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderProfile,
  OpenShellProviderResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import {
  codexDeviceAuthorizationState,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from "../../apps/controller/src/drivers/credential-refresh/codex-device-authorization.ts";
import { redirectProviderFetch, startProviderServer } from "../helpers/provider-http-transport.ts";

test("Codex device authorization never follows issuer redirects", async (t) => {
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
        await assert.rejects(startCodexDeviceAuthorization("source-owner", signal), {
          name: "DeviceAuthorizationStartError",
          reason: "unavailable",
          failure: "fetch_failed",
        });
      } else {
        const login = await startCodexDeviceAuthorization("source-owner", signal);
        const state = codexDeviceAuthorizationState("source-owner", login.privateState);
        if (phase === 1) {
          // A refused pre-code request retains the existing pending behavior.
          assert.equal(await pollCodexDeviceAuthorization(state, signal), undefined);
        } else {
          // Native fetch refuses the redirect itself (redirect: "error").
          await assert.rejects(
            pollCodexDeviceAuthorization(state, signal),
            (error) =>
              error instanceof TypeError &&
              error.cause instanceof Error &&
              error.cause.message === "unexpected redirect",
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
});

function jwt(payload: Readonly<Record<string, unknown>>) {
  return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

function fixture(
  t: TestContext,
  {
    invalidIdToken = false,
    failRotation = false,
    pollResponse,
  }: {
    invalidIdToken?: boolean;
    failRotation?: boolean;
    pollResponse?(init: RequestInit): Response;
  } = {},
) {
  const providers = new Map<string, OpenShellProviderResponse>();
  const profiles = new Map<string, OpenShellProviderProfile & { resourceVersion: string }>();
  const operations: string[] = [];
  const http: string[] = [];
  let pending = true;
  let refreshStatus: string | undefined;
  const rotationRequests: string[] = [];
  const expirationTime = new Date(Date.now() + 3_600_000).toISOString();
  const identity = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-fixture",
      chatgpt_plan_type: "business",
      user_id: "user-fixture",
      chatgpt_account_is_fedramp: false,
    },
    "https://api.openai.com/profile": { email: "oauth-fixture@example.test" },
  };
  const accessToken = jwt({
    exp: Math.floor(Date.parse(expirationTime) / 1000),
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-fixture",
      chatgpt_account_user_id: "membership-fixture",
    },
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(typeof url === "string");
      http.push(url);
      assert.ok(init);
      assert.equal(init.method, "POST");
      switch (url) {
        case "https://auth.openai.com/api/accounts/deviceauth/usercode":
          assert.ok(typeof init.body === "string");
          assert.equal(asRecord(JSON.parse(init.body))?.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
          return Response.json({
            device_auth_id: "device-fixture",
            user_code: "USER-CODE",
            interval: "5",
          });
        case "https://auth.openai.com/api/accounts/deviceauth/token":
          assert.ok(typeof init.body === "string");
          assert.deepEqual(JSON.parse(init.body), {
            device_auth_id: "device-fixture",
            user_code: "USER-CODE",
          });
          if (pollResponse !== undefined) {
            return pollResponse(init);
          }
          return pending
            ? new Response(null, { status: 403 })
            : Response.json({
                authorization_code: "authorization-fixture",
                code_verifier: "verifier-fixture",
              });
        case "https://auth.openai.com/oauth/token": {
          assert.equal(
            new Headers(init.headers).get("Content-Type"),
            "application/x-www-form-urlencoded",
          );
          assert.ok(typeof init.body === "string" || init.body instanceof URLSearchParams);
          const form = new URLSearchParams(init.body);
          assert.equal(form.get("grant_type"), "authorization_code");
          assert.equal(form.get("code_verifier"), "verifier-fixture");
          assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
          return Response.json({
            access_token: accessToken,
            refresh_token: "synthetic-initial-refresh",
            id_token: invalidIdToken ? "invalid-private-response" : jwt(identity),
          });
        }
        default:
          assert.fail("unexpected provider URL");
      }
    },
  );
  // Simulate only OpenShell storage/RPC responses. The Driver performs the real device
  // response parsing, source ownership checks, handoff sequencing, and attachment projection.
  const client = {
    async getProviderProfile(_workspace, id) {
      return profiles.get(id);
    },
    async importProviderProfile(_workspace, profile) {
      profiles.set(profile.id, { ...profile, resourceVersion: "1" });
    },
    async createProvider(input) {
      const provider = { ...input, config: {}, resourceVersion: "1" };
      providers.set(input.name, provider);
      return provider;
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async updateProviderCredentials() {
      assert.fail("The initial unmanaged access token must not be published.");
    },
    async configureProviderRefresh(request) {
      operations.push("configure-refresh");
      assert.equal(request.credentialKey, "CODEX_ACCESS_TOKEN");
      assert.equal(request.strategy, "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN");
      assert.match(request.requestId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(request.material, {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        refresh_token: "synthetic-initial-refresh",
      });
      refreshStatus = "configured";
      return { status: refreshStatus };
    },
    async updateProviderConfig(_workspace, name, config) {
      operations.push("store-metadata");
      const provider = providers.get(name);
      assert.ok(provider);
      const updated = { ...provider, config };
      providers.set(name, updated);
      return updated;
    },
    async getProviderRefreshStatus() {
      return refreshStatus === undefined ? undefined : { status: refreshStatus, expirationTime };
    },
    async rotateProviderCredential(_workspace, _provider, _key, requestId) {
      rotationRequests.push(requestId);
      operations.push("rotate");
      if (failRotation) {
        throw new Error("synthetic rotation transport failure");
      }
      refreshStatus = "refreshed";
      return { status: refreshStatus, expirationTime };
    },
    async getProviderCredential() {
      operations.push("read-usable");
      return { value: "synthetic-rotated-access", expirationTime };
    },
  } satisfies Partial<OpenShellGatewayClient>;
  const backend = createOpenShellBackend(
    {
      id: "openshell",
      type: "openshell",
      // A literal loopback endpoint has no named Kubernetes placement.
      configuration: { endpoint: "http://127.0.0.1:1" },
      drivers: {
        sandbox: "sandbox-openshell",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    },
    { gatewayClient: completeOpenShellGatewayClient(client) },
  );
  t.after(() => backend.client.close());
  const driver = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    { backend },
  );
  const refresh = new OpenShellCredentialRefreshDriver({}, { backend });
  const namespace: CredentialSourceContext["namespace"] = {
    id: "ns-fixture",
    name: "oauth-fixture",
    status: "ready",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const context = (id: string): CredentialSourceContext => ({
    namespace,
    signal: AbortSignal.timeout(10_000),
    source: {
      id,
      type: "codex-oauth",
      namespaceId: namespace.id,
      driverId: driver.id,
      config: {},
      name: id,
      ownerCapability: "credential_gateway",
      secrets: {},
      state: "ready",
      createdAt: namespace.createdAt,
    },
  });
  const register = async (id: string) => {
    const current = context(id);
    await driver.registerSource(current, { type: "codex-oauth", config: {}, secrets: {} });
    return current;
  };
  return {
    driver,
    refresh,
    providers,
    profiles,
    rotationRequests,
    context,
    register,
    operations,
    http,
    approve: () => {
      pending = false;
    },
    allowRotation: () => {
      failRotation = false;
    },
    setRefreshStatus: (value: string | undefined) => {
      refreshStatus = value;
    },
  };
}

test("Codex device flow transfers trusted account claims and never reseeds a completed connection", async (t) => {
  const f = fixture(t);
  const owner = await f.register("source-owner");
  const other = await f.register("source-other");
  // Separate OAuth sources must not share a profile: changing or removing one
  // source's endpoint/binary policy must leave the other's policy intact.
  const registered = [...f.providers.values()];
  assert.equal(registered.length, 2);
  const [first, second] = registered;
  assert.ok(first && second);
  assert.notEqual(first.type, second.type);
  for (const provider of registered) {
    assert.equal(provider.type, provider.name);
    assert.equal(f.profiles.get(provider.type)?.id, provider.name);
  }
  assert.deepEqual(await f.refresh.refreshStatus(owner), { state: "pending" });
  const login = await f.refresh.startDeviceAuthorization(owner);
  assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(login.intervalSeconds, 5);
  await assert.rejects(
    f.refresh.pollDeviceAuthorization(other, login.privateState),
    /another credential source/,
  );
  assert.equal(f.http.length, 1, "a login handle cannot cross sources before provider exchange");
  assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
    status: "pending",
  });
  assert.deepEqual(f.operations, []);
  f.approve();
  assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
    status: "ready",
  });
  assert.deepEqual(f.operations, ["configure-refresh", "store-metadata", "rotate", "read-usable"]);
  const [attachment] = await f.driver.attachForRevision({
    namespace: owner.namespace,
    revision: {
      id: "revision-fixture",
      namespaceId: owner.namespace.id,
      agentId: "agent-fixture",
      revision: 1,
      backendId: "openshell",
      executionAdmission: { version: 2, mode: "unprotected" },
      configurationId: "configuration-fixture",
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: {},
      gatewayManagedMode: true,
      harnessAuth: { method: "runtime" },
      compute: { id: "compute-fixture", implementation: "kubernetes" },
      servicePrincipalId: "service-principal-fixture",
      createdAt: owner.namespace.createdAt,
      harness: {
        id: "codex",
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
    },
    sources: [owner.source],
    signal: owner.signal,
  });
  assert.ok(attachment);
  assert.deepEqual(attachment.externalChatgptAuth, {
    accessTokenPlaceholder: "openshell:resolve:env:CODEX_ACCESS_TOKEN",
    accountId: "account-fixture",
    planType: "business",
    userId: "user-fixture",
    accountUserId: "membership-fixture",
    email: "oauth-fixture@example.test",
    isFedramp: false,
  });
  const calls = f.http.length;
  f.operations.length = 0;
  assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
    status: "ready",
  });
  assert.equal(
    f.http.length,
    calls,
    "completed-source replay does not redeem the code or original refresh token again",
  );
  assert.deepEqual(f.operations, ["read-usable"]);
  f.setRefreshStatus(undefined);
  assert.deepEqual(
    await f.refresh.refreshStatus(owner),
    {
      state: "failed",
      recoveryAction: "fix_configuration",
    },
    "a completed connection cannot return to waiting when its refresh grant disappears",
  );
});

test("invalid OAuth token metadata cannot seed an OpenShell credential source", async (t) => {
  const f = fixture(t, { invalidIdToken: true });
  const owner = await f.register("source-owner");
  const login = await f.refresh.startDeviceAuthorization(owner);
  f.approve();
  await assert.rejects(
    f.refresh.pollDeviceAuthorization(owner, login.privateState),
    /invalid token payload/,
  );
  assert.deepEqual(f.operations, [], "validate the trusted bundle before persisting any token");
});

test("configured OAuth material stays pending until the gateway establishes its managed access token", async (t) => {
  const f = fixture(t, { failRotation: true });
  const owner = await f.register("source-owner");
  const login = await f.refresh.startDeviceAuthorization(owner);
  f.approve();
  // Configure and metadata storage succeeded, but the initial rotate RPC never ran.
  // Future expiry from the original OAuth response does not prove managed-token readiness.
  await assert.rejects(
    f.refresh.pollDeviceAuthorization(owner, login.privateState),
    /rotation transport failure/,
  );
  assert.equal((await f.refresh.refreshStatus(owner)).state, "pending");
  const calls = f.http.length;
  f.allowRotation();
  assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
    status: "ready",
  });
  assert.deepEqual(await f.driver.sourceStatus(owner), { state: "ready" });
  assert.equal(
    f.http.length,
    calls,
    "resume from gateway-owned refresh material without replaying OAuth",
  );
  assert.equal(f.operations.filter((operation) => operation === "configure-refresh").length, 1);
  assert.equal(f.rotationRequests.length, 2);
  assert.equal(
    f.rotationRequests[0],
    f.rotationRequests[1],
    "completion retries preserve the mint request ID",
  );
});

test("unfinished OpenShell refresh keeps source and device completion pending", async (t) => {
  const f = fixture(t);
  const owner = await f.register("source-in-progress");
  const login = await f.refresh.startDeviceAuthorization(owner);
  f.approve();
  assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
    status: "ready",
  });
  const exchanges = f.http.length;
  f.operations.length = 0;

  // Upstream publishes both markers during ordinary refresh. Neither proves a
  // completed mint, and a crashed owner may leave one requiring operator recovery.
  for (const phase of ["refresh_in_progress", "refresh_committing"]) {
    f.setRefreshStatus(phase);
    const status = await f.refresh.refreshStatus(owner);
    assert.equal(status.state, "pending");
    assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
      status: "pending",
    });
  }
  assert.equal(f.http.length, exchanges, "waiting does not redeem the device grant again");
  assert.deepEqual(f.operations, [], "waiting does not start another rotation or export");

  f.setRefreshStatus("refreshed");
  assert.deepEqual(await f.refresh.pollDeviceAuthorization(owner, login.privateState), {
    status: "ready",
  });
  assert.deepEqual(f.operations, ["read-usable"]);
});

test("device polling preserves cancellation and rejects a terminal issuer refusal", async (t) => {
  for (const scenario of ["cancelled", "unauthorized"]) {
    await t.test(scenario, async (t) => {
      const cancellation = new AbortController();
      const f = fixture(t, {
        pollResponse: () => {
          if (scenario === "unauthorized") {
            return new Response(null, { status: 401 });
          }
          // Cancellation can race a network failure. It must not become a pending login.
          cancellation.abort(new Error("synthetic caller cancellation"));
          throw new TypeError("synthetic polling connection failure");
        },
      });
      const owner = { ...(await f.register("source-owner")), signal: cancellation.signal };
      const login = await f.refresh.startDeviceAuthorization(owner);
      await assert.rejects(
        f.refresh.pollDeviceAuthorization(owner, login.privateState),
        scenario === "unauthorized" ? /status 401/ : /synthetic/,
      );
      assert.equal(f.http.includes("https://auth.openai.com/oauth/token"), false);
      assert.deepEqual(f.operations, [], "a cancelled or refused poll cannot configure refresh");
    });
  }
});
