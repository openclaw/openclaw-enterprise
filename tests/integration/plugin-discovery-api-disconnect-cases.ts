import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  ServerResponse,
  type ClientRequest,
} from "node:http";
import type { TestContext } from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { AgentResponse } from "../../packages/contracts/src/api/resources.ts";
import type {
  AccessBinding,
  ResolvedCredential,
  TokenServiceSourceInstance,
} from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { authenticatedHeaders } from "../helpers/auth-session.ts";
import { createDeviceCredentialDrivers } from "../helpers/device-credential-gateway.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.ts";
import { listen } from "../helpers/listen.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  accessToken,
  createFixture,
  createDiscoveryLogger,
  createSavedAgent,
  remoteId,
  boundPort,
  fetchUrl,
} from "./plugin-discovery-api-fixture.ts";

async function waitForRequest(server: Parameters<typeof boundPort>[0], signal: AbortSignal) {
  const [request, response]: unknown[] = await once(server, "request", { signal });
  assert.ok(request instanceof IncomingMessage && response instanceof ServerResponse);
  return { request, response };
}

function expectReset(error: unknown) {
  assert.ok(error instanceof Error && "code" in error);
  assert.equal(error.code, "ECONNRESET");
}

export async function honorsDisconnectsDuringIam(t: TestContext) {
  const completions = new WeakMap<IncomingMessage, () => void>();
  const fixture = await createFixture(t, {
    onSend: async (request) => {
      completions.get(request.raw)?.();
    },
  });
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const saved = await createSavedAgent(fixture);
  const headers = authenticatedHeaders(await fixture.signIn(), {
    "content-type": "application/json",
  });

  const identity = "/api/accounts/v1/user-auth-credential/whoami";
  const list = "/backend-api/ps/plugins/list";
  const detail = `/backend-api/ps/plugins/${remoteId}`;
  const payloads: Record<string, unknown> = {
    [identity]: { chatgpt_account_id: "fixture", chatgpt_account_is_fedramp: false },
    [list]: { plugins: [], pagination: { next_page_token: null } },
    [detail]: {
      id: remoteId,
      name: "knowledge",
      scope: "GLOBAL",
      status: "ENABLED",
      installation_policy: "AVAILABLE",
      release: { app_ids: [], skills: [{ name: "knowledge" }], mcp_servers: [], interface: {} },
    },
  };
  const received: string[] = [];
  const port = await listen(
    t,
    createServer((request, response) => {
      assert.ok(request.url);
      const { pathname } = new URL(request.url, "http://localhost");
      received.push(pathname);
      response.writeHead(Object.hasOwn(payloads, pathname) ? 200 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(payloads[pathname] ?? {}));
    }),
  );
  const fetch = globalThis.fetch;
  // Redirect only provider transport. The bundled Driver still performs identity and catalog reads.
  const fetchProvider: typeof fetch = (url, init) => {
    const target = fetchUrl(url);
    assert.ok(["https://auth.openai.com", "https://chatgpt.com"].includes(target.origin));
    return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
  };
  t.mock.method(globalThis, "fetch", fetchProvider);

  const server = fixture.app.server;
  const origin = `http://127.0.0.1:${boundPort(server)}`;
  const admin = fixture.policy.identities[0];
  assert.ok(admin);
  for (const [scope, base, credential] of [
    ["create", fixture.path, { harnessId: "codex", accessToken }],
    ["saved", saved.path, {}],
  ] as const) {
    for (const [operation, path, body, providerPath] of [
      ["list", base, credential, list],
      ["details", `${base}/details`, { ...credential, pluginId: remoteId }, detail],
    ] as const) {
      for (const [method, disconnect] of [
        ["lookupIdentity", false],
        ["lookupIdentity", true],
        ["authorize", true],
      ] as const) {
        await t.test(
          `${scope} ${operation} ${disconnect ? "disconnected" : "connected"} during ${method}`,
          async (t) => {
            const start = received.length;
            const evaluated = Promise.withResolvers<() => void>();
            const resume = Promise.withResolvers<void>();
            const iam = fixture.iamDriver;
            // Hold a real IAM result in the pre-handler or inside OCC, after the POST is consumed.
            if (method === "lookupIdentity") {
              const lookupIdentity = iam.lookupIdentity.bind(iam);
              const holdLookup: typeof iam.lookupIdentity = async (input) => {
                const identity = await lookupIdentity(input);
                evaluated.resolve(() => assert.equal(identity?.id, admin.id));
                await resume.promise;
                return identity;
              };
              t.mock.method(iam, "lookupIdentity", holdLookup);
            } else {
              const authorize = iam.authorize.bind(iam);
              const holdAuthorization: typeof iam.authorize = async (input) => {
                const decision = await authorize(input);
                evaluated.resolve(() => assert.equal(decision.allowed, true));
                await resume.promise;
                return decision;
              };
              t.mock.method(iam, "authorize", holdAuthorization);
            }
            t.after(() => resume.resolve());
            const incoming = waitForRequest(server, t.signal);
            const client = httpRequest(origin + path, {
              method: "POST",
              headers: { ...headers, host: new URL(fixture.origin).host },
              agent: false,
            });
            t.after(() => {
              client.destroy();
            });
            // Cleanup can destroy the socket after the test deadline. Keep its error listener alive.
            const result = once(client, disconnect ? "error" : "response");
            result.catch(() => {});
            client.end(JSON.stringify(body));
            const { request: raw, response } = await incoming;
            const completed = Promise.withResolvers<void>();
            completions.set(raw, completed.resolve);
            const verifyDecision = await evaluated.promise;
            verifyDecision();
            assert.equal(raw.readableEnded, true);
            assert.equal(raw.complete, true);
            if (disconnect) {
              const closed = once(response, "close", { signal: t.signal });
              client.destroy();
              await closed;
              assert.equal(response.writableEnded, false);
            }
            resume.resolve();
            // Wait for this route's send hook, so zero requests cannot be a slow provider call.
            const [clientEvents] = await Promise.all([result, completed.promise]);
            const [reply]: unknown[] = clientEvents;
            if (disconnect) {
              expectReset(reply);
            } else {
              assert.ok(reply instanceof IncomingMessage);
              assert.equal(reply.statusCode, 200);
              reply.resume();
            }
            assert.deepEqual(received.slice(start), disconnect ? [] : [identity, providerPath]);
          },
        );
      }
    }
  }
}

class ControlledTokenService extends OCCTokenServiceDriver {
  resolves = 0;
  afterResolved: ((signal: AbortSignal) => Promise<void> | void) | undefined;
  failure: Error | undefined;
  synchronousFailure = false;

  override resolveCredential(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    this.resolves += 1;
    if (this.failure && this.synchronousFailure) {
      throw this.failure;
    }
    return super.resolveCredential(source, signal).then(async (actual) => {
      if (this.failure) {
        throw this.failure;
      }
      // Hold only delivery of the concrete owner's real result. This lets the test revoke
      // a grant or disconnect HTTP after custody resolved but before OCC can dispatch it.
      await this.afterResolved?.(signal);
      return actual;
    });
  }
}

async function codexSourceFixture(
  t: TestContext,
  logger?: ReturnType<typeof createDiscoveryLogger>["logger"],
) {
  const fixture = await createFixture(t, {
    ...(logger === undefined ? {} : { logger }),
    sandboxDriver: {
      id: "source-discovery-sandbox",
      capability: "sandbox",
      implementation: "test-admission-only",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    },
  });
  const ownerId = "plugin-token-service";
  const instanceId = await fixture.controller.activateTokenServiceInstance(ownerId, randomUUID());
  const owner = new ControlledTokenService(
    ownerId,
    fixture.controller.installation.id,
    fixture.secretDriver.installationSecrets,
    instanceId,
    fixture.state,
    undefined,
    new OAuthAccountTokens(
      fixture.state,
      fixture.secretDriver,
      fixture.controller.resolveConnectionClient.bind(fixture.controller),
    ),
  );
  fixture.controller.registerDriver(owner);
  fixture.controller.selectDriver("token_service", owner.id);
  const account = { accountId: "account-discovery", planType: "plus", isFedramp: true };
  // The real TokenService owns registration and custody after the controlled device exchange.
  // This does not claim that an interactive provider approved the device code.
  const registered = await owner.createSource(
    {
      kind: "oauth_refresh_token",
      namespaceId: fixture.namespace.id,
      name: "Codex discovery account",
      consent: { kind: "builtin_codex", ownerPrincipalId: fixture.principal.id, account },
      grant: {
        accessToken,
        refreshToken: "synthetic-refresh-first",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestedScopes: ["openid"],
        grantedScopes: ["openid"],
      },
    },
    AbortSignal.timeout(5_000),
  );
  const source = {
    kind: "credential_source" as const,
    namespaceId: fixture.namespace.id,
    id: registered.id,
  };
  const actor = await fixture.createAccountWithPolicy("source-discovery-editor", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "source-agent-creator",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["create"] },
    });
  });
  const session = await fixture.signIn(actor.credentials);
  const callerBinding = grantRole(fixture.policy, actor.principal.id, {
    id: "source-caller-operator",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: source,
  }).binding;
  return { fixture, owner, instanceId, source, account, actor, session, callerBinding };
}

export async function suppressesSourceResolutionErrors(t: TestContext) {
  const { logger, logs } = createDiscoveryLogger();
  const { fixture, owner, source, session } = await codexSourceFixture(t, logger);
  const sentinel = "source-owner-private-sentinel";
  const selected = { harnessId: "codex", credentialSource: source };
  // A selected producer can throw before returning a Promise or reject after custody I/O.
  for (const [error, status, synchronous] of [
    [new ResourceStateConflictError(sentinel), 409, true],
    [new DependencyUnavailableError(sentinel), 503, false],
  ] as const) {
    owner.failure = error;
    owner.synchronousFailure = synchronous;
    for (const [suffix, body] of operations) {
      const before = owner.resolves;
      const response = await fixture.request("POST", `${fixture.path}${suffix}`, {
        session,
        body: { ...selected, ...body },
      });
      assert.equal(response.status, status);
      assert.equal(owner.resolves, before + 1, "the selected concrete owner was called");
      assert.equal(JSON.stringify(response.body).includes(sentinel), false);
    }
  }
  assert.deepEqual(fixture.calls, [], "a failed resolve cannot dispatch a catalog request");
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(sentinel), false);
  assert.ok(logs.length > 0, "the request logger was captured");
  assert.equal(logs.join("").includes(sentinel), false);
}

type CodexSourceFixture = Awaited<ReturnType<typeof codexSourceFixture>>;
const operations = [
  ["", {}],
  ["/details", { pluginId: remoteId }],
] as const;

function removeBinding(fixture: CodexSourceFixture["fixture"], binding: AccessBinding) {
  const index = fixture.policy.bindings.findIndex((item) => item.id === binding.id);
  assert.notEqual(index, -1);
  fixture.policy.bindings.splice(index, 1);
}

async function expectDenied(
  context: CodexSourceFixture,
  path: string,
  body: unknown,
  calls: number,
) {
  const result = await context.fixture.request("POST", path, { session: context.session, body });
  assertApiError(result, 403, "FORBIDDEN");
  assert.equal(context.fixture.calls.length, calls, "denied source use must not invoke discovery");
}

export async function rechecksCredentialSourceGrants(t: TestContext) {
  const context = await codexSourceFixture(t);
  const { fixture, owner, instanceId, account, source, session, callerBinding } = context;
  const selected = { harnessId: "codex", credentialSource: source };
  for (const [suffix, body] of operations) {
    const before = owner.resolves;
    const result = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { ...selected, ...body },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(owner.resolves, before + 1);
    assert.deepEqual(fixture.calls.at(-1)?.input, {
      accessToken,
      accountId: account.accountId,
      isFedramp: account.isFedramp,
      ...body,
    });
    assert.equal(JSON.stringify(result.body).includes(accessToken), false);
  }
  let driverCalls = fixture.calls.length;
  removeBinding(fixture, callerBinding);
  const resolves = owner.resolves;
  for (const [suffix, body] of operations) {
    await expectDenied(context, `${fixture.path}${suffix}`, { ...selected, ...body }, driverCalls);
  }
  assert.equal(owner.resolves, resolves, "IAM refuses custody access before resolve");
  fixture.policy.bindings.push(callerBinding);

  // Only the external token endpoint is controlled. Real TokenService custody, refresh,
  // state transitions, and the following Fastify discovery request remain in the path.
  const refreshedToken = "at-plugin-discovery-refreshed";
  const realFetch = globalThis.fetch;
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (fetchUrl(input).href === "https://auth.openai.com/oauth/token") {
      exchanges += 1;
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
      return Promise.resolve(
        Response.json({
          access_token: refreshedToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "synthetic-refresh-next",
          scope: "openid",
        }),
      );
    }
    return realFetch(input, init);
  });
  await owner.forceRefresh(
    { sourceRef: source, tokenServiceInstanceId: instanceId },
    AbortSignal.timeout(5_000),
  );
  assert.equal(exchanges, 1);
  const refreshed = await fixture.request("POST", `${fixture.path}/details`, {
    session,
    body: { ...selected, pluginId: remoteId },
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(
    fixture.calls.at(-1)?.input.accessToken,
    refreshedToken,
    "the next request uses refreshed custody",
  );
  driverCalls = fixture.calls.length;

  for (const [suffix, body] of operations) {
    const before = owner.resolves;
    owner.afterResolved = () => removeBinding(fixture, callerBinding);
    await expectDenied(context, `${fixture.path}${suffix}`, { ...selected, ...body }, driverCalls);
    owner.afterResolved = undefined;
    assert.equal(owner.resolves, before + 1, "the grant was revoked after real resolution");
    fixture.policy.bindings.push(callerBinding);
  }

  // Historical Gateway rows never become canonical TokenService Codex Sources; configuring
  // a Gateway must not create a second reader or a fallback using the old persisted row.
  const { gateway } = createDeviceCredentialDrivers();
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  const legacyId = `cs_${randomUUID()}`;
  await fixture.state.transact((unit) =>
    unit.credentialSources.createCredentialSource({
      id: legacyId,
      namespaceId: fixture.namespace.id,
      name: "Historical Codex account",
      type: "codex-device",
      ownerCapability: "credential_gateway",
      driverId: gateway.id,
      config: {},
      secrets: {},
      state: "ready",
      createdAt: new Date().toISOString(),
    }),
  );
  const legacy = { ...source, id: legacyId };
  grantRole(fixture.policy, context.actor.principal.id, {
    id: "legacy-source-operator",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: legacy,
  });
  const refused = await fixture.request("POST", fixture.path, {
    session,
    body: { harnessId: "codex", credentialSource: legacy },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(gateway.calls.filter(({ operation }) => operation === "withSourceToken").length, 0);
  assert.equal(fixture.calls.length, driverCalls);

  await assertResolveDisconnect(t, context, `${fixture.path}`, selected, driverCalls);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(refreshedToken), false);
}

async function assertResolveDisconnect(
  t: TestContext,
  { fixture, owner, session }: CodexSourceFixture,
  path: string,
  body: unknown,
  driverCalls: number,
) {
  const producer = new EventEmitter<{ entered: [AbortSignal]; finished: [] }>();
  const entered = once(producer, "entered", { signal: t.signal });
  const finished = once(producer, "finished", { signal: t.signal });
  entered.catch(() => {});
  finished.catch(() => {});
  const resume = Promise.withResolvers<void>();
  let started = false;
  let cancelled = false;
  let client: ClientRequest | undefined;
  owner.afterResolved = async (signal) => {
    started = true;
    producer.emit("entered", signal);
    try {
      await resume.promise;
      cancelled = signal.aborted;
    } finally {
      producer.emit("finished");
    }
  };
  try {
    const server = fixture.app.server;
    const incoming = waitForRequest(server, t.signal);
    client = httpRequest(`http://127.0.0.1:${boundPort(server)}${path}`, {
      method: "POST",
      headers: authenticatedHeaders(session, {
        "content-type": "application/json",
        host: new URL(fixture.origin).host,
      }),
      agent: false,
    });
    const result = once(client, "error");
    result.catch(() => {});
    client.on("response", (reply) => reply.resume());
    client.end(JSON.stringify(body));
    const { request: raw, response } = await incoming;
    const [signal]: unknown[] = await entered;
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.equal(raw.complete, true);
    const closed = once(response, "close", { signal: t.signal });
    client.destroy();
    await closed;
    assert.equal(signal.aborted, true, "HTTP disconnect aborts the real resolve signal");
    expectReset((await result)[0]);
    resume.resolve();
    await finished;
    assert.equal(cancelled, true);
    assert.equal(fixture.calls.length, driverCalls, "a late token cannot reach the Plugin Driver");
  } finally {
    resume.resolve();
    client?.destroy();
    if (started) {
      await finished;
    }
    owner.afterResolved = undefined;
  }
}

export async function savedAgentCredentialSourceGrants(t: TestContext) {
  const context = await codexSourceFixture(t);
  const { fixture, owner, source, account, actor, session, callerBinding } = context;
  const configuration = await fixture.createConfiguration(
    fixture.namespace.id,
    createHarnessConfiguration("codex", "gpt-5.1"),
  );
  const created = await fixture.request("POST", `/namespaces/${fixture.namespace.id}/agents`, {
    body: {
      name: "Source discovery Agent",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
  });
  // This intentionally requires the aggregate's canonical OAuth Source admission. A standalone
  // dependency head that cannot admit the Source must fail here, not fabricate persisted state.
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agent = fixture.fixtureResponse(created, 201, AgentResponse, "create Agent").data;
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: fixture.namespace.id,
    agentId: agent.id,
  });
  grantRole(fixture.policy, actor.principal.id, {
    id: "source-agent-editor",
    namespaceId: fixture.namespace.id,
    permissions: { agent: ["read", "update"] },
    resource: { kind: "agent", id: agent.id },
  });
  const agentBinding = grantRole(fixture.policy, agent.servicePrincipalId, {
    id: "source-agent-operator",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: source,
  }).binding;
  const path = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`;
  const alternate = await owner.createSource(
    {
      kind: "oauth_refresh_token",
      namespaceId: fixture.namespace.id,
      name: "Other Codex account",
      consent: {
        kind: "builtin_codex",
        ownerPrincipalId: fixture.principal.id,
        account: { ...account, accountId: "account-other" },
      },
      grant: {
        accessToken: "at-other-codex-account",
        refreshToken: "synthetic-refresh-other",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestedScopes: ["openid"],
        grantedScopes: ["openid"],
      },
    },
    AbortSignal.timeout(5_000),
  );
  const alternateSource = { ...source, id: alternate.id };
  grantRole(fixture.policy, actor.principal.id, {
    id: "source-other-caller-operator",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: alternateSource,
  });

  // A person's access to a different account cannot override this saved Agent's Harness binding.
  for (const [suffix, body] of operations) {
    const preAgent = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", credentialSource: alternateSource, ...body },
    });
    assert.equal(preAgent.status, 200, JSON.stringify(preAgent.body));
    const beforeSavedOverride = owner.resolves;
    const result = await fixture.request("POST", `${path}${suffix}`, {
      session,
      body: { ...body, credentialSource: alternateSource },
    });
    assertApiError(result, 404, "NOT_FOUND");
    assert.equal(owner.resolves, beforeSavedOverride, "an unbound account must not reach custody");
  }
  for (const [suffix, body] of operations) {
    const result = await fixture.request("POST", `${path}${suffix}`, { session, body });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(fixture.calls.at(-1)?.input, {
      accessToken,
      accountId: account.accountId,
      isFedramp: account.isFedramp,
      ...body,
    });
    const explicit = await fixture.request("POST", `${path}${suffix}`, {
      session,
      body: { ...body, credentialSource: source },
    });
    assert.equal(explicit.status, 200, JSON.stringify(explicit.body));
  }
  const driverCalls = fixture.calls.length;
  for (const binding of [callerBinding, agentBinding]) {
    removeBinding(fixture, binding);
    const before = owner.resolves;
    for (const [suffix, body] of operations) {
      await expectDenied(context, `${path}${suffix}`, body, driverCalls);
      await expectDenied(
        context,
        `${path}${suffix}`,
        { ...body, credentialSource: source },
        driverCalls,
      );
    }
    assert.equal(owner.resolves, before);
    fixture.policy.bindings.push(binding);
    for (const [suffix, body] of operations) {
      for (const requestBody of [body, { ...body, credentialSource: source }]) {
        owner.afterResolved = () => removeBinding(fixture, binding);
        await expectDenied(context, `${path}${suffix}`, requestBody, driverCalls);
        owner.afterResolved = undefined;
        fixture.policy.bindings.push(binding);
      }
    }
  }
}

export async function refusesUnboundSavedAgentSource(t: TestContext) {
  const { fixture, owner, source, account, actor, session } = await codexSourceFixture(t);
  const { agent, path } = await createSavedAgent(fixture);
  grantRole(fixture.policy, actor.principal.id, {
    id: "source-saved-agent-editor",
    namespaceId: fixture.namespace.id,
    permissions: { agent: ["read", "update"] },
    resource: { kind: "agent", id: agent.id },
  });
  for (const [suffix, body] of operations) {
    // Pre-Agent discovery is governed by the caller's exact Source operate grant.
    const preAgent = await fixture.request("POST", `${fixture.path}${suffix}`, {
      session,
      body: { harnessId: "codex", credentialSource: source, ...body },
    });
    assert.equal(preAgent.status, 200, JSON.stringify(preAgent.body));
    assert.deepEqual(fixture.calls.at(-1)?.input, {
      accessToken,
      accountId: account.accountId,
      isFedramp: account.isFedramp,
      ...body,
    });

    // The same Source cannot be used on a saved Agent whose Harness is bound elsewhere.
    const resolves = owner.resolves;
    const calls = fixture.calls.length;
    const saved = await fixture.request("POST", `${path}${suffix}`, {
      session,
      body: { credentialSource: source, ...body },
    });
    assertApiError(saved, 404, "NOT_FOUND");
    assert.equal(owner.resolves, resolves);
    assert.equal(fixture.calls.length, calls);
  }
}
