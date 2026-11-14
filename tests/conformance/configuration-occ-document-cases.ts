import assert from "node:assert/strict";
import test from "node:test";
import { administrator, fixture } from "./configuration-occ-fixture.ts";
import type {
  HarnessExecutionMode,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { ScopeViolationError } from "../../packages/occ/src/index.ts";
import { servedAs } from "../helpers/agent-identity.mjs";
import {
  OPENCLAW_SANDBOX_SETTINGS,
  admittedConfiguration,
  openClawSandboxRefusal,
  withSetting as buildSetting,
} from "../helpers/admitted-configuration.mjs";
import { configIncludeRefusal, pluginEntryKeyVariantRefusal } from "../helpers/refusal-text.mjs";

const withSetting: (
  values: OpenClawConfigurationDocument,
  path: [string, ...string[]],
  value: OpenClawConfigurationValue,
) => OpenClawConfigurationDocument = buildSetting;

function isConfigurationObject(
  value: OpenClawConfigurationValue | undefined,
): value is OpenClawConfigurationDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settingAt(
  values: OpenClawConfigurationDocument,
  ...path: string[]
): OpenClawConfigurationValue | undefined {
  let current: OpenClawConfigurationValue | undefined = values;
  for (const key of path) {
    assert.ok(isConfigurationObject(current), `Expected an object on ${path.join(".")}`);
    current = current[key];
  }
  return current;
}

export function registerConfigurationDocumentCases(): void {
  test("native Configuration documents remain bound to their exact Namespace", async () => {
    const { controller, namespace } = await fixture();
    const otherNamespace = await controller.createNamespace(administrator, {
      name: "Foreign native-configuration tenant",
    });
    const foreign = await controller.createConfiguration(administrator, {
      namespaceId: otherNamespace.id,
      kind: "agent",
      values: {
        models: {
          providers: {
            openai: { apiKey: { source: "store", provider: "default", id: "FOREIGN_API_KEY" } },
          },
        },
      },
    });

    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, foreign.id),
      ScopeViolationError,
    );
    await assert.rejects(
      controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name: "Cross-namespace configuration agent",
        configurationId: foreign.id,
      }),
      ScopeViolationError,
    );
  });

  test("Agent deployment snapshots its selected Configuration and Compute identity", async () => {
    const { agent, compute, configuration, controller, namespace } = await fixture();

    const revision = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );

    assert.equal(revision.configurationId, configuration.id);
    assert.equal(revision.configurationKind, "agent");
    assert.equal(revision.configurationGeneration, configuration.generation);
    assert.deepEqual(
      revision.configuration,
      admittedConfiguration(servedAs(configuration.values, agent.name), "info"),
    );
    const apiKey = settingAt(configuration.values, "models", "providers", "openai", "apiKey");
    assert.ok(isConfigurationObject(apiKey));
    assert.equal(Object.isFrozen(apiKey), true);
    const regions = settingAt(revision.configuration, "plugins", "entries", "example", "regions");
    assert.ok(Array.isArray(regions));
    assert.equal(Object.isFrozen(regions), true);
    assert.equal(agent.executionMode, "embedded");
    assert.deepEqual(revision.harness, {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    });
    assert.deepEqual(revision.compute, { id: compute.id, implementation: compute.implementation });
  });

  test("Agent deployment keeps the display name its Configuration sets", async () => {
    const { agent, configuration, controller, namespace } = await fixture();
    // The Configuration owner chose this name for the Control UI; the OCC Agent name must not
    // replace it, and the entry's other identity settings stay as written.
    const agents = configuration.values.agents;
    assert.ok(isConfigurationObject(agents));
    const values = {
      ...configuration.values,
      agents: {
        ...agents,
        // A roster entry selects its own model when agents.defaults.model is unset.
        entries: {
          main: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
            identity: { name: "Configured name", emoji: "🦞" },
          },
        },
      },
    };
    await controller.updateConfiguration(administrator, {
      namespaceId: namespace.id,
      configurationId: configuration.id,
      values,
    });

    const revision = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );

    assert.notEqual(agent.name, "Configured name");
    assert.deepEqual(revision.configuration, admittedConfiguration(values, "info"));
  });

  // Every Compute Driver renders the defaults OCE admits. Embedded and dedicated Gateways
  // keep explicit choices about steering, workspace access, direct-message sessions, and command
  // approvals.
  test("deployment admission keeps apply_patch in the workspace, the sandbox off, exec runnable, DMs per sender and steering to the Configuration", async () => {
    const { agent, configuration, controller, namespace, saveConfiguration } = await fixture();
    const codexValues = {
      agents: {
        defaults: {
          model: { primary: "codex/gpt-4.1" },
          models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
        },
      },
    };
    const deploy = async (
      values: OpenClawConfigurationDocument,
      executionMode: HarnessExecutionMode,
    ) => {
      const selected = await saveConfiguration(values);
      await controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: selected.id,
        executionMode,
      });
      return controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );
    };
    const cases = {
      // Admission fills each default, keeps the settings beside them (the base's sandbox scope, an
      // empty applyPatch, the queue mode), and adds no steering value.
      unset: { messages: { queue: { mode: "collect" } }, tools: { exec: { applyPatch: {} } } },
      // An explicit strictInlineEval `true` is kept beside the filled mode: inline programs then wait
      // for an approval, as that Configuration asks.
      "an explicit inline-program rule": {
        tools: { exec: { strictInlineEval: true } },
      },
      // Explicit values reach the Gateway as written; inline programs need no approval in an
      // explicit mode "full" either. An explicit dmScope is kept.
      "explicit looser values": {
        messages: { queue: { allowCollaborativeSteering: true } },
        session: { dmScope: "main" },
        tools: { exec: { mode: "full", applyPatch: { enabled: true, workspaceOnly: false } } },
      },
      // An explicit steering restriction is kept, and so is an exec
      // mode "ask" for an operator who connects an approval channel; beside it admission fills no
      // strictInlineEval.
      "explicit stricter values": {
        messages: { queue: { allowCollaborativeSteering: false } },
        tools: { exec: { mode: "ask", applyPatch: { enabled: true, workspaceOnly: true } } },
      },
      // A legacy exec security or ask value is an explicit policy too: admission
      // fills no mode beside it, since the Gateway would apply a mode over it, and no
      // strictInlineEval.
      "a legacy exec security": { tools: { exec: { security: "allowlist" } } },
      "a legacy exec ask": { tools: { exec: { ask: "always" } } },
    };
    for (const [executionMode, base] of [
      ["embedded", configuration.values],
      ["dedicated", codexValues],
    ] as const) {
      for (const [name, settings] of Object.entries(cases)) {
        const values = { ...base, ...settings };
        const revision = await deploy(values, executionMode);
        assert.equal(revision.harness.mode, executionMode, name);
        assert.deepEqual(
          revision.configuration,
          admittedConfiguration(servedAs(values, agent.name), "info"),
          `${executionMode}: ${name}`,
        );
      }
    }
    // An owner can keep inline approvals for one Agent while other entries inherit the default.
    const entryExec = { mode: "allowlist", strictInlineEval: true };
    const revision = await deploy(
      {
        agents: {
          ...codexValues.agents,
          entries: { main: { tools: { exec: entryExec } } },
        },
      },
      "dedicated",
    );
    assert.equal(settingAt(revision.configuration, "tools", "exec", "strictInlineEval"), false);
    assert.deepEqual(
      settingAt(revision.configuration, "agents", "entries", "main", "tools", "exec"),
      entryExec,
    );

    // With a channel enabled, each direct-message sender gets a session per account, channel and
    // sender, so external senders never share the main conversation browser chat opens (finding
    // 3191). Without one, admission adds no session settings, so OpenClaw keeps recall across the
    // Agent's conversations.
    const slack = { enabled: true, allowBots: false };
    for (const [name, settings, dmScope] of [
      ["no channel", {}, undefined],
      ["a disabled channel", { channels: { slack: { ...slack, enabled: false } } }, undefined],
      ["a Slack channel", { channels: { slack } }, "per-account-channel-peer"],
      [
        "named Slack accounts",
        { channels: { slack: { enabled: true, accounts: { work: { allowBots: false } } } } },
        "per-account-channel-peer",
      ],
      [
        "an explicit main with a channel",
        { channels: { slack }, session: { dmScope: "main" } },
        "main",
      ],
    ] satisfies Array<[string, OpenClawConfigurationDocument, string | undefined]>) {
      const values = { ...codexValues, ...settings };
      const channelRevision = await deploy(values, "dedicated");
      const session = channelRevision.configuration.session;
      assert.ok(session === undefined || isConfigurationObject(session), name);
      assert.equal(session?.dmScope, dmScope, name);
      if (dmScope === undefined) {
        assert.equal(channelRevision.configuration.session, undefined, name);
      }
      assert.deepEqual(
        channelRevision.configuration,
        admittedConfiguration(servedAs(values, agent.name), "info"),
        name,
      );
    }

    // Admission fills only unset settings. A value of the wrong type, or a
    // non-object on the path, stays for the Gateway's own validation, which refuses it at startup,
    // so it cannot loosen the setting.
    for (const tools of [{ exec: { mode: 1, applyPatch: { workspaceOnly: "no" } } }, ["read"]]) {
      const invalid = await deploy({ ...codexValues, tools }, "dedicated");
      assert.deepEqual(invalid.configuration.tools, tools);
      assert.equal(invalid.configuration.messages, undefined);
    }
  });

  // The rule's refused and accepted values, for every Agent and for one Agent's entry, which
  // overrides it (findings 2767, 2773). configuration-controller.test.mjs proves that each save
  // path, Agent save and deployment run it.
  test("Configuration save refuses OpenClaw's sandbox and keeps the values the OCE runtime runs", async () => {
    const { saveConfiguration } = await fixture();
    for (const setting of OPENCLAW_SANDBOX_SETTINGS) {
      const [first, ...rest] = setting.path;
      assert.ok(first);
      const defaultsPath: [string, ...string[]] = [first, ...rest];
      const entry: [string, ...string[]] = ["agents", "entries", "main", ...setting.entry];
      const [accepted] = setting.accepted;
      assert.ok(accepted !== undefined);
      for (const value of setting.refused) {
        for (const [path, values] of [
          [setting.path, withSetting({}, defaultsPath, value)],
          // An accepted value for every Agent does not admit an Agent's entry that turns it on.
          [entry, withSetting(withSetting({}, defaultsPath, accepted), entry, value)],
        ] as const) {
          await assert.rejects(saveConfiguration(values), {
            name: "ConfigurationHarnessError",
            message: openClawSandboxRefusal(setting, path),
          });
        }
      }
      for (const value of setting.accepted) {
        const values = withSetting(withSetting({}, defaultsPath, value), entry, value);
        assert.deepEqual((await saveConfiguration(values)).values, values, JSON.stringify(values));
      }
    }
    const values = { agents: { defaults: { sandbox: { mode: "off", scope: "session" } } } };
    assert.deepEqual((await saveConfiguration(values)).values, values);
  });

  // The pinned OpenClaw merges plugins.entries keys that match trimmed and lowercased, and the last
  // entry with a `config` replaces the plugin's whole config. OCE checks and renders codex and acpx
  // settings only at their exact key, so another spelling of either is refused (finding 3073).
  // configuration-controller.test.mjs proves that each save path, Agent save and deployment run it.
  test("Configuration save refuses another spelling of the codex or acpx plugin entry key", async () => {
    const { saveConfiguration } = await fixture();
    const codex = { config: { appServer: { approvalPolicy: "on-request" } } };
    for (const [entries, path, id] of [
      // A later entry would replace the codex config OCE checked at the exact key.
      [
        { codex, Codex: { config: { appServer: { approvalPolicy: "never" } } } },
        "plugins.entries.Codex",
        "codex",
      ],
      // Alone, too: a later exact entry could still be added beside it.
      [{ " codex": codex }, 'plugins.entries[" codex"]', "codex"],
      [{ CODEX: { enabled: true } }, "plugins.entries.CODEX", "codex"],
      [
        { acpx: { config: {} }, ACPX: { config: { mcpServers: {} } } },
        "plugins.entries.ACPX",
        "acpx",
      ],
    ] satisfies Array<[OpenClawConfigurationDocument, string, string]>) {
      await assert.rejects(saveConfiguration({ plugins: { entries } }), {
        name: "ConfigurationHarnessError",
        message: pluginEntryKeyVariantRefusal(path, id),
      });
    }
    // The exact keys, and other spellings of plugins OCE reads no settings for (finding 3072), save.
    for (const entries of [
      { codex, acpx: { config: {} } },
      { Google: { config: { webSearch: {} } }, " slack": { enabled: false }, codexx: {} },
    ]) {
      const values = { plugins: { entries } };
      assert.deepEqual((await saveConfiguration(values)).values, values, JSON.stringify(values));
    }
  });

  // The pinned OpenClaw replaces an object holding $include with the named files' settings, merged
  // under its other keys with arrays concatenated, and re-reads them when they change. Configuration
  // rules and Compute read the document as written, so $include is refused at any depth (finding
  // 3078). configuration-controller.test.mjs proves that each save path, Agent save and deployment
  // run it.
  test("Configuration save refuses OpenClaw's $include directive anywhere in the document", async () => {
    const { saveConfiguration } = await fixture();
    for (const [values, path] of [
      // At the root, where its settings would sit under every rendered one.
      [{ $include: "./extra.json", tools: { elevated: { enabled: false } } }, "$include"],
      // Inside an object a Compute rule reads, where it would add a setting that rule refuses.
      [{ gateway: { auth: { $include: ["./a.json", "./b.json"] } } }, "gateway.auth.$include"],
      // Under a submitted key and inside a list.
      [
        { plugins: { entries: { "my plugin": { config: { $include: "./p.json" } } } } },
        'plugins.entries["my plugin"].config.$include',
      ],
      [
        { agents: { list: [{ id: "main" }, { $include: "./agent.json" }] } },
        "agents.list[1].$include",
      ],
    ] satisfies Array<[OpenClawConfigurationDocument, string]>) {
      await assert.rejects(saveConfiguration(values), {
        name: "ConfigurationHarnessError",
        message: configIncludeRefusal(path),
      });
    }
    // The text $include as a value, or in a longer key, is not the directive and saves.
    const values = {
      agents: { defaults: { skipBootstrap: true } },
      plugins: { entries: { notes: { config: { note: "$include", $includes: [] } } } },
    };
    assert.deepEqual((await saveConfiguration(values)).values, values);
  });
}
