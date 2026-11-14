import assert from "node:assert/strict";
import test from "node:test";
import { pluginRuntimeSpecForRevision } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { startupPhaseHelper } from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  PluginDesiredState,
} from "../../packages/contracts/src/index.ts";
import { validateConfigurationSettings } from "../../packages/occ/src/configuration-settings.ts";
import { pluginPolicyListRefusal } from "../helpers/refusal-text.mjs";
import {
  codexLinearPluginState,
  occSelection,
  openClawPluginState,
  parseJson,
  record,
  required,
  revision,
  runGeneratedProgram,
} from "./plugin-compute-fixtures.ts";
import { runRuntime, runRuntimeHelper } from "./plugin-compute-runtime-helper.ts";

export function registerStartupAdmission(): void {
  test("a failed startup phase line carries only a fixed upper-case cause code", () => {
    const lines: Record<string, unknown>[] = [];
    runGeneratedProgram(
      `${startupPhaseHelper("agent")}
  logStartupPhase("plugin-install", Date.now(), "failed", "PLUGIN_NOT_IN_CATALOG");
  logStartupPhase("plugin-install", Date.now(), "failed", "catalog lacks linear");
  logStartupPhase("plugin-install", Date.now(), "failed");
  logStartupPhase("native-spawn", Date.now(), "ok", "PLUGIN_NOT_IN_CATALOG");`,
      { Date, JSON, console: { error: (line: string) => lines.push(record(parseJson(line))) } },
    );
    assert.deepEqual(
      lines.map(({ phase, outcome, code }) => [phase, outcome, code]),
      [
        ["plugin-install", "failed", "PLUGIN_NOT_IN_CATALOG"],
        ["plugin-install", "failed", undefined],
        ["plugin-install", "failed", undefined],
        ["native-spawn", "ok", undefined],
      ],
    );
  });

  test("OpenClaw runtime helper rejects foreign OpenClaw plugin config before native install", () => {
    const state = openClawPluginState();
    const runtime = {
      manifest: required(
        pluginRuntimeSpecForRevision(
          revision({
            harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
            plugins: state,
          }),
        ),
      ),
    };
    const result = runRuntimeHelper(runtime, [], {
      captureError: true,
      baseConfig: {
        gateway: { port: 8080 },
        plugins: { entries: { diffs: { enabled: false, source: "foreign" } } },
      },
    });

    assert.match(
      required(result.error).message,
      /configuration conflicts with managed plugin selections/,
    );
    assert.deepEqual(result.calls, []);
    assert.equal(result.files.has("/home/node/.openclaw/openclaw.json"), false);
  });

  test("Agent save refuses the Configuration plugin settings the Gateway entrypoint refuses for a selected catalog plugin, apart from two documented rows", () => {
    // Finding 3091. The entrypoint writes each selected catalog plugin's entry and exits
    // at every start on a setting that turns an enabled one off or replaces that entry; the OpenClaw
    // Plugin Driver refuses the same settings at Agent save, provisioning and deploy admission. Each
    // case runs both; one that passes the entrypoint's check reaches the (failing) package install.
    const driver = new OCCPluginDriver();
    const enabled = occSelection();
    const disabled = { "occ-plugin:diffs": { enabled: false } };
    const origin = "https://agent.example.com";
    // The Gateway serves this origin only with trusted-proxy auth, which Kubernetes Compute always
    // renders; the entrypoint then writes the entry with the Diffs viewer's public-origin config.
    const publicOrigin = {
      port: 8080,
      publicOrigin: origin,
      auth: { mode: "trusted-proxy" },
      controlUi: { allowedOrigins: [origin] },
    };
    const viewer = { security: { allowRemoteViewer: true } };
    // The TypeError the entrypoint's trim of a number, object or null item throws.
    const unreadableItem = /id\.trim is not a function|reading 'trim'/;
    const cases: readonly [
      OpenClawConfigurationValue,
      PluginDesiredState,
      boolean | RegExp,
      (boolean | RegExp)?,
      OpenClawConfigurationDocument?,
    ][] = [
      [{ enabled: false }, enabled, true],
      [{ deny: [" DIFFS "] }, enabled, true],
      [{ allow: ["codex"] }, enabled, true],
      [{ entries: { diffs: { config: {} } } }, enabled, true],
      [{ entries: { diffs: { enabled: true, config: {} } } }, enabled, true],
      [{ entries: { diffs: { enabled: false } } }, enabled, true],
      [{ entries: { diffs: { enabled: true } } }, disabled, true],
      [{ entries: { diffs: null } }, enabled, true],
      // The entrypoint trims every allow and deny item before it checks any entry it writes, so an
      // item that is not text stops it, for a disabled selection too (finding 3099).
      [{ allow: ["diffs", 1] }, enabled, unreadableItem],
      [{ deny: [null] }, disabled, unreadableItem],
      [{ allow: ["diffs"], deny: [{ id: "slack" }] }, enabled, unreadableItem],
      // A list that is not an array is ignored, as the entrypoint ignores it.
      [{ allow: "codex", deny: 1 }, enabled, false],
      // An exact copy of the entry the entrypoint writes passes.
      [{ entries: { diffs: { enabled: true } } }, enabled, false],
      [{ entries: { diffs: { enabled: false } } }, disabled, false],
      [{ entries: { diffs: { enabled: false } } }, disabled, false, false, publicOrigin],
      // An origin the Control UI does not allow is not served, so the entry stays {enabled:true}.
      [
        { entries: { diffs: { enabled: true } } },
        enabled,
        false,
        false,
        { ...publicOrigin, controlUi: { allowedOrigins: [] } },
      ],
      [{ entries: { diffs: { enabled: true } } }, enabled, true, true, publicOrigin],
      // PostgreSQL's jsonb stores shorter keys first, so a deployed Gateway reads a public-origin
      // copy in this order, and the entrypoint's JSON comparison refuses it.
      [
        { entries: { diffs: { config: viewer, enabled: true } } },
        enabled,
        true,
        true,
        publicOrigin,
      ],
      // Documented divergence: only a copy kept in the order the entrypoint writes passes, which no
      // PostgreSQL-backed deployment delivers, so Agent save refuses every public-origin copy.
      [
        { entries: { diffs: { enabled: true, config: viewer } } },
        enabled,
        false,
        true,
        publicOrigin,
      ],
      // Documented divergence: with password auth (Docker Compute) the Gateway serves no public
      // origin and accepts {enabled:true}; Agent save cannot know the Compute, and Kubernetes
      // Compute renders trusted-proxy auth, where the same document does not start.
      [
        { entries: { diffs: { enabled: true } } },
        enabled,
        false,
        true,
        { ...publicOrigin, auth: { mode: "password" } },
      ],
      [{ enabled: true, allow: ["codex", " Diffs"], deny: ["slack"] }, enabled, false],
      [{ allow: [" "], entries: { slack: { enabled: true } } }, enabled, false],
      [{ enabled: false, deny: ["diffs"], allow: ["codex"] }, disabled, false],
    ];
    for (const [index, row] of cases.entries()) {
      const [settings, plugins, entrypointRefuses, saveRefuses = entrypointRefuses] = row;
      const configuration = { gateway: row[4] ?? { port: 8080 }, plugins: settings };
      const runtime = {
        manifest: required(
          pluginRuntimeSpecForRevision(
            revision({
              harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
              plugins: {
                driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
                plugins,
              },
            }),
          ),
        ),
      };
      const result = runRuntimeHelper(
        runtime,
        [{ status: null, signal: "SIGTERM", stdout: "", stderr: "" }],
        { captureError: true, baseConfig: configuration },
      );
      if (entrypointRefuses) {
        assert.match(
          result.error?.message ?? "",
          entrypointRefuses === true
            ? /conflicts with managed plugin selection/
            : entrypointRefuses,
          `${index}: entrypoint`,
        );
      } else {
        assert.match(result.error?.message ?? "", /OpenClaw plugin install failed/, `${index}`);
      }
      if (saveRefuses) {
        assert.throws(
          () => driver.validateAgentConfiguration(plugins, configuration),
          { name: "ConfigurationHarnessError" },
          `${index}: Agent save`,
        );
      } else {
        driver.validateAgentConfiguration(plugins, configuration);
      }
    }
  });

  test("every Configuration save refuses the non-text plugins.allow and deny items the Gateway entrypoint trims for any OpenClaw plugin runtime", async () => {
    // Finding 3101. The entrypoint trims every allow and deny item whenever an openclaw plugin
    // runtime writes plugins.entries, which it does for any such runtime, selection or not. Two
    // runtimes reach it with no catalog plugin, so the OpenClaw Plugin Driver's rule (above) never
    // ran: plugin approvers without a plugin, and the managed Google plugin alone on dedicated
    // OpenClaw, which installGatewayPlugins sets aside. OpenClaw's own config schema refuses the
    // same items on every Gateway, so every Configuration save refuses them.
    const unreadableItem = /id\.trim is not a function|reading 'trim'/;
    const google = { [managedGoogleInstall.id]: { enabled: false } };
    const approversOnly = (mode: "embedded" | "dedicated") =>
      pluginRuntimeSpecForRevision(
        revision({ harness: { id: "openclaw", version: "1.0.0", mode }, pluginApprovers: [] }),
      );
    const googleOnly = pluginRuntimeSpecForRevision(
      revision({
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        plugins: {
          driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
          plugins: google,
        },
      }),
    );
    const driver = new OCCPluginDriver();
    for (const [plugins, key] of [
      [{ deny: ["discord", 7] }, "deny"],
      [{ allow: [null] }, "allow"],
      [{ allow: ["slack"], deny: [{ id: "discord" }] }, "deny"],
    ] as const) {
      const configuration = { gateway: { port: 8080 }, plugins };
      for (const mode of ["embedded", "dedicated"] as const) {
        const result = runRuntimeHelper({ manifest: required(approversOnly(mode)) }, [], {
          captureError: true,
          baseConfig: configuration,
        });
        assert.match(result.error?.message ?? "", unreadableItem, `approvers ${mode}`);
      }
      // The plugin rule skips a plugin outside the native catalog.
      driver.validateAgentConfiguration(google, configuration);
      // The full Gateway entrypoint, as a dedicated Gateway that hosts a workspace node runs it.
      await assert.rejects(
        async () =>
          runRuntime({ manifest: required(googleOnly) }, [], {
            baseConfig: configuration,
            env: {
              OPENCLAW_MANAGED_PLUGIN_JSON: JSON.stringify({
                kind: "cli",
                id: managedGoogleInstall.id,
                packageName: managedGoogleInstall.packageName,
                slotId: "account",
              }),
              OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: required(googleOnly) }),
            },
            workspaceNodeBindingPath: true,
          }),
        unreadableItem,
        "Google",
      );
      assert.throws(() => validateConfigurationSettings(configuration), {
        name: "ConfigurationHarnessError",
        message: pluginPolicyListRefusal(key),
      });
    }
    // With text items the entrypoint passes its check and reaches the (failing) package install.
    const startable = { gateway: { port: 8080 }, plugins: { allow: [" "], deny: ["Discord"] } };
    validateConfigurationSettings(startable);
    const result = runRuntimeHelper({ manifest: required(approversOnly("embedded")) }, [], {
      captureError: true,
      baseConfig: startable,
    });
    assert.equal(result.error, undefined);
  });

  test("OpenClaw runtime helper keeps install signals generic", () => {
    const state = openClawPluginState();
    const runtime = {
      manifest: required(
        pluginRuntimeSpecForRevision(
          revision({
            harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
            plugins: state,
          }),
        ),
      ),
    };
    const result = runRuntimeHelper(
      runtime,
      [{ status: null, signal: "SIGTERM", stdout: "", stderr: "" }],
      {
        captureError: true,
        env: {
          OPENCLAW_PLUGIN_STATUS_PORT: "18791",
        },
      },
    );

    assert.match(required(result.error).message, /OpenClaw plugin install failed/);
    assert.equal(required(result.error).diagnostic, undefined);
  });

  test("compute rejects plugin selections that target the wrong native runtime", async () => {
    await assert.rejects(async () => {
      const state = openClawPluginState();
      pluginRuntimeSpecForRevision(revision({ plugins: state }));
    }, /require an OpenClaw Harness/);
  });

  test("compute fails closed when Codex plugin selections are malformed", () => {
    const plugins = codexLinearPluginState();
    // Simulate a null selection in the persisted revision before Compute validates it.
    Reflect.defineProperty(plugins.plugins, "codex-plugin:linear@openai-curated-remote", {
      value: null,
    });
    assert.throws(
      () => pluginRuntimeSpecForRevision(revision({ plugins })),
      /plugin selections are invalid/,
    );
  });
}
