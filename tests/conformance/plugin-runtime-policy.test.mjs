import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_FILE_NAMES } from "../../packages/contracts/src/index.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

function openClawRuntime(selection = {}) {
  return {
    manifest: {
      kind: "openclaw",
      selections: { "occ-plugin:diffs": { enabled: true, approvalMode: "always", ...selection } },
    },
  };
}

function installedPluginResponses() {
  return [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify({
        plugin: {
          id: "diffs",
          version: "2026.8.2",
          rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
        },
        install: {
          source: "npm",
          resolvedName: "@openclaw/diffs",
          resolvedVersion: "2026.8.2",
          installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
          integrity: OCC_DIFFS_DIGEST,
        },
      }),
      stderr: "",
    },
  ];
}

test("OpenClaw runtime helper installs exact admitted package pins and verifies the install record", async () => {
  const runtime = openClawRuntime();
  const firstInstallConfig = { path: undefined, config: undefined };
  const { calls, files } = runOpenClawRuntimeHelper(runtime, installedPluginResponses(), {
    beforeSpawn(command, args, sandbox) {
      if (command === "node" && args[1] === "plugins" && args[2] === "install") {
        firstInstallConfig.path = sandbox.process.env.OPENCLAW_CONFIG_PATH;
        firstInstallConfig.config = JSON.parse(sandbox.files.get(firstInstallConfig.path));
      }
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls.map((call) => call.args))), [
    [
      "/app/openclaw.mjs",
      "plugins",
      "install",
      "@openclaw/diffs@2026.8.2",
      "--pin",
      "--force",
      "--no-enable",
    ],
    ["/app/openclaw.mjs", "plugins", "registry", "--refresh", "--json"],
    ["/app/openclaw.mjs", "plugins", "inspect", "diffs", "--json"],
  ]);
  assert.equal(firstInstallConfig.path, "/home/node/.openclaw/openclaw.json");
  assert.deepEqual(firstInstallConfig.config.plugins.entries, { diffs: { enabled: true } });
  assert.deepEqual(firstInstallConfig.config.tools.alsoAllow, ["existing-tool", "diffs"]);

  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effective.gateway.port, 8080);
  assert.deepEqual(effective.plugins.installs.keep, { source: "npm" });
  assert.deepEqual(effective.plugins.load.paths, ["existing"]);
  assert.deepEqual(effective.plugins.entries, { diffs: { enabled: true } });
  assert.deepEqual(effective.tools.alsoAllow, ["existing-tool", "diffs"]);
});

for (const [name, tools] of [
  ["profile grants", { alsoAllow: ["existing-tool"] }],
  ["explicit allowlist", { allow: ["read"] }],
  ["operator plugin grant", { allow: ["diffs"] }],
]) {
  test(`OpenClaw runtime helper reports install warnings and preserves ${name}`, () => {
    const runtime = openClawRuntime();
    const result = runOpenClawRuntimeHelper(
      runtime,
      [{ status: 1, stdout: "", stderr: "native install failed" }],
      {
        baseConfig: { tools },
        env: {
          OPENCLAW_PLUGIN_STATUS_PORT: "18791",
          OPENCLAW_AGENT_REVISION_ID: "revision-plugin-compute-1",
          OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), {
      successfulPluginIds: [],
      failures: [{ pluginId: "occ-plugin:diffs", code: "PLUGIN_INSTALL_FAILED" }],
    });
    assert.equal(result.calls.length, 1);
    const effective = JSON.parse(result.files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.plugins.entries, { diffs: { enabled: false } });
    // Remove only startup's generated grant; emptying an operator allowlist would widen access.
    assert.deepEqual(effective.tools, tools);
  });
}

test("OpenClaw runtime helper fails before readiness when raw Codex bridge config conflicts", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": { enabled: true, approvalMode: "auto" },
      },
    },
  };

  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        baseConfig: {
          gateway: { port: 8080 },
          plugins: {
            entries: {
              codex: {
                config: {
                  codexPlugins: {
                    enabled: true,
                    allow_all_plugins: false,
                    plugins: { google_calendar: { enabled: true } },
                  },
                },
              },
            },
          },
        },
      }),
    /Codex bridge configuration conflicts/,
  );
});

test("OpenClaw runtime helper fails before readiness when installed metadata drifts", async () => {
  const runtime = openClawRuntime();
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.3",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /installed version does not match/,
  );
});

test("OpenClaw runtime helper fails before readiness when bundled metadata shadows the install", async () => {
  const runtime = openClawRuntime();
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/app/plugin-skills/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.2",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /runtime root directory does not resolve inside the admitted install path/,
  );
});

for (const [name, tools, expected] of [
  [
    "explicit allowlist",
    { allow: ["read"], deny: ["exec"] },
    { allow: ["read", "diffs"], deny: ["exec"] },
  ],
  [
    "profile grants",
    { profile: "coding", alsoAllow: ["existing-tool"], deny: ["exec"] },
    { profile: "coding", alsoAllow: ["existing-tool", "diffs"], deny: ["exec"] },
  ],
  ["existing grant", { allow: ["read", "diffs"] }, { allow: ["read", "diffs"] }],
  ["empty allowlist", { allow: [] }, { allow: [], alsoAllow: ["diffs"] }],
]) {
  test(`OpenClaw startup composes plugin grants with ${name}`, () => {
    const { files } = runOpenClawRuntimeHelper(openClawRuntime(), installedPluginResponses(), {
      baseConfig: { tools },
    });
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.tools, expected);
  });
}

for (const [field, plugins] of [
  ["plugins.enabled", { enabled: false }],
  ["plugins.deny", { deny: ["diffs"] }],
  ["plugins.allow", { allow: ["memory-core"] }],
  ["plugins.deny", { deny: [" Diffs "] }],
]) {
  test(`OpenClaw startup rejects blocked selection before installation: ${JSON.stringify(plugins)}`, () => {
    const calls = [];
    assert.throws(
      () =>
        runOpenClawRuntimeHelper(openClawRuntime(), installedPluginResponses(), {
          calls,
          baseConfig: { plugins },
        }),
      (error) =>
        error.message.includes("OpenClaw plugin configuration conflicts") &&
        error.message.includes(field),
    );
    assert.equal(calls.length, 0);
  });
}

for (const selection of [{ enabled: false }, { approvalMode: "never" }]) {
  test(`OpenClaw startup preserves restrictions for disabled selection: ${JSON.stringify(selection)}`, () => {
    const plugins = { allow: ["memory-core"], deny: ["diffs"], enabled: false };
    const { files, calls } = runOpenClawRuntimeHelper(
      openClawRuntime(selection),
      installedPluginResponses(),
      {
        baseConfig: { plugins },
      },
    );
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.plugins, { ...plugins, entries: { diffs: { enabled: false } } });
    assert.ok(calls[0].args.includes("--no-enable"));
  });
}

test("OpenClaw startup rejects a blocked Codex bridge before readiness", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": { enabled: true, approvalMode: "auto" },
      },
    },
  };
  const calls = [];
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        calls,
        baseConfig: { plugins: { deny: ["codex"] } },
      }),
    /OpenClaw plugin configuration conflicts.*codex.*plugins.deny/,
  );
  assert.equal(calls.length, 0);
});

test("Gateway launch binds the enrolled node without expanding owner writes or changing its snapshot", async () => {
  const baseConfig = {
    gateway: { nodes: { commands: { allow: ["existing.command"] } } },
    plugins: {
      allow: ["codex"],
      entries: {
        codex: {
          enabled: true,
          config: { appServer: { transport: "websocket", url: "wss://harness.example.test" } },
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
  const initial = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig,
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
  });
  const initialConfig = JSON.parse(
    initial.files.get("/home/node/.openclaw/openclaw.json") ??
      initial.files.get("/etc/openclaw/openclaw.json"),
  );
  assert.deepEqual(initialConfig.gateway.nodes.commands.allow, [
    "existing.command",
    "file.fetch",
    "file.stat",
    "file.write",
    "file.create",
    "dir.list",
    "workspace.memory",
    "workspace.skills",
  ]);
  assert.equal(initialConfig.plugins.entries["file-transfer"], undefined);
  assert.equal(initial.files.get("/etc/openclaw/openclaw.json"), original);
  // This exercises launch-time configuration only. Native file RPC execution
  // remains the real Gateway/node integration test's responsibility.
  const { files, calls } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig,
    workspaceNodeId: "enrolled-node",
  });
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(files.get("/etc/openclaw/openclaw.json"), original);
  assert.deepEqual(effective.plugins.entries.codex, {
    enabled: true,
    config: {
      appServer: {
        ...baseConfig.plugins.entries.codex.config.appServer,
        remoteWorkspaceRoot: "/home/node/workspace",
      },
    },
  });
  assert.deepEqual(effective.plugins.allow, ["codex", "file-transfer"]);
  const transfer = effective.plugins.entries["file-transfer"].config;
  assert.deepEqual(transfer.workspaces.main, {
    nodeId: "enrolled-node",
    remoteRoot: "/home/node/workspace",
  });
  assert.deepEqual(transfer.nodes["enrolled-node"].allowWritePaths, [
    ...WORKSPACE_FILE_NAMES.map((name) => "/home/node/workspace/" + name),
    ...["MEMORY.md", "memory.md", "DREAMS.md", "dreams.md", "memory", "memory/**"].map(
      (name) => "/home/node/workspace/" + name,
    ),
    "/home/node/workspace/skills",
    "/home/node/workspace/media/inbound/openclaw-staged-*/**",
  ]);
  assert.deepEqual(transfer.nodes["enrolled-node"].allowReadPaths, [
    "/home/node/workspace",
    ...[...WORKSPACE_FILE_NAMES, "BOOTSTRAP.md", "MEMORY.md"].map(
      (name) => "/home/node/workspace/" + name,
    ),
    ...["MEMORY.md", "memory.md", "DREAMS.md", "dreams.md", "memory", "memory/**"].map(
      (name) => "/home/node/workspace/" + name,
    ),
    "/home/node/.openclaw",
    ...[
      "/home/node/workspace/skills",
      "/home/node/workspace/.agents/skills",
      "/home/node/.openclaw/skills",
      "/home/node/.openclaw/plugin-skills",
      "/home/node/.agents/skills",
      "/home/node/openclaw-runtime-assets/bundled-skills",
      "/home/node/openclaw-runtime-assets/plugin-skills",
    ].flatMap((root) => [root, root + "/**"]),
    "/home/node/workspace/media/inbound/openclaw-staged-*",
    "/home/node/workspace/media/inbound/openclaw-staged-*/**",
    "/home/node/workspace/media/outbound/**",
  ]);
  assert.equal(transfer.nodes["enrolled-node"].followSymlinks, false);
  // Native bootstrap treats brackets literally. Grant only the configured
  // document, without admitting sibling files, writes, or out-of-workspace paths.
  assert.deepEqual(transfer.literalGrants, [
    {
      nodeId: "enrolled-node",
      command: "file.fetch",
      requestedPath: "/home/node/workspace/team[1]/AGENTS.md",
      canonicalPath: "/home/node/workspace/team[1]/AGENTS.md",
    },
    {
      nodeId: "enrolled-node",
      command: "file.stat",
      requestedPath: "/home/node/workspace/team[1]/AGENTS.md",
      canonicalPath: "/home/node/workspace/team[1]/AGENTS.md",
    },
  ]);
  assert.equal(effective.gateway.nodes.commands.allow.includes("existing.command"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("dir.list"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("file.create"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("workspace.memory"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("workspace.skills"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], "gateway");
  for (const hooks of [
    { internal: { ...baseConfig.hooks.internal, enabled: false } },
    {
      internal: {
        entries: { "bootstrap-extra-files": { paths: ["team[1]/AGENTS.md"], enabled: false } },
      },
    },
  ]) {
    const disabled = await runOpenClawRuntimeHelper(undefined, [], {
      baseConfig: { ...baseConfig, hooks },
      workspaceNodeId: "enrolled-node",
    });
    const config = JSON.parse(disabled.files.get("/home/node/.openclaw/openclaw.json"));
    assert.equal(config.plugins.entries["file-transfer"].config.literalGrants, undefined);
  }
  const explicit = { nodes: { "*": { ask: "off", allowReadPaths: ["/chosen/AGENTS.md"] } } };
  const configured = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: {
      ...baseConfig,
      plugins: { entries: { "file-transfer": { config: explicit } } },
    },
    workspaceNodeId: "enrolled-node",
  });
  const configuredTransfer = JSON.parse(configured.files.get("/home/node/.openclaw/openclaw.json"))
    .plugins.entries["file-transfer"].config;
  assert.deepEqual(configuredTransfer.nodes, explicit.nodes);
  assert.equal(configuredTransfer.literalGrants, undefined);
  for (const plugins of [
    { deny: ["file-transfer"] },
    { entries: { "file-transfer": { enabled: false } } },
  ]) {
    await assert.rejects(
      () =>
        runOpenClawRuntimeHelper(undefined, [], {
          baseConfig: { plugins },
          workspaceNodeId: "enrolled-node",
        }),
      /requires the file-transfer plugin/,
    );
  }
});
