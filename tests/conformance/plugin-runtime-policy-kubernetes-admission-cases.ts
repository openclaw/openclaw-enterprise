import assert from "node:assert/strict";

import test from "node:test";

import { requireWorkspaceNodePlugins } from "../../apps/controller/src/drivers/compute/kubernetes/configuration-rules.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import {
  requireConfiguration,
  type HarnessAuthSnapshot,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type RevisionHarnessDescriptor,
} from "../../packages/contracts/src/index.ts";
import { apiKeyAuth, options, routedOptions } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  launchGateway,
  nativeGatewaySpawns,
  record,
  type RuntimeCall,
  type RuntimeInput,
  type RuntimeKill,
  type SpawnResponse,
} from "./plugin-runtime-policy-fixture.ts";

export function registerKubernetesAdmissionCases() {
  test("deployment admission and the Gateway entrypoint agree on the workspace node's plugins", async () => {
    // The entrypoint exits at every start on a plugin shape a workspace node cannot use, so a
    // dedicated deployment that admitted one crash-looped after its predecessor stopped
    // (finding 1112). Admission applies its own copy of the rule; both must refuse the same shapes.
    const admits = (config: OpenClawConfigurationDocument) => {
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
    const entrypointStarts = async (config: OpenClawConfigurationDocument) => {
      const calls: RuntimeCall[] = [];
      const kills: RuntimeKill[] = [];
      try {
        await launchGateway(undefined, [], {
          baseConfig: config,
          workspaceNodeId: "enrolled-node",
          calls,
          kills,
        });
        return nativeGatewaySpawns(calls).length === 1 && kills.length === 0;
      } catch (error) {
        assert.match(
          String(record(error).message),
          /requires the file-transfer plugin|is not a function/,
        );
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
      // OpenClaw matches deny entries trimmed and lowercased (finding 3077).
      [{ plugins: { deny: [1, " File-Transfer"] } }, false],
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
      // OpenClaw turns off every plugin, file-transfer included (finding 3083).
      [{ plugins: { enabled: false } }, false],
      [{ plugins: { enabled: false, entries: { "file-transfer": { enabled: true } } } }, false],
      [{ plugins: { enabled: true } }, true],
      // The entrypoint adds file-transfer to a non-empty allowlist.
      [{ plugins: { allow: ["other"] } }, true],
    ] satisfies [OpenClawConfigurationDocument, boolean][]) {
      const label = JSON.stringify(config);
      assert.equal(await entrypointStarts(structuredClone(config)), starts, label);
      assert.equal(admits(config), starts, label);
    }
  });

  test("Kubernetes admission and the Dedicated Codex Gateway entrypoint agree on the codex plugin policy", async () => {
    // Finding 3096. Every Dedicated Codex Gateway gets a codex plugin runtime, even with no plugin
    // selected, whose overlay enables plugins.entries.codex; the entrypoint exits at every start on
    // a Configuration that turns it off, and admission accepted each such Configuration. Each row
    // runs the real entrypoint and the real Kubernetes Compute admission: Configuration save (the
    // model policy selects Codex), Agent save (null bindings) and deployment, with and without a
    // workspace node. Each admission and native spawn must match the intended policy; agreement
    // alone could hide matching permissive regressions. This observes the generated launcher;
    // native image tests separately verify the built runtime's enforcement behavior.
    const manifest: RuntimeInput["manifest"] = { kind: "codex", selections: {} };
    const codexSelected = {
      agents: {
        defaults: {
          model: "codex/gpt-5",
          models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
        },
      },
    };
    const harness: RevisionHarnessDescriptor = { id: "codex", version: "1.0.0", mode: "dedicated" };
    const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
    const topologies = [
      [
        "without workspace node",
        new KubernetesComputeDriver(requireConfiguration(KubernetesComputeDriver, options())),
        undefined,
      ],
      [
        "with workspace node",
        new KubernetesComputeDriver(
          requireConfiguration(KubernetesComputeDriver, routedOptions({ runtime })),
          {
            nodeEnrollment: createGatewayNodeEnrollment(async () =>
              assert.fail("plugin admission does not contact the Gateway"),
            ),
          },
        ),
        "enrolled-node",
      ],
    ] as const;
    const auth: HarnessAuthSnapshot = {
      method: "api_key",
      source: { ...apiKeyAuth.source, kind: "secret" },
      secretDriverId: apiKeyAuth.secretDriverId,
    };
    const entrypointStarts = async (
      plugins: OpenClawConfigurationValue,
      workspaceNodeId: string | undefined,
      observations: {
        calls?: RuntimeCall[];
        kills?: RuntimeKill[];
        configValidationResponse?: SpawnResponse;
      } = {},
    ) => {
      const { calls = [], kills = [], configValidationResponse } = observations;
      try {
        await launchGateway({ manifest }, [], {
          env: {
            APP_SERVER_URL: "ws://harness.example.test:18790",
            OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest }),
          },
          baseConfig: { gateway: { port: 8080 }, plugins: structuredClone(plugins) },
          workspaceNodeId,
          calls,
          kills,
          configValidationResponse,
        });
        return nativeGatewaySpawns(calls).length === 1 && kills.length === 0;
      } catch (error) {
        assert.match(
          String(record(error).message),
          /conflicts with managed plugin selection codex|is not a function|reading 'trim'|requires the file-transfer plugin/,
        );
        return false;
      }
    };
    const admits = (admit: () => void) => {
      try {
        admit();
        return true;
      } catch (error) {
        const { name, message } = record(error);
        assert.equal(name, "ConfigurationHarnessError", String(message));
        return false;
      }
    };
    for (const [topology, , workspaceNodeId] of topologies) {
      const calls: RuntimeCall[] = [];
      const kills: RuntimeKill[] = [];
      const validStarts = await entrypointStarts({ allow: ["codex"] }, workspaceNodeId, {
        calls,
        kills,
      });
      assert.equal(nativeGatewaySpawns(calls).length, 1, `${topology}: valid native spawn`);
      assert.deepEqual(kills, [], `${topology}: valid launcher must not exit`);
      assert.equal(validStarts, true, `${topology}: valid Gateway starts`);

      calls.length = 0;
      const refusedStarts = await entrypointStarts({ allow: ["codex"] }, workspaceNodeId, {
        calls,
        kills,
        configValidationResponse: {
          status: 1,
          stdout: JSON.stringify({ valid: false }),
          stderr: "unsupported gatewayPolicy",
        },
      });
      assert.equal(nativeGatewaySpawns(calls).length, 0, `${topology}: native schema refusal`);
      assert.deepEqual(kills, [], `${topology}: schema refusal holds the wrapper`);
      assert.equal(refusedStarts, false, `${topology}: no native Gateway spawn during schema hold`);
    }
    const rows = [
      [{}, true],
      [{ allow: ["codex"] }, true],
      [{ allow: [" CODEX ", "slack"], deny: ["slack", "codex-extra"], enabled: true }, true],
      // Blank items are ignored, so this allowlist is empty.
      [{ allow: [" ", ""] }, true],
      // The overlay turns the codex entry back on.
      [{ allow: ["codex"], entries: { codex: { enabled: false } } }, true],
      // The entrypoint does not read an allowlist that is not an array.
      [{ allow: "slack" }, true],
      [{ enabled: false }, false],
      [{ enabled: false, entries: { codex: { enabled: true } } }, false],
      [{ deny: [" Codex "] }, false],
      [{ allow: ["slack"] }, false],
      [{ allow: ["codex", 1] }, false],
      [{ deny: [null] }, false],
      // Only a workspace node needs file-transfer.
      [{ deny: ["file-transfer"] }, true, false],
    ] satisfies [OpenClawConfigurationValue, boolean, boolean?][];
    for (const [plugins, withoutWorkspaceNode, withWorkspaceNode = withoutWorkspaceNode] of rows) {
      const configuration = { ...codexSelected, plugins };
      for (const [topology, driver, workspaceNodeId] of topologies) {
        const starts = await entrypointStarts(plugins, workspaceNodeId);
        const expected = workspaceNodeId === undefined ? withoutWorkspaceNode : withWorkspaceNode;
        const label = `${topology} ${JSON.stringify(plugins)}`;
        assert.equal(starts, expected, `${label}: native Gateway start`);
        const admissions = {
          "Agent save": () => driver.validateHarnessAuth(harness, auth, configuration, null),
          deployment: () => driver.validateHarnessAuth(harness, auth, configuration, {}),
        };
        for (const [stage, admit] of Object.entries(admissions)) {
          assert.equal(admits(admit), expected, `${label}: ${stage}`);
        }
        // Configuration save does not know the workspace node.
        const saved = admits(() => driver.validateConfiguration(configuration));
        assert.equal(saved, withoutWorkspaceNode, `${label}: Configuration save`);
      }
    }
  });
}
