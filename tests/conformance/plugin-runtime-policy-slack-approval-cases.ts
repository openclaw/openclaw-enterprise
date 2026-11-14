import assert from "node:assert/strict";

import test from "node:test";

import {
  installedPluginResponses,
  openClawRuntime,
  runPluginInstall,
  configPath,
  readConfig,
  field,
  commandArgs,
  type SpawnResponse,
  type RuntimeInput,
} from "./plugin-runtime-policy-fixture.ts";

export function registerSlackApprovalCases() {
  for (const [label, channels] of [
    ["no channels", undefined],
    ["unrelated channel", { msteams: { enabled: true } }],
    ["disabled Slack", { slack: { enabled: false, accounts: { team: { enabled: true } } } }],
  ]) {
    test(`Gateway omits managed Slack approvers for ${label} while preserving admitted denies`, () => {
      for (const kind of ["openclaw", "codex"] as const) {
        const runtime: RuntimeInput =
          kind === "openclaw"
            ? openClawRuntime({ approvers: [], tools: { diffs: { approvers: [] } } }, [])
            : {
                manifest: {
                  kind,
                  selections: {
                    "codex-plugin:linear@openai-curated-remote": {
                      enabled: true,
                      approvers: [],
                      tools: {
                        "asdk_app_69a089a326dc8191b32a3f2553f5be2c/repos%2Fwrite": {
                          approvers: [],
                        },
                      },
                    },
                  },
                  pluginApprovers: [],
                },
              };
        const admitted = structuredClone(runtime);
        const nativeApprovals = { exec: { enabled: true, mode: "session" } };
        const { files, calls } = runPluginInstall(runtime, installedPluginResponses(), {
          baseConfig: { ...(channels ? { channels } : {}), approvals: nativeApprovals },
        });
        const effective = readConfig(files);
        assert.deepEqual(effective.approvals, nativeApprovals);
        assert.deepEqual(runtime, admitted);
        assert.equal(
          calls.some((call) => commandArgs(call)[1] === "config"),
          false,
        );
      }
    });
  }

  test("Gateway validates only the generated Slack policy before writing the effective configuration", () => {
    const runtime: RuntimeInput = {
      manifest: { kind: "codex", selections: {}, pluginApprovers: [] },
    };
    const baseConfig = {
      channels: { slack: { enabled: true, accounts: { disabled: { enabled: false } } } },
      approvals: { exec: { enabled: true, mode: "session" } },
    };
    let candidate: unknown;
    const { calls, files } = runPluginInstall(runtime, [], {
      baseConfig,
      beforeSpawn(_command, args, sandbox, options) {
        if (args[1] !== "config") {
          return;
        }
        assert.equal(sandbox.files.has("/home/node/.openclaw/openclaw.json"), false);
        const candidatePath = configPath(options.env?.OPENCLAW_CONFIG_PATH);
        candidate = readConfig(sandbox.files, candidatePath);
        assert.notEqual(candidatePath, sandbox.process.env.OPENCLAW_CONFIG_PATH);
        assert.equal(options.timeout, 30_000);
        assert.equal(options.maxBuffer, 1024 * 1024);
      },
    });
    assert.deepEqual(candidate, { approvals: { plugin: { slack: { approvers: [] } } } });
    // Reapplying the identical policy after install reuses its successful probe.
    assert.deepEqual(
      calls.map((call) => commandArgs(call)),
      [["/app/openclaw.mjs", "config", "validate", "--json"]],
    );
    const effective = readConfig(files);
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
  ] satisfies [string, SpawnResponse][]) {
    test(`Gateway rejects ${label} before replacing its effective configuration`, () => {
      const runtime: RuntimeInput = {
        manifest: { kind: "codex", selections: {}, pluginApprovers: [] },
      };
      const baseConfig = { channels: { slack: { enabled: true } } };
      const effectivePath = "/home/node/.openclaw/openclaw.json";
      const previousConfiguration = JSON.stringify({ gateway: { port: 9999 } });
      const result = runPluginInstall(runtime, [], {
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
    const runtime: RuntimeInput = {
      manifest: { kind: "codex", selections: {}, pluginApprovers: [] },
    };
    const baseConfig = { channels: { slack: { enabled: true } } };
    const effectivePath = "/home/node/.openclaw/openclaw.json";
    const previousConfiguration = JSON.stringify({ gateway: { port: 9999 } });
    const result = runPluginInstall(runtime, [], {
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
    const runtime = openClawRuntime(
      {
        approvers: [{ channel: "slack", id: pluginApprover }],
        tools: { diffs: { approvers: [] } },
      },
      [agentApprover, otherAgentApprover].map((id) => ({ channel: "slack", id })),
    );
    const configured = {
      approvers: [otherAgentApprover.toUpperCase(), agentApprover],
      plugins: {
        diffs: {
          tools: { other: { approvers: [pluginApprover] }, diffs: { approvers: [] } },
          approvers: [pluginApprover],
        },
      },
    };
    const { files } = runPluginInstall(runtime, installedPluginResponses(), {
      baseConfig: {
        channels: { slack: { enabled: true } },
        approvals: { plugin: { slack: configured } },
      },
    });
    const effective = readConfig(files);
    assert.deepEqual(field(effective, "approvals", "plugin", "slack"), {
      ...configured,
      approvers: [agentApprover, otherAgentApprover],
    });

    const conflicting = runPluginInstall(runtime, [], {
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
      conflicting.calls.map((call) => commandArgs(call).slice(1)),
      [["config", "validate", "--json"]],
    );

    const conflictingTool = runPluginInstall(runtime, [], {
      baseConfig: {
        channels: { slack: { enabled: true } },
        approvals: {
          plugin: {
            slack: {
              ...configured,
              plugins: {
                diffs: {
                  ...configured.plugins.diffs,
                  tools: {
                    ...configured.plugins.diffs.tools,
                    diffs: { approvers: [agentApprover] },
                  },
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
      conflictingTool.calls.map((call) => commandArgs(call).slice(1)),
      [["config", "validate", "--json"]],
    );
  });

  test("OpenClaw startup rejects native approvers that bypass an Agent ancestor", () => {
    const agentApprover = "team:T123:user:U123";
    const otherApprover = "team:T123:user:U456";
    const defaultRuntime = openClawRuntime({}, []);
    for (const [runtime, configured] of [
      [defaultRuntime, { plugins: { diffs: { approvers: [otherApprover] } } }],
      [
        openClawRuntime({ approvers: [{ channel: "slack", id: agentApprover }] }),
        { plugins: { diffs: { tools: { other: { approvers: [otherApprover] } } } } },
      ],
    ] as const) {
      const result = runPluginInstall(runtime, installedPluginResponses(), {
        baseConfig: {
          channels: { slack: { enabled: true } },
          approvals: { plugin: { slack: configured } },
        },
        captureError: true,
      });
      assert.match(result.error?.message ?? "", /conflicts with managed Agent approvers/);
      assert.deepEqual(
        result.calls.map((call) => commandArgs(call).slice(1)),
        [["config", "validate", "--json"]],
      );
    }
  });

  test("Codex bridge preserves an unrelated native tool approver for the same plugin", () => {
    const appId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
    const readTool = `${appId}/repos%2Fread`;
    const writeTool = `${appId}/repos%2Fwrite`;
    const approver = "team:T123:user:U123";
    const runtime: RuntimeInput = {
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
    const { files } = runPluginInstall(runtime, [], {
      baseConfig: {
        channels: { slack: { enabled: true } },
        approvals: {
          plugin: { slack: { plugins: { linear: { tools: { [writeTool]: { approvers: [] } } } } } },
        },
      },
    });
    const effective = readConfig(files);
    assert.deepEqual(
      field(effective, "approvals", "plugin", "slack", "plugins", "linear", "tools"),
      {
        [writeTool]: { approvers: [] },
        [readTool]: { approvers: [approver] },
      },
    );
  });
}
