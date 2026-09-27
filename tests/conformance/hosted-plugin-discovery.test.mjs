import assert from "node:assert/strict";
import test from "node:test";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { PluginDiscoveryError } from "../../packages/occ/src/index.ts";

const accessToken = "at-discovery-fixture";
const pluginId = "plugins~discovery-fixture";
const whoamiUrl = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
const catalogUrl = "https://chatgpt.com/backend-api/ps/";
const workspaceHelp = {
  label: "Manage workspace plugins",
  url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
};
const runtimeHelp = {
  label: "OCE plugin setup",
  url: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
};

// Plugin Service's PluginDirectoryDetailItem and AppBatchRecord wire contracts.
function plugin(release = {}) {
  return {
    id: pluginId,
    name: "discovery-fixture",
    scope: "GLOBAL",
    discoverability: "LISTED",
    status: "ENABLED",
    disabled_reason: null,
    installation_policy: "AVAILABLE",
    authentication_policy: "ON_USE",
    release: {
      id: "release_fixture",
      version: "1.0.0",
      display_name: "Discovery fixture",
      description: "A hosted integration",
      interface: { short_description: "Hosted tools" },
      requires_local_executor: false,
      app_ids: ["connector_fixture"],
      app_manifest: null,
      skills: [],
      mcp_servers: [],
      ...release,
    },
  };
}

function app(id, status = "ENABLED", enabled = true) {
  return {
    id,
    name: id,
    description: "Connected content",
    icon_url: null,
    supported_auth_types: [],
    requires_link_params: false,
    developer: null,
    status,
    tools: [
      {
        name: "search",
        title: "Search",
        description: "Search connected content",
        is_enabled: enabled,
        disabled_reason: enabled ? null : "disabled_by_admin",
        is_read_only: true,
      },
    ],
  };
}

function useService(t, detail, apps, onAppsRequest = () => {}) {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === whoamiUrl) {
      return Response.json({
        email: null,
        chatgpt_user_id: "user_fixture",
        chatgpt_account_id: "account_fixture",
        chatgpt_plan_type: "team",
        chatgpt_account_is_fedramp: false,
      });
    }
    if (url === `${catalogUrl}plugins/${pluginId}?includeDownloadUrls=true`) {
      return Response.json(detail);
    }
    assert.equal(url, `${catalogUrl}apps/batch`);
    onAppsRequest(JSON.parse(init.body));
    return Response.json({ apps });
  });
  return new CodexPluginDriver();
}

for (const q of [undefined, "  ", " linear & docs? "]) {
  test(`hosted plugin discovery preserves pages and opaque cursors for query ${JSON.stringify(q)}`, async (t) => {
    const cursor = "opaque/+cursor?offset=20&rank=a b";
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url === whoamiUrl) {
        return Response.json({
          chatgpt_account_id: "account_fixture",
          chatgpt_account_is_fedramp: false,
        });
      }
      const request = new URL(url);
      requests.push(request);
      return Response.json({
        plugins: request.searchParams.has("pageToken")
          ? []
          : [plugin({ interface: { logo_url: "https://public.example/logo.png" } })],
        pagination: {
          limit: 20,
          next_page_token: request.searchParams.has("pageToken") ? null : cursor,
        },
      });
    });
    const driver = new CodexPluginDriver();
    const first = await driver.discoverCatalog({ accessToken, q });
    assert.equal(requests.length, 1);
    assert.equal(first.plugins[0].id, "codex-plugin:discovery-fixture@openai-curated-remote");
    assert.equal(first.plugins[0].logoUrl, "https://public.example/logo.png");
    assert.equal(first.nextCursor, cursor);
    assert.match(first.setup.message, /App connection status is not verified/);
    assert.match(first.setup.message, /Catalog availability does not confirm linked credentials/);
    assert.match(first.setup.message, /Service accounts/);
    assert.deepEqual(first.setup.links, [
      workspaceHelp,
      { label: "Service account credentials", url: "https://admin.openai.com/" },
      runtimeHelp,
    ]);
    const second = await driver.discoverCatalog({ accessToken, q, cursor: first.nextCursor });
    assert.deepEqual(second, { plugins: [], nextCursor: null, setup: first.setup });
    assert.deepEqual(
      requests.map((url) => ({
        endpoint: `${url.origin}${url.pathname}`,
        parameters: Object.fromEntries(url.searchParams),
      })),
      [
        {
          endpoint: `${catalogUrl}plugins/${q?.trim() ? "search" : "list"}`,
          parameters: { scope: "GLOBAL", limit: "20", ...(q?.trim() ? { q: q.trim() } : {}) },
        },
        {
          endpoint: `${catalogUrl}plugins/${q?.trim() ? "search" : "list"}`,
          parameters: {
            scope: "GLOBAL",
            limit: "20",
            ...(q?.trim() ? { q: q.trim() } : {}),
            pageToken: cursor,
          },
        },
      ],
    );
  });
}

test("hosted plugin logos prefer valid public HTTPS metadata and omit invalid cosmetic values", async (t) => {
  const primary = "https://images.example/logo.png?signature=fixture&expires=123";
  const fallback = "https://images.example/composer.png";
  const detail = plugin();
  const driver = useService(t, detail, [app("connector_fixture")]);
  const cases = [
    [{ logo_url: primary, composer_icon_url: fallback }, primary],
    [{ composer_icon_url: fallback }, fallback],
    [{ logo_url: "http://images.example/logo.png", composer_icon_url: fallback }, fallback],
    [{}, undefined],
    ...[
      null,
      12,
      {},
      "not-a-url",
      "http://images.example/logo.png",
      "data:image/png;base64,aGVsbG8=",
      "https://user:password@images.example/logo.png",
      "https://user@images.example/logo.png",
      "https://images.example/logo\n.png",
      "https://images.example/logo\u0000.png",
      `https://images.example/${"a".repeat(8192)}`,
    ].map((logo_url) => [{ logo_url }, undefined]),
  ];
  for (const [presentation, expected] of cases) {
    detail.release.interface = presentation;
    const result = await driver.getCatalogPlugin({ accessToken, pluginId });
    assert.equal(result.logoUrl, expected);
    assert.equal(Object.hasOwn(result, "logoUrl"), expected !== undefined);
    // Bad decorative metadata must not make an otherwise available plugin unusable.
    assert.equal(result.available, true);
    assert.equal(result.tools.length, 1);
  }
});

test("hosted plugin website and legal links preserve safe URLs and omit unsafe metadata", async (t) => {
  const detail = plugin();
  const driver = useService(t, detail, [app("connector_fixture")]);
  const safeUrl = "https://publisher.example/policy?version=1&source=plugin";
  for (const value of [
    safeUrl,
    undefined,
    "javascript:alert(1)",
    "http://publisher.example/",
    "https://user:password@publisher.example/",
    "https://publisher.example/\npolicy",
    `https://publisher.example/${"x".repeat(8192)}`,
  ]) {
    detail.release.interface = {
      website_url: value,
      privacy_policy_url: value,
      terms_of_service_url: value,
    };
    const serialized = JSON.parse(
      JSON.stringify(await driver.getCatalogPlugin({ accessToken, pluginId })),
    );
    for (const field of ["websiteUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) {
      assert.equal(serialized[field], value === safeUrl ? safeUrl : undefined);
      assert.equal(Object.hasOwn(serialized, field), value === safeUrl);
    }
    assert.equal(serialized.available, true);
  }
});

test("hosted plugin unavailability explains known workspace reasons without exposing unknown text", async (t) => {
  const detail = {
    ...plugin({ mcp_servers: [{ key: "local-only", metadata: { command: "local-tool" } }] }),
    status: "DISABLED_BY_ADMIN",
  };
  const driver = useService(t, detail, [app("connector_fixture")]);
  // The service aggregates several causes under this status; local checks must retain the workspace cause.
  for (const [reason, expected] of [
    ["disabled_by_admin", /Disabled by a ChatGPT workspace administrator/],
    ["plan_not_eligible", /plan is not eligible/],
    ["required_app_unavailable", /required app is unavailable/],
    [null, /did not provide a recognized reason/],
    [`private upstream ${accessToken}`, /did not provide a recognized reason/],
  ]) {
    detail.disabled_reason = reason;
    const result = await driver.getCatalogPlugin({ accessToken, pluginId });
    assert.equal(result.available, false);
    assert.match(result.unavailableReason, expected);
    assert.deepEqual(result.unavailableHelp, workspaceHelp);
    assert.doesNotMatch(JSON.stringify(result), /private upstream|at-discovery-fixture/);
  }
});

test("hosted plugin tools respect parent app access independently of action policy", async (t) => {
  const driver = useService(
    t,
    plugin({ app_ids: ["connector_denied", "connector_owned", "connector_action_denied"] }),
    [
      app("connector_denied", "DISABLED_BY_ADMIN"),
      app("connector_owned", "ONLY_ME"),
      app("connector_action_denied", "ENABLED", false),
    ],
  );
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.deepEqual(
    detail.tools.map(({ ownerId, available }) => ({ ownerId, available })),
    [
      { ownerId: "connector_action_denied", available: false },
      { ownerId: "connector_denied", available: false },
      { ownerId: "connector_owned", available: true },
    ],
  );
  assert.match(detail.tools[0].unavailableReason, /tool is disabled/i);
  assert.match(detail.tools[1].unavailableReason, /app providing this tool/i);
});

test("hosted plugin detail follows native authored app IDs and removes their MCP alternatives", async (t) => {
  const driver = useService(
    t,
    plugin({
      app_ids: ["connector_mapped"],
      app_manifest: { apps: { content: { id: "connector_authored" } } },
      mcp_servers: [{ key: "content", metadata: { command: "local-alternative" } }],
      bundle_download_url: "https://files.openai.com/private-artifact",
    }),
    [app("connector_authored")],
    (body) => assert.deepEqual(body, { app_ids: ["connector_authored"], include_tools: true }),
  );
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.equal(detail.available, true);
  assert.equal(detail.tools[0].ownerId, "connector_authored");
  assert.equal(detail.tools[0].id, "connector_authored/search");
  assert.doesNotMatch(JSON.stringify(detail), /private-artifact|local-alternative/);
});

test("hosted plugin detail rejects an unmatched MCP despite a cloud executor override", async (t) => {
  const driver = useService(
    t,
    plugin({ mcp_servers: [{ key: "local-only", metadata: { command: "local-tool" } }] }),
    [app("connector_fixture")],
  );
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.equal(detail.available, false);
  assert.match(detail.unavailableReason, /components not supported/i);
  assert.deepEqual(detail.unavailableHelp, runtimeHelp);
});

test("hosted plugin detail keeps MCPs whose duplicate app declaration Codex discards", async (t) => {
  const driver = useService(
    t,
    plugin({
      app_manifest: {
        apps: {
          first: { id: "connector_fixture" },
          second: { id: "connector_fixture" },
        },
      },
      mcp_servers: [{ key: "second", metadata: { command: "local-tool" } }],
    }),
    [app("connector_fixture")],
  );
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.equal(detail.available, false);
});

test("hosted plugin detail cannot enable a release with no effective native apps", async (t) => {
  const driver = useService(t, plugin({ app_manifest: { apps: {} } }), []);
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.equal(detail.available, false);
  assert.equal(detail.tools, null);
  assert.equal(
    detail.unavailableReason,
    "This plugin has no concrete hosted app supported by OCE.",
  );
  assert.deepEqual(detail.unavailableHelp, runtimeHelp);
});

test("hosted plugin detail preserves an unknown tool list when an app is omitted", async (t) => {
  const driver = useService(t, plugin({ app_ids: ["connector_fixture", "connector_omitted"] }), [
    app("connector_fixture"),
  ]);
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.equal(detail.tools, null);
});

test("hosted plugin detail accepts native optional tool metadata", async (t) => {
  const metadata = app("connector_fixture");
  // Codex's batch metadata contract defaults these omitted flags and permits absent tools.
  delete metadata.tools[0].is_enabled;
  delete metadata.tools[0].is_read_only;
  const driver = useService(t, plugin(), [metadata]);
  const detail = await driver.getCatalogPlugin({ accessToken, pluginId });
  assert.equal(detail.tools[0].available, true);
  assert.equal(detail.tools[0].writes, true);
  delete metadata.tools;
  assert.equal((await driver.getCatalogPlugin({ accessToken, pluginId })).tools, null);
});

for (const [name, upstream, reason] of [
  [
    "a rejected credential response",
    () => new Response(`private upstream data: ${accessToken}`, { status: 403 }),
    "credentials_rejected",
  ],
  [
    "a transport error containing the credential",
    () => {
      throw new Error(`request failed with ${accessToken}`);
    },
    "unavailable",
  ],
]) {
  test(`hosted plugin discovery sanitizes ${name}`, async (t) => {
    t.mock.method(globalThis, "fetch", upstream);
    await assert.rejects(new CodexPluginDriver().discoverCatalog({ accessToken }), (error) => {
      assert.ok(error instanceof PluginDiscoveryError);
      assert.equal(error.reason, reason);
      assert.equal(error.message, "Plugin discovery failed.");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /at-discovery-fixture|private upstream/);
      return true;
    });
  });
}

test("hosted plugin discovery bounds and cancels an oversized streamed response", async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(new CodexPluginDriver().discoverCatalog({ accessToken }), {
    name: "PluginDiscoveryError",
    reason: "invalid_response",
  });
  assert.equal(cancelled, true);
});
