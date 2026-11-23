import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AgentDeviceAuthorizationResponse,
  CredentialSourceListResponse,
  CredentialSourceResponse,
  ErrorResponse,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderResponse,
  OpenShellRefreshStatus,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { jsonLineDestination, requireLogRecord } from "../helpers/json-lines.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { unconfiguredGateway } from "../helpers/openshell-gateway-client.ts";
import { DEVICE_LOGIN_FAILED } from "../helpers/refusal-text.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.ts";

function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

test("Console device login completes through the paired OpenShell Refresh Driver without exposing its grant", async (t) => {
  const clock = createControlledClock();
  const logs: unknown[] = [];
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: jsonLineDestination(logs),
  });
  const providers = new Map<string, OpenShellProviderResponse>();
  const operations: string[] = [];
  const expirationTime = new Date(Date.now() + 3_600_000).toISOString();
  const initialAccess = jwt({ exp: Math.floor(Date.parse(expirationTime) / 1000) });
  const initialRefresh = "synthetic-device-refresh-private";
  const managedAccess = "synthetic-managed-access-private";
  let status: OpenShellRefreshStatus | undefined;
  // Only issuer HTTP and OpenShell transport are simulated. Fastify, IAM, OCC,
  // both production Drivers, response parsing, handoff, and session fencing are real.
  // This checks orchestration/custody; the real-gateway lane proves actual minting.
  const client: OpenShellGatewayClient = {
    ...unconfiguredGateway,
    async getProviderProfile() {
      return undefined;
    },
    async importProviderProfile() {},
    async createProvider(input) {
      operations.push("register");
      assert.deepEqual(input.credentials, {});
      const { name, workspace, type, labels } = input;
      const provider = { name, workspace, type, labels, config: {}, resourceVersion: "1" };
      providers.set(name, provider);
      return provider;
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async configureProviderRefresh(input) {
      operations.push("configure");
      assert.equal(input.credentialKey, "CODEX_ACCESS_TOKEN");
      assert.deepEqual(input.material, {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        refresh_token: initialRefresh,
      });
      assert.match(input.requestId, /^[0-9a-f-]{36}$/);
      status = { status: "configured" };
      return status;
    },
    async updateProviderCredentials() {
      assert.fail("the device exchange token must not be seeded through the Credential Gateway");
    },
    async updateProviderConfig(_workspace, name, config) {
      operations.push("metadata");
      const existing = providers.get(name);
      assert.ok(existing);
      const provider = { ...existing, config, resourceVersion: "2" };
      providers.set(name, provider);
      return provider;
    },
    async getProviderRefreshStatus() {
      return status;
    },
    async rotateProviderCredential(_workspace, _name, key, requestId) {
      operations.push("rotate");
      assert.equal(key, "CODEX_ACCESS_TOKEN");
      assert.match(requestId, /^[0-9a-f-]{36}$/);
      status = { status: "refreshed", expirationTime };
      return status;
    },
    async getProviderCredential() {
      operations.push("retrieve");
      return { value: managedAccess, expirationTime };
    },
    async deleteProviderRefresh() {
      operations.push("removeRefresh");
    },
    async deleteProvider(_workspace, name) {
      operations.push("removeProvider");
      providers.delete(name);
    },
    async deleteProviderProfile() {
      operations.push("removeProfile");
    },
  };
  const backend = createOpenShellBackend(
    {
      id: "openshell",
      type: "openshell",
      configuration: { endpoint: "https://fixture.invalid:443" },
      drivers: {
        sandbox: "openshell-sandbox",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    },
    { gatewayClient: client },
  );
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    { backend },
  );
  const refresh = new OpenShellCredentialRefreshDriver({}, { backend });
  const compute = createTestKubernetesComputeDriver("openshell-device-api-compute");
  Object.assign(compute, {
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: "oauth-api-fixture" };
    },
  } satisfies Pick<typeof compute, "ensureNamespace" | "resolveSandboxNamespace">);
  const fixture = await createConsoleAppFixture(t, {
    computeDriver: compute,
    logger,
    now: () => new Date(clock.wallNow()),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OAuth API proof", { ready: true });
  const controller: unknown = fixture.controller;
  assert.ok(controller instanceof OpenClawController);
  for (const driver of [gateway, refresh]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  let polls = 0;
  let loseExchangeResponse = false;
  let startFailure: Response | Error | undefined;
  const pollFailures: (Response | Error)[] = [
    new Response(null, { status: 429 }),
    new Response(null, { status: 503 }),
    new TypeError("synthetic polling connection failure"),
  ];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === "127.0.0.1") {
      return originalFetch(input, init);
    }
    assert.equal(init?.method, "POST");
    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      if (startFailure instanceof Error) {
        throw startFailure;
      }
      if (startFailure !== undefined) {
        return startFailure;
      }
      return Response.json({
        device_auth_id: "synthetic-device-handle",
        user_code: "TEST-CODE",
        interval: "5",
      });
    }
    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
      polls += 1;
      const failure = pollFailures.shift();
      if (failure instanceof Error) {
        throw failure;
      }
      if (failure !== undefined) {
        return failure;
      }
      return Response.json({
        authorization_code: "synthetic-code",
        code_verifier: "synthetic-verifier",
      });
    }
    assert.equal(url, "https://auth.openai.com/oauth/token");
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof URLSearchParams);
    assert.equal(new URLSearchParams(body).get("grant_type"), "authorization_code");
    exchanges += 1;
    if (loseExchangeResponse) {
      // The issuer may already have consumed its code; this result must not be replayed.
      throw new TypeError("synthetic lost token-exchange response");
    }
    return Response.json({
      access_token: initialAccess,
      refresh_token: initialRefresh,
      id_token: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-account",
          chatgpt_plan_type: "plus",
        },
      }),
    });
  };
  t.mock.method(globalThis, "fetch", mockFetch);
  const path = `/namespaces/${namespace.id}/agents/device-authorizations`;
  const startLogin = () => fixture.request("POST", path, { body: { harnessId: "codex" } });
  const pollLogin = (id: string) => fixture.request("POST", `${path}/${id}/poll`, { body: {} });
  const loginData = (response: Awaited<ReturnType<typeof startLogin>>) =>
    fixture.fixtureResponse(response, 200, AgentDeviceAuthorizationResponse, "device login").data;
  const sourcesPath = `/namespaces/${namespace.id}/credential-sources`;

  const started = await startLogin();
  const login = loginData(started);
  assert.equal(login.status, "pending");
  assert.deepEqual(
    operations,
    ["register"],
    "a device source has no refresh grant at registration",
  );
  assert.equal(exchanges, 0);
  const listSources = () => fixture.request("GET", sourcesPath);
  const sourceList = (response: Awaited<ReturnType<typeof listSources>>) =>
    fixture.fixtureResponse(response, 200, CredentialSourceListResponse, "list credential sources")
      .data;
  const [registeredSource] = sourceList(await listSources());
  assert.ok(registeredSource);
  const pendingSource = fixture.fixtureResponse(
    await fixture.request("GET", `${sourcesPath}/${registeredSource.id}`),
    200,
    CredentialSourceResponse,
    "read pending credential source",
  ).data;
  const pendingRefresh = pendingSource.status?.refresh;
  assert.ok(pendingRefresh);
  assert.equal(pendingRefresh.state, "pending");
  assert.equal(pendingRefresh.recoveryAction, undefined);
  assert.deepEqual(operations, ["register"], "reading a pending source must not configure or mint");
  const loginId = login.session.id;
  // These failures precede authorization-code acquisition. Preserve the same login and
  // source, with OCC's existing interval fence, until the issuer can answer.
  const failedPolls = pollFailures.length;
  for (let attempt = 0; attempt < failedPolls; attempt += 1) {
    await clock.advance(5000);
    const pending = loginData(await pollLogin(loginId));
    assert.equal(pending.status, "pending");
    assert.equal(pending.session.id, loginId);
    assert.equal(polls, attempt + 1);
    assert.equal(exchanges, 0, "retryable polling must not redeem an authorization code");
    assert.deepEqual(operations, ["register"], "polling must not configure or mint");
    const observedPolls = polls;
    assert.equal(loginData(await pollLogin(loginId)).status, "pending");
    assert.equal(polls, observedPolls, "OCC still throttles repeated polls");
  }
  await clock.advance(5000);
  const completed = await pollLogin(loginId);
  const ready = loginData(completed);
  assert.equal(ready.status, "ready");
  assert.equal(exchanges, 1);
  assert.equal(operations.filter((operation) => operation === "configure").length, 1);
  assert.equal(operations.filter((operation) => operation === "rotate").length, 1);
  const settled = [...operations];
  assert.equal(loginData(await pollLogin(loginId)).status, "ready");
  assert.deepEqual(operations, settled, "re-polling a completed session must not reseed or mint");
  const { source } = ready;
  assert.ok(source);
  const sources = await listSources();
  const listedSources = sourceList(sources);
  assert.deepEqual(
    listedSources.map(({ id }) => id),
    [source.id],
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "OAuth Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
  );
  assert.equal(agent.harnessAuth?.method, "credential_source");
  assert.equal(agent.harnessAuth.sourceId, source.id);
  const updated = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/credential-sources/${source.id}`,
    { body: {} },
  );
  assert.equal(updated.status, 409, JSON.stringify(updated.body));
  assert.deepEqual(operations, settled);
  const session = await controller.transact((unit) =>
    unit.authenticationStates.findDevice(namespace.id, loginId),
  );
  assert.ok(session);
  assert.equal(session.credentialGatewayId, gateway.id);
  assert.equal(session.credentialRefreshId, refresh.id);
  assert.equal(session.privateState, undefined);
  // A transport failure after the token POST is a different boundary: cancel the
  // new login, erase its private state, and never redeem its code a second time.
  loseExchangeResponse = true;
  const interruptedId = loginData(await startLogin()).session.id;
  await clock.advance(5000);
  const failed = await pollLogin(interruptedId);
  const failedBody = fixture.fixtureResponse(
    failed,
    503,
    ErrorResponse,
    "redeem authorization code",
  );
  // The 503 says the login was cancelled and to start a new one (finding 2536).
  assert.equal(failedBody.error.message, DEVICE_LOGIN_FAILED);
  // The text sends the caller to an operator. The API's 503 record for this request names the
  // Refresh Driver's failure by class (and code, when it has one), never by its message.
  const record = logs
    .map(requireLogRecord)
    .find(
      (line) =>
        line.event === "http.dependency_unavailable" &&
        line.requestId === failedBody.meta.requestId,
    );
  assert.ok(record);
  assert.equal(record.errorClass, "RetryLaterError", JSON.stringify(record));
  assert.deepEqual(record.causes, [{ errorClass: "TypeError" }]);
  assert.equal(JSON.stringify(logs).includes("synthetic lost token-exchange response"), false);
  assert.equal(exchanges, 2);
  // It comes only after the caller's grants: a Namespace reader polling this login and a missing
  // one gets the same denial, each request's own ID hidden.
  const reader = await fixture.createNamespaceMember("device-login-reader", namespace.id, [
    ["read", "namespace"],
  ]);
  const readerSession = await fixture.signIn(reader.credentials);
  await assertSameAnswer(
    (id) => fixture.request("POST", `${path}/${id}/poll`, { session: readerSession, body: {} }),
    [interruptedId, `${interruptedId.slice(0, interruptedId.indexOf("_"))}_${randomUUID()}`],
  );
  assert.equal(exchanges, 2);
  const failedSession = await controller.transact((unit) =>
    unit.authenticationStates.findDevice(namespace.id, interruptedId),
  );
  assert.ok(failedSession);
  assert.equal(failedSession.phase, "cancelled");
  assert.equal(failedSession.privateState, undefined);
  assert.equal((await pollLogin(interruptedId)).status, 409);
  assert.equal(exchanges, 2, "an uncertain token exchange is never replayed");
  const publicAndStored = JSON.stringify([
    started.body,
    completed.body,
    sources.body,
    agent,
    session,
    failed.body,
    failedSession,
  ]);
  for (const credential of [
    initialAccess,
    initialRefresh,
    managedAccess,
    "synthetic-device-handle",
    "synthetic-code",
    "synthetic-verifier",
  ]) {
    assert.equal(
      publicAndStored.includes(credential),
      false,
      "responses and session storage must contain no credential material",
    );
  }
  // The actual Refresh-owned issuer request must distinguish blocked API egress from
  // a reachable service refusing login. Provider text and nested causes stay private.
  const privateText = "private-device-start-response";
  const connectionCause = Object.assign(new Error(`connect refused ${privateText}`), {
    code: "ECONNREFUSED",
  });
  const failures: [Response | Error, "unreachable" | "unavailable", string][] = [
    [new TypeError("fetch failed", { cause: connectionCause }), "unreachable", "ECONNREFUSED"],
    [new DOMException(privateText, "TimeoutError"), "unreachable", "TimeoutError"],
    [new DOMException(privateText, "AbortError"), "unavailable", "AbortError"],
    [Response.json({ error: privateText }, { status: 503 }), "unavailable", "HTTP_503"],
    [new Response(privateText), "unavailable", "invalid_response"],
  ];
  const startWarnings = () =>
    logs.map(requireLogRecord).filter((line) => line.event === "device_authorization.start_failed");
  for (const [failure, reason, failureClass] of failures) {
    startFailure = failure;
    const warningsBefore = startWarnings().length;
    const rejected = fixture.fixtureResponse(await startLogin(), 503, ErrorResponse, "start login");
    assert.equal(rejected.error.code, "DEPENDENCY_UNAVAILABLE");
    if (reason === "unreachable") {
      assert.match(
        rejected.error.message,
        /auth\.openai\.com.*HTTPS connectivity from the API server/,
      );
    } else {
      assert.equal(rejected.error.message, "Device login could not start. Try again.");
    }
    const warnings = startWarnings();
    assert.equal(warnings.length, warningsBefore + 1);
    const warning = warnings.at(-1);
    assert.ok(warning);
    assert.partialDeepStrictEqual(warning, {
      severity: "WARN",
      boundary: "credential_refresh",
      reason,
      failure: failureClass,
    });
    assert.equal(JSON.stringify([rejected, logs]).includes(privateText), false);
  }
  assert.equal(exchanges, 2, "failed starts must never acquire or redeem an authorization code");

  const createCleanupSource = async () => {
    const created = await fixture.request("POST", sourcesPath, {
      body: { name: "Abandoned device login", type: "codex-oauth" },
    });
    const { id } = fixture.fixtureResponse(
      created,
      201,
      CredentialSourceResponse,
      "register abandoned credential source",
    ).data;
    const provider = [...providers.values()].find(
      (candidate) => candidate.labels["openclaw.dev/credential-source-id"] === id,
    );
    assert.ok(provider);
    // The registration fence must not obscure the provider ownership check or successful cleanup.
    await clock.advance(71_000);
    return {
      provider,
      path: `${sourcesPath}/${id}`,
    };
  };
  // Simulate out-of-band replacement in OpenShell. Ordinary OCE sources cannot select these
  // names. Both real Drivers must refuse shared-authority mutations before sending an RPC.
  const replacements: ((provider: OpenShellProviderResponse) => OpenShellProviderResponse)[] = [
    (provider) => ({
      ...provider,
      labels: { ...provider.labels, "app.kubernetes.io/managed-by": "other" },
    }),
    (provider) => ({
      ...provider,
      labels: { ...provider.labels, "openclaw.dev/credential-source-id": "other-source" },
    }),
    (provider) => ({ ...provider, type: "other-profile" }),
  ];
  for (const replacement of replacements) {
    const source = await createCleanupSource();
    const foreign = replacement(source.provider);
    providers.set(source.provider.name, foreign);
    const before = operations.length;
    const rotated = await fixture.request("POST", `${source.path}/rotate`);
    const removed = await fixture.request("DELETE", source.path);
    assertApiError(removed, 404, "NOT_FOUND");
    assert.deepEqual(
      operations.slice(before),
      [],
      "a foreign provider must receive neither rotation nor destructive cleanup RPCs",
    );
    assert.equal(rotated.status, 404, JSON.stringify(rotated.body));
    assert.equal(providers.get(source.provider.name), foreign);

    // The failed removal retains its source record; restoring ownership allows the normal retry.
    providers.set(source.provider.name, source.provider);
    assert.equal((await fixture.request("DELETE", source.path)).status, 204);
    assert.deepEqual(operations.slice(before), [
      "removeRefresh",
      "removeProvider",
      "removeProfile",
    ]);
  }
  const absent = await createCleanupSource();
  providers.delete(absent.provider.name);
  const beforeAbsent = operations.length;
  assert.equal((await fixture.request("DELETE", absent.path)).status, 204);
  assert.deepEqual(
    operations.slice(beforeAbsent),
    ["removeProfile"],
    "an absent provider needs no refresh mutation; source profile cleanup still completes",
  );
});
