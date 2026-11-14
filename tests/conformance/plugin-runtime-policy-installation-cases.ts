import assert from "node:assert/strict";

import test from "node:test";
import type { PluginDesiredSelection } from "../../packages/contracts/src/index.ts";

import {
  OCC_DIFFS_DIGEST,
  installedPluginResponses,
  openClawRuntime,
  runPluginInstall,
  parseJson,
  readConfig,
  field,
  record,
  stringList,
  configPath,
  type RuntimeCall,
  type RuntimeInput,
  commandArgs,
} from "./plugin-runtime-policy-fixture.ts";

export function registerInstallationAndNativeAdminCases() {
  test("OpenClaw runtime helper installs exact admitted package pins and verifies the install record", async () => {
    const runtime = openClawRuntime();
    const firstInstallConfig: { path?: string; config?: unknown } = {};
    const { calls, files } = runPluginInstall(runtime, installedPluginResponses(), {
      beforeSpawn(command, args, sandbox) {
        if (command === "node" && args[1] === "plugins" && args[2] === "install") {
          firstInstallConfig.path = configPath(sandbox.process.env.OPENCLAW_CONFIG_PATH);
          firstInstallConfig.config = readConfig(sandbox.files, firstInstallConfig.path);
        }
      },
    });

    assert.deepEqual(
      calls.map((call) => commandArgs(call)),
      [
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
      ],
    );
    assert.equal(firstInstallConfig.path, "/home/node/.openclaw/openclaw.json");
    assert.deepEqual(field(firstInstallConfig.config, "plugins", "entries"), {
      diffs: { enabled: true },
    });
    assert.deepEqual(field(firstInstallConfig.config, "tools", "alsoAllow"), [
      "existing-tool",
      "diffs",
    ]);

    const effective = readConfig(files);
    assert.equal(field(effective, "gateway", "port"), 8080);
    assert.deepEqual(field(effective, "plugins", "installs", "keep"), { source: "npm" });
    assert.deepEqual(field(effective, "plugins", "load", "paths"), ["existing"]);
    assert.deepEqual(field(effective, "plugins", "entries"), { diffs: { enabled: true } });
    assert.deepEqual(field(effective, "tools", "alsoAllow"), ["existing-tool", "diffs"]);
  });

  test("OpenClaw runtime helper opens Diffs viewer links only through the native admin origin", () => {
    const origin = "https://agent-0123456789abcdef.agents.example.test";
    const nativeAdminGateway = {
      port: 8080,
      publicOrigin: origin,
      auth: { mode: "trusted-proxy" },
      controlUi: { enabled: true, allowedOrigins: [origin] },
    };
    const effectiveEntries = (
      gateway: { port: number; publicOrigin?: string | undefined },
      selection?: Partial<PluginDesiredSelection>,
    ) => {
      const { files } = runPluginInstall(openClawRuntime(selection), installedPluginResponses(), {
        baseConfig: { gateway },
      });
      const effective = readConfig(files);
      assert.equal(field(effective, "gateway", "publicOrigin"), gateway.publicOrigin);
      return field(effective, "plugins", "entries");
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
    const result = runPluginInstall(
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

    assert.deepEqual(parseJson(JSON.stringify(result.value)), {
      successfulPluginIds: [],
      failures: [{ pluginId: "occ-plugin:diffs", code: "PLUGIN_INSTALL_FAILED" }],
    });
    const effective = readConfig(result.files);
    assert.equal(field(effective, "plugins", "entries", "diffs", "enabled"), false);
    const alsoAllow = effective.tools == null ? undefined : record(effective.tools).alsoAllow;
    assert.equal(alsoAllow == null ? false : stringList(alsoAllow).includes("diffs"), false);
  });

  test("OpenClaw runtime helper rejects foreign Diffs config beside the native admin origin", () => {
    const origin = "https://agent-0123456789abcdef.agents.example.test";
    const result = runPluginInstall(openClawRuntime(), [], {
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
}

export function registerInstallAndGrantCases() {
  for (const [name, tools] of [
    ["profile grants", { alsoAllow: ["existing-tool"] }],
    ["explicit allowlist", { allow: ["read"] }],
    ["operator plugin grant", { allow: ["diffs"] }],
  ]) {
    test(`OpenClaw runtime helper reports install warnings and preserves ${name}`, () => {
      const runtime = openClawRuntime();
      const result = runPluginInstall(
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

      assert.deepEqual(parseJson(JSON.stringify(result.value)), {
        successfulPluginIds: [],
        failures: [{ pluginId: "occ-plugin:diffs", code: "PLUGIN_INSTALL_FAILED" }],
      });
      assert.equal(result.calls.length, 1);
      const effective = readConfig(result.files);
      assert.deepEqual(field(effective, "plugins", "entries"), { diffs: { enabled: false } });
      // Remove only startup's generated grant; emptying an operator allowlist would widen access.
      assert.deepEqual(effective.tools, tools);
    });
  }

  test("OpenClaw runtime helper fails before readiness when raw Codex bridge config conflicts", () => {
    const runtime: RuntimeInput = {
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
        runPluginInstall(runtime, [], {
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
        runPluginInstall(runtime, [
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
        runPluginInstall(runtime, [
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
      const { files } = runPluginInstall(openClawRuntime(), installedPluginResponses(), {
        baseConfig: { tools },
      });
      const effective = readConfig(files);
      assert.deepEqual(effective.tools, expected);
    });
  }

  for (const [field, plugins] of [
    ["plugins.enabled", { enabled: false }],
    ["plugins.deny", { deny: ["diffs"] }],
    ["plugins.allow", { allow: ["memory-core"] }],
    ["plugins.deny", { deny: [" Diffs "] }],
  ] as const) {
    test(`OpenClaw startup rejects blocked selection before installation: ${JSON.stringify(plugins)}`, () => {
      const calls: RuntimeCall[] = [];
      assert.throws(
        () =>
          runPluginInstall(openClawRuntime(), installedPluginResponses(), {
            calls,
            baseConfig: { plugins },
          }),
        (error) => {
          const message = record(error).message;
          return (
            typeof message === "string" &&
            message.includes("OpenClaw plugin configuration conflicts") &&
            message.includes(field)
          );
        },
      );
      assert.equal(calls.length, 0);
    });
  }

  test("OpenClaw startup preserves restrictions for a disabled selection", () => {
    const plugins = { allow: ["memory-core"], deny: ["diffs"], enabled: false };
    const { files, calls } = runPluginInstall(
      openClawRuntime({ enabled: false }),
      installedPluginResponses(),
      {
        baseConfig: { plugins },
      },
    );
    const effective = readConfig(files);
    assert.deepEqual(effective.plugins, { ...plugins, entries: { diffs: { enabled: false } } });
    assert.ok(commandArgs(calls[0]).includes("--no-enable"));
  });

  test("OpenClaw startup rejects a blocked Codex bridge before readiness", () => {
    const runtime: RuntimeInput = {
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
    const calls: RuntimeCall[] = [];
    assert.throws(
      () =>
        runPluginInstall(runtime, [], {
          calls,
          baseConfig: { plugins: { deny: ["codex"] } },
        }),
      /OpenClaw plugin configuration conflicts.*codex.*plugins.deny/,
    );
    assert.equal(calls.length, 0);
  });

  // The file-transfer entry of OpenClaw's live `plugins.list` answer.
}
