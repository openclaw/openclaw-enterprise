import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from "node:http";
import type { TestContext } from "node:test";

import { installDeviceCredentialService } from "../helpers/device-credential-service.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { CredentialSourceResponse } from "../../packages/contracts/src/api/resources.ts";
import { authenticatedHeaders } from "../helpers/auth-session.ts";
import { listen } from "../helpers/listen.ts";
import {
  accessToken,
  createFixture,
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
  await installDeviceCredentialService(fixture.controller, fixture.state, fixture.secretDriver);
  const enrolled = await fixture.request(
    "POST",
    `/namespaces/${fixture.namespace.id}/credential-sources`,
    {
      body: {
        type: "static",
        name: "Hosted Apps test account",
        config: { provider_preset: "codex-pat" },
        secret: accessToken,
      },
    },
  );
  const credentialSource = fixture.fixtureResponse(
    enrolled,
    201,
    CredentialSourceResponse,
    "enroll discovery Source",
  ).data.ref;
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
    ["create", fixture.path, { harnessId: "codex", credentialSource }],
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
