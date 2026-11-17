import assert from "node:assert/strict";

import test from "node:test";

import { WORKSPACE_FILE_NAMES } from "../../packages/contracts/src/index.ts";
import {
  GATEWAY_LOCAL_CODEX_TOOLS,
  codexGatewayConfig,
  launchGateway,
  parseJson,
  readConfig,
  field,
  record,
  stringList,
  commandArgs,
} from "./plugin-runtime-policy-fixture.ts";

export function registerWorkspaceLaunchCases() {
  test("a workspace-node Gateway keeps owner Codex tool excludes, pins the codex provider, and refuses malformed settings", async () => {
    const withExcludes = (codexDynamicToolsExclude: string | string[]) => {
      const { config, codex } = codexGatewayConfig();
      codex.config.codexDynamicToolsExclude = codexDynamicToolsExclude;
      return config;
    };
    const ownerConfig = withExcludes(["web_search", "ls"]);
    ownerConfig.cron = { enabled: true, triggers: { enabled: true } };
    ownerConfig.agents = {
      defaults: {
        model: "codex/gpt-test",
        compaction: { memoryFlush: { enabled: true, softThresholdTokens: 1000 } },
      },
    };
    const ownerModels = {
      mode: "merge",
      providers: {
        Codex: {
          baseUrl: "https://model.example.test/v1",
          api: "anthropic-messages",
          apiKey: "owner-key",
          maxTokens: 4096,
          timeoutSeconds: 30,
          headers: { "x-route": "a" },
          params: { store: false },
          authHeader: false,
          request: { proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:3128" } },
          localService: { command: "/bin/sh", args: ["-c", "id"] },
          models: [
            {
              id: "gpt-test",
              name: "gpt-test",
              contextWindow: 200000,
              api: "openai-completions",
              baseUrl: "https://other.example.test/v1",
              headers: { "x-model": "b" },
              params: { temperature: 0 },
              reasoning: true,
              thinkingLevelMap: { off: "low", minimal: "low" },
              compat: {
                supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                supportsTools: false,
                thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
                headers: { "x-route": "forbidden" },
                baseUrl: "https://forbidden.example.test/v1",
              },
            },
            // An unannotated sibling must not inherit the preceding model's efforts.
            { id: "plain" },
          ],
        },
        // Codex's other provider: an authored transport here would also make Codex
        // hand a normal openai/<model> turn to the built-in runtime.
        OpenAI: {
          baseUrl: "https://proxy.example.test/v1",
          headers: { "x-route": "c" },
          request: { proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:3128" } },
          models: [{ id: "gpt-5", headers: { "x-model": "d" }, contextWindow: 400000 }],
        },
        anthropic: { baseUrl: "https://api.anthropic.com", models: [] },
      },
    };
    ownerConfig.models = ownerModels;
    const logged: string[] = [];
    const { files } = await launchGateway(undefined, [], {
      baseConfig: ownerConfig,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
      workspaceNodeId: "enrolled-node",
      console: { error: (line) => logged.push(line) },
    });
    const effective = readConfig(files);
    // The Gateway says which owner settings it replaced, by name only (D202).
    const overrides = logged
      .filter((line) => line.includes("runtime.gateway_settings_overridden"))
      .map((line) => parseJson(line));
    assert.deepEqual(overrides, [
      {
        event: "runtime.gateway_settings_overridden",
        container: "gateway",
        settings: [
          "cron.triggers.enabled",
          "agents.defaults.compaction.memoryFlush.enabled",
          "models.providers.codex.baseUrl",
          "models.providers.codex.api",
          "models.providers.codex.apiKey",
          "models.providers.codex.timeoutSeconds",
          "models.providers.codex.headers",
          "models.providers.codex.params",
          "models.providers.codex.authHeader",
          "models.providers.codex.request",
          "models.providers.codex.localService",
          "models.providers.codex.models[].api",
          "models.providers.codex.models[].baseUrl",
          "models.providers.codex.models[].headers",
          "models.providers.codex.models[].params",
          "models.providers.codex.models[].compat",
          "models.providers.openai.baseUrl",
          "models.providers.openai.headers",
          "models.providers.openai.request",
          "models.providers.openai.models[].headers",
        ],
      },
    ]);
    assert.ok(
      logged.every((line) => !line.includes("owner-key") && !line.includes("example.test")),
      "override events never carry setting values",
    );
    // Owner exclusions stay first and are not duplicated.
    assert.deepEqual(
      field(effective, "plugins", "entries", "codex", "config", "codexDynamicToolsExclude"),
      ["web_search", ...GATEWAY_LOCAL_CODEX_TOOLS],
    );
    // Timed automations stay; an owner cannot turn triggers back on in the Gateway Pod.
    assert.deepEqual(effective.cron, { enabled: true, triggers: { enabled: false } });
    // An owner cannot turn the memory flush back on; its other settings stay.
    assert.deepEqual(effective.agents, {
      defaults: {
        model: "codex/gpt-test",
        compaction: { memoryFlush: { enabled: false, softThresholdTokens: 1000 } },
        modelSelectionScope: "session",
      },
    });
    // The codex row keeps its models but not a transport a built-in run could reach,
    // nor the overrides that make Codex hand a turn to the built-in runtime.
    assert.deepEqual(effective.models, {
      mode: "merge",
      providers: {
        Codex: {
          maxTokens: 4096,
          models: [
            {
              id: "gpt-test",
              name: "gpt-test",
              contextWindow: 200000,
              reasoning: true,
              thinkingLevelMap: { off: "low", minimal: "low" },
              compat: {
                supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
              },
            },
            { id: "plain" },
          ],
          baseUrl: "http://127.0.0.1:9",
          api: "openai-responses",
        },
        OpenAI: {
          models: [{ id: "gpt-5", contextWindow: 400000 }],
          baseUrl: "http://127.0.0.1:9",
          api: "openai-responses",
        },
        anthropic: ownerModels.providers.anthropic,
      },
    });
    // An invalid/empty native effort list must not introduce a compat override,
    // and another row must not acquire the first row's capability metadata.
    for (const efforts of [[], ["off"], ["high", "unknown"], [1], "high"]) {
      const { config } = codexGatewayConfig();
      config.models = {
        providers: {
          codex: {
            models: [
              { id: "invalid", compat: { supportedReasoningEfforts: efforts } },
              { id: "plain" },
            ],
          },
        },
      };
      const result = await launchGateway(undefined, [], {
        baseConfig: config,
        env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
        workspaceNodeId: "enrolled-node",
        console: { error() {} },
      });
      const saved = readConfig(result.files);
      assert.deepEqual(field(saved, "models", "providers", "codex", "models"), [
        { id: "invalid" },
        { id: "plain" },
      ]);
      assert.equal(field(saved, "models", "providers", "codex", "baseUrl"), "http://127.0.0.1:9");
    }
    // An openai row that names no transport keeps OpenClaw's default (no credential
    // in the Gateway) so Codex keeps owning its account's models; overrides still go.
    // APP_SERVER_URL marks a Codex Gateway, so the pin holds without the plugin entry.
    const { config: noEntry } = codexGatewayConfig();
    delete noEntry.plugins.entries.codex;
    noEntry.models = {
      providers: {
        openai: {
          headers: { "x-route": "e" },
          models: [{ id: "gpt-5", params: { store: false } }],
        },
      },
    };
    const noEntryRun = await launchGateway(undefined, [], {
      baseConfig: noEntry,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
      workspaceNodeId: "enrolled-node",
    });
    const noEntryConfig = readConfig(noEntryRun.files);
    assert.deepEqual(noEntryConfig.models, {
      providers: {
        openai: { models: [{ id: "gpt-5" }] },
        codex: { baseUrl: "http://127.0.0.1:9", api: "openai-responses" },
      },
    });
    // A dedicated OpenClaw Gateway runs its turns with these rows, so it keeps them.
    const { config: native } = codexGatewayConfig();
    delete native.plugins.entries.codex;
    native.models = {
      providers: { openai: { baseUrl: "https://model.example.test/v1", models: [] } },
    };
    const nativeRun = await launchGateway(undefined, [], {
      baseConfig: native,
      env: { OPENCLAW_NATIVE_WORKER_PROFILE: "native" },
      workspaceNodeId: "enrolled-node",
    });
    const nativeConfig = record(
      parseJson(
        nativeRun.files.get("/home/node/.openclaw/openclaw.json") ??
          nativeRun.files.get("/etc/openclaw/openclaw.json"),
      ),
    );
    assert.deepEqual(nativeConfig.models, native.models);
    // A malformed setting fails the Gateway start instead of being replaced silently.
    await assert.rejects(
      () =>
        launchGateway(undefined, [], {
          baseConfig: withExcludes("ls"),
          env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
          workspaceNodeId: "enrolled-node",
        }),
      /codexDynamicToolsExclude setting must be a list/,
    );
    for (const [settings, message] of [
      [{ cron: "off" }, /cron setting must be an object/],
      [{ cron: { triggers: true } }, /cron\.triggers setting must be an object/],
      [
        { agents: { defaults: { compaction: { memoryFlush: true } } } },
        /agents\.defaults\.compaction\.memoryFlush setting must be an object/,
      ],
    ] as const) {
      const malformed = { ...codexGatewayConfig().config, ...settings };
      await assert.rejects(
        () =>
          launchGateway(undefined, [], {
            baseConfig: malformed,
            env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
            workspaceNodeId: "enrolled-node",
          }),
        message,
      );
    }
    for (const [models, message] of [
      ["none", /models setting must be an object/],
      [{ providers: [] }, /models\.providers setting must be an object/],
      [{ providers: { codex: "stub" } }, /codex model provider setting must be an object/],
      [{ providers: { openai: "stub" } }, /openai model provider setting must be an object/],
      [
        { providers: { OpenAI: { models: "gpt-5" } } },
        /openai model provider models setting must be a list/,
      ],
      [
        { providers: { codex: { models: {} } } },
        /codex model provider models setting must be a list/,
      ],
      [
        { providers: { codex: { models: ["gpt-test"] } } },
        /codex model provider models setting must be a list/,
      ],
    ] as const) {
      const { config: malformed } = codexGatewayConfig();
      malformed.models = models;
      await assert.rejects(
        () =>
          launchGateway(undefined, [], {
            baseConfig: malformed,
            env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
            workspaceNodeId: "enrolled-node",
          }),
        message,
      );
    }
    // A remote Codex Harness still needs the model policy and Gateway-local
    // exclusions while the workspace node is unavailable.
    const { config: localBase } = codexGatewayConfig();
    localBase.models = {
      providers: { codex: { baseUrl: "https://model.example.test/v1", models: [] } },
    };
    const local = await launchGateway(undefined, [], {
      baseConfig: localBase,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    });
    const localConfig = record(
      parseJson(
        local.files.get("/home/node/.openclaw/openclaw.json") ??
          local.files.get("/etc/openclaw/openclaw.json"),
      ),
    );
    assert.deepEqual(
      field(localConfig, "plugins", "entries", "codex", "config", "codexDynamicToolsExclude"),
      GATEWAY_LOCAL_CODEX_TOOLS,
    );
    assert.deepEqual(localConfig.cron, { triggers: { enabled: false } });
    assert.deepEqual(localConfig.agents, { defaults: { modelSelectionScope: "session" } });
    assert.deepEqual(localConfig.models, localBase.models);
    assert.equal(
      field(
        localConfig,
        "plugins",
        "entries",
        "codex",
        "config",
        "appServer",
        "remoteWorkspaceRoot",
      ),
      undefined,
    );
  });

  test("Gateway launch binds the enrolled node without expanding owner writes or changing its snapshot", async () => {
    const baseConfig = {
      gateway: { nodes: { commands: { allow: ["existing.command"] } } },
      plugins: {
        allow: ["codex"],
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                transport: "websocket",
                url: "wss://harness.example.test",
                remoteWorkspaceRoot: "/owner/harness-workspace",
              },
            },
          },
        },
      },
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": {
              paths: [" team[1]/AGENTS.md ", "../AGENTS.md", "team/secrets.txt"],
              patterns: ["ignored/SOUL.md"],
            },
          },
        },
      },
    };
    const original = JSON.stringify(baseConfig);
    const initial = await launchGateway(undefined, [], {
      baseConfig,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    });
    const initialConfig = record(
      parseJson(
        initial.files.get("/home/node/.openclaw/openclaw.json") ??
          initial.files.get("/etc/openclaw/openclaw.json"),
      ),
    );
    assert.deepEqual(field(initialConfig, "gateway", "nodes", "commands", "allow"), [
      "existing.command",
      "file.fetch",
      "file.stat",
      "file.write",
      "file.create",
      "dir.list",
      "workspace.memory",
      "workspace.skills",
    ]);
    assert.equal(field(initialConfig, "plugins", "entries", "file-transfer"), undefined);
    assert.equal(initial.files.get("/etc/openclaw/openclaw.json"), original);
    // This exercises launch-time configuration only. Native file RPC execution
    // remains the real Gateway/node integration test's responsibility.
    const { files, calls } = await launchGateway(undefined, [], {
      baseConfig,
      workspaceNodeId: "enrolled-node",
    });
    const effective = readConfig(files);
    assert.equal(files.get("/etc/openclaw/openclaw.json"), original);
    // The Gateway's own workspace is empty: OpenClaw tools that would run in it
    // are withheld from Codex, which lists and runs files in the Harness.
    assert.deepEqual(field(effective, "plugins", "entries", "codex"), {
      enabled: true,
      config: {
        appServer: baseConfig.plugins.entries.codex.config.appServer,
        codexDynamicToolsExclude: GATEWAY_LOCAL_CODEX_TOOLS,
      },
    });
    assert.deepEqual(field(effective, "plugins", "allow"), ["codex", "file-transfer"]);
    const transfer = record(field(effective, "plugins", "entries", "file-transfer", "config"));
    assert.deepEqual(field(transfer, "workspaces", "main"), {
      nodeId: "enrolled-node",
      remoteRoot: "/home/node/workspace",
    });
    assert.deepEqual(field(transfer, "nodes", "enrolled-node", "allowWritePaths"), [
      ...WORKSPACE_FILE_NAMES.map((name) => "/home/node/workspace/" + name),
      ...["MEMORY.md", "memory.md", "DREAMS.md", "dreams.md", "memory", "memory/**"].map(
        (name) => "/home/node/workspace/" + name,
      ),
      "/home/node/workspace/skills",
      "/home/node/workspace/skills/**",
      "/home/node/workspace/.clawhub/lock.json",
      "/home/node/workspace/.clawdhub/lock.json",
      "/home/node/workspace/.openclaw/skill-installs/**",
      "/home/node/workspace/media/inbound/openclaw-staged-*/**",
    ]);
    assert.deepEqual(field(transfer, "nodes", "enrolled-node", "allowReadPaths"), [
      "/home/node/workspace",
      "/home/node/workspace/**",
      "/home/node/.openclaw",
      ...[
        "/home/node/.openclaw/skills",
        "/home/node/.openclaw/plugin-skills",
        "/home/node/.openclaw/agents/*/agent/workshop-skills",
        "/home/node/.openclaw/worktree-sources/empty/*/workspace",
        "/home/node/.agents/skills",
        "/home/node/openclaw-runtime-assets/bundled-skills",
        "/home/node/openclaw-runtime-assets/custodian-skills",
        "/home/node/openclaw-runtime-assets/plugin-skills",
        "/app/extensions/*/skills",
      ].flatMap((root) => [root, root + "/**"]),
    ]);
    assert.equal(field(transfer, "nodes", "enrolled-node", "followSymlinks"), false);
    assert.equal(transfer.literalGrants, undefined);
    const allowedCommands = stringList(field(effective, "gateway", "nodes", "commands", "allow"));
    assert.equal(allowedCommands.includes("existing.command"), true);
    assert.equal(allowedCommands.includes("dir.list"), true);
    assert.equal(allowedCommands.includes("file.create"), true);
    assert.equal(allowedCommands.includes("workspace.memory"), true);
    assert.equal(allowedCommands.includes("workspace.skills"), true);
    assert.equal(calls.length, 1);
    assert.equal(commandArgs(calls[0])[1], "gateway");
    const explicit = {
      nodes: {
        "*": {
          ask: "off",
          allowReadPaths: ["/chosen/AGENTS.md"],
          allowWritePaths: ["/chosen/SOUL.md"],
        },
      },
    };
    const configured = await launchGateway(undefined, [], {
      baseConfig: {
        ...baseConfig,
        plugins: { entries: { "file-transfer": { config: explicit } } },
      },
      workspaceNodeId: "enrolled-node",
    });
    const configuredTransfer = record(
      field(readConfig(configured.files), "plugins", "entries", "file-transfer", "config"),
    );
    assert.deepEqual(configuredTransfer.nodes, explicit.nodes);
    assert.equal(configuredTransfer.literalGrants, undefined);
    for (const plugins of [
      { deny: ["file-transfer"] },
      { entries: { "file-transfer": { enabled: false } } },
      { enabled: false },
    ]) {
      await assert.rejects(
        () =>
          launchGateway(undefined, [], {
            baseConfig: { plugins },
            workspaceNodeId: "enrolled-node",
          }),
        /requires the file-transfer plugin/,
      );
    }
  });
}
