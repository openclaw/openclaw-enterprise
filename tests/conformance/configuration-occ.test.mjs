import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVELOPMENT_HARNESS_DESCRIPTOR,
  resolveApprovedHarness as resolveApprovedDevelopmentHarness,
  resolveApprovedProductionHarness,
} from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  InMemoryPlatformState,
  NamespaceNotEmptyError,
  NativeWorkerSupportError,
  OpenClawController,
  PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS,
  ScopeViolationError,
  resolveConfiguredHarnessId,
} from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const administrator = "principal-configuration-administrator";
const deployOnly = "principal-configuration-deploy-only";
const installation = Object.freeze({
  id: "installation-configuration-occ",
  name: "Configuration OCC conformance",
  createdAt: "2026-08-19T00:00:00.000Z",
});
async function fixture(options = {}) {
  const permissions = [
    { action: "create", resourceKind: "secret" },
    { action: "operate", resourceKind: "secret" },
    { action: "create", resourceKind: "namespace" },
    { action: "read", resourceKind: "namespace" },
    { action: "delete", resourceKind: "namespace" },
    { action: "create", resourceKind: "configuration" },
    { action: "read", resourceKind: "configuration" },
    { action: "update", resourceKind: "configuration" },
    { action: "delete", resourceKind: "configuration" },
    { action: "create", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
    { action: "update", resourceKind: "agent" },
    { action: "deploy", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
    { action: "read", resourceKind: "installation" },
  ];
  const iamState = {
    identities: [administrator, deployOnly].map((id) => ({
      kind: "principal",
      id,
      issuer: "configuration-conformance",
      subject: id,
    })),
    groups: [],
    memberships: [],
    roles: [
      { id: "configuration-administrator-role", permissions },
      {
        id: "configuration-deploy-only-role",
        permissions: [
          { action: "deploy", resourceKind: "agent" },
          { action: "operate", resourceKind: "secret" },
        ],
      },
    ],
    bindings: [
      {
        id: "configuration-administrator-binding",
        subjectKind: "identity",
        subjectId: administrator,
        roleId: "configuration-administrator-role",
      },
      {
        id: "configuration-deploy-only-binding",
        subjectKind: "identity",
        subjectId: deployOnly,
        roleId: "configuration-deploy-only-role",
      },
    ],
    restrictions: [],
  };
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "configuration-occ-iam" },
  );
  const compute = {
    ...createDevelopmentComputeDriver(),
    id: "configuration-occ-compute",
    implementation: "configuration-conformance-compute",
  };
  const configurationDriver = createTestConfigurationDriver();
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, { state, ...options });
  const secretDriver = createTestSecretDriver();
  for (const driver of [iam, compute, configurationDriver, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const namespace = await controller.createNamespace(administrator, {
    name: "Configuration conformance tenant",
  });
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "store", provider: "teamstore", id: "OPENAI_API_KEY" },
          },
        },
      },
      secrets: {
        providers: { teamstore: { source: "store" } },
        defaults: { store: "teamstore" },
      },
      agents: { defaults: { sandbox: { mode: "all" } } },
      plugins: { entries: { example: { enabled: true, regions: ["west"], retryCount: 2 } } },
    },
  });
  let agent = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Configuration conformance agent",
    configurationId: configuration.id,
  });
  await controller.transact((transaction) =>
    transaction.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );

  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "harness-key",
    value: "synthetic-harness-key",
  });
  async function bindHarnessAuth(target) {
    iamState.identities.push({
      kind: "service_principal",
      id: target.servicePrincipalId,
      namespaceId: target.namespaceId,
      agentId: target.id,
    });
    iamState.roles.push({
      id: `harness-role-${target.id}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    iamState.bindings.push({
      id: `harness-binding-${target.id}`,
      subjectKind: "identity",
      subjectId: target.servicePrincipalId,
      roleId: `harness-role-${target.id}`,
      namespaceId: namespace.id,
      resourceKind: "secret",
      resourceId: secret.id,
    });
    return controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: target.id,
      configurationId: target.configurationId,
      harnessAuth: { method: "api_key", source: secret.ref },
    });
  }
  agent = await bindHarnessAuth(agent);
  return {
    agent,
    bindHarnessAuth,
    compute,
    configuration,
    configurationDriver,
    controller,
    iam,
    namespace,
    state,
  };
}

test("concurrent Configuration updates serialize into distinct server-managed generations", async () => {
  const { configuration, controller, namespace } = await fixture();

  // The real in-memory unit of work serializes competing writers instead of losing a generation.
  const updated = await Promise.all(
    ["first", "second"].map((model) =>
      controller.updateConfiguration(administrator, {
        namespaceId: namespace.id,
        configurationId: configuration.id,
        values: { model },
      }),
    ),
  );

  assert.deepEqual(
    updated.map((value) => value.generation),
    [2, 3],
  );
  const latest = await controller.getConfiguration(administrator, namespace.id, configuration.id);
  assert.equal(latest.generation, 3);
  assert.deepEqual(latest.values, { model: "second" });
});

test("Configuration metadata and selected substrate generation divergence fails closed", async () => {
  const { agent, configuration, configurationDriver, controller, namespace } = await fixture();

  // Simulate a real persisted-metadata/substrate mismatch without replacing OCC or Driver behavior.
  await controller.transact((state) =>
    state.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
  );

  await assert.rejects(
    controller.getConfiguration(administrator, namespace.id, configuration.id),
    DependencyUnavailableError,
  );
  await assert.rejects(
    controller.updateConfiguration(administrator, {
      namespaceId: namespace.id,
      configurationId: configuration.id,
      values: { model: "must-not-overwrite-divergence" },
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  assert.deepEqual(
    await configurationDriver.read({ id: configuration.id, namespaceId: namespace.id }),
    configuration,
  );
});

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
  assert.deepEqual(revision.configuration, admitLoggingConfiguration(configuration.values, "info"));
  assert.equal(Object.isFrozen(configuration.values.models.providers.openai.apiKey), true);
  assert.equal(Object.isFrozen(revision.configuration.plugins.entries.example.regions), true);
  assert.equal(agent.executionMode, "embedded");
  assert.deepEqual(revision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
  assert.deepEqual(revision.compute, { id: compute.id, implementation: compute.implementation });
});

test("native selected-model policy explicitly chooses Codex or OpenClaw", () => {
  for (const [model, runtime] of [
    ["codex/gpt-4.1", "codex"],
    ["openai/gpt-4.1", "openclaw"],
  ]) {
    assert.equal(
      resolveConfiguredHarnessId({
        agents: { defaults: { model, models: { [model]: { agentRuntime: { id: runtime } } } } },
      }),
      runtime,
    );
  }
  assert.equal(
    resolveConfiguredHarnessId({
      agents: { defaults: { model: "openai/gpt-4.1" } },
      models: {
        providers: {
          openai: {
            agentRuntime: { id: "openclaw" },
            baseUrl: "https://provider.example.test/v1",
          },
        },
      },
    }),
    "openclaw",
  );
  assert.equal(
    resolveConfiguredHarnessId({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-4.1", fallbacks: [] },
          models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
        },
        list: [],
      },
    }),
    "codex",
  );
  assert.equal(
    resolveConfiguredHarnessId({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          models: {
            "openai/gpt-4.1": { agentRuntime: { id: "codex" } },
            "openai/gpt-4.1-mini": { agentRuntime: { id: "codex" } },
            "openai/gpt-4o": { agentRuntime: { id: "codex" } },
          },
        },
        entries: { main: { default: true } },
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { transport: "websocket" } },
          },
        },
      },
    }),
    "codex",
  );
  assert.equal(
    resolveConfiguredHarnessId({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
        },
        entries: {
          primary: {
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      models: {
        providers: {
          openai: {
            agentRuntime: { id: "openclaw" },
            models: [{ id: "gpt-4.1", agentRuntime: { id: "openclaw" } }],
          },
        },
      },
    }),
    "openclaw",
  );
  assert.equal(
    resolveConfiguredHarnessId({
      agents: {
        defaults: { models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } } },
        entries: { primary: { model: "codex/gpt-4.1" } },
      },
    }),
    "codex",
  );
  // A model ID may itself contain slashes. The provider ends at the first slash, so the
  // catalog entry `vendor/model` must match `openai/vendor/model` and keep its authored name.
  assert.equal(
    resolveConfiguredHarnessId({
      agents: {
        defaults: {
          model: "openai/vendor/model",
          models: { "openai/vendor/model": { agentRuntime: { id: "openclaw" } } },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://gateway.example.test/v1",
            api: "openai-responses",
            models: [{ id: "vendor/model", name: "Team Fast", agentRuntime: { id: "openclaw" } }],
          },
        },
      },
    }),
    "openclaw",
  );
});

test("an unambiguous built-in model defaults to embedded OpenClaw", () => {
  assert.equal(resolveConfiguredHarnessId({}), "openclaw");
  assert.equal(
    resolveConfiguredHarnessId({ agents: { defaults: { model: "anthropic/claude" } } }),
    "openclaw",
  );
});

test("ambiguous and plugin-routed models require supported explicit native policy", () => {
  for (const configuration of [
    { agents: { defaults: { model: "openai/gpt-4.1" } } },
    { agents: { defaults: { model: "codex/gpt-4.1" } } },
    {
      agents: { defaults: { model: "openai/gpt-4.1", agentRuntime: { id: "openclaw" } } },
    },
    {
      agents: { defaults: { model: "anthropic/claude" } },
      models: { providers: { anthropic: { baseUrl: "https://provider.example.test/v1" } } },
    },
    {
      agents: { defaults: { model: "custom/plugin-model" } },
      plugins: { entries: { custom: { enabled: true } } },
    },
    {
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          models: { "openai/gpt-4.1": { agentRuntime: { id: "unsupported" } } },
        },
      },
    },
  ]) {
    assert.throws(() => resolveConfiguredHarnessId(configuration), ScopeViolationError);
  }
});

test("one installation admits embedded and dedicated revisions without rewriting historical placement", async () => {
  const { agent, bindHarnessAuth, configuration, controller, namespace } = await fixture();
  const embedded = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  const codexConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {
      agents: {
        defaults: {
          model: { primary: "codex/gpt-4.1" },
          models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
        },
      },
    },
  });
  const dedicatedAgent = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Dedicated configuration conformance agent",
    configurationId: codexConfiguration.id,
    executionMode: "dedicated",
  });
  await bindHarnessAuth(dedicatedAgent);
  const dedicatedNeighbor = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: dedicatedAgent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.deepEqual(dedicatedNeighbor.harness, {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  });
  const updated = await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: codexConfiguration.id,
    executionMode: "dedicated",
  });
  assert.equal(updated.executionMode, "dedicated");

  const dedicated = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.deepEqual(embedded.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
  assert.deepEqual(dedicated.harness, { id: "codex", version: "1.0.0", mode: "dedicated" });
  assert.equal(embedded.configurationId, configuration.id);
  assert.equal(dedicated.configurationId, codexConfiguration.id);

  // Omitting placement during a later edit cannot silently reset the explicit dedicated choice.
  const preserved = await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: codexConfiguration.id,
  });
  assert.equal(preserved.executionMode, "dedicated");
  assert.equal(embedded.harness.mode, "embedded");
});

for (const scope of ["primary", "default-fallback", "entry-fallback", "provider-policy-fallback"]) {
  test(`actual OCC admission accepts a same-Harness OpenAI Codex ${scope} selection`, async () => {
    const { bindHarnessAuth, controller, namespace } = await fixture();
    const selection = {
      primary: "openai/gpt-4.1",
      fallbacks: ["openai/gpt-4.1-mini", "openai/gpt-4.1-nano"],
    };
    const values = {
      agents: {
        defaults: {
          model:
            scope === "default-fallback" || scope === "provider-policy-fallback"
              ? selection
              : selection.primary,
          models: {
            "openai/gpt-4.1": { agentRuntime: { id: "codex" } },
            "openai/gpt-4.1-mini": { agentRuntime: { id: "codex" } },
            "openai/gpt-4.1-nano": { agentRuntime: { id: "codex" } },
          },
        },
        entries: {
          main: {
            default: true,
            ...(scope === "entry-fallback" ? { model: selection } : {}),
          },
        },
      },
      channels: { slack: { enabled: true, allowBots: false } },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { transport: "websocket" } },
          },
        },
      },
    };
    if (scope === "provider-policy-fallback") {
      // Native provider catalogs may describe every selected fallback. Resolve
      // their policies without relying on duplicate Agent-default policies.
      delete values.agents.defaults.models;
      values.models = {
        providers: {
          openai: {
            models: [selection.primary, ...selection.fallbacks].map((model) => ({
              id: model.slice("openai/".length),
              agentRuntime: { id: "codex" },
            })),
          },
        },
      };
    }
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values,
    });
    const dedicated = await controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: "OpenAI Codex Runtime",
      configurationId: configuration.id,
      executionMode: "dedicated",
    });

    await bindHarnessAuth(dedicated);
    const admitted = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: dedicated.id },
      resolveApprovedProductionHarness,
    );

    assert.deepEqual(configuration.values, values);
    // Admission freezes the original fallback order for the runtime to execute.
    assert.deepEqual(admitted.configuration, admitLoggingConfiguration(values, "info"));
    assert.deepEqual(admitted.harness, { id: "codex", version: "1.0.0", mode: "dedicated" });
    assert.equal(admitted.compute.id, "configuration-occ-compute");
  });
}

test("OCC rejects alternate selectable runtimes and unsupported Codex providers before admitting work", async () => {
  const scenarios = [
    ...[null, "openai/gpt-4.1-mini", [42], ["/missing-provider"]].map((fallbacks) => ({
      name: `malformed fallback selection ${JSON.stringify(fallbacks)} cannot be admitted`,
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1", fallbacks },
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
    })),
    {
      name: "fallback cannot change provider even when both models select the same Harness",
      executionMode: "dedicated",
      values: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1", fallbacks: ["codex/gpt-4.1"] },
            models: { "openai/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
        },
        models: { providers: { codex: { agentRuntime: { id: "codex" } } } },
        plugins: {
          entries: { codex: { enabled: true, config: { appServer: { transport: "websocket" } } } },
        },
      },
    },
    ...[
      ["same-provider fallback cannot select a different Harness", { id: "openclaw" }],
      ["same-provider fallback cannot omit its required runtime policy", undefined],
    ].map(([name, fallbackRuntime]) => ({
      name,
      executionMode: "dedicated",
      values: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] },
            models: {
              "openai/gpt-4.1": { agentRuntime: { id: "codex" } },
              ...(fallbackRuntime === undefined
                ? {}
                : {
                    "openai/gpt-4.1-mini": { agentRuntime: fallbackRuntime },
                  }),
            },
          },
        },
        plugins: {
          entries: { codex: { enabled: true, config: { appServer: { transport: "websocket" } } } },
        },
      },
    })),
    {
      name: "embedded OpenClaw cannot fall back to dedicated Codex",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1", fallbacks: ["codex/gpt-4.1"] },
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
    },
    {
      name: "dedicated Codex cannot fall back to embedded OpenClaw",
      executionMode: "dedicated",
      values: {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-4.1", fallbacks: ["openai/gpt-4.1"] },
            models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    },
    {
      name: "agent lists cannot introduce a separate dedicated runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
          list: [{ id: "alternate", model: "codex/gpt-4.1" }],
        },
      },
    },
    {
      name: "the selectable model catalog cannot offer a conflicting runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: {
              "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } },
              "codex/gpt-4.1": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
    },
    {
      name: "per-agent primary model fallbacks cannot select dedicated Codex",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            primary: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["codex/gpt-4.1"] },
            },
          },
        },
      },
    },
    {
      name: "per-agent selectable models cannot offer a conflicting runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            primary: {
              models: {
                "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } },
                "codex/gpt-4.1": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
      },
    },
    {
      name: "provider model catalogs cannot expose alternate runtime overrides",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            openai: {
              models: [
                { id: "gpt-4.1", agentRuntime: { id: "openclaw" } },
                { id: "gpt-5.6-luna", agentRuntime: { id: "codex" } },
              ],
            },
          },
        },
      },
    },
    {
      name: "selected model policy cannot mask a conflicting provider runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
      },
    },
    {
      name: "selected model policy cannot mask a conflicting provider-model runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            openai: { models: [{ id: "gpt-4.1", agentRuntime: { id: "codex" } }] },
          },
        },
      },
    },
    {
      // The nested catalog entry must still be found, or its conflicting runtime would go unseen.
      name: "selected model policy cannot mask a conflicting nested-slash provider-model runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/vendor/model",
            models: { "openai/vendor/model": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            openai: { models: [{ id: "vendor/model", agentRuntime: { id: "codex" } }] },
          },
        },
      },
    },
    {
      name: "per-agent model policy cannot mask a conflicting default runtime",
      executionMode: "embedded",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            primary: {
              models: { "openai/gpt-4.1": { agentRuntime: { id: "codex" } } },
            },
          },
        },
      },
    },
    {
      name: "dedicated Codex cannot use the OpenAI gateway provider",
      executionMode: "dedicated",
      values: {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    },
  ];

  for (const { name, executionMode, values } of scenarios) {
    const { agent, controller, namespace } = await fixture();
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values,
    });
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
      executionMode,
    });
    const operations = controller.pendingOperations();

    // Admission must fail before creating an immutable revision or enqueuing runtime work.
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      ScopeViolationError,
      name,
    );
    assert.deepEqual(
      await controller.listRevisions(administrator, namespace.id, agent.id),
      [],
      name,
    );
    assert.deepEqual(controller.pendingOperations(), operations, name);
  }
});

test("Harness admission rejects conflicting selections, mode mismatches, and unapproved routes", async () => {
  const { agent, controller, namespace } = await fixture();
  const codexConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {
      agents: {
        defaults: {
          model: "codex/gpt-4.1",
          models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
        },
      },
    },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: codexConfiguration.id,
  });

  // An explicit Codex selection cannot run in an embedded Agent or use OpenClaw's approval.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      () => DEVELOPMENT_HARNESS_DESCRIPTOR,
    ),
    ScopeViolationError,
  );

  // Production accepts the same explicitly approved embedded OpenClaw placement as development.
  const openclawConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: openclawConfiguration.id,
  });
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), []);
  const embedded = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedProductionHarness,
  );
  assert.deepEqual(embedded.harness, { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: openclawConfiguration.id,
    executionMode: "dedicated",
  });
  // The pinned runtime cannot run dedicated OpenClaw, so admission refuses it before
  // any revision exists unless the Installation declares a native-worker runtime image.
  assert.equal(PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS, false);
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedProductionHarness,
    ),
    (error) =>
      error instanceof NativeWorkerSupportError &&
      /cloudWorkers\.requiredProfile/.test(error.message) &&
      /docs-enterprise\.openclaw\.org\/reference\/harness-execution\/#native-worker-support/.test(
        error.message,
      ),
  );
  assert.equal((await controller.getInstallation(administrator)).capabilities, undefined);
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), [
    embedded,
  ]);

  assert.throws(
    () =>
      resolveConfiguredHarnessId({
        agents: {
          defaults: {
            model: "codex/gpt-4.1",
            models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
          entries: { secondary: { model: "anthropic/claude" } },
        },
      }),
    ScopeViolationError,
  );
  assert.throws(
    () =>
      resolveConfiguredHarnessId({
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: "openclaw" } },
          },
        },
      }),
    ScopeViolationError,
  );
});

test("Installation native worker support admits dedicated OpenClaw to Sandbox checks", async () => {
  const { agent, controller, namespace } = await fixture({ nativeWorkerSupport: "custom-image" });
  assert.deepEqual((await controller.getInstallation(administrator)).capabilities, {
    nativeWorkers: { support: "custom-image" },
  });
  const openclawConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: openclawConfiguration.id,
    executionMode: "dedicated",
  });
  // The declaration lifts only the runtime refusal: dedicated OpenClaw still fails closed
  // without a provisioning SandboxDriver that declares networking, filesystem, and process containment.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedProductionHarness,
    ),
    (error) =>
      error instanceof DependencyUnavailableError &&
      /requires a provisioning SandboxDriver with networking, filesystem, and process containment/.test(
        error.message,
      ),
  );
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), []);
  assert.throws(
    () => new OpenClawController(installation, { nativeWorkerSupport: "pinned-runtime" }),
    ScopeViolationError,
  );
});

test("Agent deployment separately authorizes its exact Configuration", async () => {
  const { agent, controller, namespace } = await fixture();

  // An Agent deploy grant does not imply authority to read its referenced Configuration.
  await assert.rejects(
    controller.deployAgent(
      deployOnly,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization, {
        action: "read",
        resource: { kind: "configuration", id: agent.configurationId, namespaceId: namespace.id },
      });
      return true;
    },
  );
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), []);
});

test("Namespace deletion refuses an otherwise agent-free Namespace with Configuration", async () => {
  const { controller } = await fixture();
  const namespace = await controller.createNamespace(administrator, {
    name: "Configuration-only tenant",
  });
  await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "unattached-model" },
  });

  // Namespace ownership must remain intact until every ConfigMap-backed resource is removed.
  await assert.rejects(
    controller.deleteNamespace(administrator, namespace.id),
    NamespaceNotEmptyError,
  );
  assert.equal((await controller.getNamespace(administrator, namespace.id)).status, "provisioning");
});
