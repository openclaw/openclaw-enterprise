import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { WORKSPACE_FILE_NAMES } from "../../packages/contracts/src/index.ts";
import { requireWorkspaceNodePlugins } from "../../apps/controller/src/drivers/compute/kubernetes/configuration-rules.ts";
import {
  WORKSPACE_NODE_BINDING_PATH,
  runOpenClawRuntimeHelper,
  workspaceNodeBinding,
} from "../helpers/plugin-runtime.mjs";
import {
  GATEWAY_DID_NOT_START,
  gatewayConfigurationHoldLine,
  invalidGatewayConfiguration,
  invalidGatewayConfigurationLine,
  invalidGatewayConfigurationSecret,
  openClawConfigValidationRefusal,
} from "../helpers/openclaw-config-validation.mjs";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

function openClawRuntime(selection = {}) {
  return {
    manifest: {
      kind: "openclaw",
      selections: {
        "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" }, ...selection },
      },
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

test("OpenClaw runtime helper opens Diffs viewer links only through the native admin origin", () => {
  const origin = "https://agent-0123456789abcdef.agents.example.test";
  const nativeAdminGateway = {
    port: 8080,
    publicOrigin: origin,
    auth: { mode: "trusted-proxy" },
    controlUi: { enabled: true, allowedOrigins: [origin] },
  };
  const effectiveEntries = (gateway, selection) => {
    const { files } = runOpenClawRuntimeHelper(
      openClawRuntime(selection),
      installedPluginResponses(),
      { baseConfig: { gateway } },
    );
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.equal(effective.gateway.publicOrigin, gateway.publicOrigin);
    return effective.plugins.entries;
  };

  assert.deepEqual(effectiveEntries(nativeAdminGateway), {
    diffs: { enabled: true, config: { security: { allowRemoteViewer: true } } },
  });
  assert.deepEqual(effectiveEntries(nativeAdminGateway, { enabled: false }), {
    diffs: { enabled: false },
  });
  for (const gateway of [
    { port: 8080 },
    { ...nativeAdminGateway, publicOrigin: undefined },
    { ...nativeAdminGateway, publicOrigin: "https://other.agents.example.test" },
    { ...nativeAdminGateway, controlUi: { enabled: true, allowedOrigins: [] } },
    { ...nativeAdminGateway, auth: { mode: "password" } },
    {
      ...nativeAdminGateway,
      publicOrigin: "http://127.0.0.1:8080",
      controlUi: { enabled: true, allowedOrigins: ["http://127.0.0.1:8080"] },
    },
  ]) {
    assert.deepEqual(effectiveEntries(gateway), { diffs: { enabled: true } });
  }
});

test("OpenClaw runtime helper disables a failed Diffs install behind the native admin origin", () => {
  const origin = "https://agent-0123456789abcdef.agents.example.test";
  const result = runOpenClawRuntimeHelper(
    openClawRuntime(),
    [{ status: 1, stdout: "", stderr: "native install failed" }],
    {
      baseConfig: {
        gateway: {
          publicOrigin: origin,
          auth: { mode: "trusted-proxy" },
          controlUi: { enabled: true, allowedOrigins: [origin] },
        },
      },
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
  const effective = JSON.parse(result.files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effective.plugins.entries.diffs.enabled, false);
  assert.equal(effective.tools?.alsoAllow?.includes("diffs") ?? false, false);
});

test("OpenClaw runtime helper rejects foreign Diffs config beside the native admin origin", () => {
  const origin = "https://agent-0123456789abcdef.agents.example.test";
  const result = runOpenClawRuntimeHelper(openClawRuntime(), [], {
    captureError: true,
    baseConfig: {
      gateway: {
        publicOrigin: origin,
        auth: { mode: "trusted-proxy" },
        controlUi: { enabled: true, allowedOrigins: [origin] },
      },
      plugins: {
        entries: {
          diffs: { enabled: true, config: { security: { allowRemoteViewer: false } } },
        },
      },
    },
  });
  assert.match(result.error?.message ?? "", /conflicts with managed plugin selections/);
  assert.deepEqual(result.calls, []);
});

for (const [label, channels] of [
  ["no channels", undefined],
  ["unrelated channel", { msteams: { enabled: true } }],
  ["disabled Slack", { slack: { enabled: false, accounts: { team: { enabled: true } } } }],
]) {
  test(`Gateway omits managed Slack approvers for ${label} while preserving admitted denies`, () => {
    for (const kind of ["openclaw", "codex"]) {
      const runtime =
        kind === "openclaw"
          ? openClawRuntime({ approvers: [], tools: { diffs: { approvers: [] } } })
          : {
              manifest: {
                kind,
                selections: {
                  "codex-plugin:linear@openai-curated-remote": {
                    enabled: true,
                    approvers: [],
                    tools: {
                      "asdk_app_69a089a326dc8191b32a3f2553f5be2c/repos%2Fwrite": { approvers: [] },
                    },
                  },
                },
              },
            };
      runtime.manifest.pluginApprovers = [];
      const admitted = structuredClone(runtime);
      const nativeApprovals = { exec: { enabled: true, mode: "session" } };
      const { files, calls } = runOpenClawRuntimeHelper(runtime, installedPluginResponses(), {
        baseConfig: { ...(channels ? { channels } : {}), approvals: nativeApprovals },
      });
      const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
      assert.deepEqual(effective.approvals, nativeApprovals);
      assert.deepEqual(runtime, admitted);
      assert.equal(
        calls.some((call) => call.args[1] === "config"),
        false,
      );
    }
  });
}

test("Gateway validates only the generated Slack policy before writing the effective configuration", () => {
  const runtime = { manifest: { kind: "codex", selections: {}, pluginApprovers: [] } };
  const baseConfig = {
    channels: { slack: { enabled: true, accounts: { disabled: { enabled: false } } } },
    approvals: { exec: { enabled: true, mode: "session" } },
  };
  let candidate;
  const { calls, files } = runOpenClawRuntimeHelper(runtime, [], {
    baseConfig,
    beforeSpawn(command, args, sandbox, options) {
      if (args[1] !== "config") {
        return;
      }
      assert.equal(sandbox.files.has("/home/node/.openclaw/openclaw.json"), false);
      candidate = JSON.parse(sandbox.files.get(options.env.OPENCLAW_CONFIG_PATH));
      assert.notEqual(options.env.OPENCLAW_CONFIG_PATH, sandbox.process.env.OPENCLAW_CONFIG_PATH);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 1024 * 1024);
    },
  });
  assert.deepEqual(candidate, { approvals: { plugin: { slack: { approvers: [] } } } });
  // Reapplying the identical policy after install reuses its successful probe.
  assert.deepEqual(
    calls.map((call) => Array.from(call.args)),
    [["/app/openclaw.mjs", "config", "validate", "--json"]],
  );
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(effective.approvals, {
    ...baseConfig.approvals,
    plugin: { slack: { approvers: [] } },
  });
  assert.equal(files.get("/etc/openclaw/openclaw.json"), JSON.stringify(baseConfig));
  assert.equal(
    [...files.keys()].some((path) => path.includes("oce-plugin-approvers-")),
    false,
  );
});

for (const [label, response] of [
  [
    "unsupported field",
    { status: 1, stdout: JSON.stringify({ valid: false }), stderr: "unknown key" },
  ],
  ["rejected configuration", { status: 0, stdout: JSON.stringify({ valid: false }), stderr: "" }],
  ["unavailable validator", { status: null, error: new Error("spawn failed") }],
  ["non-JSON output", { status: 0, stdout: "invalid response", stderr: "" }],
]) {
  test(`Gateway rejects ${label} before replacing its effective configuration`, () => {
    const runtime = { manifest: { kind: "codex", selections: {}, pluginApprovers: [] } };
    const baseConfig = { channels: { slack: { enabled: true } } };
    const effectivePath = "/home/node/.openclaw/openclaw.json";
    const previousConfiguration = JSON.stringify({ gateway: { port: 9999 } });
    const result = runOpenClawRuntimeHelper(runtime, [], {
      baseConfig,
      files: [[effectivePath, previousConfiguration]],
      configValidationResponse: response,
      captureError: true,
    });
    assert.match(
      result.error?.message ?? "",
      /gateway image cannot validate approvals\.plugin\.slack/,
    );
    assert.equal(result.files.get(effectivePath), previousConfiguration);
    assert.equal(result.files.get("/etc/openclaw/openclaw.json"), JSON.stringify(baseConfig));
    assert.equal(result.calls.length, 1);
    assert.equal(
      [...result.files.keys()].some((path) => path.includes("oce-plugin-approvers-")),
      false,
    );
  });
}

test("Gateway maps approver probe tmpdir failures to the approver configuration error", () => {
  const runtime = { manifest: { kind: "codex", selections: {}, pluginApprovers: [] } };
  const baseConfig = { channels: { slack: { enabled: true } } };
  const effectivePath = "/home/node/.openclaw/openclaw.json";
  const previousConfiguration = JSON.stringify({ gateway: { port: 9999 } });
  const result = runOpenClawRuntimeHelper(runtime, [], {
    baseConfig,
    files: [[effectivePath, previousConfiguration]],
    mkdtempError: Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
    captureError: true,
  });
  assert.match(
    result.error?.message ?? "",
    /gateway image cannot validate approvals\.plugin\.slack/,
  );
  assert.equal(result.files.get(effectivePath), previousConfiguration);
  assert.equal(result.calls.length, 0);
});

test("OpenClaw runtime merges matching inherited native approvers", () => {
  const agentApprover = "team:T123:user:U123";
  const otherAgentApprover = "team:T123:user:U789";
  const pluginApprover = "team:T123:user:U456";
  const runtime = openClawRuntime({
    approvers: [{ channel: "slack", id: pluginApprover }],
    tools: { diffs: { approvers: [] } },
  });
  runtime.manifest.pluginApprovers = [agentApprover, otherAgentApprover].map((id) => ({
    channel: "slack",
    id,
  }));
  const configured = {
    approvers: [otherAgentApprover.toUpperCase(), agentApprover],
    plugins: {
      diffs: {
        tools: { other: { approvers: [pluginApprover] }, diffs: { approvers: [] } },
        approvers: [pluginApprover],
      },
    },
  };
  const { files } = runOpenClawRuntimeHelper(runtime, installedPluginResponses(), {
    baseConfig: {
      channels: { slack: { enabled: true } },
      approvals: { plugin: { slack: configured } },
    },
  });
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(effective.approvals.plugin.slack, {
    ...configured,
    approvers: [agentApprover, otherAgentApprover],
  });

  const conflicting = runOpenClawRuntimeHelper(runtime, [], {
    baseConfig: {
      channels: { slack: { enabled: true } },
      approvals: {
        plugin: {
          slack: {
            ...configured,
            plugins: { diffs: { ...configured.plugins.diffs, approvers: [] } },
          },
        },
      },
    },
    captureError: true,
  });
  assert.match(conflicting.error?.message ?? "", /conflicts with managed Agent approvers/);
  assert.deepEqual(
    conflicting.calls.map((call) => Array.from(call.args).slice(1)),
    [["config", "validate", "--json"]],
  );

  const conflictingTool = runOpenClawRuntimeHelper(runtime, [], {
    baseConfig: {
      channels: { slack: { enabled: true } },
      approvals: {
        plugin: {
          slack: {
            ...configured,
            plugins: {
              diffs: {
                ...configured.plugins.diffs,
                tools: { ...configured.plugins.diffs.tools, diffs: { approvers: [agentApprover] } },
              },
            },
          },
        },
      },
    },
    captureError: true,
  });
  assert.match(conflictingTool.error?.message ?? "", /conflicts with managed Agent approvers/);
  assert.deepEqual(
    conflictingTool.calls.map((call) => Array.from(call.args).slice(1)),
    [["config", "validate", "--json"]],
  );
});

test("OpenClaw startup rejects native approvers that bypass an Agent ancestor", () => {
  const agentApprover = "team:T123:user:U123";
  const otherApprover = "team:T123:user:U456";
  const defaultRuntime = openClawRuntime();
  defaultRuntime.manifest.pluginApprovers = [];
  for (const [runtime, configured] of [
    [defaultRuntime, { plugins: { diffs: { approvers: [otherApprover] } } }],
    [
      openClawRuntime({ approvers: [{ channel: "slack", id: agentApprover }] }),
      { plugins: { diffs: { tools: { other: { approvers: [otherApprover] } } } } },
    ],
  ]) {
    const result = runOpenClawRuntimeHelper(runtime, installedPluginResponses(), {
      baseConfig: {
        channels: { slack: { enabled: true } },
        approvals: { plugin: { slack: configured } },
      },
      captureError: true,
    });
    assert.match(result.error?.message ?? "", /conflicts with managed Agent approvers/);
    assert.deepEqual(
      result.calls.map((call) => Array.from(call.args).slice(1)),
      [["config", "validate", "--json"]],
    );
  }
});

test("Codex bridge preserves an unrelated native tool approver for the same plugin", () => {
  const appId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
  const readTool = `${appId}/repos%2Fread`;
  const writeTool = `${appId}/repos%2Fwrite`;
  const approver = "team:T123:user:U123";
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          tools: { [readTool]: { approvers: [{ channel: "slack", id: approver }] } },
        },
      },
    },
  };
  const { files } = runOpenClawRuntimeHelper(runtime, [], {
    baseConfig: {
      channels: { slack: { enabled: true } },
      approvals: {
        plugin: { slack: { plugins: { linear: { tools: { [writeTool]: { approvers: [] } } } } } },
      },
    },
  });
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(effective.approvals.plugin.slack.plugins.linear.tools, {
    [writeTool]: { approvers: [] },
    [readTool]: { approvers: [approver] },
  });
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
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
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

test("OpenClaw startup preserves restrictions for a disabled selection", () => {
  const plugins = { allow: ["memory-core"], deny: ["diffs"], enabled: false };
  const { files, calls } = runOpenClawRuntimeHelper(
    openClawRuntime({ enabled: false }),
    installedPluginResponses(),
    {
      baseConfig: { plugins },
    },
  );
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(effective.plugins, { ...plugins, entries: { diffs: { enabled: false } } });
  assert.ok(calls[0].args.includes("--no-enable"));
});

test("OpenClaw startup rejects a blocked Codex bridge before readiness", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
        },
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

// The file-transfer entry of OpenClaw's live `plugins.list` answer.
function pluginList(state, generation) {
  return {
    generation,
    plugins: [
      { id: "codex", runtime: { state: "active" } },
      { id: "file-transfer", runtime: { state } },
    ],
  };
}

// What the wrapper's private runtime status would report.
function workspaceNodeState(sandbox) {
  const [nodeId, failure] = vm.runInContext(
    "[runtimeWorkspaceNodeId, runtimeWorkspaceNodeFailure?.code]",
    sandbox,
  );
  return { nodeId, failure };
}

// OpenClaw dynamic tools that execute against the Gateway Pod's local disk or shell,
// type into its terminals, proxy its ports, or change its configuration, plugins
// or installed version.
const GATEWAY_LOCAL_CODEX_TOOLS = [
  "ls",
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "gateway_exec",
  "gateway_process",
  "terminal",
  "portal",
  "openclaw",
  "plugins",
  "gateway",
];

const codexGatewayConfig = () => ({
  gateway: { port: 8080, nodes: { commands: { allow: ["existing.command"] } } },
  plugins: {
    allow: ["codex"],
    entries: {
      codex: {
        enabled: true,
        config: { appServer: { transport: "websocket", url: "wss://harness.example.test" } },
      },
    },
  },
  tools: { alsoAllow: ["existing-tool"] },
});

test("a running Gateway hot-applies its workspace node under plugins.* and acks only OpenClaw's reload", async () => {
  const intervals = [];
  const kills = [];
  const lines = [];
  let openClaw = pluginList("disabled", 1);
  // The Gateway starts before the node pairs: the optional binding file is absent.
  // Its provider owns a private directory outside the model/file-transfer workspace.
  const baseConfig = codexGatewayConfig();
  baseConfig.plugins.entries.codex.config.appServer.nativeHookRelay = {
    url: "https://gateway.example.test/node/__openclaw__/native-hook",
    credentialDirectory: "/private/provider-home/.oce-native-hooks",
  };
  const hookDirectory = "/private/provider-home/.oce-native-hooks";
  const { files, calls, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig,
    env: {
      APP_SERVER_URL: "ws://harness.example.test:18790",
      OPENCLAW_REMOTE_WORKSPACE_ROOT: "/sandbox/enterprise",
    },
    workspaceNodeBindingPath: true,
    intervals,
    kills,
    gatewayCall: (method) => (method === "plugins.list" ? openClaw : undefined),
    setTimeout: () => ({ unref() {} }),
    console: { error: (line) => lines.push(JSON.parse(line)) },
  });
  const configPath = "/home/node/.openclaw/openclaw.json";
  const atStart = JSON.parse(files.get(configPath));
  assert.equal(
    atStart.plugins.entries.codex.config.appServer.remoteWorkspaceRoot,
    "/sandbox/enterprise",
  );
  assert.deepEqual(atStart.plugins.entries.codex.config.appServer.nativeHookRelay, {
    ...baseConfig.plugins.entries.codex.config.appServer.nativeHookRelay,
    credentialDirectory: hookDirectory,
  });
  assert.equal(atStart.plugins.entries["file-transfer"], undefined);
  // Before the node pairs, Codex already gets no tool that would act on the
  // Gateway Pod's empty workspace or run commands there.
  assert.deepEqual(
    atStart.plugins.entries.codex.config.codexDynamicToolsExclude,
    GATEWAY_LOCAL_CODEX_TOOLS,
  );
  // Automation triggers would run model-written commands in the Gateway Pod.
  assert.deepEqual(atStart.cron, { triggers: { enabled: false } });
  // The memory flush run gets Gateway-local read and write despite the excludes.
  assert.deepEqual(atStart.agents, {
    defaults: { compaction: { memoryFlush: { enabled: false } }, modelSelectionScope: "session" },
  });
  // Defaults the owner never set are not reported as overridden.
  assert.ok(
    lines.every(
      (line) =>
        line.event !== "runtime.gateway_settings_overridden" ||
        !line.settings.some((name) => name.startsWith("agents.")),
    ),
  );
  // A built-in runtime run in the Gateway gets no reachable model.
  assert.deepEqual(atStart.models, {
    providers: { codex: { baseUrl: "http://127.0.0.1:9", api: "openai-responses" } },
  });
  // gateway.* is final at start: the command grant precedes any node ID.
  assert.equal(atStart.gateway.nodes.commands.allow.includes("file.fetch"), true);
  const gatewayAtStart = JSON.stringify(atStart.gateway);
  const poll = intervals.find(({ ms }) => ms === 1000);
  assert.ok(poll, "the wrapper polls the binding every second");
  const tick = () => poll.callback();
  const gatewayCalls = () => calls.filter(({ method }) => method === "plugins.list");

  await tick();
  assert.equal(files.get(configPath), JSON.stringify(atStart), "no binding, no write");
  // A partial file, one for another revision of this Agent, or a malformed
  // device ID is treated as absent.
  for (const binding of [
    '{"revisionId":"revi',
    workspaceNodeBinding("enrolled-node", "revision-2"),
    workspaceNodeBinding("../escape"),
  ]) {
    files.set(WORKSPACE_NODE_BINDING_PATH, binding);
    await tick();
    assert.equal(files.get(configPath), JSON.stringify(atStart));
  }
  assert.equal(gatewayCalls().length, 0);

  files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));
  await tick();
  const applied = JSON.parse(files.get(configPath));
  const changedKeys = Object.keys({ ...atStart, ...applied }).filter(
    (key) => JSON.stringify(atStart[key]) !== JSON.stringify(applied[key]),
  );
  assert.deepEqual(changedKeys, ["plugins"]);
  assert.equal(JSON.stringify(applied.gateway), gatewayAtStart, "gateway.* is byte-identical");
  assert.deepEqual(applied.plugins.allow, ["codex", "file-transfer"]);
  assert.equal(applied.plugins.entries["file-transfer"].enabled, true);
  assert.deepEqual(applied.plugins.entries["file-transfer"].config.workspaces.main, {
    nodeId: "enrolled-node",
    remoteRoot: "/sandbox/enterprise",
  });
  assert.deepEqual(applied.plugins.entries.codex, atStart.plugins.entries.codex);
  // The write was a whole-file replacement, not an in-place rewrite.
  assert.equal(
    [...files.keys()].some((path) => path.includes(".workspace-node-")),
    false,
  );
  // Writing the file is not the ack: OpenClaw has not reloaded its plugins yet.
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });

  // OpenClaw's reload published a registry with file-transfer active.
  openClaw = pluginList("active", 2);
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
  assert.deepEqual(
    gatewayCalls().map(({ method }) => method),
    ["plugins.list", "plugins.list", "plugins.list"],
  );
  // OpenClaw watches the file it was started with; the child is not replaced.
  assert.equal(calls.filter(({ args }) => args?.[1] === "gateway" && args.length === 4).length, 1);
  assert.deepEqual(kills, []);
  assert.deepEqual(
    lines
      .filter(({ phase }) => phase?.startsWith("workspace-node"))
      .map(({ phase, outcome }) => [phase, outcome]),
    [["workspace-node", "ok"]],
  );

  // The same binding again is a no-op.
  await tick();
  assert.equal(files.get(configPath), JSON.stringify(applied));
  assert.equal(gatewayCalls().length, 3);
  // Another node for this revision replaces the config from a clean start.
  files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("other-node"));
  await tick();
  assert.equal(files.get(configPath), JSON.stringify(applied));
  assert.deepEqual(kills, [{ signal: "SIGTERM" }]);
});

test("a Gateway reports why OpenClaw has not applied its workspace node and clears it on success", async () => {
  const intervals = [];
  const lines = [];
  let now = 1_000_000;
  const clock = class extends Date {
    static now() {
      return now;
    }
  };
  let openClaw;
  const { files, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: codexGatewayConfig(),
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    workspaceNodeBindingPath: true,
    intervals,
    Date: clock,
    gatewayCall: () => openClaw,
    setTimeout: () => ({ unref() {} }),
    console: { error: (line) => lines.push(JSON.parse(line)) },
  });
  const configPath = "/home/node/.openclaw/openclaw.json";
  const tick = () => intervals.find(({ ms }) => ms === 1000).callback();
  const failures = () =>
    lines.filter(({ event }) => event === "runtime.workspace_node").map(({ code }) => code);
  files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));

  // The Gateway does not answer: nothing is written, and after the budget that is the cause.
  await tick();
  now += 31_000;
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "GATEWAY_UNAVAILABLE",
  });
  assert.equal(JSON.parse(files.get(configPath)).plugins.entries["file-transfer"], undefined);

  // A config that now denies file-transfer cannot host the node.
  openClaw = pluginList("disabled", 1);
  const denied = JSON.parse(files.get(configPath));
  denied.plugins.deny = ["file-transfer"];
  files.set(configPath, JSON.stringify(denied));
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "FILE_TRANSFER_DENIED",
  });
  delete denied.plugins.deny;
  files.set(configPath, JSON.stringify(denied));

  // Written, but OpenClaw's file-transfer service failed to start.
  await tick();
  assert.equal(
    JSON.parse(files.get(configPath)).plugins.entries["file-transfer"].config.workspaces.main
      .nodeId,
    "enrolled-node",
  );
  openClaw = pluginList("service-failed", 2);
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "FILE_TRANSFER_FAILED",
  });
  // Still unloaded past the budget: the reload never happened.
  openClaw = pluginList("disabled", 1);
  now += 31_000;
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "RELOAD_NOT_CONFIRMED",
  });
  // A later reload clears the cause.
  openClaw = pluginList("active", 3);
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
  assert.deepEqual(failures(), [
    "GATEWAY_UNAVAILABLE",
    "FILE_TRANSFER_DENIED",
    "FILE_TRANSFER_FAILED",
    "RELOAD_NOT_CONFIRMED",
  ]);
});

// The error OpenClaw's CLI call rejects with when the Gateway refuses its connect
// handshake: a GatewayClientRequestError carrying the server's connect-error details.
function gatewayConnectRefusal(detailCode, retryable = false) {
  const error = new Error("unauthorized");
  error.name = "GatewayClientRequestError";
  error.gatewayCode = "INVALID_REQUEST";
  error.retryable = retryable;
  error.details = { code: detailCode, authReason: "trusted_proxy_untrusted_source" };
  return error;
}

test("a Gateway that refuses its own CLI as unauthorized reports it at once; other refusals keep waiting", async () => {
  const intervals = [];
  let now = 1_000_000;
  const clock = class extends Date {
    static now() {
      return now;
    }
  };
  const lines = [];
  let refusal;
  let openClaw;
  const { files, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: codexGatewayConfig(),
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    workspaceNodeBindingPath: true,
    intervals,
    Date: clock,
    gatewayCall: () => {
      if (refusal !== undefined) {
        throw refusal;
      }
      return openClaw;
    },
    setTimeout: () => ({ unref() {} }),
    console: { error: (line) => lines.push(JSON.parse(line)) },
  });
  const configPath = "/home/node/.openclaw/openclaw.json";
  const tick = () => intervals.find(({ ms }) => ms === 1000).callback();
  files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));

  // A rate-limited or pairing refusal clears by itself: it waits like an
  // unreachable Gateway and is reported only as unavailable after the budget.
  refusal = gatewayConnectRefusal("AUTH_RATE_LIMITED", true);
  await tick();
  refusal = gatewayConnectRefusal("PAIRING_REQUIRED");
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
  now += 31_000;
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "GATEWAY_UNAVAILABLE",
  });

  // D381: without gateway.auth.password the in-Pod CLI connects with no
  // credential and the Gateway refuses it on every call. That is fixed by the
  // admitted configuration, so it is reported on the first refusal.
  refusal = gatewayConnectRefusal("AUTH_UNAUTHORIZED");
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "GATEWAY_UNAUTHORIZED",
  });
  assert.equal(JSON.parse(files.get(configPath)).plugins.entries["file-transfer"], undefined);
  // The Pod log names OpenClaw's refusal reason, so the operator can see why.
  assert.deepEqual(
    lines
      .filter(({ event }) => event === "runtime.workspace_node")
      .map(({ code, reason }) => ({ code, reason })),
    [
      { code: "GATEWAY_UNAVAILABLE", reason: undefined },
      { code: "GATEWAY_UNAUTHORIZED", reason: "trusted_proxy_untrusted_source" },
    ],
  );

  // A refusal after the node was written is reported the same way.
  refusal = undefined;
  openClaw = pluginList("disabled", 1);
  await tick();
  assert.equal(
    JSON.parse(files.get(configPath)).plugins.entries["file-transfer"].config.workspaces.main
      .nodeId,
    "enrolled-node",
  );
  refusal = gatewayConnectRefusal("AUTH_PASSWORD_MISSING");
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "GATEWAY_UNAUTHORIZED",
  });
  refusal = undefined;
  openClaw = pluginList("active", 2);
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
});

test("a Gateway that starts after its node paired applies the binding before OpenClaw starts", async () => {
  const intervals = [];
  const kills = [];
  let openClaw = pluginList("unloaded", 1);
  const { files, calls, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    workspaceNodeId: "enrolled-node",
    intervals,
    kills,
    gatewayCall: () => openClaw,
    setTimeout: () => ({ unref() {} }),
  });
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(
    effective.plugins.entries["file-transfer"].config.workspaces.main.nodeId,
    "enrolled-node",
  );
  assert.equal(calls.length, 1);
  // The poll writes nothing and waits for OpenClaw to report file-transfer loaded.
  const written = files.get("/home/node/.openclaw/openclaw.json");
  const tick = () => intervals.find(({ ms }) => ms === 1000).callback();
  await tick();
  assert.equal(workspaceNodeState(sandbox).nodeId, undefined);
  openClaw = pluginList("active", 1);
  await tick();
  assert.equal(workspaceNodeState(sandbox).nodeId, "enrolled-node");
  assert.equal(files.get("/home/node/.openclaw/openclaw.json"), written);
  assert.deepEqual(kills, []);
});

test("a Gateway starting with its node bound measures the apply budget from OpenClaw's spawn", async () => {
  const intervals = [];
  // The wrapper's first clock read is its startup origin; login, the model probe
  // and plugin install then take a minute before OpenClaw spawns.
  let now = 0;
  let reads = 0;
  const clock = class extends Date {
    static now() {
      return reads++ === 0 ? 0 : now;
    }
  };
  now = 60_000;
  let openClaw;
  const { sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    workspaceNodeId: "enrolled-node",
    intervals,
    Date: clock,
    gatewayCall: () => openClaw,
    setTimeout: () => ({ unref() {} }),
    console: { error() {} },
  });
  const tick = () => intervals.find(({ ms }) => ms === 1000).callback();
  // OpenClaw is still coming up: not a failure yet.
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
  now += 31_000;
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), {
    nodeId: undefined,
    failure: "GATEWAY_UNAVAILABLE",
  });
  openClaw = pluginList("active", 1);
  await tick();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
});

test("a Gateway given its node in the environment configures it at start and arms no poll", async () => {
  // Native worker profiles, and Gateways whose controller cannot read runtime
  // status, receive OPENCLAW_WORKSPACE_NODE_ID instead of a binding file.
  const intervals = [];
  const kills = [];
  const { files, calls, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    env: {
      APP_SERVER_URL: "ws://harness.example.test:18790",
      OPENCLAW_WORKSPACE_NODE_ID: "environment-node",
    },
    intervals,
    kills,
  });
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(
    effective.plugins.entries["file-transfer"].config.workspaces.main.nodeId,
    "environment-node",
  );
  assert.equal(sandbox.process.env.OPENCLAW_WORKSPACE_NODE_PATH, undefined);
  assert.equal(calls.filter(({ args }) => args?.[1] === "gateway").length, 1);
  assert.deepEqual(intervals, [], "no binding poll without a binding path");
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
  assert.deepEqual(kills, []);
});

test("a workspace-node Gateway keeps owner Codex tool excludes, pins the codex provider, and refuses malformed settings", async () => {
  const withExcludes = (codexDynamicToolsExclude) => {
    const config = codexGatewayConfig();
    config.plugins.entries.codex.config.codexDynamicToolsExclude = codexDynamicToolsExclude;
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
  ownerConfig.models = {
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
            compat: { supportsTools: false },
          },
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
  const logged = [];
  const { files } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: ownerConfig,
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    workspaceNodeId: "enrolled-node",
    console: { error: (line) => logged.push(line) },
  });
  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  // The Gateway says which owner settings it replaced, by name only (D202).
  const overrides = logged
    .filter((line) => line.includes("runtime.gateway_settings_overridden"))
    .map((line) => JSON.parse(line));
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
  assert.deepEqual(effective.plugins.entries.codex.config.codexDynamicToolsExclude, [
    "web_search",
    ...GATEWAY_LOCAL_CODEX_TOOLS,
  ]);
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
        models: [{ id: "gpt-test", name: "gpt-test", contextWindow: 200000 }],
        baseUrl: "http://127.0.0.1:9",
        api: "openai-responses",
      },
      OpenAI: {
        models: [{ id: "gpt-5", contextWindow: 400000 }],
        baseUrl: "http://127.0.0.1:9",
        api: "openai-responses",
      },
      anthropic: ownerConfig.models.providers.anthropic,
    },
  });
  // An openai row that names no transport keeps OpenClaw's default (no credential
  // in the Gateway) so Codex keeps owning its account's models; overrides still go.
  // APP_SERVER_URL marks a Codex Gateway, so the pin holds without the plugin entry.
  const noEntry = codexGatewayConfig();
  delete noEntry.plugins.entries.codex;
  noEntry.models = {
    providers: {
      openai: { headers: { "x-route": "e" }, models: [{ id: "gpt-5", params: { store: false } }] },
    },
  };
  const noEntryRun = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: noEntry,
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    workspaceNodeId: "enrolled-node",
  });
  const noEntryConfig = JSON.parse(noEntryRun.files.get("/home/node/.openclaw/openclaw.json"));
  assert.deepEqual(noEntryConfig.models, {
    providers: {
      openai: { models: [{ id: "gpt-5" }] },
      codex: { baseUrl: "http://127.0.0.1:9", api: "openai-responses" },
    },
  });
  // A dedicated OpenClaw Gateway runs its turns with these rows, so it keeps them.
  const native = codexGatewayConfig();
  delete native.plugins.entries.codex;
  native.models = {
    providers: { openai: { baseUrl: "https://model.example.test/v1", models: [] } },
  };
  const nativeRun = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: native,
    env: { OPENCLAW_NATIVE_WORKER_PROFILE: "native" },
    workspaceNodeId: "enrolled-node",
  });
  const nativeConfig = JSON.parse(
    nativeRun.files.get("/home/node/.openclaw/openclaw.json") ??
      nativeRun.files.get("/etc/openclaw/openclaw.json"),
  );
  assert.deepEqual(nativeConfig.models, native.models);
  // A malformed setting fails the Gateway start instead of being replaced silently.
  await assert.rejects(
    () =>
      runOpenClawRuntimeHelper(undefined, [], {
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
  ]) {
    const malformed = { ...codexGatewayConfig(), ...settings };
    await assert.rejects(
      () =>
        runOpenClawRuntimeHelper(undefined, [], {
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
  ]) {
    const malformed = codexGatewayConfig();
    malformed.models = models;
    await assert.rejects(
      () =>
        runOpenClawRuntimeHelper(undefined, [], {
          baseConfig: malformed,
          env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
          workspaceNodeId: "enrolled-node",
        }),
      message,
    );
  }
  // A remote Codex Harness still needs the model policy and Gateway-local
  // exclusions while the workspace node is unavailable.
  const localBase = codexGatewayConfig();
  localBase.models = {
    providers: { codex: { baseUrl: "https://model.example.test/v1", models: [] } },
  };
  const local = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: localBase,
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
  });
  const localConfig = JSON.parse(
    local.files.get("/home/node/.openclaw/openclaw.json") ??
      local.files.get("/etc/openclaw/openclaw.json"),
  );
  assert.deepEqual(
    localConfig.plugins.entries.codex.config.codexDynamicToolsExclude,
    GATEWAY_LOCAL_CODEX_TOOLS,
  );
  assert.deepEqual(localConfig.cron, { triggers: { enabled: false } });
  assert.deepEqual(localConfig.agents, { defaults: { modelSelectionScope: "session" } });
  assert.deepEqual(localConfig.models, localBase.models);
  assert.equal(localConfig.plugins.entries.codex.config.appServer.remoteWorkspaceRoot, undefined);
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
  // The Gateway's own workspace is empty: OpenClaw tools that would run in it
  // are withheld from Codex, which lists and runs files in the Harness.
  assert.deepEqual(effective.plugins.entries.codex, {
    enabled: true,
    config: {
      appServer: baseConfig.plugins.entries.codex.config.appServer,
      codexDynamicToolsExclude: GATEWAY_LOCAL_CODEX_TOOLS,
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
    "/home/node/workspace/skills/**",
    "/home/node/workspace/.clawhub/lock.json",
    "/home/node/workspace/.clawdhub/lock.json",
    "/home/node/workspace/.openclaw/skill-installs/**",
    "/home/node/workspace/media/inbound/openclaw-staged-*/**",
  ]);
  assert.deepEqual(transfer.nodes["enrolled-node"].allowReadPaths, [
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
  assert.equal(transfer.nodes["enrolled-node"].followSymlinks, false);
  assert.equal(transfer.literalGrants, undefined);
  assert.equal(effective.gateway.nodes.commands.allow.includes("existing.command"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("dir.list"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("file.create"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("workspace.memory"), true);
  assert.equal(effective.gateway.nodes.commands.allow.includes("workspace.skills"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], "gateway");
  const explicit = {
    nodes: {
      "*": {
        ask: "off",
        allowReadPaths: ["/chosen/AGENTS.md"],
        allowWritePaths: ["/chosen/SOUL.md"],
      },
    },
  };
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

test("deployment admission and the Gateway entrypoint agree on the workspace node's plugins", async () => {
  // The entrypoint exits at every start on a plugin shape a workspace node cannot use, so a
  // dedicated deployment that admitted one crash-looped after its predecessor stopped
  // (finding 1112). Admission applies its own copy of the rule; both must refuse the same shapes.
  const admits = (config) => {
    try {
      requireWorkspaceNodePlugins(
        config,
        (setting, requirement) => new Error(setting + requirement),
      );
      return true;
    } catch {
      return false;
    }
  };
  const entrypointStarts = async (config) => {
    try {
      await runOpenClawRuntimeHelper(undefined, [], {
        baseConfig: config,
        workspaceNodeId: "enrolled-node",
      });
      return true;
    } catch (error) {
      assert.match(String(error?.message), /requires the file-transfer plugin|is not a function/);
      return false;
    }
  };
  for (const [config, starts] of [
    [{}, true],
    [{ plugins: null }, true],
    [{ plugins: "none" }, true],
    [{ plugins: { deny: [] } }, true],
    [{ plugins: { deny: null } }, true],
    [{ plugins: { deny: ["other", "file-transfers"] } }, true],
    [{ plugins: { deny: ["other", "file-transfer"] } }, false],
    // A deny that is not a list stops the entrypoint (OpenClaw requires a list as well).
    [{ plugins: { deny: { "file-transfer": true } } }, false],
    [{ plugins: { deny: 1 } }, false],
    [{ plugins: { deny: "file-transfer" } }, false],
    // Not listed: a deny string without file-transfer starts the entrypoint, but admission
    // refuses it as not a list, as OpenClaw's own schema (an array of strings) does.
    [{ plugins: { entries: { "file-transfer": { enabled: false } } } }, false],
    [{ plugins: { entries: { "file-transfer": { enabled: true } } } }, true],
    [{ plugins: { entries: { "file-transfer": { enabled: "false" } } } }, true],
    [{ plugins: { entries: { "file-transfer": null } } }, true],
    [{ plugins: { entries: { "file-transfer": {} } } }, true],
    [{ plugins: { entries: { other: { enabled: false } } } }, true],
    [{ plugins: { entries: [] } }, true],
  ]) {
    const label = JSON.stringify(config);
    assert.equal(await entrypointStarts(structuredClone(config)), starts, label);
    assert.equal(admits(config), starts, label);
  }
});

test("a timed-out workspace binding probe releases the poll and can recover", async () => {
  const intervals = [];
  let timeout;
  let signal;
  let unavailable = true;
  let openClaw = pluginList("disabled", 1);
  const { files, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: codexGatewayConfig(),
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    workspaceNodeBindingPath: true,
    intervals,
    gatewayCall: (_method, probeSignal) => {
      signal = probeSignal;
      return unavailable ? new Promise(() => {}) : openClaw;
    },
    setTimeout: (callback, ms) => {
      if (ms === 8000) {
        timeout = callback;
      }
      return { unref() {} };
    },
    console: { error() {} },
  });
  files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));
  const poll = intervals.find(({ ms }) => ms === 1000);
  const pending = poll.callback();
  await new Promise((resolve) => setImmediate(resolve));
  // A probe that never settles must still release the single-flight poll.
  timeout();
  await pending;
  assert.equal(signal.aborted, true);
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });

  unavailable = false;
  await poll.callback();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
  openClaw = pluginList("active", 2);
  await poll.callback();
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
});

// `openclaw config validate --json` output for a configuration read OpenClaw refused,
// as the pinned OpenClaw prints it (exit status 1).
function configReadRefusal(error) {
  return openClawConfigValidationRefusal(
    [{ path: "<root>", message: `read failed at /home/node/.openclaw/openclaw.json: ${error}` }],
    "Resolve the read error shown above, then retry.",
  );
}
const configReadPermissionDenied =
  "EACCES: permission denied, open '/home/node/.openclaw/openclaw.json'";
// Captured from a dedicated Gateway container started again after its native Gateway was
// killed (SIGKILL): the new PID namespace cannot verify the recorded holder (finding 2864).
const gatewayLockNamespaceRefusal =
  "GatewayLockNamespaceError: cannot verify Gateway ownership from this process; heartbeat age" +
  " does not prove that the holder stopped. holder 608 at 54b9b0fe1247/pid-ns 4026536051, last" +
  " renewed 14 s ago. Run this command inside the Gateway container or with a shared PID" +
  " namespace; if the holder has stopped, run `openclaw gateway recover-lock` to inspect and" +
  " explicitly recover the unchanged owner.";
const heldStatusEnvironment = {
  OPENCLAW_RUNTIME_STATUS_PORT: "18791",
  OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
};

const dedicatedGatewayLaunchers = [
  {
    name: "Kubernetes dedicated OpenClaw",
    env: {
      OPENCLAW_NATIVE_WORKER_PROFILE: "oce-native",
      OPENCLAW_WORKSPACE_NODE_ID: "a".repeat(64),
    },
  },
  {
    name: "Kubernetes dedicated Codex",
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
  },
  {
    name: "Docker dedicated Codex",
    launcher: "docker",
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
  },
];

for (const launcher of dedicatedGatewayLaunchers) {
  test(`${launcher.name} applies the reviewed tool ceiling before native startup`, async () => {
    const baseConfig = codexGatewayConfig();
    baseConfig.tools = {
      profile: "coding",
      allow: ["read", "sessions"],
      alsoAllow: ["gateway", "diffs"],
      deny: ["sessions_send"],
      // Deployment admission restricts apply_patch to the workspace by default.
      exec: { applyPatch: { workspaceOnly: true } },
    };
    // A strict Configuration's explicit steering value reaches the Gateway unchanged.
    baseConfig.messages = { queue: { allowCollaborativeSteering: false } };
    baseConfig.agents = { defaults: { modelSelectionScope: "agent" } };
    baseConfig.cron = { enabled: true, triggers: { enabled: true } };
    baseConfig.plugins.entries.codex.config.codexDynamicToolsExclude = ["web_search"];
    const { calls, files } = await runOpenClawRuntimeHelper(undefined, [], {
      ...launcher,
      baseConfig,
    });
    const native = calls.findIndex(({ args }) => args?.[1] === "gateway");
    const validate = calls.findIndex(
      ({ args }) => args?.[1] === "config" && args[2] === "validate",
    );
    assert.ok(
      validate >= 0 && validate < native,
      "validate the final config before starting the native Gateway",
    );
    const effective = JSON.parse(files.get(calls[validate].options.env.OPENCLAW_CONFIG_PATH));
    const { gatewayPolicy, ...ordinaryTools } = effective.tools;
    assert.deepEqual(
      ordinaryTools,
      baseConfig.tools,
      "ordinary restrictions and plugin grants are retained",
    );
    assert.deepEqual(gatewayPolicy.allow, [
      "sessions",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
      "session_status",
      "agents_list",
      "automations",
      "message",
      "ask_user",
      "progress_card",
      "get_goal",
      "create_goal",
      "update_goal",
      "ls",
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
    ]);
    assert.equal(gatewayPolicy.allow.includes("gateway"), false);
    assert.equal(
      gatewayPolicy.allow.includes("diffs"),
      false,
      "a plugin tool grant is not policy approval",
    );
    assert.deepEqual(Object.keys(gatewayPolicy.actions).sort(), [
      "automations",
      "message",
      "process",
      "sessions",
      "subagents",
    ]);
    assert.equal(gatewayPolicy.actions.message.includes("send"), true);
    assert.equal(gatewayPolicy.actions.message.includes("set-profile"), false);
    assert.deepEqual(gatewayPolicy.automations, { scope: "caller", allowCommandJobs: false });
    assert.deepEqual(effective.messages, baseConfig.messages);
    assert.equal(effective.agents.defaults.modelSelectionScope, "session");
    assert.deepEqual(effective.cron, { enabled: true, triggers: { enabled: false } });
    if (launcher.env.APP_SERVER_URL !== undefined) {
      assert.deepEqual(effective.plugins.entries.codex.config.codexDynamicToolsExclude, [
        "web_search",
        ...GATEWAY_LOCAL_CODEX_TOOLS,
      ]);
    }
    assert.deepEqual(
      effective.gateway.auth,
      baseConfig.gateway.auth,
      "human Gateway authorization remains unchanged",
    );
    assert.deepEqual(
      JSON.parse(files.get("/etc/openclaw/openclaw.json")),
      baseConfig,
      "the admitted revision is untouched",
    );
  });

  // A beam entry that fails its schema (finding 3045). Beside an issue on a setting the tool
  // policy step composes, the tool policy hold wins.
  const beamIssue = {
    path: "plugins.entries.beam.config.mirror.endpoint",
    message: "invalid config: must have required property 'endpoint'",
  };
  for (const [failure, options, held = "gateway-tool-policy", line] of [
    [
      "unknown runtime source",
      {
        files: [
          [
            "/opt/oce/runtime/provenance.json",
            JSON.stringify({
              source: "https://github.com/openclaw/openclaw",
              commit: "a".repeat(40),
            }),
          ],
        ],
      },
    ],
    [
      "schema validation refusal",
      {
        configValidationResponse: {
          status: 1,
          stdout: JSON.stringify({ valid: false }),
          stderr: "unsupported gatewayPolicy",
        },
      },
    ],
    // Another refused read of the configuration is not a lock: it keeps the tool policy hold.
    [
      "unreadable configuration",
      { configValidationResponse: configReadRefusal(`Error: ${configReadPermissionDenied}`) },
    ],
    [
      "Gateway state lock refusal",
      { configValidationResponse: configReadRefusal(gatewayLockNamespaceRefusal) },
      "gateway-state-lock",
    ],
    // Settings outside the tool policy are the Agent's configuration, not the policy. The hold
    // writes the line an embedded Gateway's gateway-config hold writes: the settings and the
    // remedy, never a configured value.
    [
      "invalid settings outside the tool policy",
      { configValidationResponse: invalidGatewayConfiguration },
      "gateway-config",
      invalidGatewayConfigurationLine(GATEWAY_DID_NOT_START),
    ],
    [
      "a refused key beside the settings the tool policy composes",
      {
        configValidationResponse: openClawConfigValidationRefusal([
          { path: "agents.defaults", message: 'Unrecognized key: "thinkingBudget"' },
        ]),
      },
      "gateway-config",
      gatewayConfigurationHoldLine(GATEWAY_DID_NOT_START, ["agents.defaults"]),
    ],
    // An issue on a setting the step composes keeps the tool policy hold, beside any other.
    [
      "an invalid composed tool policy",
      {
        configValidationResponse: openClawConfigValidationRefusal([
          beamIssue,
          { path: "tools.gatewayPolicy.actions.sessions", message: "Invalid input" },
        ]),
      },
    ],
    [
      "an invalid composed Codex tool exclusion",
      {
        configValidationResponse: openClawConfigValidationRefusal([
          {
            path: "plugins.entries.codex.config.codexDynamicToolsExclude.0",
            message: "invalid config: must be string",
          },
        ]),
      },
    ],
    // A runtime whose OpenClaw does not know a composed setting refuses its key one level up.
    [
      "a runtime that refuses the composed cron trigger switch",
      {
        configValidationResponse: openClawConfigValidationRefusal([
          { path: "cron.triggers", message: 'Unrecognized key: "enabled"' },
          beamIssue,
        ]),
      },
    ],
    [
      "a runtime that refuses the composed model selection scope",
      {
        configValidationResponse: openClawConfigValidationRefusal([
          { path: "agents.defaults", message: 'Unrecognized key: "modelSelectionScope"' },
        ]),
      },
    ],
    // A refusal that names no setting cannot be told apart from a policy refusal.
    [
      "an invalid report without issues",
      { configValidationResponse: openClawConfigValidationRefusal([]) },
    ],
  ]) {
    test(`${launcher.name} holds ${failure} unready without starting model work`, async () => {
      const messages = [];
      const intervals = [];
      const { calls, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
        ...launcher,
        ...options,
        // The Docker launcher serves no status itself, so its published hold can be read here;
        // runtime-image-gateway-peer reads the Kubernetes Gateway's over its status port.
        env: { ...launcher.env, ...(launcher.launcher === "docker" ? heldStatusEnvironment : {}) },
        baseConfig: codexGatewayConfig(),
        intervals,
        console: { error: (message) => messages.push(message) },
      });
      assert.equal(
        calls.some(({ args }) => args?.[1] === "gateway"),
        false,
      );
      assert.equal(
        messages.some((message) => message.includes("required tool policy")),
        held === "gateway-tool-policy",
        messages.join("\n"),
      );
      if (held === "gateway-state-lock") {
        // The operator reads the cause and OpenClaw's holder description, not a policy hint.
        assert.ok(
          messages.some(
            (message) =>
              message.includes("still holds the Gateway state lock") &&
              message.includes("unverifiable state owner") &&
              message.includes("holder 608 at 54b9b0fe1247/pid-ns 4026536051"),
          ),
          messages.join("\n"),
        );
      }
      if (line !== undefined) {
        assert.deepEqual(messages, [line]);
      }
      assert.equal(messages.join("\n").includes(invalidGatewayConfigurationSecret), false);
      if (launcher.launcher === "docker") {
        const published = vm.runInContext("runtimeStartupFailure", sandbox);
        assert.deepEqual(
          { check: published?.check, code: published?.code },
          {
            check: held,
            code: held === "gateway-tool-policy" ? "INCOMPATIBLE_RESPONSE" : "UNAVAILABLE",
          },
        );
      }
      assert.ok(
        intervals.some(({ ms }) => ms === 3_600_000),
        "keep the failed workload available for diagnosis",
      );
    });
  }
}

test("a dedicated Gateway permits concrete OCE tool additions and preserves empty or narrower policy", async () => {
  for (const gatewayPolicy of [
    { allow: [] },
    { allow: ["sessions", "diffs"], actions: { sessions: ["patch"] } },
  ]) {
    const baseConfig = codexGatewayConfig();
    baseConfig.tools = { alsoAllow: ["plugins"], gatewayPolicy };
    const { files } = await runOpenClawRuntimeHelper(undefined, [], {
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
      baseConfig,
    });
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json")).tools
      .gatewayPolicy;
    assert.deepEqual(effective.allow, gatewayPolicy.allow);
    assert.deepEqual(effective.actions, gatewayPolicy.actions ?? {});
    assert.deepEqual(effective.automations, { scope: "caller", allowCommandJobs: false });
  }
});

test("a dedicated Gateway takes approved tools from the immutable revision rather than native admin config", async () => {
  const admitted = codexGatewayConfig();
  admitted.tools = {
    gatewayPolicy: { allow: ["sessions", "read"], actions: { sessions: ["patch", "reset"] } },
  };
  const mutable = structuredClone(admitted);
  mutable.tools.gatewayPolicy = {
    allow: ["sessions", "plugins"],
    actions: { sessions: ["patch"] },
  };
  const { files } = await runOpenClawRuntimeHelper(undefined, [], {
    env: {
      APP_SERVER_URL: "ws://harness.example.test:18790",
      OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
    },
    files: [
      ["/home/node/.openclaw/openclaw.json", JSON.stringify(mutable)],
      ["/etc/openclaw-managed/openclaw.json", JSON.stringify(admitted)],
    ],
  });
  assert.deepEqual(
    JSON.parse(files.get("/home/node/.openclaw/openclaw.json")).tools.gatewayPolicy,
    {
      allow: ["sessions"],
      actions: { sessions: ["patch"] },
      automations: { scope: "caller", allowCommandJobs: false },
    },
  );
});

test("the embedded Docker launcher retains ordinary Gateway configuration", async () => {
  const baseConfig = {
    gateway: { mode: "local" },
    tools: { allow: ["gateway"] },
    cron: { triggers: { enabled: true } },
  };
  const { calls, files } = await runOpenClawRuntimeHelper(undefined, [], {
    launcher: "docker",
    baseConfig,
  });
  assert.equal(calls.filter(({ args }) => args?.[1] === "gateway").length, 1);
  assert.equal(
    calls.some(({ args }) => args?.[1] === "config"),
    false,
  );
  assert.deepEqual(JSON.parse(files.get("/etc/openclaw/openclaw.json")), baseConfig);
});
