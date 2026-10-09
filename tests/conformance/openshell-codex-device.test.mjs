import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";

function jwt(payload) {
  return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

function fixture(t, { invalidIdToken = false, failRotation = false } = {}) {
  const providers = new Map();
  const operations = [];
  const http = [];
  let pending = true;
  let refreshStatus;
  const rotationRequests = [];
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
  t.mock.method(globalThis, "fetch", async (url, init) => {
    http.push(url);
    assert.equal(init.method, "POST");
    switch (url) {
      case "https://auth.openai.com/api/accounts/deviceauth/usercode":
        assert.equal(JSON.parse(init.body).client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
        return Response.json({
          device_auth_id: "device-fixture",
          user_code: "USER-CODE",
          interval: "5",
        });
      case "https://auth.openai.com/api/accounts/deviceauth/token":
        assert.deepEqual(JSON.parse(init.body), {
          device_auth_id: "device-fixture",
          user_code: "USER-CODE",
        });
        return pending
          ? new Response(null, { status: 403 })
          : Response.json({
              authorization_code: "authorization-fixture",
              code_verifier: "verifier-fixture",
            });
      case "https://auth.openai.com/oauth/token": {
        assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
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
  });
  // Simulate only OpenShell storage/RPC responses. The Driver performs the real device
  // response parsing, source ownership checks, handoff sequencing, and attachment projection.
  const client = {
    async getProviderProfile() {},
    async importProviderProfile() {},
    async createProvider(input) {
      providers.set(input.name, { ...input, config: {}, resourceVersion: "1" });
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
      const updated = { ...providers.get(name), config };
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
  };
  const backend = {
    drivers: {
      credential_gateway: "credential-gateway-openshell",
      credential_refresh: "credential-refresh-openshell",
    },
    client: { clientForNamespace: () => client, credentialClientForNamespace: () => client },
  };
  const driver = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    { backend },
  );
  const refresh = new OpenShellCredentialRefreshDriver({}, { backend });
  const namespace = { id: "ns-fixture", name: "oauth-fixture" };
  const context = (id) => ({
    namespace,
    signal: AbortSignal.timeout(10_000),
    source: { id, type: "codex-oauth", namespaceId: namespace.id, driverId: driver.id, config: {} },
  });
  const register = async (id) => {
    const current = context(id);
    await driver.registerSource(current, { type: "codex-oauth", config: {}, secrets: {} });
    return current;
  };
  return {
    driver,
    refresh,
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
    setRefreshStatus: (value) => {
      refreshStatus = value;
    },
  };
}

test("Codex device flow transfers trusted account claims and never reseeds a completed connection", async (t) => {
  const f = fixture(t);
  const owner = await f.register("source-owner");
  const other = await f.register("source-other");
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
    sources: [owner.source],
    signal: owner.signal,
  });
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
