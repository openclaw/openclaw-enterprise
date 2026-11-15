import assert from "node:assert/strict";
import test from "node:test";
import {
  codexOpenClawConfiguration,
  codexRuntimeArtifact,
  validatePolicies,
} from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import type { PluginDesiredState } from "../../packages/contracts/src/index.ts";
import {
  calendarPluginId,
  codexSelection,
  configurationObject,
  linearPluginId,
  thirdPluginId,
  thirdRemotePluginId,
  unvalidatedPluginSelections,
} from "./plugin-driver-fixtures.ts";

interface CodexDetailOptions {
  readonly summaryId?: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly skills?: readonly { readonly name: string }[];
  readonly hooks?: readonly { readonly id: string }[];
  readonly mcpServers?: readonly { readonly id: string }[];
  readonly scheduledTasks?: readonly { readonly id: string }[];
}

function codexDetail(
  remotePluginId: string,
  appIds: readonly string[],
  options: CodexDetailOptions = {},
) {
  return {
    plugin: {
      summary: {
        id: options.summaryId ?? `${remotePluginId}@openai-curated-remote`,
        remotePluginId,
        interface: { displayName: options.displayName ?? remotePluginId },
        version: options.version ?? "1.0.0",
      },
      apps: appIds.map((id) => ({ id })),
      appTemplates: [],
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

function codexBridgeConfig(configuration: ReturnType<typeof codexOpenClawConfiguration>) {
  return configurationObject(configuration, "plugins", "entries", "codex", "config");
}

function codexBridgePlugin(
  configuration: ReturnType<typeof codexOpenClawConfiguration>,
  plugin: string,
) {
  return configurationObject(codexBridgeConfig(configuration), "codexPlugins", "plugins", plugin);
}

test("Codex startup default-denies plugins", () => {
  const empty = codexRuntimeArtifact({}, []);
  assert.equal(empty.kind, "codex");
  assert.deepEqual(empty.configuration.features, {
    apps: false,
    plugins: false,
    remote_plugin: false,
  });
  assert.deepEqual(empty.configuration.apps, { _default: { enabled: false } });
  assert.deepEqual(empty.configuration.plugins, { _default: { enabled: false } });
  assert.deepEqual(empty.installs, []);
});

test("Codex bridge keeps runtime binaries readable after the last plugin is removed", () => {
  // A normal no-plugin revision still starts the packaged native sandbox helper.
  // Plugin skill and credential directories must not survive as incidental grants.
  const config = codexBridgeConfig(codexOpenClawConfiguration({}));
  assert.deepEqual(config, {
    appServer: {
      networkProxy: { readOnlyPaths: ["/app/node_modules/openclaw"] },
    },
  });
});

test("Codex bridge configuration carries repository broker network policy without plugins", () => {
  const bridgeConfiguration = codexOpenClawConfiguration({}, [], {
    repositoryBrokerNetworkPolicy: { host: "git.tenant.svc", domains: { "github.com": "allow" } },
  });

  assert.deepEqual(codexBridgeConfig(bridgeConfiguration), {
    appServer: {
      networkProxy: {
        enabled: true,
        mode: "full",
        allowLocalBinding: true,
        readOnlyPaths: [
          "/app/node_modules/openclaw",
          "/home/node/.openclaw/plugin-skills",
          "/home/node/openclaw-runtime-assets/plugin-skills",
          "/opt/oce/repository-credentials",
          "/run/oce/repository-credentials",
        ],
        domains: { "github.com": "allow", "git.tenant.svc": "allow" },
      },
    },
  });
});

test("Codex bridge configuration grants plugin skill reads without broker policy", () => {
  const bridgeConfiguration = codexOpenClawConfiguration(codexSelection());

  assert.deepEqual(codexBridgeConfig(bridgeConfiguration).appServer, {
    networkProxy: {
      readOnlyPaths: [
        "/app/node_modules/openclaw",
        "/home/node/.openclaw/plugin-skills",
        "/home/node/openclaw-runtime-assets/plugin-skills",
      ],
    },
  });
  assert.deepEqual(codexBridgePlugin(bridgeConfiguration, "linear"), {
    enabled: true,
    marketplaceName: "openai-curated-remote",
    pluginName: "linear",
    allow_destructive_actions: "auto",
  });
});

test("Codex startup translation renders selected marketplace app plugins", () => {
  const selections = {
    ...codexSelection(linearPluginId),
    ...codexSelection(calendarPluginId, {
      toolDefaults: { approval: "provider_default", reviewer: "auto" },
    }),
    ...codexSelection(thirdPluginId),
  };
  const artifact = codexRuntimeArtifact(selections, codexDetails);
  const bridgeConfiguration = codexOpenClawConfiguration(selections);

  assert.equal(artifact.kind, "codex");
  assert.deepEqual(artifact.configuration.plugins, {
    _default: { enabled: false },
    "linear@openai-curated-remote": { enabled: true },
    "google-calendar@openai-curated-remote": { enabled: true },
    "third-plugin@openai-curated-remote": { enabled: true },
  });
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
  assert.deepEqual(
    configurationObject(codexBridgeConfig(bridgeConfiguration), "codexPlugins").plugins,
    {
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
    },
  );
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

test("Codex activates selected skills independently of app tools", () => {
  const skillPluginId = "codex-plugin:writing@openai-curated-remote";
  const skillDetail = codexDetail("writing", [], { skills: [{ name: "draft" }] });
  const selections = {
    ...codexSelection(linearPluginId, { toolDefaults: { enabled: false } }),
    ...codexSelection(skillPluginId),
  };
  const artifact = codexRuntimeArtifact(selections, [
    codexDetail("linear", ["app_notes"], { skills: [{ name: "notes" }] }),
    skillDetail,
  ]);
  assert.deepEqual(artifact.configuration.plugins, {
    _default: { enabled: false },
    "linear@openai-curated-remote": { enabled: true },
    "writing@openai-curated-remote": { enabled: true },
  });
  assert.deepEqual(artifact.configuration.apps, {
    _default: { enabled: false },
    app_notes: {
      enabled: true,
      default_tools_enabled: false,
      default_tools_approval_mode: "auto",
    },
  });

  // Aliases cannot represent separate install outcomes for one native plugin.
  const aliases = codexSelection(skillPluginId);
  for (const enabled of [true, false]) {
    assert.throws(
      () =>
        codexRuntimeArtifact({ ...aliases, "writing@openai-curated-remote": { enabled } }, [
          skillDetail,
        ]),
      /duplicate native plugin IDs/,
    );
  }
});

test("Codex startup translation preserves explicit approval defaults and routed reviewer selection", () => {
  for (const [approval, nativeApproval] of [
    ["provider_default", "auto"],
    ["all_actions", "prompt"],
    ["write_actions", "writes"],
    ["none", "approve"],
  ] as const) {
    for (const [reviewer, nativeReviewer] of [
      ["human", "user"],
      ["auto", "auto_review"],
      [undefined, undefined],
    ] as const) {
      const selections = codexSelection(linearPluginId, {
        toolDefaults: { approval, ...(reviewer === undefined ? {} : { reviewer }) },
      });
      const app = configurationObject(
        codexRuntimeArtifact(selections, codexDetails).configuration,
        "apps",
        "asdk_app_69a089a326dc8191b32a3f2553f5be2c",
      );
      assert.equal(app.default_tools_approval_mode, nativeApproval);
      assert.equal(app.approvals_reviewer, nativeReviewer);
      assert.equal(Object.hasOwn(app, "approvals_reviewer"), reviewer !== undefined);
      assert.equal(Object.hasOwn(app, "default_tools_enabled"), false);
      assert.equal(Object.hasOwn(app, "tools"), false);
      assert.equal(
        codexBridgePlugin(codexOpenClawConfiguration(selections), "linear")
          .allow_destructive_actions,
        "auto",
      );
    }
  }
  const disabled = codexSelection(linearPluginId, { enabled: false });
  assert.deepEqual(codexRuntimeArtifact(disabled, codexDetails).configuration.apps, {
    _default: { enabled: false },
  });
  assert.equal(codexBridgePlugin(codexOpenClawConfiguration(disabled), "linear").enabled, false);
});

test("Codex scoped tools override write action defaults and retain omitted native fields", () => {
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
    toolDefaults: { enabled: false, approval: "write_actions", reviewer: "auto" },
    tools: {
      [appId + "/repos%2Fread"]: { enabled: true },
      [appId + "/repos%2Fwrite"]: { approval: "provider_default" },
    },
  });
  const app = configurationObject(
    codexRuntimeArtifact(selections, codexDetails, [], inventory).configuration,
    "apps",
  )[appId];
  assert.deepEqual(app, {
    enabled: true,
    default_tools_enabled: false,
    default_tools_approval_mode: "writes",
    approvals_reviewer: "auto_review",
    tools: {
      "repos/read": { enabled: true },
      "repos/write": { approval_mode: "auto" },
    },
  });
  assert.equal(
    codexBridgePlugin(codexOpenClawConfiguration(selections), "linear").allow_destructive_actions,
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

test("Codex catalog tool policies resolve through owned action metadata to native names", () => {
  const appId = "catalog-app";
  const nativeName = "renamed_123.search";
  const details = [codexDetail("linear", [appId])];
  const tool = {
    name: nativeName,
    _meta: {
      connector_id: appId,
      _codex_apps: { resource_uri: "/catalog-app/link_fixture/search" },
    },
  };
  const inventory = [{ name: "codex_apps", tools: { [nativeName]: tool } }];
  const selections = codexSelection(linearPluginId, {
    tools: { "catalog-app/search": { enabled: true, approval: "all_actions" } },
  });
  assert.deepEqual(
    configurationObject(
      codexRuntimeArtifact(selections, details, [], inventory).configuration,
      "apps",
      appId,
    ).tools,
    { [nativeName]: { enabled: true, approval_mode: "prompt" } },
  );
  const writeActionSelection = codexSelection(linearPluginId, {
    tools: { "catalog-app/search": { approval: "write_actions" } },
  });
  assert.deepEqual(
    configurationObject(
      codexRuntimeArtifact(writeActionSelection, details, [], inventory).configuration,
      "apps",
      appId,
    ).tools,
    { [nativeName]: { approval_mode: "writes" } },
  );

  // Display prefixes are not identities; missing, malformed or foreign metadata cannot bind them.
  for (const resourceUri of [
    undefined,
    "/other-app/link_fixture/search",
    "/catalog-app//search",
    "/catalog-app/link_fixture/search/extra",
    "catalog-app/link_fixture/search",
  ]) {
    const invalidTool = {
      ...tool,
      _meta: { ...tool._meta, _codex_apps: { resource_uri: resourceUri } },
    };
    const invalid = [{ name: "codex_apps", tools: { [nativeName]: invalidTool } }];
    assert.throws(
      () => codexRuntimeArtifact(selections, details, [], invalid),
      /unknown or unowned tool/,
    );
  }

  const ambiguous = [
    {
      name: "codex_apps",
      tools: { [nativeName]: tool, "another.search": { ...tool, name: "another.search" } },
    },
  ];
  assert.throws(() => codexRuntimeArtifact(selections, details, [], ambiguous), /ambiguous/);
  assert.throws(
    () =>
      codexRuntimeArtifact(
        codexSelection(linearPluginId, {
          tools: {
            "catalog-app/search": { enabled: true },
            [appId + "/" + nativeName]: { enabled: false },
          },
        }),
        details,
        [],
        inventory,
      ),
    /same native tool/,
  );
});

test("Codex shared apps accept identical policies using mixed catalog and native IDs", () => {
  const details = [codexDetail("linear", ["app"]), codexDetail("google-calendar", ["app"])];
  const inventory = [
    {
      name: "codex_apps",
      tools: Object.fromEntries(
        ["alpha", "beta"].map((action) => [
          "prefix." + action,
          {
            name: "prefix." + action,
            _meta: {
              connector_id: "app",
              _codex_apps: { resource_uri: "/app/link_fixture/" + action },
            },
          },
        ]),
      ),
    },
  ];
  // Alias sorting differs, but both plugins request the same native policy.
  const selections = {
    ...codexSelection(linearPluginId, {
      tools: { "app/prefix.alpha": { enabled: true }, "app/beta": { enabled: false } },
    }),
    ...codexSelection(calendarPluginId, {
      tools: { "app/alpha": { enabled: true }, "app/beta": { enabled: false } },
    }),
  };
  assert.deepEqual(
    configurationObject(
      codexRuntimeArtifact(selections, details, [], inventory).configuration,
      "apps",
      "app",
    ).tools,
    {
      "prefix.alpha": { enabled: true },
      "prefix.beta": { enabled: false },
    },
  );
});

test("Codex destructive defaults project to native config and the hosted-app bridge", () => {
  const selections = codexSelection(linearPluginId, {
    toolDefaults: { approval: "provider_default", reviewer: "human" },
    driverPolicy: { destructiveEnabled: false },
  });
  const app = configurationObject(
    codexRuntimeArtifact(selections, codexDetails).configuration,
    "apps",
    "asdk_app_69a089a326dc8191b32a3f2553f5be2c",
  );
  assert.equal(app.destructive_enabled, false);
  assert.equal(Object.hasOwn(app, "default_tools_enabled"), false);
  assert.equal(
    codexBridgePlugin(codexOpenClawConfiguration(selections), "linear").allow_destructive_actions,
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
  for (const [driverPolicy, message] of [
    [{ unknown: true }, "Codex driver policy contains unsupported policy fields."],
    [{ destructiveEnabled: "false" }, "Codex destructiveEnabled must be a boolean."],
    [{ approvalsReviewer: "user" }, "Codex driver policy contains unsupported policy fields."],
  ] as const) {
    assert.throws(
      () => validatePolicies("codex", codexSelection(linearPluginId, { driverPolicy })),
      { message },
    );
  }
  // Codex accepts toolDefaults.reviewer, so only the value check can refuse this one.
  assert.throws(
    () =>
      validatePolicies(
        "codex",
        unvalidatedPluginSelections({
          [linearPluginId]: {
            ...codexSelection(linearPluginId)[linearPluginId],
            toolDefaults: { reviewer: "robot" },
          },
        }),
      ),
    { message: "Tool reviewer must be human or auto." },
  );
  // Codex selections must name a plugin from the curated remote marketplace.
  assert.throws(
    () => validatePolicies("codex", codexSelection("codex-plugin:linear@openai-internal-testing")),
    { message: "Codex plugin ID must identify the curated remote marketplace." },
  );
});

test("Codex startup translation admits a selected plugin with native skills", () => {
  const detail = codexDetail("linear", ["linear_app"], {
    skills: [{ name: "linear-workflow" }],
  });
  const artifact = codexRuntimeArtifact(codexSelection(linearPluginId), [detail]);
  assert.deepEqual(
    artifact.installs.map((install) => install.pluginId),
    [linearPluginId],
  );
  assert.equal(configurationObject(artifact.configuration, "apps", "linear_app").enabled, true);
});

test("Codex startup translation fails selected-only policy gaps at startup", () => {
  const cases: (readonly [PluginDesiredState, readonly unknown[], RegExp])[] = [
    [
      unvalidatedPluginSelections({
        [linearPluginId]: {
          ...codexSelection(linearPluginId)[linearPluginId],
          approvalMode: "never",
        },
      }),
      codexDetails,
      /unsupported/i,
    ],
    [
      unvalidatedPluginSelections({
        [linearPluginId]: { ...codexSelection(linearPluginId)[linearPluginId], writes: "prompt" },
      }),
      codexDetails,
      /unsupported/i,
    ],
    [codexSelection(linearPluginId, { tools: { search: {} } }), codexDetails, /tool/i],
    [codexSelection(linearPluginId), [], /detail/i],
    [codexSelection(linearPluginId), [codexDetail("linear", [])], /app mapping/i],
    [
      codexSelection(linearPluginId),
      [codexDetail("linear", ["app"], { version: "" })],
      /release version/i,
    ],
    ...(["hooks", "mcpServers", "scheduledTasks"] as const).map(
      (field) =>
        [
          codexSelection(linearPluginId),
          [codexDetail("linear", [], { skills: [{ name: "draft" }], [field]: [{ id: "native" }] })],
          new RegExp(field, "i"),
        ] as const,
    ),
    [
      {
        ...codexSelection(linearPluginId, {
          toolDefaults: { approval: "provider_default", reviewer: "human" },
        }),
        ...codexSelection(thirdPluginId, {
          toolDefaults: { approval: "provider_default", reviewer: "auto" },
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
  ];
  for (const [selection, details, pattern] of cases) {
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
  ] as const) {
    assert.throws(() => codexRuntimeArtifact(codexSelection(linearPluginId), [detail]), pattern);
  }
});
