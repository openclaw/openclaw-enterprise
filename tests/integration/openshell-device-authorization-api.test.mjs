import assert from "node:assert/strict";
import test from "node:test";
import { assertApiError } from "../helpers/api-error.mjs";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import {
  CODEX_HARNESS_TEMPLATE_ID,
  CODEX_HARNESS_OAUTH_CLIENT_ID,
} from "../../packages/contracts/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { installCodexDeviceIssuer } from "../helpers/codex-device-issuer.mjs";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

test("device consent pins the native client and saves a personal account in Token Service custody", async (t) => {
  const clock = createControlledClock();
  const logs = [];
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: jsonLineDestination(logs),
  });
  const secrets = createTestSecretDriver();
  const tokens = new OAuthConnectionTokens(secrets, refreshPinnedOAuthGrant);
  const fixture = await createConsoleAppFixture(t, {
    logger,
    secretDriver: secrets,
    preparedTokens: new TokenService(tokens),
    now: () => new Date(clock.wallNow()),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Codex account proof", { ready: true });
  const { createdProviders } = selectTemplateDrivers(fixture.controller);
  const issuer = installCodexDeviceIssuer(t);
  const path = `/namespaces/${namespace.id}/agents/device-authorizations`;
  const start = () => fixture.request("POST", path, { body: { harnessId: "codex" } });
  const started = await start();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.data.status, "pending");
  assert.match(started.data.sessionId, /^cda_/);
  assert.equal(started.data.userCode, "TEST-CODE");
  assert.equal(started.data.source, undefined);
  const pollPath = `${path}/${started.data.sessionId}/poll`;
  const poll = (url = pollPath, extra = {}) => fixture.request("POST", url, { body: {}, ...extra });
  const samePerson = await fixture.signIn(fixture.credentials);
  assert.equal(
    (await poll(pollPath, { session: samePerson })).status,
    404,
    "a different login by this user cannot claim the challenge",
  );
  const privateAttempt = () =>
    fixture.controller.transact((unit) =>
      unit.savedConnections.lockDeviceSession(started.data.sessionId),
    );
  assert.equal(
    await fixture.controller.transact((unit) =>
      unit.secrets.findSecret(namespace.id, started.data.sessionId),
    ),
    undefined,
  );
  assert.match((await privateAttempt()).privateState, /private-device-attempt/);
  const pending = await poll();
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(issuer.polls, 0);
  issuer.pendingReplies.push(
    new Response(null, { status: 429 }),
    new Response(null, { status: 503 }),
    new TypeError("synthetic network error"),
  );
  for (let i = 0; i < 3; i++) {
    await clock.advance(1000);
    assert.equal((await poll()).data.status, "pending");
    assert.equal(issuer.exchanges, 0);
  }
  await clock.advance(1000);
  const completed = await poll();
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.data.status, "ready");
  assert.equal((await poll()).data.status, "ready");
  assert.equal(issuer.exchanges, 1);
  assert.equal((await privateAttempt()).privateState, null);
  const id = completed.data.source.id;
  const { account, custody, source } = await fixture.controller.transact(async (unit) => ({
    account: await unit.savedConnections.findSavedConnection(namespace.id, id),
    custody: await unit.savedConnections.findTokenCustody(namespace.id, id),
    source: await unit.credentialSources.findCredentialSource(namespace.id, id),
  }));
  assert.equal(source.ownerCapability, "credential_refresh");
  assert.equal(source.type, "codex-oauth");
  assert.equal(account.ownerPrincipalId, (await privateAttempt()).actorId);
  assert.equal(account.connectionTemplateId, CODEX_HARNESS_TEMPLATE_ID);
  assert.equal(account.oauthClientId, CODEX_HARNESS_OAUTH_CLIENT_ID);
  assert.equal(account.codexAccount.accountId, issuer.accountId);
  assert.equal(account.codexAccount.email, undefined, "provider did not verify the address");
  assert.equal(
    (await tokens.warm(custody, AbortSignal.timeout(1000))).accessToken,
    issuer.accessToken,
  );
  assert.deepEqual(createdProviders, [], "OpenShell never receives the reusable grant");

  await fixture.request("DELETE", `${path}/${started.data.sessionId}`);
  const accounts = await fixture.request("GET", `/namespaces/${namespace.id}/connections`);
  assert.equal(accounts.status, 200, JSON.stringify(accounts.body));
  assert.ok(
    accounts.data.some((account) => account.credentialSourceId === id),
    "closing the attempt preserves the saved connection",
  );
  for (const credential of [
    issuer.accessToken,
    issuer.refreshToken,
    "private-device-attempt",
    "private-verifier",
  ]) {
    assert.equal(
      JSON.stringify([started.body, completed.body, accounts.body, logs]).includes(credential),
      false,
    );
  }

  // An uncertain exchange might already have spent the code. Record terminal cleanup and
  // require a new sign-in rather than allowing a retry to submit it a second time.
  const interrupted = await start();
  await clock.advance(1000);
  issuer.loseExchange = true;
  const interruptedPath = `${path}/${interrupted.data.sessionId}/poll`;
  assert.equal((await poll(interruptedPath)).status, 503);
  assert.equal((await poll(interruptedPath)).status, 409);
  assert.equal(issuer.exchanges, 2);
  const failed = await fixture.controller.transact((unit) =>
    unit.savedConnections.lockDeviceSession(interrupted.data.sessionId),
  );
  assert.equal(failed.phase, "cancelled");
  assert.equal(failed.privateState, null);
  await clock.advance(120000);
  await fixture.controller.expireConnectionSessions(32);
  assert.equal(
    await fixture.controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(namespace.id, failed.credentialSourceId),
    ),
    undefined,
  );
  // A second tab can poll a claimed code, and the originating browser can discard it
  // while the issuer is responding. That late response must never publish a saved account.
  issuer.loseExchange = false;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  issuer.beforeExchange = async () => {
    entered.resolve();
    await release.promise;
  };
  const inFlight = await start();
  const attemptUrl = `${path}/${inFlight.data.sessionId}`;
  await clock.advance(1000);
  const lateResponse = poll(`${attemptUrl}/poll`);
  try {
    await entered.promise;
    assert.equal((await poll(`${attemptUrl}/poll`)).data.status, "pending");
    assert.equal((await fixture.request("DELETE", attemptUrl)).status, 204);
  } finally {
    release.resolve();
  }
  assert.equal((await lateResponse).status, 409);
  assert.equal(issuer.exchanges, 3);
  const cancelled = await fixture.controller.transact((unit) =>
    unit.savedConnections.lockDeviceSession(inFlight.data.sessionId),
  );
  assert.equal(cancelled.phase, "cancelled");
  assert.deepEqual(
    await fixture.controller.transact(async (unit) => [
      await unit.savedConnections.findTokenCustody(namespace.id, cancelled.credentialSourceId),
      await unit.savedConnections.findSavedConnection(namespace.id, cancelled.credentialSourceId),
    ]),
    [undefined, undefined],
  );
  // A registration fence delays final removal of a just-cancelled source. Even with a
  // one-row batch the next attempt must make progress before that fence clears.
  await clock.advance(1);
  const queued = await start();
  assert.equal((await fixture.request("DELETE", `${path}/${queued.data.sessionId}`)).status, 204);
  await fixture.controller.expireConnectionSessions(1);
  await fixture.controller.expireConnectionSessions(1);
  const queuedId = await fixture.controller.transact(async (unit) => {
    const attempt = await unit.savedConnections.lockDeviceSession(queued.data.sessionId);
    assert.equal(
      (await unit.credentialSources.findCredentialSource(namespace.id, attempt.credentialSourceId))
        .state,
      "deleting",
    );
    return attempt.credentialSourceId;
  });
  await clock.advance(120000);
  await fixture.controller.expireConnectionSessions(2);
  assert.equal(
    await fixture.controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(namespace.id, queuedId),
    ),
    undefined,
  );

  // The actual Refresh-owned issuer request must distinguish blocked API egress from
  // a reachable service refusing login. Provider text and nested causes stay private.
  const privateText = "private-device-start-response";
  const connectionCause = Object.assign(new Error(`connect refused ${privateText}`), {
    code: "ECONNREFUSED",
  });
  const failures = [
    [new TypeError("fetch failed", { cause: connectionCause }), "unreachable", "ECONNREFUSED"],
    [new DOMException(privateText, "TimeoutError"), "unreachable", "TimeoutError"],
    [new DOMException(privateText, "AbortError"), "unavailable", "AbortError"],
    [Response.json({ error: privateText }, { status: 503 }), "unavailable", "HTTP_503"],
    [new Response(privateText), "unavailable", "invalid_response"],
  ];
  for (const [failure, reason, failureClass] of failures) {
    issuer.startFailure = failure;
    const warningsBefore = logs.filter(
      (line) => line.event === "device_authorization.start_failed",
    ).length;
    const rejected = await fixture.request("POST", path, { body: { harnessId: "codex" } });
    assert.equal(rejected.status, 503, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "DEPENDENCY_UNAVAILABLE");
    if (reason === "unreachable") {
      assert.match(
        rejected.body.error.message,
        /auth\.openai\.com.*HTTPS egress.*API Pods.*api\.modelDiscoveryCidrs/,
      );
    } else {
      assert.equal(rejected.body.error.message, "Device login could not start. Try again.");
    }
    const warnings = logs.filter((line) => line.event === "device_authorization.start_failed");
    assert.equal(warnings.length, warningsBefore + 1);
    assert.deepEqual(
      {
        severity: warnings.at(-1).severity,
        boundary: warnings.at(-1).boundary,
        reason: warnings.at(-1).reason,
        failure: warnings.at(-1).failure,
      },
      { severity: "WARN", boundary: "credential_refresh", reason, failure: failureClass },
    );
    assert.equal(JSON.stringify([rejected.body, logs]).includes(privateText), false);
  }
  assert.equal(
    issuer.exchanges,
    3,
    "failed starts must never acquire or redeem an authorization code",
  );
});

test("the paired Drivers clean only their own legacy Codex OAuth provider", async (t) => {
  const clock = createControlledClock();
  const operations = [];
  const providers = new Map();
  const client = {
    async getProviderProfile() {},
    async importProviderProfile() {},
    async createProvider(input) {
      providers.set(input.name, { ...input, config: {}, resourceVersion: "1" });
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async getProviderRefreshStatus() {},
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
    close() {},
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
  const compute = createTestKubernetesComputeDriver("legacy-device-api-compute");
  Object.assign(compute, {
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: "oauth-api-fixture" };
    },
  });
  const fixture = await createConsoleAppFixture(t, {
    computeDriver: compute,
    now: () => new Date(clock.wallNow()),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Legacy Codex login", { ready: true });
  for (const driver of [
    new OpenShellCredentialGatewayDriver({ binaries: ["/usr/local/bin/codex"] }, { backend }),
    new OpenShellCredentialRefreshDriver({}, { backend }),
  ]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const createCleanupSource = async () => {
    const created = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/credential-sources`,
      {
        body: { name: "Abandoned device login", type: "codex-oauth" },
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const provider = [...providers.values()].find(
      (candidate) => candidate.labels["openclaw.dev/credential-source-id"] === created.data.id,
    );
    assert.ok(provider);
    // The registration fence must not obscure the provider ownership check or successful cleanup.
    await clock.advance(71_000);
    return {
      provider,
      path: `/namespaces/${namespace.id}/credential-sources/${created.data.id}`,
    };
  };
  // Simulate out-of-band replacement in OpenShell. Ordinary OCE sources cannot select these
  // names. Both real Drivers must refuse shared-authority mutations before sending an RPC.
  for (const replacement of [
    (provider) => ({
      ...provider,
      labels: { ...provider.labels, "app.kubernetes.io/managed-by": "other" },
    }),
    (provider) => ({
      ...provider,
      labels: { ...provider.labels, "openclaw.dev/credential-source-id": "other-source" },
    }),
    (provider) => ({ ...provider, type: "other-profile" }),
  ]) {
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
