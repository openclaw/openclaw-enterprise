import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { assertApiError } from "../helpers/api-error.mjs";
import type { ModelDiscoveryFixture } from "./secret-api.test.ts";

export function registerModelDiscoveryCases({
  createFixture,
  bootstrapNamespace,
  request,
  responseError,
  grantRole,
}: ModelDiscoveryFixture) {
  function createModelDiscoveryFixture() {
    const native = createTestKubernetesComputeDriver("compute-model-discovery");
    return createFixture({
      computeDriver: {
        ...createReadyComputeDriver("compute-secret-api"),
        discoverHarnessModels: native.discoverHarnessModels,
      },
    });
  }

  test("Agent model discovery uses native provider APIs without creating platform resources", async (t) => {
    const fixture = await createModelDiscoveryFixture();
    const namespace = await bootstrapNamespace(fixture);
    const apiKey = `model-discovery-key-${randomUUID()}`;
    const pages = [
      { data: [{ id: "z-model" }, { id: "embedding-model" }, { id: "ft:model/custom" }] },
      {
        data: [{ id: "claude-new", display_name: "New Claude" }],
        has_more: true,
        last_id: "claude-new",
      },
      {
        data: [{ id: "claude-previous", display_name: "Previous Claude" }],
        has_more: false,
        last_id: "claude-previous",
      },
      { data: [], has_more: false, last_id: null },
      { chatgpt_account_id: "verified-account", chatgpt_account_is_fedramp: true },
      {
        models: [
          {
            slug: "codex-later",
            display_name: "Later model",
            visibility: "list",
            priority: 2,
            model_messages: { instructions: "omit runtime prompts" },
          },
          { slug: "codex-hidden", display_name: "Hidden model", visibility: "hide", priority: 0 },
          { slug: "codex-dynamic", display_name: "Codex dynamic", visibility: "list", priority: 1 },
        ],
      },
    ];
    const transport = t.mock.method(
      globalThis,
      "fetch",
      async (..._request: Parameters<typeof fetch>) => {
        const page = pages.shift();
        assert.ok(page, "Unexpected provider request after the queued responses");
        return Response.json(page);
      },
    );
    const path = `/namespaces/${namespace.id}/agents/models`;
    const openai = await request(fixture.app, "POST", path, {
      body: { provider: "openai", authMethod: "api_key", apiKey },
    });
    assert.equal(openai.status, 200);
    assert.equal(openai.headers.get("cache-control"), "no-store");
    assert.deepEqual(openai.data, [
      { id: "embedding-model", name: "embedding-model" },
      { id: "ft:model/custom", name: "ft:model/custom" },
      { id: "z-model", name: "z-model" },
    ]);
    const anthropic = await request(fixture.app, "POST", path, {
      body: { provider: "anthropic", authMethod: "api_key", apiKey },
    });
    assert.equal(anthropic.status, 200);
    assert.deepEqual(anthropic.data, [
      { id: "claude-new", name: "New Claude" },
      { id: "claude-previous", name: "Previous Claude" },
    ]);
    const empty = await request(fixture.app, "POST", path, {
      body: { provider: "anthropic", authMethod: "api_key", apiKey },
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, []);
    const pat = await request(fixture.app, "POST", path, {
      body: { provider: "openai", authMethod: "codex_pat", apiKey: "at-fixture-token" },
    });
    assert.equal(pat.status, 200);
    assert.deepEqual(pat.data, [
      { id: "codex-dynamic", name: "Codex dynamic" },
      { id: "codex-later", name: "Later model" },
    ]);
    const calls = transport.mock.calls.map(({ arguments: args }) => args);
    assert.deepEqual(
      calls.map(([url]) => url),
      [
        "https://api.openai.com/v1/models",
        "https://api.anthropic.com/v1/models?limit=1000",
        "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-new",
        "https://api.anthropic.com/v1/models?limit=1000",
        "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
        "https://chatgpt.com/backend-api/codex/models?client_version=0.156.0",
      ],
    );
    assert.deepEqual(calls[0]?.[1]?.headers, { Authorization: `Bearer ${apiKey}` });
    for (const [, options] of calls.slice(1, 4)) {
      assert.deepEqual(options?.headers, {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      });
    }
    for (const [, options] of calls) {
      assert.ok(options);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
    }
    assert.equal(calls[1]?.[1]?.signal, calls[2]?.[1]?.signal);
    assert.deepEqual(calls[4]?.[1]?.headers, { Authorization: "Bearer at-fixture-token" });
    assert.deepEqual(calls[5]?.[1]?.headers, {
      Authorization: "Bearer at-fixture-token",
      "ChatGPT-Account-ID": "verified-account",
      "X-OpenAI-Fedramp": "true",
    });
    assert.equal(calls[4]?.[1]?.signal, calls[5]?.[1]?.signal);
    assert.deepEqual(fixture.secretDriver.calls, []);
    assert.deepEqual(
      await fixture.controller().transact(async (unit) => ({
        agents: await unit.namespaces.hasAgents(namespace.id),
        configurations: await unit.namespaces.hasConfigurations(namespace.id),
        secrets: await unit.namespaces.hasSecrets(namespace.id),
      })),
      { agents: false, configurations: false, secrets: false },
    );
    assert.equal(JSON.stringify([openai.body, anthropic.body, empty.body]).includes(apiKey), false);
    assert.equal(JSON.stringify(fixture.auditSink.events).includes(apiKey), false);
  });

  test("OpenAI API-key model discovery excludes models whose shutdown date has arrived", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-04-15T23:59:59Z") });
    const fixture = await createModelDiscoveryFixture();
    const namespace = await bootstrapNamespace(fixture);
    // OpenAI's optional shutdown_date is a calendar date, independent of model age or ID.
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        data: [
          { id: "past-shutdown", shutdown_date: "2030-04-14" },
          { id: "today-shutdown", shutdown_date: "2030-04-15" },
          { id: "future-shutdown", shutdown_date: "2030-04-16" },
          { id: "invalid-date", shutdown_date: "2030-02-30" },
          { id: "invalid-type", shutdown_date: 1 },
          { id: "null-shutdown", shutdown_date: null },
          { id: "unspecified-shutdown", created: 1 },
        ],
      }),
    );
    const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents/models`, {
      body: { provider: "openai", authMethod: "api_key", apiKey: "synthetic-discovery-key" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, [
      { id: "future-shutdown", name: "future-shutdown" },
      { id: "invalid-date", name: "invalid-date" },
      { id: "invalid-type", name: "invalid-type" },
      { id: "null-shutdown", name: "null-shutdown" },
      { id: "unspecified-shutdown", name: "unspecified-shutdown" },
    ]);
  });

  test("Codex service-account discovery returns visible models when the catalog omits priority", async (t) => {
    const fixture = await createModelDiscoveryFixture();
    const namespace = await bootstrapNamespace(fixture);
    // The operator catalog command lists visibility "list" and does not read priority.
    // A hidden row is not part of that list. The shipped models API is the entry.
    const pages = [
      { chatgpt_account_id: "verified-account", chatgpt_account_is_fedramp: false },
      {
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
          { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" },
        ],
      },
    ];
    const transport = t.mock.method(
      globalThis,
      "fetch",
      async (..._request: Parameters<typeof fetch>) => {
        const page = pages.shift();
        assert.ok(page, "Unexpected provider request after the queued responses");
        return Response.json(page);
      },
    );
    const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents/models`, {
      body: { provider: "openai", authMethod: "codex_pat", apiKey: "at-fixture-token" },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(result.data, [
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4", name: "GPT-5.4" },
    ]);
    assert.deepEqual(
      transport.mock.calls.map(({ arguments: args }) => args[0]),
      [
        "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
        "https://chatgpt.com/backend-api/codex/models?client_version=0.156.0",
      ],
    );
    assert.equal(
      JSON.stringify([result.body, fixture.auditSink.events]).includes("at-fixture-token"),
      false,
    );
  });

  test("Service account token discovery rejects invalid identity without falling through to the API-key endpoint", async (t) => {
    const fixture = await createModelDiscoveryFixture();
    const namespace = await bootstrapNamespace(fixture);
    for (const [response, expectedCode] of [
      [
        Response.json({ error: "private upstream error" }, { status: 401 }),
        "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
      ],
      [Response.json({ chatgpt_account_id: "unverified" }), "MODEL_DISCOVERY_INVALID_RESPONSE"],
    ] as const) {
      const transport = t.mock.method(
        globalThis,
        "fetch",
        async (..._request: Parameters<typeof fetch>) => response,
      );
      const result = await request(
        fixture.app,
        "POST",
        `/namespaces/${namespace.id}/agents/models`,
        {
          body: { provider: "openai", authMethod: "codex_pat", apiKey: "at-private-fixture" },
        },
      );
      assert.equal(responseError(result).code, expectedCode);
      assert.equal(transport.mock.callCount(), 1);
      assert.equal(
        transport.mock.calls[0]?.arguments[0],
        "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      );
      assert.doesNotMatch(
        JSON.stringify([result.body, fixture.auditSink.events]),
        /at-private-fixture|private upstream error/,
      );
      transport.mock.restore();
    }
  });

  test("Agent model discovery requires namespace Agent-create permission before provider I/O", async (t) => {
    const fixture = await createModelDiscoveryFixture();
    const namespace = await bootstrapNamespace(fixture);
    const { principal: reader, app: readerApp } = await fixture.createPrincipal("model-reader");
    grantRole(fixture.state, reader.id, {
      id: "role-model-reader",
      bindingId: "binding-model-reader",
      namespaceId: namespace.id,
      permissions: { namespace: ["read"] },
    });
    const transport = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
    const apiKey = `denied-discovery-key-${randomUUID()}`;
    const denied = await request(readerApp, "POST", `/namespaces/${namespace.id}/agents/models`, {
      body: { provider: "openai", authMethod: "api_key", apiKey },
    });
    assertApiError(denied, 403, "FORBIDDEN");
    assert.equal(transport.mock.callCount(), 0);
    const denial = fixture.auditSink.events.at(-1);
    assert.ok(denial?.kind === "authorization_denial");
    assert.deepEqual(denial.authorization, {
      principalId: reader.id,
      action: "create",
      resource: { kind: "agent", id: namespace.id, namespaceId: namespace.id },
    });
    assert.equal(JSON.stringify([denied.body, denial]).includes(apiKey), false);

    const role = fixture.state.roles.find(({ id }) => id === "role-model-reader");
    assert.ok(role);
    role.permissions.push({
      action: "create",
      resourceKind: "agent",
    });
    const granted = await request(readerApp, "POST", `/namespaces/${namespace.id}/agents/models`, {
      body: { provider: "openai", authMethod: "api_key", apiKey },
    });
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.data, []);
    assert.equal(transport.mock.callCount(), 1);
  });

  test("Agent model discovery reports unsupported Compute Drivers without contacting a provider", async (t) => {
    const fixture = await createFixture();
    const namespace = await bootstrapNamespace(fixture);
    const transport = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
    const result = await request(fixture.app, "POST", `/namespaces/${namespace.id}/agents/models`, {
      body: {
        provider: "openai",
        authMethod: "api_key",
        apiKey: `unsupported-key-${randomUUID()}`,
      },
    });
    assert.equal(result.status, 501);
    assert.equal(responseError(result).code, "NOT_IMPLEMENTED");
    assert.equal(
      responseError(result).message,
      "Model discovery is unavailable. Enter a model ID manually.",
    );
    assert.equal(transport.mock.callCount(), 0);
  });

  test("Agent model discovery bounds and redacts provider failures", async (t) => {
    const fixture = await createModelDiscoveryFixture();
    const namespace = await bootstrapNamespace(fixture);
    const apiKey = `private-discovery-key-${randomUUID()}`;
    const upstreamDetail = `private-upstream-detail-${randomUUID()}`;
    let oversizedCancelled = false;
    const credentialsRejected = [
      400,
      "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
      "The provider rejected model discovery. Check the selected credential and its permission to list models, then retry or enter a model ID manually.",
    ] as const;
    const rateLimited = [
      429,
      "MODEL_DISCOVERY_RATE_LIMITED",
      "The provider rate-limited model discovery. Wait and retry, or enter a model ID manually.",
    ] as const;
    const unavailable = [
      503,
      "MODEL_DISCOVERY_UNAVAILABLE",
      "The provider model service is unavailable. Retry or enter a model ID manually.",
    ] as const;
    const invalidResponse = [
      503,
      "MODEL_DISCOVERY_INVALID_RESPONSE",
      "The provider returned an invalid model list. Retry or enter a model ID manually.",
    ] as const;
    const scenarios = [
      [
        "rejected API key",
        () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 401 }),
        credentialsRejected,
      ],
      [
        "missing Models permission",
        () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 403 }),
        credentialsRejected,
      ],
      [
        "provider rate limit",
        () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 429 }),
        rateLimited,
      ],
      [
        "provider service error",
        () => Response.json({ error: `${upstreamDetail} ${apiKey}` }, { status: 500 }),
        unavailable,
      ],
      [
        "transport error",
        () => {
          throw new Error(`${upstreamDetail} ${apiKey}`);
        },
        unavailable,
      ],
      [
        "provider timeout",
        () => {
          throw new DOMException(`${upstreamDetail} ${apiKey}`, "TimeoutError");
        },
        unavailable,
      ],
      ["malformed JSON", () => new Response(`{${upstreamDetail} ${apiKey}`), invalidResponse],
      [
        "missing model list",
        () => Response.json({ message: `${upstreamDetail} ${apiKey}` }),
        invalidResponse,
      ],
      [
        "oversized stream",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
              },
              cancel() {
                oversizedCancelled = true;
              },
            }),
          ),
        invalidResponse,
      ],
    ] as const;
    for (const [name, respond, [status, code, message]] of scenarios) {
      await t.test(name, async (subtest) => {
        const transport = subtest.mock.method(globalThis, "fetch", respond);
        const failed = await request(
          fixture.app,
          "POST",
          `/namespaces/${namespace.id}/agents/models`,
          { body: { provider: "openai", authMethod: "api_key", apiKey } },
        );
        assert.equal(failed.status, status);
        assert.equal(responseError(failed).code, code);
        assert.equal(responseError(failed).message, message);
        assert.equal(transport.mock.callCount(), 1);
        const exposed = JSON.stringify([failed.body, fixture.auditSink.events]);
        assert.equal(exposed.includes(apiKey), false);
        assert.equal(exposed.includes(upstreamDetail), false);
      });
    }
    assert.equal(oversizedCancelled, true);
  });
}
