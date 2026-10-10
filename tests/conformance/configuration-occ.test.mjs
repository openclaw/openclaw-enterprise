import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  DEVELOPMENT_HARNESS_DESCRIPTOR,
  resolveApprovedHarness as resolveApprovedDevelopmentHarness,
  resolveApprovedProductionHarness,
} from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  AuthorizationDeniedError,
  ConfigurationHarnessError,
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
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.mjs";
import { bindRole, grantRole, principalIAMState } from "../helpers/iam-grants.mjs";

const administrator = "principal-configuration-administrator";
const deployOnly = "principal-configuration-deploy-only";
const installation = Object.freeze({
  id: "installation-configuration-occ",
  name: "Configuration OCC conformance",
  createdAt: "2026-08-19T00:00:00.000Z",
});
async function fixture(options = {}) {
  const iamState = principalIAMState([administrator, deployOnly], "configuration-conformance");
  grantRole(iamState, administrator, {
    id: "configuration-administrator-role",
    bindingId: "configuration-administrator-binding",
    permissions: {
      secret: ["create", "operate"],
      namespace: ["create", "read", "delete"],
      configuration: ["create", "read", "update", "delete"],
      agent: ["create", "read", "update", "deploy"],
      agent_revision: ["read"],
      installation: ["read"],
    },
  });
  grantRole(iamState, deployOnly, {
    id: "configuration-deploy-only-role",
    bindingId: "configuration-deploy-only-binding",
    permissions: { agent: ["deploy"], secret: ["operate"] },
  });
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
  registerAndSelectDrivers(controller, [iam, compute, configurationDriver, secretDriver]);
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
    bindRole(iamState, target.servicePrincipalId, {
      id: `harness-binding-${target.id}`,
      roleId: `harness-role-${target.id}`,
      namespaceId: namespace.id,
      resource: { kind: "secret", id: secret.id },
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
    iamState,
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

test("a Configuration update that applied but answered an error is rolled back with its metadata", async () => {
  const { configuration, configurationDriver, controller, namespace } = await fixture();
  const reference = { id: configuration.id, namespaceId: namespace.id };
  const update = configurationDriver.update;
  const updateInput = (model) => ({
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { model },
  });

  // The replace lands but its response is lost (a timeout after the API server applied it).
  // The metadata transaction rolls back, so the stored document must return to generation 1
  // instead of staying one generation ahead (finding 911).
  configurationDriver.update = async (next) => {
    configurationDriver.update = update;
    await update(next);
    throw new Error("synthetic Configuration update response loss");
  };
  await assert.rejects(
    controller.updateConfiguration(administrator, updateInput("applied-but-lost")),
    DependencyUnavailableError,
  );
  assert.deepEqual(await configurationDriver.read(reference), configuration);
  assert.deepEqual(
    await controller.getConfiguration(administrator, namespace.id, configuration.id),
    configuration,
  );

  // A replace that never applied leaves the stored document alone and keeps its own error.
  configurationDriver.update = async () => {
    configurationDriver.update = update;
    throw new Error("synthetic Configuration outage");
  };
  await assert.rejects(
    controller.updateConfiguration(administrator, updateInput("never-applied")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.deepEqual(await configurationDriver.read(reference), configuration);

  // When the backend cannot even be read, OCC cannot tell whether the replace applied, so it
  // says the rollback failed instead of claiming the write did not happen.
  const read = configurationDriver.read;
  configurationDriver.update = async () => {
    configurationDriver.update = update;
    configurationDriver.read = async () => {
      configurationDriver.read = read;
      throw new Error("synthetic Configuration outage");
    };
    throw new Error("synthetic Configuration outage");
  };
  await assert.rejects(
    controller.updateConfiguration(administrator, updateInput("unknown")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "A Driver could not roll back a failed resource mutation.",
  );
  assert.deepEqual(await configurationDriver.read(reference), configuration);

  const updated = await controller.updateConfiguration(administrator, updateInput("applied"));
  assert.equal(updated.generation, 2);
  assert.deepEqual((await configurationDriver.read(reference)).values, { model: "applied" });
});

/**
 * Gives the test Driver the exact inspection the Kubernetes Driver has: undefined when absent,
 * the stored Configuration when it matches exactly, and a conflict otherwise.
 */
function inspectExactly(configurationDriver) {
  configurationDriver.inspectExact = async (configuration) => {
    const stored = configurationDriver.stored(configuration);
    if (stored === undefined) {
      return undefined;
    }
    if (!isDeepStrictEqual(stored, configuration)) {
      throw new Error("synthetic Configuration identity conflict");
    }
    return stored;
  };
}

test("a Configuration create that applied but answered an error leaves no ConfigMap behind", async () => {
  const { configurationDriver, controller, namespace } = await fixture();
  inspectExactly(configurationDriver);
  const create = configurationDriver.create;
  const input = (model) => ({ namespaceId: namespace.id, kind: "agent", values: { model } });
  const created = [];

  // The create lands but its response is lost (a timeout after the API server applied it). The
  // metadata rolls back, so the stored document must go too (finding 916).
  configurationDriver.create = async (configuration) => {
    configurationDriver.create = create;
    created.push(configuration);
    await create(configuration);
    throw new Error("synthetic Configuration create response loss");
  };
  await assert.rejects(
    controller.createConfiguration(administrator, input("applied-but-lost")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.equal(configurationDriver.stored(created[0]), undefined);
  await assert.rejects(
    controller.getConfiguration(administrator, namespace.id, created[0].id),
    ScopeViolationError,
  );

  // A create that never applied leaves nothing to delete and keeps its own error.
  const inspected = [];
  const inspect = configurationDriver.inspectExact;
  configurationDriver.inspectExact = async (configuration) => {
    inspected.push(configuration);
    return inspect(configuration);
  };
  configurationDriver.create = async (configuration) => {
    configurationDriver.create = create;
    created.push(configuration);
    throw new Error("synthetic Configuration outage");
  };
  const deleteConfiguration = configurationDriver.delete;
  const deleted = [];
  configurationDriver.delete = async (reference) => {
    deleted.push(reference);
    return deleteConfiguration(reference);
  };
  await assert.rejects(
    controller.createConfiguration(administrator, input("never-applied")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.deepEqual(inspected, [created[1]]);
  assert.deepEqual(deleted, []);

  // A document at the new identity that is not this exact Configuration is never deleted; OCC
  // says it could not roll back instead.
  configurationDriver.create = async (configuration) => {
    configurationDriver.create = create;
    created.push(configuration);
    await create({ ...configuration, values: { model: "someone-else" } });
    throw new Error("synthetic Configuration create response loss");
  };
  await assert.rejects(
    controller.createConfiguration(administrator, input("foreign")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "A Driver could not roll back a failed resource mutation.",
  );
  assert.deepEqual(configurationDriver.stored(created[2])?.values, { model: "someone-else" });
  assert.deepEqual(deleted, []);

  // When the backend cannot be read, OCC cannot tell whether the create applied, so it says the
  // rollback failed instead of reporting a create that may have stored a ConfigMap.
  const inspectExact = configurationDriver.inspectExact;
  configurationDriver.create = async (configuration) => {
    configurationDriver.create = create;
    created.push(configuration);
    configurationDriver.inspectExact = async () => {
      configurationDriver.inspectExact = inspectExact;
      throw new Error("synthetic Configuration outage");
    };
    await create(configuration);
    throw new Error("synthetic Configuration create response loss");
  };
  await assert.rejects(
    controller.createConfiguration(administrator, input("unknown")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "A Driver could not roll back a failed resource mutation.",
  );
  assert.deepEqual(deleted, []);

  const configuration = await controller.createConfiguration(administrator, input("applied"));
  assert.deepEqual(configurationDriver.stored(configuration).values, { model: "applied" });
});

test("a Configuration delete that applied but answered an error restores the ConfigMap", async () => {
  const { configurationDriver, controller, namespace } = await fixture();
  inspectExactly(configurationDriver);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "kept" },
  });
  const deleteConfiguration = configurationDriver.delete;
  const create = configurationDriver.create;
  const recreated = [];
  configurationDriver.create = async (next) => {
    recreated.push(next);
    return create(next);
  };

  // The delete lands but its response is lost. The metadata rolls back, so the stored document
  // must come back instead of leaving metadata that names nothing (finding 916).
  configurationDriver.delete = async (reference) => {
    configurationDriver.delete = deleteConfiguration;
    await deleteConfiguration(reference);
    throw new Error("synthetic Configuration delete response loss");
  };
  await assert.rejects(
    controller.deleteConfiguration(administrator, namespace.id, configuration.id),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.deepEqual(configurationDriver.stored(configuration), configuration);
  assert.deepEqual(
    await controller.getConfiguration(administrator, namespace.id, configuration.id),
    configuration,
  );
  assert.equal(recreated.length, 1);

  // A delete that never applied leaves the stored document alone and keeps its own error.
  configurationDriver.delete = async () => {
    configurationDriver.delete = deleteConfiguration;
    throw new Error("synthetic Configuration outage");
  };
  await assert.rejects(
    controller.deleteConfiguration(administrator, namespace.id, configuration.id),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.deepEqual(configurationDriver.stored(configuration), configuration);
  assert.equal(recreated.length, 1);

  // When the backend cannot be read, OCC cannot tell whether the delete applied, so it says the
  // rollback failed instead of claiming the Configuration is intact.
  const inspectExact = configurationDriver.inspectExact;
  configurationDriver.delete = async (reference) => {
    configurationDriver.delete = deleteConfiguration;
    configurationDriver.inspectExact = async () => {
      configurationDriver.inspectExact = inspectExact;
      throw new Error("synthetic Configuration outage");
    };
    await deleteConfiguration(reference);
    throw new Error("synthetic Configuration delete response loss");
  };
  await assert.rejects(
    controller.deleteConfiguration(administrator, namespace.id, configuration.id),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "A Driver could not roll back a failed resource mutation.",
  );
  assert.equal(configurationDriver.stored(configuration), undefined);
  assert.equal(recreated.length, 1);
});

test("a failed Configuration delete leaves a delete committed after its rollback alone", async () => {
  const { configurationDriver, controller, namespace, state } = await fixture();
  inspectExactly(configurationDriver);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "raced" },
  });
  const deleteConfiguration = configurationDriver.delete;
  const inspectExact = configurationDriver.inspectExact;
  const create = configurationDriver.create;
  const recreated = [];
  configurationDriver.create = async (next) => {
    recreated.push(next);
    return create(next);
  };

  // Request A's delete never applies. Its compensation runs after ROLLBACK released the row
  // lock, and request B deletes the same Configuration and commits before A inspects it. A
  // must not recreate a ConfigMap whose metadata is gone (finding 945).
  configurationDriver.delete = async () => {
    configurationDriver.delete = deleteConfiguration;
    throw new Error("synthetic Configuration outage");
  };
  configurationDriver.inspectExact = async (next) => {
    configurationDriver.inspectExact = inspectExact;
    await controller.deleteConfiguration(administrator, namespace.id, configuration.id);
    return inspectExact(next);
  };
  await assert.rejects(
    controller.deleteConfiguration(administrator, namespace.id, configuration.id),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.equal(configurationDriver.stored(configuration), undefined);
  assert.deepEqual(recreated, []);
  await assert.rejects(
    controller.getConfiguration(administrator, namespace.id, configuration.id),
    ScopeViolationError,
  );

  // When that re-read fails too (the outage that failed the request), the compensation
  // proceeds as before: a delete that applied gets its ConfigMap back (finding 916).
  const kept = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "kept" },
  });
  recreated.length = 0;
  const read = state.read;
  configurationDriver.delete = async (reference) => {
    configurationDriver.delete = deleteConfiguration;
    await deleteConfiguration(reference);
    state.read = async () => {
      state.read = read;
      throw new Error("synthetic state outage");
    };
    throw new Error("synthetic Configuration delete response loss");
  };
  await assert.rejects(
    controller.deleteConfiguration(administrator, namespace.id, kept.id),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  assert.equal(state.read, read);
  assert.deepEqual(configurationDriver.stored(kept), kept);
  assert.deepEqual(recreated, [kept]);
});

test("a failed Configuration update leaves an update committed after its rollback alone", async () => {
  const { configuration, configurationDriver, controller, namespace } = await fixture();
  const reference = { id: configuration.id, namespaceId: namespace.id };
  const update = configurationDriver.update;
  const read = configurationDriver.read;
  const updateInput = (model) => ({
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { model },
  });

  // Request A's replace never applies. Before its compensation reads the stored generation,
  // request B updates the same Configuration and commits generation 2. A must not roll B's
  // committed document back to generation 1 under metadata that says 2.
  configurationDriver.update = async () => {
    configurationDriver.update = update;
    configurationDriver.read = async (next) => {
      configurationDriver.read = read;
      await controller.updateConfiguration(administrator, updateInput("committed"));
      return read(next);
    };
    throw new Error("synthetic Configuration outage");
  };
  await assert.rejects(
    controller.updateConfiguration(administrator, updateInput("failed")),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The selected Configuration Driver is unavailable.",
  );
  const stored = await configurationDriver.read(reference);
  assert.equal(stored.generation, 2);
  assert.deepEqual(stored.values, { model: "committed" });
  assert.deepEqual(
    await controller.getConfiguration(administrator, namespace.id, configuration.id),
    stored,
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

// Returns the refusal message after checking that every refusal is a ConfigurationHarnessError
// within the 256-character cap.
function configurationRefusal(values) {
  try {
    resolveConfiguredHarnessId(values);
  } catch (error) {
    assert.ok(error instanceof ConfigurationHarnessError, String(error));
    assert.ok(Array.from(error.message).length <= 256, error.message);
    return error.message;
  }
  assert.fail(`${JSON.stringify(values)} was admitted`);
}

test("Agent roster refusals name the setting and the fix", () => {
  const listRefusal =
    "Configuration setting agents.list is unsupported: remove it and configure each Agent under agents.entries, keyed by its Agent ID.";
  for (const list of [[{ id: "main" }], {}, null]) {
    assert.equal(configurationRefusal({ agents: { list } }), listRefusal, JSON.stringify(list));
  }
  for (const [entries, path] of [
    [{ main: "not-an-object" }, "agents.entries.main"],
    [{ main: {}, helper: null }, "agents.entries.helper"],
    [{ "a.b": [] }, 'agents.entries["a.b"]'],
    [{ "a\u0007b": 1 }, 'agents.entries["a?b"]'],
  ]) {
    assert.equal(
      configurationRefusal({ agents: { defaults: { model: "codex/gpt-4.1" }, entries } }),
      `Configuration setting ${path} must be an object.`,
      path,
    );
  }
  // Shape refusals precede model policy, even for an earlier entry's model.
  assert.equal(
    configurationRefusal({ agents: { entries: { main: { model: "unqualified" }, helper: null } } }),
    "Configuration setting agents.entries.helper must be an object.",
  );
  const long = "x.".repeat(200);
  const message = configurationRefusal({ agents: { entries: { [long]: false } } });
  assert.equal(Array.from(message).length, 256, message);
  assert.ok(message.endsWith("… must be an object."), message);
});

test("model policy refusals name the Configuration setting", () => {
  const catalog = { providers: { openai: { models: [{ id: "gpt-4.1" }] } } };
  const selectableRule =
    "must be an object keyed by model ref: a model other than the primary needs the primary's provider and the same agentRuntime, set on both.";
  const catalogRule =
    "Configuration setting models.providers.openai.models may list only entries whose id names a primary or fallback model set in agents.defaults.model or agents.entries.";
  for (const [values, message] of [
    // Finding 888: a non-object agents read as an empty roster, so the provider catalog check
    // refused it first with text about selectable provider models.
    ...["x", 1, [], null].map((agents) => [
      { agents, models: catalog },
      "Configuration setting agents must be an object.",
    ]),
    ...["x", [], null].map((defaults) => [
      { agents: { defaults, entries: { main: {} } }, models: catalog },
      "Configuration setting agents.defaults must be an object.",
    ]),
    ...["x", [], null].map((entries) => [
      { agents: { entries }, models: catalog },
      "Configuration setting agents.entries must be an object keyed by Agent ID.",
    ]),
    [
      { agents: { entries: { main: {} } } },
      "Configuration setting agents.entries.main.model is required when agents.defaults.model is unset: set either one.",
    ],
    [
      {
        agents: {
          defaults: { model: "openai/gpt-4.1" },
          entries: { main: {}, "x.y": { model: "openai/gpt-4.1-mini" } },
        },
      },
      'Configuration setting agents.entries["x.y"].model must select the same primary model as agents.defaults.model and the other agents.entries.',
    ],
    [
      {
        agents: {
          defaults: { model: "openai/gpt-4.1" },
          entries: { main: { models: { "openai/gpt-4.1-mini": {} } } },
        },
      },
      `Configuration setting agents.entries.main.models ${selectableRule}`,
    ],
    [
      { agents: { defaults: { model: "openai/gpt-4.1", models: "x" } } },
      `Configuration setting agents.defaults.models ${selectableRule}`,
    ],
    [
      { agents: { defaults: { models: {} } } },
      "Configuration setting agents.defaults.models needs a primary model: set agents.defaults.model or an agents.entries model.",
    ],
    [
      { models: { providers: { openai: "x" } } },
      "Configuration setting models.providers.openai must be an object.",
    ],
    [
      { models: { providers: { "my provider": { models: {} } } } },
      'Configuration setting models.providers["my provider"].models must be an array of model entries.',
    ],
    [
      {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        models: { providers: { openai: { models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }] } } },
      },
      catalogRule,
    ],
    [
      {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        models: { providers: { openai: { models: ["gpt-4.1"] } } },
      },
      catalogRule,
    ],
    [
      {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: { openai: { models: [{ id: "gpt-4.1" }, { id: "openai/gpt-4.1" }] } },
        },
      },
      "Configuration setting models.providers.openai.models lists the selected model more than once: keep one entry.",
    ],
  ]) {
    assert.equal(configurationRefusal(values), message, JSON.stringify(values));
  }
  const long = "p.".repeat(200);
  assert.ok(
    configurationRefusal({ models: { providers: { [long]: false } } }).endsWith(
      "… must be an object.",
    ),
  );
});

test("deployment names a non-object agents setting before model policy", async () => {
  const { agent, configuration, configurationDriver, controller, namespace } = await fixture();
  const values = {
    agents: "x",
    models: { providers: { openai: { models: [{ id: "gpt-4.1" }] } } },
  };
  const refusal = (error) =>
    error instanceof ConfigurationHarnessError &&
    error.message === "Configuration setting agents must be an object.";
  // Save refuses it with the same text (finding 874), so store it as an older release would have.
  await assert.rejects(
    controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values,
    }),
    refusal,
  );
  await configurationDriver.update({ ...configurationDriver.stored(configuration), values });
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    refusal,
  );
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), []);
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
          main: scope === "entry-fallback" ? { model: selection } : {},
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
  // The mismatch is the caller's to fix, so it is named rather than reported as a missing dependency.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) =>
      error instanceof ConfigurationHarnessError &&
      error.message ===
        "The Configuration selects the Codex Harness, which needs dedicated execution; this Agent uses embedded execution. Change the Agent's execution mode or its Configuration.",
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

test("Agent creation and update separately authorize their exact Configuration", async () => {
  const { agent, configuration, controller, iamState, namespace } = await fixture();
  const deniedRead = (error) => {
    assert.ok(error instanceof AuthorizationDeniedError);
    assert.deepEqual(error.authorization, {
      action: "read",
      resource: { kind: "configuration", id: configuration.id, namespaceId: namespace.id },
    });
    return true;
  };
  const create = () =>
    controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: "Configuration read probe",
      configurationId: configuration.id,
    });
  const update = () =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
    });

  // Agent create and update grants do not imply reading the Configuration they select.
  iamState.restrictions.push({
    id: "deny-configuration-read",
    namespaceId: namespace.id,
    action: "read",
    resourceKind: "configuration",
    resourceId: configuration.id,
    effect: "deny",
  });
  await assert.rejects(create(), deniedRead);
  await assert.rejects(update(), deniedRead);
  assert.deepEqual(
    (await controller.listAgents(administrator, namespace.id)).map(({ id }) => id),
    [agent.id],
  );

  iamState.restrictions.pop();
  assert.equal((await create()).configurationId, configuration.id);
  assert.equal((await update()).configurationId, configuration.id);
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
