import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  codexCatalogEntries,
  codexOpenClawConfiguration,
  codexRuntimeArtifact,
  codexRuntimeReadParams,
  openClawRuntimeArtifact,
  validatePolicies,
} from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import { NativeCodexPluginCatalogReader } from "../../apps/controller/src/drivers/plugin/stdio-catalog-reader.ts";
import { NotImplementedError } from "../../packages/occ/src/index.ts";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

const namespace = Object.freeze({
  id: "ns_plugin",
  name: "Plugin conformance",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
});

const agent = Object.freeze({
  id: "agent_plugin",
  namespaceId: namespace.id,
  name: "Plugin agent",
  configurationId: "cfg_plugin",
  executionMode: "embedded",
  servicePrincipalId: "sp_plugin",
  createdAt: namespace.createdAt,
});

const linearPluginId = "codex-plugin:linear@openai-curated-remote";
const calendarPluginId = "codex-plugin:google-calendar@openai-curated-remote";
const thirdPluginId = "codex-plugin:third-plugin@openai-curated-remote";
const thirdRemotePluginId = "opaque-third-123";

function context(mode, configuration = {}) {
  return {
    namespace,
    agent: { ...agent, executionMode: mode },
    harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "2026.9.0", mode },
    configuration,
    signal: AbortSignal.timeout(1_000),
  };
}

function occSelection(overrides = {}) {
  return {
    "occ-plugin:diffs": {
      enabled: true,
      toolDefaults: { approval: "approve" },
      ...overrides,
    },
  };
}

function codexSelection(pluginId = linearPluginId, overrides = {}) {
  return {
    [pluginId]: {
      enabled: true,
      toolDefaults: { approval: "native" },
      ...overrides,
    },
  };
}

function codexCatalogFixture() {
  return {
    marketplaces: [
      {
        name: "openai-internal-testing",
        plugins: [
          {
            id: "internal-only@openai-internal-testing",
            remotePluginId: "opaque-internal-only",
            interface: { displayName: "Internal Only" },
            version: "0.0.1",
          },
        ],
      },
      {
        name: "openai-curated-remote",
        plugins: [
          {
            id: "linear@openai-curated-remote",
            remotePluginId: "linear",
            interface: { displayName: "Linear" },
            version: "5.0.1",
          },
          {
            id: "google-calendar@openai-curated-remote",
            remotePluginId: "google-calendar",
            interface: { displayName: "Google Calendar" },
            version: "1.2.7",
          },
          {
            id: "third-plugin@openai-curated-remote",
            remotePluginId: thirdRemotePluginId,
            interface: { displayName: "Third Plugin" },
            version: "2.3.4",
          },
        ],
      },
    ],
  };
}

function codexDetail(remotePluginId, appIds, options = {}) {
  return {
    plugin: {
      summary: {
        id: options.summaryId ?? `${remotePluginId}@openai-curated-remote`,
        remotePluginId,
        interface: { displayName: options.displayName ?? remotePluginId },
        ...(options.version === undefined ? { version: "1.0.0" } : { version: options.version }),
      },
      apps: appIds.map((id) => ({ id })),
      appTemplates: options.appTemplates ?? [],
      hooks: options.hooks ?? [],
      skills: options.skills ?? [],
      mcpServers: options.mcpServers ?? [],
      scheduledTasks: options.scheduledTasks ?? [],
    },
  };
}

const codexDetails = Object.freeze([
  codexDetail("linear", ["asdk_app_69a089a326dc8191b32a3f2553f5be2c"], {
    displayName: "Linear",
    version: "5.0.1",
  }),
  codexDetail("google-calendar", ["connector_947e0d954944416db111db556030eea6"], {
    displayName: "Google Calendar",
    version: "1.2.7",
  }),
  codexDetail(thirdRemotePluginId, ["connector_third_fixture"], {
    summaryId: "third-plugin@openai-curated-remote",
    displayName: "Third Plugin",
    version: "2.3.4",
  }),
]);

test("OpenClaw Plugin Driver lists the vetted Diffs catalog entry", async () => {
  const driver = new OCCPluginDriver(
    {},
    { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
  );

  const [catalogEntry] = await driver.listCatalog(context("embedded"));
  assert.deepEqual(catalogEntry, {
    id: "occ-plugin:diffs",
    name: "Diffs",
    tools: [{ id: "diffs", name: "diffs", ownerId: "diffs" }],
  });
});

test("OpenClaw plugin startup translation renders native install and enablement", () => {
  const enabled = openClawRuntimeArtifact(occSelection());
  assert.deepEqual(enabled.installs, [
    {
      pluginId: "occ-plugin:diffs",
      nativeId: "diffs",
      packageName: "@openclaw/diffs",
      version: "2026.8.2",
      integrity: OCC_DIFFS_DIGEST,
    },
  ]);
  assert.deepEqual(enabled.configuration.plugins.entries.diffs, { enabled: true });
  assert.deepEqual(enabled.configuration.tools, { alsoAllow: ["diffs"] });

  const blocked = openClawRuntimeArtifact(occSelection({ enabled: false }));
  assert.deepEqual(blocked.configuration.plugins.entries.diffs, { enabled: false });
  assert.equal(Object.hasOwn(blocked.configuration, "tools"), false);
});

test("OpenClaw plugin startup translation rejects unsupported policies", () => {
  for (const selection of [
    occSelection({ toolDefaults: { approval: "prompt" } }),
    occSelection({ toolDefaults: { reviewer: "auto" } }),
    occSelection({ tools: { unknown: { enabled: false } } }),
    occSelection({ tools: { diffs: { approval: "prompt" } } }),
    occSelection({ approvalMode: "never" }),
    { "occ-plugin:unknown": { enabled: true } },
  ]) {
    assert.throws(() => openClawRuntimeArtifact(selection));
  }
});

test("OpenClaw tool enablement overrides tool defaults without enabling a disabled plugin", () => {
  const selections = occSelection({
    toolDefaults: { enabled: false },
    tools: { diffs: { enabled: true } },
  });
  assert.deepEqual(openClawRuntimeArtifact(selections).configuration, {
    plugins: { entries: { diffs: { enabled: true } } },
    tools: { alsoAllow: ["diffs"] },
  });
  const disabledTool = openClawRuntimeArtifact(
    occSelection({ tools: { diffs: { enabled: false, approval: "approve" } } }),
  );
  assert.deepEqual(disabledTool.configuration.tools, { alsoAllow: ["diffs"], deny: ["diffs"] });
  selections["occ-plugin:diffs"].enabled = false;
  assert.deepEqual(openClawRuntimeArtifact(selections).configuration, {
    plugins: { entries: { diffs: { enabled: false } } },
  });
});

test("Codex curated catalog discovery projects arbitrary marketplace entries", () => {
  const catalog = codexCatalogEntries(codexCatalogFixture());
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  assert.deepEqual(catalog[2], {
    id: thirdPluginId,
    name: "Third Plugin",
    tools: null,
  });
  assert.deepEqual(codexRuntimeReadParams(codexSelection(thirdPluginId), codexCatalogFixture()), [
    { remoteMarketplaceName: "openai-curated-remote", pluginName: thirdRemotePluginId },
  ]);
});

test("native Codex catalog reader accepts initialized logged-in accounts and opaque remote IDs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-codex-plugin-reader-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "codex-fixture.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

const catalog = ${JSON.stringify(codexCatalogFixture())};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    return;
  }
  if (message.method === "account/read") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        account: {
          type: "chatgpt",
          email: "fixture@example.test",
          planType: "team"
        },
        requiresOpenaiAuth: true
      }
    }));
    return;
  }
  if (message.method === "plugin/list") {
    console.log(JSON.stringify({ id: message.id, result: catalog }));
    process.exit(0);
  }
});
`,
  );
  await chmod(executable, 0o755);

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 1_000,
  });

  const catalog = await reader.listCatalog();
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  assert.equal(catalog[2].name, "Third Plugin");

  const fixture = await readFile(executable, "utf8");
  await writeFile(executable, fixture.replace('type: "chatgpt"', 'type: "apiKey"'));
  await assert.rejects(reader.listCatalog(), /ChatGPT\/Codex-backed account/);
});

test("Codex startup default-denies plugins", () => {
  const empty = codexRuntimeArtifact({}, []);
  assert.equal(empty.kind, "codex");
  assert.deepEqual(empty.configuration.features, {
    apps: false,
    plugins: false,
    remote_plugin: false,
  });
  assert.deepEqual(empty.configuration.apps, { _default: { enabled: false } });
  assert.deepEqual(empty.configuration.plugins, {});
  assert.deepEqual(empty.installs, []);
});

test("Codex bridge configuration carries repository broker network policy without plugins", () => {
  const bridgeConfiguration = codexOpenClawConfiguration({}, [], {
    host: "git.tenant.svc",
    domains: { "github.com": "allow" },
  });

  assert.deepEqual(bridgeConfiguration.plugins.entries.codex.config, {
    appServer: {
      networkProxy: {
        enabled: true,
        mode: "full",
        allowLocalBinding: true,
        readOnlyPaths: [
          "/app/node_modules/openclaw",
          "/opt/oce/repository-credentials",
          "/run/oce/repository-credentials",
        ],
        domains: { "github.com": "allow", "git.tenant.svc": "allow" },
      },
    },
  });
});

test("Codex startup translation renders selected marketplace app plugins", () => {
  const selections = {
    ...codexSelection(linearPluginId),
    ...codexSelection(calendarPluginId, { toolDefaults: { approval: "native", reviewer: "auto" } }),
    ...codexSelection(thirdPluginId),
  };
  const artifact = codexRuntimeArtifact(selections, codexDetails);
  const bridgeConfiguration = codexOpenClawConfiguration(selections);

  assert.equal(artifact.kind, "codex");
  assert.deepEqual(artifact.configuration.apps, {
    _default: { enabled: false },
    asdk_app_69a089a326dc8191b32a3f2553f5be2c: {
      enabled: true,
      default_tools_approval_mode: "auto",
    },
    connector_947e0d954944416db111db556030eea6: {
      enabled: true,
      default_tools_approval_mode: "auto",
      approvals_reviewer: "auto_review",
    },
    connector_third_fixture: { enabled: true, default_tools_approval_mode: "auto" },
  });
  assert.deepEqual(bridgeConfiguration.plugins.entries.codex.config.codexPlugins.plugins, {
    linear: {
      enabled: true,
      marketplaceName: "openai-curated-remote",
      pluginName: "linear",
      allow_destructive_actions: "auto",
    },
    "google-calendar": {
      enabled: true,
      marketplaceName: "openai-curated-remote",
      pluginName: "google-calendar",
      allow_destructive_actions: "auto",
    },
    "third-plugin": {
      enabled: true,
      marketplaceName: "openai-curated-remote",
      pluginName: "third-plugin",
      allow_destructive_actions: "auto",
    },
  });
  assert.deepEqual(artifact.installs, [
    {
      pluginId: linearPluginId,
      nativeId: "linear@openai-curated-remote",
      remotePluginId: "linear",
      version: "5.0.1",
      registry: "openai-curated-remote",
    },
    {
      pluginId: calendarPluginId,
      nativeId: "google-calendar@openai-curated-remote",
      remotePluginId: "google-calendar",
      version: "1.2.7",
      registry: "openai-curated-remote",
    },
    {
      pluginId: thirdPluginId,
      nativeId: "third-plugin@openai-curated-remote",
      remotePluginId: thirdRemotePluginId,
      version: "2.3.4",
      registry: "openai-curated-remote",
    },
  ]);
});

test("Codex startup translation preserves explicit approval defaults and routed reviewer selection", () => {
  for (const approval of ["native", "prompt", "approve"]) {
    for (const [reviewer, nativeReviewer] of [
      ["human", "user"],
      ["auto", "auto_review"],
      [undefined, undefined],
    ]) {
      const selections = codexSelection(linearPluginId, {
        toolDefaults: { approval, ...(reviewer === undefined ? {} : { reviewer }) },
      });
      const app = codexRuntimeArtifact(selections, codexDetails).configuration.apps
        .asdk_app_69a089a326dc8191b32a3f2553f5be2c;
      assert.equal(app.default_tools_approval_mode, approval === "native" ? "auto" : approval);
      assert.equal(app.approvals_reviewer, nativeReviewer);
      assert.equal(Object.hasOwn(app, "approvals_reviewer"), reviewer !== undefined);
      assert.equal(Object.hasOwn(app, "default_tools_enabled"), false);
      assert.equal(
        codexOpenClawConfiguration(selections).plugins.entries.codex.config.codexPlugins.plugins
          .linear.allow_destructive_actions,
        "auto",
      );
    }
  }
  const disabled = codexSelection(linearPluginId, { enabled: false });
  assert.deepEqual(codexRuntimeArtifact(disabled, codexDetails).configuration.apps, {
    _default: { enabled: false },
  });
  assert.equal(
    codexOpenClawConfiguration(disabled).plugins.entries.codex.config.codexPlugins.plugins.linear
      .enabled,
    false,
  );
});

test("Codex scoped tools override independent defaults and retain omitted native fields", () => {
  const appId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
  const inventory = [
    {
      name: "codex_apps",
      tools: Object.fromEntries(
        ["repos/read", "repos/write"].map((name) => [
          name,
          { name, _meta: { connector_id: appId } },
        ]),
      ),
    },
  ];
  const selections = codexSelection(linearPluginId, {
    toolDefaults: { enabled: false, approval: "prompt", reviewer: "auto" },
    tools: {
      [appId + "/repos%2Fread"]: { enabled: true },
      [appId + "/repos%2Fwrite"]: { approval: "native" },
    },
  });
  const app = codexRuntimeArtifact(selections, codexDetails, [], inventory).configuration.apps[
    appId
  ];
  assert.deepEqual(app, {
    enabled: true,
    default_tools_enabled: false,
    default_tools_approval_mode: "prompt",
    approvals_reviewer: "auto_review",
    tools: {
      "repos/read": { enabled: true },
      "repos/write": { approval_mode: "auto" },
    },
  });
  assert.equal(
    codexOpenClawConfiguration(selections).plugins.entries.codex.config.codexPlugins.plugins.linear
      .allow_destructive_actions,
    "auto",
  );
  for (const id of [
    "repos/read",
    "other-app/repos%2Fread",
    appId + "/missing",
    appId + "/repos%2fread",
  ]) {
    assert.throws(
      () =>
        codexRuntimeArtifact(
          codexSelection(linearPluginId, { tools: { [id]: { enabled: false } } }),
          codexDetails,
          [],
          inventory,
        ),
      /tool/i,
    );
  }
  assert.throws(() => codexRuntimeArtifact(selections, codexDetails), /inventory/i);
});

test("Codex destructive defaults project to native config and the hosted-app bridge", () => {
  const selections = codexSelection(linearPluginId, {
    toolDefaults: { approval: "native", reviewer: "human" },
    driverPolicy: { destructiveEnabled: false },
  });
  const app = codexRuntimeArtifact(selections, codexDetails).configuration.apps
    .asdk_app_69a089a326dc8191b32a3f2553f5be2c;
  assert.equal(app.destructive_enabled, false);
  assert.equal(Object.hasOwn(app, "default_tools_enabled"), false);
  assert.equal(
    codexOpenClawConfiguration(selections).plugins.entries.codex.config.codexPlugins.plugins.linear
      .allow_destructive_actions,
    false,
  );
  for (const enabled of [true, false]) {
    assert.throws(
      () =>
        validatePolicies(
          "codex",
          codexSelection(linearPluginId, {
            toolDefaults: { enabled },
            driverPolicy: { destructiveEnabled: false },
          }),
        ),
      /bypasses category/,
    );
  }
  for (const driverPolicy of [
    { unknown: true },
    { destructiveEnabled: "false" },
    { approvalsReviewer: "user" },
  ]) {
    assert.throws(() =>
      validatePolicies("codex", codexSelection(linearPluginId, { driverPolicy })),
    );
  }
});

test("Codex startup translation fails selected-only policy gaps at startup", () => {
  for (const [selection, details, pattern] of [
    [codexSelection(linearPluginId, { approvalMode: "never" }), codexDetails, /unsupported/i],
    [codexSelection(linearPluginId, { writes: "prompt" }), codexDetails, /unsupported/i],
    [codexSelection(linearPluginId, { tools: { search: {} } }), codexDetails, /tool/i],
    [codexSelection(linearPluginId), [], /detail/i],
    [codexSelection(linearPluginId), [codexDetail("linear", [])], /app mapping/i],
    [
      codexSelection(linearPluginId),
      [codexDetail("linear", ["app"], { version: "" })],
      /release version/i,
    ],
    [
      codexSelection(linearPluginId),
      [codexDetail("linear", ["app"], { mcpServers: [{ id: "native" }] })],
      /mcpServers/i,
    ],
    [
      {
        ...codexSelection(linearPluginId, {
          toolDefaults: { approval: "native", reviewer: "human" },
        }),
        ...codexSelection(thirdPluginId, {
          toolDefaults: { approval: "native", reviewer: "auto" },
        }),
      },
      [
        codexDetail("linear", ["shared_app"]),
        codexDetail(thirdRemotePluginId, ["shared_app"], {
          summaryId: "third-plugin@openai-curated-remote",
          version: "2.3.4",
        }),
      ],
      /conflicting approval policy/i,
    ],
  ]) {
    assert.throws(() => codexRuntimeArtifact(selection, details), pattern);
  }
});

test("Codex rejects shared app enablement conflicts in either selection order", () => {
  const selections = {
    ...codexSelection(linearPluginId),
    ...codexSelection(thirdPluginId, { enabled: false }),
  };
  const details = [
    codexDetail("linear", ["shared_app"]),
    codexDetail(thirdRemotePluginId, ["shared_app"], {
      summaryId: "third-plugin@openai-curated-remote",
      version: "2.3.4",
    }),
  ];
  for (const entries of [Object.entries(selections), Object.entries(selections).reverse()]) {
    assert.throws(
      () => codexRuntimeArtifact(Object.fromEntries(entries), details),
      /conflicting enablement/,
    );
  }
});

test("Codex startup translation rejects malformed native plugin detail metadata", () => {
  const baseSummary = {
    id: "linear@openai-curated-remote",
    remotePluginId: "linear",
    interface: { displayName: "Linear" },
    version: "5.0.1",
  };
  const baseDetail = {
    plugin: {
      summary: baseSummary,
      apps: [{ id: "linear_app" }],
      appTemplates: [],
      hooks: [],
      skills: [],
      mcpServers: [],
      scheduledTasks: [],
    },
  };

  for (const [detail, pattern] of [
    [{ plugin: { ...baseDetail.plugin, apps: "linear_app" } }, /app/i],
    [{ plugin: { ...baseDetail.plugin, hooks: "hook" } }, /hooks/i],
    [{ plugin: { ...baseDetail.plugin, skills: "skill" } }, /skills/i],
    [{ plugin: { ...baseDetail.plugin, mcpServers: "native" } }, /mcpServers/i],
    [
      {
        plugin: {
          ...baseDetail.plugin,
          releaseVersion: "9.9.9",
          summary: {
            id: "linear@openai-curated-remote",
            remotePluginId: "linear",
            interface: {
              displayName: "Linear",
              manifest: { version: "9.9.9" },
            },
          },
        },
      },
      /release version/i,
    ],
  ]) {
    assert.throws(() => codexRuntimeArtifact(codexSelection(linearPluginId), [detail]), pattern);
  }
});

test("bundled Plugin Drivers enforce Harness identity", async () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();

  await assert.rejects(occ.listCatalog(context("dedicated")), NotImplementedError);
  await assert.rejects(codex.listCatalog(context("embedded")), NotImplementedError);
});
