import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  PlatformOperation,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import {
  event,
  identifier,
  postgresIdentityConflict,
  postgresOwnershipViolation,
  storeRefusal,
  type PlatformStateSeed,
} from "./platform-state-contract-fixture.ts";

// PostgreSQL refuses a wrong Agent lifecycle target in its one controller work shape check.
const postgresWorkTargetShape =
  "Controller work requires one exact Namespace, Agent, or revision target shape.";

export async function verifyPlatformStateTransactions(
  store: PlatformStateStore,
  {
    installation,
    namespace,
    configuration,
    harnessSecret,
    agent,
    revision,
    audit,
  }: PlatformStateSeed,
): Promise<void> {
  for (const admission of ["", "a".repeat(1025), "bad\nvalue"]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({
          ...revision,
          id: identifier("rev"),
          revision: 2,
          compute: { ...revision.compute, admission },
        }),
      ),
      storeRefusal(
        "ScopeViolationError",
        "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
        postgresOwnershipViolation,
      ),
      "malformed Compute admission must be rejected",
    );
  }

  // The draft binding and the pending deployment both reference the key: one Agent entry.
  await store.read(async (state) => {
    assert.deepEqual(await state.secrets.listReferences(namespace.id, harnessSecret.id, 50), {
      references: [{ kind: "agent", id: agent.id }],
      truncated: false,
    });
  });

  // Agent-scoped work exists only to tear an Agent down. Reconciliation still
  // belongs to revisions, so Agent work without the deleted target is refused
  // rather than queued as generic Agent reconciliation.
  await assert.rejects(
    store.transact((transaction) =>
      // @ts-expect-error An untyped caller can submit Agent work without a target.
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: agent.id,
        actorId: audit.actorId,
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "Agent work does not match its exact lifecycle target.",
      postgresWorkTargetShape,
    ),
    "Agent work without a lifecycle target must not enqueue reconciliation",
  );

  await assert.rejects(
    store.transact((transaction) =>
      // @ts-expect-error A Namespace target is invalid for Agent work at runtime too.
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: agent.id,
        actorId: audit.actorId,
        target: "ready",
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "Agent work does not match its exact lifecycle target.",
      postgresWorkTargetShape,
    ),
    "an Agent cannot be driven to a Namespace lifecycle target",
  );

  // Teardown work must name the Agent, not its owning Namespace; otherwise it
  // would be indistinguishable from Namespace work on the queue.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: namespace.id,
        actorId: audit.actorId,
        target: "deleted",
      }),
    ),
    { name: "ScopeViolationError", message: "Agent work must name its exact Agent." },
    "teardown work naming its Namespace instead of its Agent must be refused",
  );

  const backendConfiguration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  } satisfies typeof configuration;
  const providerAgent = {
    ...agent,
    id: identifier("agt"),
    name: `Backend owner ${randomUUID()}`,
    configurationId: backendConfiguration.id,
    backendId: "provider-a",
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    await transaction.configurations.createConfiguration(backendConfiguration);
    // Creation cannot enable editing; the separately authorized setter owns that change.
    assert.deepEqual(
      await transaction.agents.createAgent({ ...providerAgent, sandboxPolicyEditing: true }),
      providerAgent,
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...revision,
        id: identifier("rev"),
        agentId: providerAgent.id,
        configurationId: backendConfiguration.id,
        backendId: "provider-b",
        servicePrincipalId: providerAgent.servicePrincipalId,
      }),
    ),
    { name: "ScopeViolationError", message: "The AgentRevision belongs to an unavailable Agent." },
    "AgentRevision Backend snapshots must match the owning Agent.",
  );
  await store.read(async (state) => {
    assert.deepEqual(await state.revisions.listRevisions(namespace.id, providerAgent.id), []);
  });
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        providerAgent.id,
        backendConfiguration.id,
        providerAgent.executionMode,
        undefined,
        null,
      ),
      { ...providerAgent, backendId: null },
    );
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.createAgent({
        ...agent,
        id: identifier("agt"),
        name: `Duplicate principal ${randomUUID()}`,
      }),
    ),
    storeRefusal(
      "ResourceConflictError",
      "An Agent service principal already belongs to another Agent.",
      postgresIdentityConflict,
    ),
    "An Agent service principal cannot be shared with another Agent.",
  );

  for (const executionMode of [undefined, "remote", null]) {
    // Placement is an explicit, checked platform decision rather than an inferred fallback.
    await assert.rejects(
      store.transact((transaction) =>
        transaction.agents.createAgent({
          ...agent,
          id: identifier("agt"),
          name: `Invalid execution mode ${randomUUID()}`,
          // @ts-expect-error JavaScript callers can pass a missing or unsupported placement.
          executionMode,
          servicePrincipalId: identifier("service-agent"),
        }),
      ),
      storeRefusal(
        "ScopeViolationError",
        "The Agent execution mode is invalid.",
        postgresOwnershipViolation,
      ),
      `unsupported Agent execution mode ${String(executionMode)}`,
    );
  }

  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...revision,
        id: identifier("rev"),
        revision: 2,
        servicePrincipalId: identifier("service-agent"),
      }),
    ),
    { name: "ScopeViolationError", message: "The AgentRevision belongs to an unavailable Agent." },
    "An AgentRevision cannot claim another service principal.",
  );

  for (const [description, invalidOwnership] of [
    ["missing consumer kind", { kind: undefined }],
    ["unsupported consumer kind", { kind: "gateway" }],
    ["missing generation", { generation: undefined }],
    ["zero generation", { generation: 0 }],
    ["negative generation", { generation: -1 }],
    ["fractional generation", { generation: 1.5 }],
    ["unsafe generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const) {
    // Both persistence adapters refuse ownership metadata PostgreSQL cannot safely represent,
    // with the same application check before any write (finding 1887: a fractional generation
    // used to reach PostgreSQL's bigint cast and fail with a raw 22P02).
    await assert.rejects(
      store.transact(async (transaction) => {
        const repository = transaction.configurations;
        // Pass the invalid input through the same runtime call an untyped caller can make.
        await Reflect.apply(repository.createConfiguration, repository, [
          {
            ...configuration,
            id: identifier("cfg"),
            ...invalidOwnership,
          },
        ]);
      }),
      { name: "ScopeViolationError", message: "The Configuration kind or generation is invalid." },
      description,
    );
  }

  await store.read(async (state) => {
    assert.deepEqual(await state.installations.getInstallation(), installation);
    const storedNamespace = await state.namespaces.findNamespace(namespace.id);
    assert.deepEqual(storedNamespace, namespace);
    assert.deepEqual(
      await state.configurations.findConfiguration(namespace.id, configuration.id),
      configuration,
    );
    assert.equal(
      await state.configurations.findConfiguration(identifier("ns"), configuration.id),
      undefined,
    );
    assert.ok(storedNamespace);
    assert.equal(Object.hasOwn(storedNamespace, "installationId"), false);
    assert.deepEqual(await state.agents.findAgent(namespace.id, agent.id), agent);
    assert.equal(await state.agents.findAgent(identifier("ns"), agent.id), undefined);

    const storedRevision = await state.revisions.findRevision(namespace.id, agent.id, revision.id);
    assert.deepEqual(storedRevision, revision);
    assert.ok(storedRevision);
    assert.ok(Object.isFrozen(storedRevision));
    assert.ok(Object.isFrozen(storedRevision.configuration));
    assert.ok(Object.isFrozen(storedRevision.harness));
    assert.ok(Object.isFrozen(storedRevision.compute));
    assert.ok(Object.isFrozen(storedRevision.harnessAuth));
    assert.ok(storedRevision.harnessAuth.method === "api_key");
    assert.ok(Object.isFrozen(storedRevision.harnessAuth.source));
    assert.equal(
      await state.revisions.findRevision(identifier("ns"), agent.id, revision.id),
      undefined,
    );
  });

  await store.transact(async (transaction) => {
    // Changing future placement never changes the placement frozen in an admitted revision.
    const dedicated = { ...agent, executionMode: "dedicated" };
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        agent.id,
        configuration.id,
        "dedicated",
      ),
      dedicated,
    );
    assert.deepEqual(
      await transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id),
      dedicated,
    );
    assert.equal(
      (await transaction.revisions.findRevision(namespace.id, agent.id, revision.id))?.harness.mode,
      "embedded",
    );
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        agent.id,
        configuration.id,
        "embedded",
      ),
      agent,
    );
  });

  await assert.rejects(
    store.transact((transaction) =>
      // @ts-expect-error The store also rejects unsupported placement updates at runtime.
      transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id, "remote"),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The Agent execution mode is invalid.",
      postgresOwnershipViolation,
    ),
    "Existing Agent placement must reject unsupported execution modes.",
  );

  for (const [description, malformed] of [
    ["missing Configuration identity", { configurationId: undefined }],
    ["malformed Configuration identity", { configurationId: "cfg_invalid" }],
    ["unsupported Configuration kind", { configurationKind: "gateway" }],
    ["missing Configuration generation", { configurationGeneration: undefined }],
    ["zero Configuration generation", { configurationGeneration: 0 }],
    ["fractional Configuration generation", { configurationGeneration: 1.5 }],
    ["unsafe Configuration generation", { configurationGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ["null draft", { configuration: null }],
    ["array draft", { configuration: [] }],
    ["missing Harness descriptor", { harness: undefined }],
    ["null Harness descriptor", { harness: null }],
    [
      "array Harness descriptor",
      {
        harness: Object.assign([], {
          overrides: {},
          configuration: {},
          id: "openclaw",
          version: "1.0.0",
          mode: "embedded",
        }),
      },
    ],
    [
      "missing Harness version",
      { harness: { overrides: {}, configuration: {}, id: "openclaw", mode: "embedded" } },
    ],
    [
      "missing Harness mode",
      { harness: { overrides: {}, configuration: {}, id: "openclaw", version: "1.0.0" } },
    ],
    [
      "unsupported Harness mode",
      {
        harness: {
          overrides: {},
          configuration: {},
          id: "openclaw",
          version: "1.0.0",
          mode: "remote",
        },
      },
    ],
    [
      "empty Harness identity",
      {
        harness: { overrides: {}, configuration: {}, id: " ", version: "1.0.0", mode: "embedded" },
      },
    ],
    [
      "empty Harness version",
      {
        harness: {
          overrides: {},
          configuration: {},
          id: "openclaw",
          version: " ",
          mode: "embedded",
        },
      },
    ],
    [
      "unexpected Harness property",
      {
        harness: {
          overrides: {},
          configuration: {},
          id: "openclaw",
          version: "1.0.0",
          mode: "embedded",
          unexpected: true,
        },
      },
    ],
    ["missing Harness overrides", { harness: { ...revision.harness, overrides: undefined } }],
    ["null Harness overrides", { harness: { ...revision.harness, overrides: null } }],
    ["missing Harness settings", { harness: { ...revision.harness, configuration: undefined } }],
    ["array Harness settings", { harness: { ...revision.harness, configuration: [] } }],
    ["missing Compute descriptor", { compute: undefined }],
    ["null Compute descriptor", { compute: null }],
    [
      "array Compute descriptor",
      { compute: Object.assign([], { id: "compute-contract", implementation: "deterministic" }) },
    ],
    ["missing Compute implementation", { compute: { id: "compute-contract" } }],
    ["empty Compute identity", { compute: { id: " ", implementation: "deterministic-contract" } }],
    ["empty Compute implementation", { compute: { id: "compute-contract", implementation: " " } }],
    [
      "unexpected Compute property",
      {
        compute: {
          id: "compute-contract",
          implementation: "deterministic-contract",
          unexpected: true,
        },
      },
    ],
  ] as const) {
    await assert.rejects(
      store.transact(async (transaction) => {
        const repository = transaction.revisions;
        // Pass the invalid input through the same runtime call an untyped caller can make.
        await Reflect.apply(repository.createRevision, repository, [
          {
            ...revision,
            id: identifier("rev"),
            revision: 2,
            ...malformed,
          },
        ]);
      }),
      storeRefusal(
        "ScopeViolationError",
        "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
        postgresOwnershipViolation,
      ),
      description,
    );
  }

  await store.read(async (state) => {
    const listed = await state.revisions.listRevisions(namespace.id, agent.id);
    assert.deepEqual(listed, [revision]);
    // Revision metadata lists the same revisions, in the same order, without saved settings.
    assert.deepEqual(
      await state.revisions.listRevisionMetadata(namespace.id, agent.id),
      listed.map(({ id, namespaceId, agentId, revision, backendId, createdAt }) => ({
        id,
        namespaceId,
        agentId,
        revision,
        backendId,
        createdAt,
      })),
    );
    assert.deepEqual(await state.revisions.listRevisionMetadata(identifier("ns"), agent.id), []);
    // A summary page carries metadata plus the fields that tell revisions apart, never the
    // saved settings; `before` excludes the revision it names and everything newer.
    assert.deepEqual(
      await state.revisions.pageRevisionSummaries(namespace.id, agent.id, { limit: 1 }),
      {
        revisions: listed.map((item) => ({
          id: item.id,
          namespaceId: item.namespaceId,
          agentId: item.agentId,
          revision: item.revision,
          backendId: item.backendId,
          configurationId: item.configurationId,
          configurationGeneration: item.configurationGeneration,
          harness: item.harness,
          createdAt: item.createdAt,
        })),
      },
    );
    assert.deepEqual(
      await state.revisions.pageRevisionSummaries(namespace.id, agent.id, {
        before: revision.revision,
        limit: 1,
      }),
      { revisions: [] },
    );
    assert.deepEqual(
      await state.revisions.pageRevisionSummaries(identifier("ns"), agent.id, { limit: 1 }),
      { revisions: [] },
    );
    // Agent references carry only the identity of each Agent in a live Namespace.
    const references = (await state.agents.listAgentReferences()).filter(
      ({ namespaceId }) => namespaceId === namespace.id,
    );
    assert.deepEqual(
      references.sort((left, right) => left.id.localeCompare(right.id)),
      (await state.agents.listAgents(namespace.id))
        .map(({ id, namespaceId }) => ({ id, namespaceId }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.ok(references.some(({ id }) => id === agent.id));
  });

  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.configurations.lockConfiguration(namespace.id, configuration.id),
      configuration,
    );

    // Exact Namespace ownership and the expected generation gate each atomic update.
    assert.equal(
      await transaction.configurations.advanceConfigurationGeneration(
        identifier("ns"),
        configuration.id,
        configuration.generation,
      ),
      undefined,
    );
    assert.equal(
      await transaction.configurations.advanceConfigurationGeneration(
        namespace.id,
        configuration.id,
        configuration.generation + 1,
      ),
      undefined,
    );

    const advanced = await transaction.configurations.advanceConfigurationGeneration(
      namespace.id,
      configuration.id,
      configuration.generation,
    );
    assert.deepEqual(advanced, { ...configuration, generation: 2 });
    assert.equal(
      await transaction.configurations.advanceConfigurationGeneration(
        namespace.id,
        configuration.id,
        configuration.generation,
      ),
      undefined,
      "A stale writer cannot advance the same Configuration generation twice.",
    );

    // Configuration changes never rewrite an already-admitted immutable revision.
    assert.deepEqual(
      await transaction.revisions.findRevision(namespace.id, agent.id, revision.id),
      revision,
    );
  });

  // A failed transaction cannot publish a generation that was only advanced speculatively.
  await assert.rejects(
    store.transact(async (transaction) => {
      assert.equal(
        (
          await transaction.configurations.advanceConfigurationGeneration(
            namespace.id,
            configuration.id,
            2,
          )
        )?.generation,
        3,
      );
      throw new Error("simulated Configuration transaction failure");
    }),
    /simulated Configuration transaction failure/,
  );
  await store.read(async (state) => {
    assert.deepEqual(await state.configurations.findConfiguration(namespace.id, configuration.id), {
      ...configuration,
      generation: 2,
    });
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.configurations.deleteConfiguration(namespace.id, configuration.id),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The Configuration is referenced by an Agent.",
      postgresOwnershipViolation,
    ),
    "A Configuration referenced by an Agent cannot be deleted.",
  );

  const rejectedNamespace = {
    ...namespace,
    id: identifier("ns"),
    name: `Rolled back ${randomUUID()}`,
  };
  const rejectedAudit = event(installation, namespace, agent, "rollback");
  const rejectedOperation = {
    kind: "namespace",
    action: "reconcile",
    target: "ready",
    namespaceId: rejectedNamespace.id,
    resourceId: rejectedNamespace.id,
    actorId: audit.actorId,
  } satisfies PlatformOperation;

  const transactionFailure = new Error("simulated transaction failure");
  let escapedTransaction: PlatformUnitOfWork | undefined;
  await assert.rejects(
    store.transact(async (transaction) => {
      escapedTransaction = transaction;
      await transaction.namespaces.createNamespace(rejectedNamespace);
      await transaction.audit.append(rejectedAudit);
      await transaction.operations.append(rejectedOperation);
      throw transactionFailure;
    }),
    (error) => error === transactionFailure,
  );

  // Use a fresh identity so a duplicate-row conflict cannot masquerade as a
  // closed transaction when the rolled-back memory snapshot is retained.
  assert.ok(escapedTransaction);
  await assert.rejects(
    escapedTransaction.namespaces.createNamespace({
      ...rejectedNamespace,
      id: identifier("ns"),
      name: `Escaped ${randomUUID()}`,
    }),
    { name: "ScopeViolationError", message: "The platform transaction is closed." },
  );

  await store.read(async (state) => {
    assert.equal(await state.namespaces.findNamespace(rejectedNamespace.id), undefined);
  });

  await store.transact(async (transaction) => {
    assert.ok((await transaction.audit.list()).some(({ id }) => id === audit.id));
    assert.ok(!(await transaction.audit.list()).some(({ id }) => id === rejectedAudit.id));
    assert.ok(
      (await transaction.operations.list()).some(({ resourceId }) => resourceId === revision.id),
    );
    assert.ok(
      !(await transaction.operations.list()).some(
        ({ resourceId }) => resourceId === rejectedNamespace.id,
      ),
    );
  });
}
