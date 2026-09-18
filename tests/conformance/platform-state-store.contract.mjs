import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

function identifier(kind) {
  return `${kind}_${randomUUID()}`;
}

function event(installation, namespace, agent, action) {
  return {
    id: identifier("aud"),
    installationId: installation.id,
    namespaceId: namespace.id,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "principal-platform-state-contract",
    action,
    resource: {
      kind: "agent",
      id: agent.id,
      namespaceId: namespace.id,
    },
    outcome: "success",
  };
}

export async function verifyPlatformStateStoreContract(store, options = {}) {
  const installation = options.installation ?? {
    id: identifier("ins"),
    name: `Platform state ${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const namespace = {
    id: identifier("ns"),
    name: `Namespace ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const harnessSecret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: "Harness key " + randomUUID(),
    driverId: "secret-contract",
    backendRef: { namespaceName: "contract", name: "harness-key", key: "value", uid: randomUUID() },
    createdAt: new Date().toISOString(),
  };
  const apiKeyBinding = {
    method: "api_key",
    source: { kind: "secret", namespaceId: namespace.id, id: harnessSecret.id },
  };
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: `Agent ${randomUUID()}`,
    configurationId: configuration.id,
    providerId: null,
    harnessAuth: apiKeyBinding,
    executionMode: "embedded",
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    createdAt: new Date().toISOString(),
  };
  const revision = {
    id: identifier("rev"),
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    providerId: null,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    configuration: {
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1" },
        },
      },
      agents: { defaults: { model: "openai/gpt-5", maxConcurrent: 2 } },
      gateway: { controlUi: { enabled: false } },
    },
    harnessAuth: { ...apiKeyBinding, secretDriverId: harnessSecret.driverId },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-contract", implementation: "deterministic-contract" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: new Date().toISOString(),
  };
  const audit = event(installation, namespace, agent, "deploy");
  const operation = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: namespace.id,
    resourceId: revision.id,
    actorId: audit.actorId,
  };

  await store.transact(async (transaction) => {
    if (!options.installation) {
      assert.deepEqual(
        await transaction.installations.createInstallation(installation),
        installation,
      );
    }
    assert.deepEqual(await transaction.namespaces.createNamespace(namespace), namespace);
    assert.deepEqual(
      await transaction.configurations.createConfiguration(configuration),
      configuration,
    );
    assert.equal(await transaction.namespaces.hasConfigurations(namespace.id), true);
    await transaction.secrets.createSecret(harnessSecret);
    assert.deepEqual(await transaction.agents.createAgent(agent), agent);
    assert.deepEqual(await transaction.revisions.createRevision(revision), revision);
    await transaction.audit.append(audit);
    await transaction.operations.append(operation);
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({
        kind: "agent",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: agent.id,
        actorId: audit.actorId,
      }),
    ),
    "Agent metadata must not enqueue reconciliation work.",
  );

  const providerConfiguration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const providerAgent = {
    ...agent,
    id: identifier("agt"),
    name: `Provider owner ${randomUUID()}`,
    configurationId: providerConfiguration.id,
    providerId: "provider-a",
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    await transaction.configurations.createConfiguration(providerConfiguration);
    await transaction.agents.createAgent(providerAgent);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...revision,
        id: identifier("rev"),
        agentId: providerAgent.id,
        configurationId: providerConfiguration.id,
        providerId: "provider-b",
        servicePrincipalId: providerAgent.servicePrincipalId,
      }),
    ),
    "AgentRevision Provider snapshots must match the owning Agent.",
  );
  await store.read(async (state) => {
    assert.deepEqual(await state.revisions.listRevisions(namespace.id, providerAgent.id), []);
  });
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.agents.updateConfiguration(
        namespace.id,
        providerAgent.id,
        providerConfiguration.id,
        providerAgent.executionMode,
        undefined,
        null,
      ),
      { ...providerAgent, providerId: null },
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
          executionMode,
          servicePrincipalId: identifier("service-agent"),
        }),
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
  ]) {
    // Both persistence adapters reject ownership metadata PostgreSQL cannot safely represent.
    await assert.rejects(
      store.transact((transaction) =>
        transaction.configurations.createConfiguration({
          ...configuration,
          id: identifier("cfg"),
          ...invalidOwnership,
        }),
      ),
      description,
    );
  }

  await store.read(async (state) => {
    assert.deepEqual(await state.installations.getInstallation(), installation);
    assert.deepEqual(await state.namespaces.findNamespace(namespace.id), namespace);
    assert.deepEqual(
      await state.configurations.findConfiguration(namespace.id, configuration.id),
      configuration,
    );
    assert.equal(
      await state.configurations.findConfiguration(identifier("ns"), configuration.id),
      undefined,
    );
    assert.equal(Object.hasOwn(namespace, "installationId"), false);
    assert.deepEqual(await state.agents.findAgent(namespace.id, agent.id), agent);
    assert.equal(await state.agents.findAgent(identifier("ns"), agent.id), undefined);

    const storedRevision = await state.revisions.findRevision(namespace.id, agent.id, revision.id);
    assert.deepEqual(storedRevision, revision);
    assert.ok(Object.isFrozen(storedRevision));
    assert.ok(Object.isFrozen(storedRevision.configuration));
    assert.ok(Object.isFrozen(storedRevision.harness));
    assert.ok(Object.isFrozen(storedRevision.compute));
    assert.ok(Object.isFrozen(storedRevision.harnessAuth));
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
      (await transaction.revisions.findRevision(namespace.id, agent.id, revision.id)).harness.mode,
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
      transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id, "remote"),
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
      { harness: Object.assign([], { id: "openclaw", version: "1.0.0", mode: "embedded" }) },
    ],
    ["missing Harness version", { harness: { id: "openclaw", mode: "embedded" } }],
    ["missing Harness mode", { harness: { id: "openclaw", version: "1.0.0" } }],
    ["unsupported Harness mode", { harness: { id: "openclaw", version: "1.0.0", mode: "remote" } }],
    ["empty Harness identity", { harness: { id: " ", version: "1.0.0", mode: "embedded" } }],
    ["empty Harness version", { harness: { id: "openclaw", version: " ", mode: "embedded" } }],
    [
      "unexpected Harness property",
      { harness: { id: "openclaw", version: "1.0.0", mode: "embedded", unexpected: true } },
    ],
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
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({
          ...revision,
          id: identifier("rev"),
          revision: 2,
          ...malformed,
        }),
      ),
      description,
    );
  }

  await store.read(async (state) => {
    assert.deepEqual(await state.revisions.listRevisions(namespace.id, agent.id), [revision]);
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
        ).generation,
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
  };

  const transactionFailure = new Error("simulated transaction failure");
  let escapedTransaction;
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

  const lifecycleNamespace = {
    id: identifier("ns"),
    name: `Lifecycle ${randomUUID()}`,
    existingNamespace: `existing-${randomUUID()}`,
    status: "provisioning",
    createdAt: new Date().toISOString(),
  };
  const blockedAgent = {
    ...agent,
    id: identifier("agt"),
    namespaceId: lifecycleNamespace.id,
    name: `Blocked ${randomUUID()}`,
    servicePrincipalId: identifier("service-agent"),
  };
  const deletedAt = new Date(Date.now() + 1).toISOString();

  await store.transact((transaction) => transaction.namespaces.createNamespace(lifecycleNamespace));

  // Two live platform tenants cannot concurrently claim the same existing Kubernetes namespace.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        name: `Duplicate existing namespace ${randomUUID()}`,
      }),
    ),
    "An existing Kubernetes namespace cannot be assigned to multiple live platform Namespaces.",
  );

  await store.transact(async (transaction) => {
    assert.equal(
      (await transaction.namespaces.findNamespace(lifecycleNamespace.id)).existingNamespace,
      lifecycleNamespace.existingNamespace,
    );
    assert.equal(
      (await transaction.namespaces.lockNamespace(lifecycleNamespace.id)).existingNamespace,
      lifecycleNamespace.existingNamespace,
    );
    await transaction.operations.append({
      kind: "namespace",
      action: "reconcile",
      target: "ready",
      namespaceId: lifecycleNamespace.id,
      resourceId: lifecycleNamespace.id,
      actorId: audit.actorId,
    });
    assert.equal(
      await transaction.namespaces.transitionNamespaceStatus(
        lifecycleNamespace.id,
        "failed",
        "ready",
      ),
      undefined,
    );
    const readyNamespace = await transaction.namespaces.transitionNamespaceStatus(
      lifecycleNamespace.id,
      "provisioning",
      "ready",
    );
    assert.equal(readyNamespace.status, "ready");
    assert.equal(readyNamespace.existingNamespace, lifecycleNamespace.existingNamespace);
    assert.equal(
      (
        await transaction.namespaces.transitionNamespaceStatus(
          lifecycleNamespace.id,
          "ready",
          "deleting",
        )
      ).status,
      "deleting",
    );
    await transaction.operations.append({
      kind: "namespace",
      action: "reconcile",
      target: "deleted",
      namespaceId: lifecycleNamespace.id,
      resourceId: lifecycleNamespace.id,
      actorId: audit.actorId,
    });
    assert.equal(await transaction.namespaces.hasAgents(lifecycleNamespace.id), false);
    await assert.rejects(transaction.agents.createAgent(blockedAgent), {
      name: "ScopeViolationError",
    });
    const tombstone = await transaction.namespaces.markNamespaceDeleted(
      lifecycleNamespace.id,
      deletedAt,
    );
    assert.equal(tombstone.deletedAt, deletedAt);
    assert.equal(tombstone.existingNamespace, lifecycleNamespace.existingNamespace);
    assert.deepEqual(
      await transaction.namespaces.markNamespaceDeleted(lifecycleNamespace.id, deletedAt),
      tombstone,
    );
  });

  // A deleted failed attempt releases its reservation; physical ownership is still checked by Kubernetes.
  const retryNamespace = await store.transact((transaction) =>
    transaction.namespaces.createNamespace({
      ...lifecycleNamespace,
      id: identifier("ns"),
      name: `Retry existing namespace ${randomUUID()}`,
    }),
  );
  assert.equal(retryNamespace.existingNamespace, lifecycleNamespace.existingNamespace);

  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        name: `Invalid existing namespace ${randomUUID()}`,
        existingNamespace: "Invalid.Namespace",
      }),
    ),
    "An existing Kubernetes namespace must be a valid lowercase DNS label.",
  );

  await store.read(async (state) => {
    assert.equal(await state.namespaces.findNamespace(lifecycleNamespace.id), undefined);
    assert.ok(
      !(await state.namespaces.listNamespaces()).some(({ id }) => id === lifecycleNamespace.id),
    );
  });

  await store.transact(async (transaction) => {
    assert.equal(await transaction.namespaces.lockNamespace(lifecycleNamespace.id), undefined);
    assert.equal(
      (
        await transaction.namespaces.lockNamespace(lifecycleNamespace.id, {
          includeDeleted: true,
        })
      ).deletedAt,
      deletedAt,
    );
    assert.deepEqual(
      (await transaction.operations.list())
        .filter(({ resourceId }) => resourceId === lifecycleNamespace.id)
        .map(({ target }) => target)
        .sort(),
      ["deleted", "ready"],
    );
  });

  const accountNamespace = {
    id: identifier("ns"),
    name: "Service accounts " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const accountConfiguration = {
    id: identifier("cfg"),
    namespaceId: accountNamespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  };
  const account = {
    id: identifier("sa"),
    namespaceId: accountNamespace.id,
    name: "Account " + randomUUID(),
  };
  const credential = {
    kind: "access_token",
    secretRef: { name: "account-source.credentials", key: "account-token" },
  };
  const alternateCredential = {
    kind: "access_token",
    secretRef: { name: "rotated-source", key: "next-account-token" },
  };
  const alternateAccount = {
    id: identifier("sa"),
    namespaceId: accountNamespace.id,
    name: "Alternate " + randomUUID(),
    credential,
  };
  const accountAgent = {
    id: identifier("agt"),
    namespaceId: accountNamespace.id,
    name: "Account agent " + randomUUID(),
    configurationId: accountConfiguration.id,
    providerId: null,
    executionMode: "dedicated",
    servicePrincipalId: identifier("service-agent"),
    harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
    desiredRuntimeState: "stopped",
    createdAt: new Date().toISOString(),
  };
  const sharedAccountAgent = {
    ...accountAgent,
    id: identifier("agt"),
    name: "Shared account agent " + randomUUID(),
    servicePrincipalId: identifier("service-agent"),
  };
  const accountRevision = {
    ...revision,
    id: identifier("rev"),
    namespaceId: accountNamespace.id,
    agentId: accountAgent.id,
    configurationId: accountConfiguration.id,
    configurationGeneration: accountConfiguration.generation,
    servicePrincipalId: accountAgent.servicePrincipalId,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: {
      method: "chatgpt_service_account",
      serviceAccountId: account.id,
      credential,
      providerBinding: {
        providerId: "chatgpt-contract",
        driverId: "service-account-contract",
        workspaceId: "workspace-contract",
        credentialIssued: true,
      },
    },
  };

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(accountNamespace);
    await transaction.configurations.createConfiguration(accountConfiguration);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountNamespace.id), false);
    assert.deepEqual(await transaction.serviceAccounts.createServiceAccount(account), account);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountNamespace.id), true);
    assert.deepEqual(
      await transaction.serviceAccounts.updateCredential(
        accountNamespace.id,
        account.id,
        credential,
      ),
      { ...account, credential },
    );
    assert.deepEqual(
      await transaction.serviceAccounts.createServiceAccount(alternateAccount),
      alternateAccount,
    );
    assert.deepEqual(await transaction.agents.createAgent(accountAgent), accountAgent);
    assert.deepEqual(await transaction.agents.createAgent(sharedAccountAgent), sharedAccountAgent);
    assert.deepEqual(await transaction.revisions.createRevision(accountRevision), accountRevision);
  });

  const oauthCredential = {
    kind: "oauth_access_token",
    secretRef: { name: "oauth-reference", key: "access-token" },
  };
  await store.transact(async (transaction) => {
    const updated = await transaction.serviceAccounts.updateCredential(
      accountNamespace.id,
      account.id,
      oauthCredential,
    );
    assert.deepEqual(updated.credential, oauthCredential);
    await transaction.serviceAccounts.updateCredential(accountNamespace.id, account.id, credential);
  });

  // ChatGPT revisions require an exact issued access-token reference with safe Secret keys.
  for (const invalidCredential of [
    oauthCredential,
    { ...credential, kind: "api_key" },
    ...[".", ".."].map((key) => ({ ...credential, secretRef: { ...credential.secretRef, key } })),
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({
          ...accountRevision,
          id: identifier("rev"),
          revision: 2,
          harnessAuth: {
            ...accountRevision.harnessAuth,
            credential: invalidCredential,
          },
        }),
      ),
      "Admitted revisions reject unsupported credentials and unsafe Secret keys.",
    );
  }

  await store.read(async (state) => {
    const stored = await state.serviceAccounts.findServiceAccount(accountNamespace.id, account.id);
    assert.deepEqual(stored, { ...account, credential });
    for (const value of [stored, stored.credential, stored.credential.secretRef]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.equal(
      await state.serviceAccounts.findServiceAccount(namespace.id, account.id),
      undefined,
      "A ServiceAccount cannot be read from another Namespace.",
    );
    const snapshot = await state.revisions.findRevision(
      accountNamespace.id,
      accountAgent.id,
      accountRevision.id,
    );
    assert.deepEqual(snapshot.harnessAuth, accountRevision.harnessAuth);
    for (const value of [
      snapshot.harnessAuth,
      snapshot.harnessAuth.credential,
      snapshot.harnessAuth.credential.secretRef,
      snapshot.harnessAuth.providerBinding,
    ]) {
      assert.ok(Object.isFrozen(value));
    }
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.serviceAccounts.createServiceAccount({ ...account, id: identifier("sa") }),
    ),
    "ServiceAccount names must be unique within their Namespace.",
  );

  for (const [description, invalidCredential] of [
    ["unsupported credential kind", { kind: "bearer", secretRef: credential.secretRef }],
    [
      "invalid source Secret name",
      { ...credential, secretRef: { name: "../foreign", key: "valid" } },
    ],
    ["invalid source Secret key", { ...credential, secretRef: { name: "valid", key: "../token" } }],
    [
      "current-directory source Secret key",
      { ...credential, secretRef: { name: "valid", key: "." } },
    ],
    [
      "parent-directory source Secret key",
      { ...credential, secretRef: { name: "valid", key: ".." } },
    ],
  ]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.serviceAccounts.updateCredential(
          accountNamespace.id,
          account.id,
          invalidCredential,
        ),
      ),
      description,
    );
  }
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.createAgent({
        ...agent,
        id: identifier("agt"),
        name: "Cross Namespace " + randomUUID(),
        servicePrincipalId: identifier("service-agent"),
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      }),
    ),
    "An Agent cannot associate a ServiceAccount from another Namespace.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
        method: "chatgpt_service_account",
        serviceAccountId: account.id,
      }),
    ),
    "An existing Agent cannot associate a ServiceAccount from another Namespace.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.serviceAccounts.deleteServiceAccount(accountNamespace.id, account.id),
    ),
    "An Agent-bound ServiceAccount cannot be deleted.",
  );

  await store.transact(async (transaction) => {
    assert.ok(
      await transaction.serviceAccounts.lockServiceAccount(accountNamespace.id, account.id),
    );
    await transaction.serviceAccounts.updateCredential(
      accountNamespace.id,
      account.id,
      alternateCredential,
    );
    // Credential updates affect future deployments, never an admitted immutable revision.
    assert.deepEqual(
      (
        await transaction.revisions.findRevision(
          accountNamespace.id,
          accountAgent.id,
          accountRevision.id,
        )
      ).harnessAuth,
      accountRevision.harnessAuth,
    );
    const alternateBinding = {
      method: "chatgpt_service_account",
      serviceAccountId: alternateAccount.id,
    };
    for (const [requested, expected] of [
      [alternateBinding, alternateBinding],
      [undefined, alternateBinding],
      [null, null],
    ]) {
      const updated = await transaction.agents.updateConfiguration(
        accountNamespace.id,
        accountAgent.id,
        accountConfiguration.id,
        undefined,
        requested,
      );
      assert.deepEqual(updated.harnessAuth, expected);
    }
  });

  await assert.rejects(
    store.transact(async (transaction) => {
      await transaction.serviceAccounts.updateCredential(
        accountNamespace.id,
        account.id,
        credential,
      );
      throw new Error("simulated ServiceAccount credential transaction failure");
    }),
    /simulated ServiceAccount credential transaction failure/,
  );
  assert.deepEqual(
    await store.read((state) =>
      state.serviceAccounts.findServiceAccount(accountNamespace.id, account.id),
    ),
    { ...account, credential: alternateCredential },
  );

  await store.transact(async (transaction) => {
    // The second consumer's draft still blocks deletion after the first consumer detaches.
    assert.equal(
      await transaction.serviceAccounts.hasReferences(accountNamespace.id, account.id),
      true,
    );
    assert.equal(await transaction.serviceAccounts.hasReferences(namespace.id, account.id), false);
    await transaction.agents.updateConfiguration(
      accountNamespace.id,
      sharedAccountAgent.id,
      accountConfiguration.id,
      undefined,
      null,
    );
    assert.equal(
      await transaction.serviceAccounts.hasReferences(accountNamespace.id, account.id),
      false,
    );
    // Completed deployment state has an active pointer even after every draft detaches.
    await transaction.agents.compareAndSetActiveRevision(
      accountNamespace.id,
      accountAgent.id,
      undefined,
      accountRevision.id,
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.serviceAccounts.deleteServiceAccount(accountNamespace.id, account.id),
    ),
    "An active revision must protect its account even without pending work or draft references.",
  );
  await store.transact(async (transaction) => {
    const replacementBinding = {
      method: "chatgpt_service_account",
      serviceAccountId: alternateAccount.id,
    };
    await transaction.agents.updateConfiguration(
      accountNamespace.id,
      accountAgent.id,
      accountConfiguration.id,
      undefined,
      replacementBinding,
    );
    const replacement = await transaction.revisions.createRevision({
      ...accountRevision,
      harnessAuth: { ...accountRevision.harnessAuth, serviceAccountId: alternateAccount.id },
      id: identifier("rev"),
      revision: 2,
    });
    await transaction.agents.compareAndSetActiveRevision(
      accountNamespace.id,
      accountAgent.id,
      accountRevision.id,
      replacement.id,
    );
    // Retaining an inactive historical snapshot does not retain the upstream account forever.
    assert.equal(
      await transaction.serviceAccounts.hasReferences(accountNamespace.id, account.id),
      false,
    );
  });

  const accountOnlyNamespace = {
    id: identifier("ns"),
    name: "Account-only " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  const accountOnly = {
    id: identifier("sa"),
    namespaceId: accountOnlyNamespace.id,
    name: "Remaining account " + randomUUID(),
  };
  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(accountOnlyNamespace);
    await transaction.serviceAccounts.createServiceAccount(accountOnly);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountOnlyNamespace.id), true);
    await transaction.namespaces.transitionNamespaceStatus(
      accountOnlyNamespace.id,
      "ready",
      "deleting",
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.markNamespaceDeleted(
        accountOnlyNamespace.id,
        new Date(Date.now() + 1).toISOString(),
      ),
    ),
    "A Namespace containing only a ServiceAccount cannot be tombstoned.",
  );
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.serviceAccounts.deleteServiceAccount(
        accountOnlyNamespace.id,
        accountOnly.id,
      ),
      true,
    );
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountOnlyNamespace.id), false);
    assert.ok(
      await transaction.namespaces.markNamespaceDeleted(
        accountOnlyNamespace.id,
        new Date(Date.now() + 1).toISOString(),
      ),
    );
  });

  return {
    installation,
    namespace,
    agent,
    configuration,
    revision,
    audit,
    operation,
    serviceAccount: { ...account, credential: alternateCredential },
    serviceAccountNamespace: accountNamespace,
    serviceAccountRevision: accountRevision,
    lifecycleNamespace,
    deletedAt,
  };
}
