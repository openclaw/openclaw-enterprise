import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { WORKSPACE_FILE_NAMES } from "../../packages/contracts/src/index.ts";
import {
  WORKSPACE_NODE_BINDING_PATH,
  runOpenClawRuntimeHelper,
  workspaceNodeBinding,
} from "../helpers/plugin-runtime.mjs";

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
  const { files, calls, sandbox } = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: codexGatewayConfig(),
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    workspaceNodeBindingPath: true,
    intervals,
    kills,
    gatewayCall: (method) => (method === "plugins.list" ? openClaw : undefined),
    setTimeout: () => ({ unref() {} }),
    console: { error: (line) => lines.push(JSON.parse(line)) },
  });
  const configPath = "/home/node/.openclaw/openclaw.json";
  const atStart = JSON.parse(files.get(configPath));
  assert.equal(atStart.plugins.entries["file-transfer"], undefined);
  // gateway.* is final at start: the command grant precedes any node ID.
  assert.equal(atStart.gateway.nodes.commands.allow.includes("file.fetch"), true);
  const gatewayAtStart = JSON.stringify(atStart.gateway);
  const poll = intervals.find(({ ms }) => ms === 1000);
  assert.ok(poll, "the wrapper polls the binding every second");
  const tick = () => poll.callback();
  const gatewayCalls = () =>
    calls.filter(({ args }) => args?.[1] === "gateway" && args[2] === "call");

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
    remoteRoot: "/home/node/workspace",
  });
  assert.equal(
    applied.plugins.entries.codex.config.appServer.remoteWorkspaceRoot,
    "/home/node/workspace",
  );
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
    gatewayCalls().map(({ args }) => args[3]),
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
  assert.equal(calls.length, 1);
  assert.deepEqual(intervals, [], "no binding poll without a binding path");
  assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
  assert.deepEqual(kills, []);
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
