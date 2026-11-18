import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import type {
  Agent,
  Configuration,
  ConfigurationDriver,
  ConfigurationReference,
  Namespace,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  ConfigurationGenerationConflictError,
  DependencyUnavailableError,
  ScopeViolationError,
  type CreateConfigurationInput,
  type InMemoryPlatformState,
  type OpenClawController,
  type UpdateConfigurationInput,
} from "../../packages/occ/src/index.ts";
import { admittedConfiguration } from "../helpers/admitted-configuration.mjs";
import { servedAs } from "../helpers/agent-identity.mjs";
import type { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";

type TestConfigurationDriver = ReturnType<typeof createTestConfigurationDriver>;

interface ConfigurationPersistenceFixture {
  agent: Readonly<Agent>;
  configuration: Readonly<Configuration>;
  configurationDriver: TestConfigurationDriver;
  controller: OpenClawController;
  namespace: Readonly<Namespace>;
  state: InMemoryPlatformState;
}

/** Match exact inspection semantics while the test Driver stores documents in memory. */
function installExactInspection(
  driver: TestConfigurationDriver,
): NonNullable<ConfigurationDriver["inspectExact"]> {
  const inspect: NonNullable<ConfigurationDriver["inspectExact"]> = async (expected) => {
    const stored = driver.stored(expected);
    if (stored === undefined) {
      return undefined;
    }
    if (!isDeepStrictEqual(stored, expected)) {
      throw new Error("synthetic Configuration identity conflict");
    }
    return stored;
  };
  driver.inspectExact = inspect;
  return inspect;
}

function isDriverUnavailable(error: unknown): boolean {
  return (
    error instanceof DependencyUnavailableError &&
    error.message === "The selected Configuration Driver is unavailable."
  );
}

function isRollbackUnavailable(error: unknown): boolean {
  return (
    error instanceof DependencyUnavailableError &&
    error.message === "A Driver could not roll back a failed resource mutation."
  );
}

export function registerConfigurationPersistenceCases({
  fixture,
  administrator,
}: {
  fixture: () => Promise<ConfigurationPersistenceFixture>;
  administrator: string;
}): void {
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

  // Two saves that read the same generation: the second is refused under the row lock instead of
  // silently replacing the first (finding 1505). An omitted expectedGeneration still replaces.
  test("concurrent Configuration updates from one read generation keep the first and refuse the second", async () => {
    const { configuration, configurationDriver, controller, namespace } = await fixture();
    const update = (model: string, expectedGeneration?: number) =>
      controller.updateConfiguration(administrator, {
        namespaceId: namespace.id,
        configurationId: configuration.id,
        values: { model },
        ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      });

    const results = await Promise.allSettled([update("first", 1), update("second", 1)]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[0].value.generation, 2);
    assert.equal(results[1].status, "rejected");
    assert.ok(
      results[1].reason instanceof ConfigurationGenerationConflictError,
      String(results[1].reason),
    );
    const latest = await controller.getConfiguration(administrator, namespace.id, configuration.id);
    assert.equal(latest.generation, 2);
    assert.deepEqual(latest.values, { model: "first" });
    assert.deepEqual(
      (await configurationDriver.read({ id: configuration.id, namespaceId: namespace.id })).values,
      { model: "first" },
    );

    assert.equal((await update("current", 2)).generation, 3);
    assert.equal((await update("unchecked")).generation, 4);
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
    const updateInput = (model: string): UpdateConfigurationInput => ({
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
      isDriverUnavailable,
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
      isRollbackUnavailable,
    );
    assert.deepEqual(await configurationDriver.read(reference), configuration);

    const updated = await controller.updateConfiguration(administrator, updateInput("applied"));
    assert.equal(updated.generation, 2);
    assert.deepEqual((await configurationDriver.read(reference)).values, { model: "applied" });
  });

  test("a Configuration create that applied but answered an error leaves no ConfigMap behind", async () => {
    const { configurationDriver, controller, namespace } = await fixture();
    const inspect = installExactInspection(configurationDriver);
    const create = configurationDriver.create;
    const input = (model: string): CreateConfigurationInput => ({
      namespaceId: namespace.id,
      kind: "agent",
      values: { model },
    });
    const created: Configuration[] = [];

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
      isDriverUnavailable,
    );
    const applied = created[0];
    assert.ok(applied);
    assert.equal(configurationDriver.stored(applied), undefined);
    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, applied.id),
      ScopeViolationError,
    );

    // A create that never applied leaves nothing to delete and keeps its own error.
    const inspected: Configuration[] = [];
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
    const deleted: ConfigurationReference[] = [];
    configurationDriver.delete = async (reference) => {
      deleted.push(reference);
      return deleteConfiguration(reference);
    };
    await assert.rejects(
      controller.createConfiguration(administrator, input("never-applied")),
      isDriverUnavailable,
    );
    const neverApplied = created[1];
    assert.ok(neverApplied);
    assert.deepEqual(inspected, [neverApplied]);
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
      isRollbackUnavailable,
    );
    const foreign = created[2];
    assert.ok(foreign);
    assert.deepEqual(configurationDriver.stored(foreign)?.values, { model: "someone-else" });
    assert.deepEqual(deleted, []);

    // When the backend cannot be read, OCC cannot tell whether the create applied, so it says the
    // rollback failed instead of treating the write as absent.
    const inspectExact = configurationDriver.inspectExact;
    assert.ok(inspectExact);
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
      isRollbackUnavailable,
    );
    assert.deepEqual(deleted, []);

    const configuration = await controller.createConfiguration(administrator, input("applied"));
    assert.deepEqual(configurationDriver.stored(configuration)?.values, { model: "applied" });
  });

  test("a Configuration delete that applied but answered an error restores the ConfigMap", async () => {
    const { configurationDriver, controller, namespace } = await fixture();
    const inspectExact = installExactInspection(configurationDriver);
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: { model: "kept" },
    });
    const deleteConfiguration = configurationDriver.delete;
    const create = configurationDriver.create;
    const recreated: Configuration[] = [];
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
      isDriverUnavailable,
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
      isDriverUnavailable,
    );
    assert.deepEqual(configurationDriver.stored(configuration), configuration);
    assert.equal(recreated.length, 1);

    // When the backend cannot be read, OCC cannot tell whether the delete applied, so it says the
    // rollback failed instead of claiming the Configuration is intact.
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
      isRollbackUnavailable,
    );
    assert.equal(configurationDriver.stored(configuration), undefined);
    assert.equal(recreated.length, 1);
  });

  test("a failed Configuration delete leaves a delete committed after its rollback alone", async () => {
    const { configurationDriver, controller, namespace, state } = await fixture();
    const inspectExact = installExactInspection(configurationDriver);
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: { model: "raced" },
    });
    const deleteConfiguration = configurationDriver.delete;
    const create = configurationDriver.create;
    const recreated: Configuration[] = [];
    configurationDriver.create = async (next) => {
      recreated.push(next);
      return create(next);
    };

    // Request A's delete never applies. Its compensation runs after ROLLBACK released the row
    // lock, and request B deletes the same Configuration and commits before A inspects it. A
    // must not recreate a document whose metadata is gone (finding 945).
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
      isDriverUnavailable,
    );
    assert.equal(configurationDriver.stored(configuration), undefined);
    assert.deepEqual(recreated, []);
    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, configuration.id),
      ScopeViolationError,
    );

    // When that re-read fails too (the outage that failed the request), the compensation
    // proceeds as before: a delete that applied gets its document back (finding 916).
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
      isDriverUnavailable,
    );
    assert.deepEqual(configurationDriver.stored(kept), kept);
    assert.deepEqual(recreated, [kept]);
    assert.deepEqual(await controller.getConfiguration(administrator, namespace.id, kept.id), kept);
  });

  test("a failed Configuration update leaves an update committed after its rollback alone", async () => {
    const { configuration, configurationDriver, controller, namespace } = await fixture();
    const reference = { id: configuration.id, namespaceId: namespace.id };
    const update = configurationDriver.update;
    const read = configurationDriver.read;
    const updateInput = (model: string): UpdateConfigurationInput => ({
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
      isDriverUnavailable,
    );
    const stored = await configurationDriver.read(reference);
    assert.equal(stored.generation, 2);
    assert.deepEqual(stored.values, { model: "committed" });
    assert.deepEqual(
      await controller.getConfiguration(administrator, namespace.id, configuration.id),
      stored,
    );
  });

  test("a Configuration left ahead of its record by failed updates recovers on the next update", async () => {
    const { agent, configuration, configurationDriver, controller, namespace } = await fixture();
    const reference = { id: configuration.id, namespaceId: namespace.id };
    // Records each replace as [stored, written] generations: the Kubernetes Driver accepts only a
    // step of exactly one from the document it read.
    const steps: [stored: number, written: number][] = [];
    const storedUpdate = configurationDriver.update;
    const update: ConfigurationDriver["update"] = async (next) => {
      const stored = configurationDriver.stored(next);
      assert.ok(stored);
      steps.push([stored.generation, next.generation]);
      return storedUpdate(next);
    };
    configurationDriver.update = update;
    const read = configurationDriver.read;
    const valuesWith = (regions: string[]): OpenClawConfigurationDocument => ({
      ...configuration.values,
      plugins: { entries: { example: { enabled: true, regions, retryCount: 2 } } },
    });
    const updateInput = (regions: string[]): UpdateConfigurationInput => ({
      namespaceId: namespace.id,
      configurationId: configuration.id,
      values: valuesWith(regions),
    });

    // The replace lands but its response is lost, and the compensation's read fails in the same
    // outage. The stored document is left one generation ahead of the record (finding 1396).
    configurationDriver.update = async (next) => {
      configurationDriver.update = update;
      await update(next);
      configurationDriver.read = async () => {
        configurationDriver.read = read;
        throw new Error("synthetic Configuration outage");
      };
      throw new Error("synthetic Configuration update response loss");
    };
    await assert.rejects(
      controller.updateConfiguration(administrator, updateInput(["lost"])),
      isRollbackUnavailable,
    );
    const leftover = configurationDriver.stored(reference);
    assert.ok(leftover);
    assert.equal(leftover.generation, 2);
    assert.deepEqual(leftover.values, valuesWith(["lost"]));

    // Reads and deploys never serve the unrecorded generation.
    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, configuration.id),
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

    // A retry whose own replace is lost restores the leftover, so a later retry still recovers.
    configurationDriver.update = async (next) => {
      configurationDriver.update = update;
      await update(next);
      throw new Error("synthetic Configuration update response loss");
    };
    await assert.rejects(
      controller.updateConfiguration(administrator, updateInput(["lost-again"])),
      isDriverUnavailable,
    );
    assert.deepEqual(configurationDriver.stored(reference), leftover);

    // A retry that fails the same way as the first update (lost response, failed compensation
    // read) leaves the stored document two generations ahead; it is still only a leftover.
    configurationDriver.update = async (next) => {
      configurationDriver.update = update;
      await update(next);
      configurationDriver.read = async () => {
        configurationDriver.read = read;
        throw new Error("synthetic Configuration outage");
      };
      throw new Error("synthetic Configuration update response loss");
    };
    await assert.rejects(
      controller.updateConfiguration(administrator, updateInput(["lost-twice"])),
      isRollbackUnavailable,
    );
    assert.equal(configurationDriver.stored(reference)?.generation, 3);
    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, configuration.id),
      DependencyUnavailableError,
    );

    // The retry replaces the leftover under a generation past it, never adopting its content.
    const recovered = await controller.updateConfiguration(administrator, updateInput(["east"]));
    assert.equal(recovered.generation, 4);
    assert.deepEqual(recovered.values, valuesWith(["east"]));
    assert.deepEqual(configurationDriver.stored(reference), {
      ...configuration,
      generation: 4,
      values: valuesWith(["east"]),
    });
    assert.deepEqual(
      await controller.getConfiguration(administrator, namespace.id, configuration.id),
      recovered,
    );

    // Deployment after recovery snapshots the recorded generation and its content.
    const revision = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    assert.equal(revision.configurationGeneration, 4);
    assert.deepEqual(
      revision.configuration,
      admittedConfiguration(servedAs(valuesWith(["east"]), agent.name), "info"),
    );
    // Lost write 1 to 2; lost retry 2 to 3 and its compensation 3 to 2; failed retry 2 to 3;
    // recovery 3 to 4.
    assert.deepEqual(steps, [
      [1, 2],
      [2, 3],
      [3, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  test("a Configuration whose ConfigMap a failed delete removed can still be deleted", async () => {
    const { configurationDriver, controller } = await fixture();
    const namespace = await controller.createNamespace(administrator, {
      name: "Configuration recovery tenant",
    });
    const create = (model: string) =>
      controller.createConfiguration(administrator, {
        namespaceId: namespace.id,
        kind: "agent",
        values: { model },
      });
    const configuration = await create("gone");
    const deleteConfiguration = configurationDriver.delete;
    const recreated: Configuration[] = [];
    const createStored = configurationDriver.create;
    configurationDriver.create = async (next) => {
      recreated.push(next);
      return createStored(next);
    };

    // The delete lands but its response is lost, and the compensation cannot inspect the backend.
    // The record is left naming nothing (finding 1396).
    const inspectExact = installExactInspection(configurationDriver);
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
      isRollbackUnavailable,
    );
    assert.equal(configurationDriver.stored(configuration), undefined);
    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, configuration.id),
      DependencyUnavailableError,
    );

    // A Driver that cannot confirm the absence keeps refusing: an unreachable backend looks the same.
    delete configurationDriver.inspectExact;
    await assert.rejects(
      controller.deleteConfiguration(administrator, namespace.id, configuration.id),
      DependencyUnavailableError,
    );
    configurationDriver.inspectExact = async () => {
      configurationDriver.inspectExact = inspectExact;
      throw new Error("synthetic Configuration outage");
    };
    await assert.rejects(
      controller.deleteConfiguration(administrator, namespace.id, configuration.id),
      DependencyUnavailableError,
    );

    // A read that fails while the document is still stored is an outage, not an absence: the
    // inspection finds the document, so delete keeps refusing and both stay.
    const intact = await create("intact");
    const read = configurationDriver.read;
    configurationDriver.read = async () => {
      configurationDriver.read = read;
      throw new Error("synthetic Configuration outage");
    };
    await assert.rejects(
      controller.deleteConfiguration(administrator, namespace.id, intact.id),
      DependencyUnavailableError,
    );
    assert.deepEqual(configurationDriver.stored(intact), intact);
    assert.deepEqual(
      await controller.getConfiguration(administrator, namespace.id, intact.id),
      intact,
    );
    await controller.deleteConfiguration(administrator, namespace.id, intact.id);
    recreated.length = 0;

    // Once the Driver confirms nothing is stored, delete removes the record and restores nothing.
    assert.deepEqual(
      await controller.deleteConfiguration(administrator, namespace.id, configuration.id),
      [],
    );
    await assert.rejects(
      controller.getConfiguration(administrator, namespace.id, configuration.id),
      ScopeViolationError,
    );
    assert.deepEqual(recreated, []);

    // A document left ahead by failed updates is deleted with its record.
    const ahead = await create("ahead");
    recreated.length = 0;
    await configurationDriver.update({ ...ahead, generation: 3, values: { model: "unrecorded" } });
    await controller.deleteConfiguration(administrator, namespace.id, ahead.id);
    assert.equal(configurationDriver.stored(ahead), undefined);
    assert.deepEqual(recreated, []);

    // A document further ahead than failed writes can leave is not a leftover: it fails closed.
    const far = await create("far");
    const farAhead = { ...far, generation: 102, values: { model: "far" } };
    await configurationDriver.update(farAhead);
    await assert.rejects(
      controller.deleteConfiguration(administrator, namespace.id, far.id),
      DependencyUnavailableError,
    );
    await assert.rejects(
      controller.updateConfiguration(administrator, {
        namespaceId: namespace.id,
        configurationId: far.id,
        values: { model: "replacement" },
      }),
      DependencyUnavailableError,
    );
    assert.deepEqual(configurationDriver.stored(far), farAhead);
    // At the bound, update advances the record past every leftover generation, then delete works.
    await configurationDriver.update({ ...farAhead, generation: 101 });
    const replaced = await controller.updateConfiguration(administrator, {
      namespaceId: namespace.id,
      configurationId: far.id,
      values: { model: "replacement" },
    });
    assert.equal(replaced.generation, 102);
    assert.deepEqual(configurationDriver.stored(far), replaced);
    await controller.deleteConfiguration(administrator, namespace.id, far.id);
    assert.equal(configurationDriver.stored(far), undefined);

    // With nothing left, the Namespace can be deleted.
    await controller.deleteNamespace(administrator, namespace.id);
  });
}
