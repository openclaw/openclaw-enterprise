import assert from "node:assert/strict";
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
import {
  AgentPluginCatalogResponse,
  CredentialSourceResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { AccessBinding, CredentialGatewayDriver } from "../../packages/contracts/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createDeviceCredentialDrivers } from "../helpers/device-credential-gateway.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { listen } from "../helpers/listen.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  accessToken,
  catalogEntry,
  createFixture,
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

export async function rechecksCredentialSourceGrants(t: TestContext) {
  const { gateway, refresh } = createDeviceCredentialDrivers();
  let wrongReaderCalls = 0;
  const fixture = await createFixture(t, {
    credentialGatewayDriver: gateway,
    // Same public ID, a distinct selected object. Never use this private reader.
    pluginSourceReader: {
      gateway: { ...gateway },
      async withSourceToken(_context, use) {
        wrongReaderCalls += 1;
        return use({ accessToken });
      },
    },
    sandboxDriver: {
      id: "source-discovery-sandbox",
      capability: "sandbox",
      implementation: "test-admission-only",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    },
  });
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const registered = await fixture.request(
    "POST",
    `/namespaces/${fixture.namespace.id}/credential-sources`,
    { body: { name: "Discovery source", type: "codex-device" } },
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const source = fixture.fixtureResponse(
    registered,
    201,
    CredentialSourceResponse,
    "register discovery source",
  ).data.ref;
  // The external credential service is simulated. Its ready token must still pass
  // the real Fastify/OCC/IAM checks; this does not prove OpenShell export or injection.
  gateway.sources.set(source.id, "ready");
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "Source discovery Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
  );
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: fixture.namespace.id,
    agentId: agent.id,
  });
  const actor = await fixture.createAccountWithPolicy("source-discovery-editor", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "source-agent-editor",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["read", "update"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const session = await fixture.signIn(actor.credentials);
  const sourceBindings = [actor.principal.id, agent.servicePrincipalId].map((principalId) => {
    const id = `source-operator-${principalId}`;
    grantRole(fixture.policy, principalId, {
      id,
      namespaceId: fixture.namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: source,
    });
    const binding = fixture.policy.bindings.find((item) => item.id === id);
    assert.ok(binding);
    return binding;
  });
  const path = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`;
  const tokenReads = () =>
    gateway.calls.filter(({ operation }) => operation === "withSourceToken").length;
  const remove = (binding: AccessBinding) => {
    const index = fixture.policy.bindings.findIndex((item) => item.id === binding.id);
    assert.notEqual(index, -1);
    fixture.policy.bindings.splice(index, 1);
  };
  // An external Gateway without its optional callback must still receive 501.
  // Its ID and source ownership alone never authorize a bundled reader fallback.
  const externalWithSourceToken = gateway.withSourceToken;
  const selectedGateway: CredentialGatewayDriver = gateway;
  delete selectedGateway.withSourceToken;
  try {
    const unsupported = await fixture.request("POST", path, { session, body: {} });
    assert.equal(unsupported.status, 501, JSON.stringify(unsupported.body));
    assert.equal(tokenReads(), 0);
    assert.equal(wrongReaderCalls, 0);
    assert.equal(fixture.calls.length, 0);
  } finally {
    gateway.withSourceToken = externalWithSourceToken;
  }
  const allowed = await fixture.request("POST", path, { session, body: {} });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(tokenReads(), 1);
  assert.equal(fixture.calls.length, 1);
  const operations = [
    ["", {}],
    ["/details", { pluginId: remoteId }],
  ] as const;
  const expectDenied = async (suffix: string, body: unknown) => {
    const denied = await fixture.request("POST", `${path}${suffix}`, { session, body });
    assertApiError(denied, 403, "FORBIDDEN");
    assert.equal(fixture.calls.length, 1, "denied source use must not invoke discovery");
  };
  for (const binding of sourceBindings) {
    remove(binding);
    for (const [suffix, body] of operations) {
      await expectDenied(suffix, body);
    }
    assert.equal(tokenReads(), 1, "both grants are required before requesting a source token");
    fixture.policy.bindings.push(binding);
  }

  const withSourceToken = gateway.withSourceToken.bind(gateway);
  let revokedBinding: AccessBinding;
  gateway.withSourceToken = (context, use) =>
    withSourceToken(context, (token) => {
      // Revoke after the external read yields its token, before OCC may hand it to discovery.
      // Neither the Plugin Driver nor an authorization method is replaced here.
      remove(revokedBinding);
      return use(token);
    });
  let reads = tokenReads();
  for (const binding of sourceBindings) {
    for (const [suffix, body] of operations) {
      revokedBinding = binding;
      await expectDenied(suffix, body);
      assert.equal(tokenReads(), ++reads, "retrieval completed before its grant was rechecked");
      fixture.policy.bindings.push(binding);
    }
  }
  gateway.withSourceToken = withSourceToken;

  await t.test(
    "source token read is cancelled when the client disconnects",
    { timeout: 10_000 },
    async (t) => {
      // The loops above restored both grants. Prove this same Agent still reaches
      // the normal synthetic token producer and catalog before holding its next read.
      const live = await fixture.request("POST", path, { session, body: {} });
      assert.equal(live.status, 200, JSON.stringify(live.body));
      assert.equal(tokenReads(), ++reads);
      assert.equal(fixture.calls.length, 2);
      assert.deepEqual(
        fixture.fixtureResponse(live, 200, AgentPluginCatalogResponse, "live source catalog").data,
        { plugins: [catalogEntry], nextCursor: "second-page" },
      );

      const producer = new EventEmitter<{ entered: [AbortSignal]; finished: [] }>();
      const entered = once(producer, "entered", { signal: t.signal });
      const finished = once(producer, "finished", { signal: t.signal });
      // Cleanup can reach this wait after the test deadline has already expired.
      entered.catch(() => {});
      finished.catch(() => {});
      const resume = Promise.withResolvers<void>();
      let started = false;
      let cancelled = false;
      let client: ClientRequest | undefined;
      const holdToken: NonNullable<CredentialGatewayDriver["withSourceToken"]> = async (
        context,
        use,
      ) => {
        started = true;
        producer.emit("entered", context.signal);
        try {
          await resume.promise;
          // Return a token despite cancellation to test OCC's late callback guard too.
          cancelled = context.signal.aborted;
          return await withSourceToken(context, use);
        } finally {
          producer.emit("finished");
        }
      };
      t.mock.method(gateway, "withSourceToken", holdToken);
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
        client.end(JSON.stringify({}));
        const { request: raw, response } = await incoming;
        const [signal]: unknown[] = await entered;
        assert.ok(signal instanceof AbortSignal);
        assert.equal(signal.aborted, false);
        assert.equal(raw.readableEnded, true);
        assert.equal(raw.complete, true);
        const closed = once(response, "close", { signal: t.signal });
        client.destroy();
        await closed;
        assert.equal(response.writableEnded, false);
        // The actual server close must abort the source read, before its own timeout.
        assert.equal(
          signal.aborted,
          true,
          "source token read signal must abort on HTTP disconnect",
        );
        expectReset((await result)[0]);
        resume.resolve();
        await finished;
        assert.equal(cancelled, true, "the held producer saw the real source-read signal abort");
        assert.equal(tokenReads(), reads + 1, "the late callback did yield a fixture token");
        assert.equal(fixture.calls.length, 2, "a late source token must not reach discovery");
      } finally {
        // Release the producer even if the assertion fails. Its completion wait uses the test deadline.
        resume.resolve();
        client?.destroy();
        if (started) {
          await finished;
        }
      }
    },
  );
}
