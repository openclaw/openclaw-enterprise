import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentRevision,
  AgentRevisionSummaryPage,
  Namespace,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRevisionReadRepository,
  PlatformOperation,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import {
  assertCreatedRevision,
  identifier,
  postgresIdentityConflict,
  postgresOwnershipViolation,
  storeRefusal,
  type PlatformStateSeed,
} from "./platform-state-contract-fixture.ts";

export async function verifyPlatformStateLifecycle(
  store: PlatformStateStore,
  seed: Pick<PlatformStateSeed, "agent" | "audit" | "configuration" | "namespace" | "revision">,
  tokenServiceInstanceId: string,
) {
  const { lifecycleNamespace, deletedAt } = await verifyNamespaceLifecycle(store, seed);
  const accounts = await verifyServiceAccountLifecycle(store, seed, tokenServiceInstanceId);
  const lifecycleAgent = await verifyAgentDeletionAdmission(store, seed);
  return { lifecycleNamespace, deletedAt, lifecycleAgent, ...accounts };
}

async function verifyNamespaceLifecycle(
  store: PlatformStateStore,
  { agent, audit }: Pick<PlatformStateSeed, "agent" | "audit">,
) {
  const lifecycleNamespace = {
    id: identifier("ns"),
    name: `Lifecycle ${randomUUID()}`,
    existingNamespace: `existing-${randomUUID()}`,
    status: "provisioning",
    createdAt: new Date().toISOString(),
  } satisfies Namespace;
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
    storeRefusal(
      "ResourceConflictError",
      "The existing Kubernetes namespace is already assigned to a Namespace.",
      postgresIdentityConflict,
    ),
    "An existing Kubernetes namespace cannot be assigned to multiple live platform Namespaces.",
  );

  await store.transact(async (transaction) => {
    const found = await transaction.namespaces.findNamespace(lifecycleNamespace.id);
    assert.ok(found);
    assert.equal(found.existingNamespace, lifecycleNamespace.existingNamespace);
    const locked = await transaction.namespaces.lockNamespace(lifecycleNamespace.id);
    assert.ok(locked);
    assert.equal(locked.existingNamespace, lifecycleNamespace.existingNamespace);
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
    assert.ok(readyNamespace);
    assert.equal(readyNamespace.status, "ready");
    assert.equal(readyNamespace.existingNamespace, lifecycleNamespace.existingNamespace);
    const deletingNamespace = await transaction.namespaces.transitionNamespaceStatus(
      lifecycleNamespace.id,
      "ready",
      "deleting",
    );
    assert.ok(deletingNamespace);
    assert.equal(deletingNamespace.status, "deleting");
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
    // A Namespace being deleted admits no new ServicePrincipal either.
    await assert.rejects(
      transaction.iamPolicy.createServicePrincipal({
        kind: "service_principal",
        id: identifier("spn"),
        namespaceId: lifecycleNamespace.id,
      }),
      { name: "ScopeViolationError" },
    );
    const tombstone = await transaction.namespaces.markNamespaceDeleted(
      lifecycleNamespace.id,
      deletedAt,
    );
    assert.ok(tombstone);
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

  // The tombstone keeps its name, and the conflict says the name belongs to a deleted Namespace.
  await assert.rejects(
    store.transact((transaction) =>
      // @ts-expect-error Exercise name reuse with an explicit undefined reservation.
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        existingNamespace: undefined,
      }),
    ),
    {
      name: "ResourceStateConflictError",
      message:
        "This name belongs to a deleted Namespace and cannot be reused. Choose a different name.",
    },
  );

  await assert.rejects(
    store.transact((transaction) =>
      transaction.namespaces.createNamespace({
        ...lifecycleNamespace,
        id: identifier("ns"),
        name: `Invalid existing namespace ${randomUUID()}`,
        existingNamespace: "Invalid.Namespace",
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The existing Kubernetes namespace name is invalid.",
      postgresOwnershipViolation,
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
    const tombstone = await transaction.namespaces.lockNamespace(lifecycleNamespace.id, {
      includeDeleted: true,
    });
    assert.ok(tombstone);
    assert.equal(tombstone.deletedAt, deletedAt);
    assert.deepEqual(
      (await transaction.operations.list())
        .filter(({ resourceId }) => resourceId === lifecycleNamespace.id)
        .map(({ target }) => target)
        .sort(),
      ["deleted", "ready"],
    );
  });

  return { lifecycleNamespace, deletedAt };
}

async function verifyServiceAccountLifecycle(
  store: PlatformStateStore,
  { namespace, revision }: Pick<PlatformStateSeed, "namespace" | "revision">,
  tokenServiceInstanceId: string,
) {
  const accountNamespace = {
    id: identifier("ns"),
    name: "Service accounts " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  } satisfies Namespace;
  const account = {
    id: identifier("sa"),
    namespaceId: accountNamespace.id,
    name: "Account " + randomUUID(),
  };
  const credential = {
    kind: "access_token",
    sourceId: identifier("cs"),
  } satisfies ServiceAccountCredential;
  const foreignSourceId = identifier("cs");
  const accountConfiguration = {
    id: identifier("cfg"),
    namespaceId: accountNamespace.id,
    kind: "agent",
    generation: 1,
    createdAt: accountNamespace.createdAt,
  } satisfies Parameters<PlatformUnitOfWork["configurations"]["createConfiguration"]>[0];
  const pagingAgent = {
    id: identifier("agt"),
    namespaceId: accountNamespace.id,
    name: "Revision paging " + randomUUID(),
    configurationId: accountConfiguration.id,
    backendId: null,
    executionMode: "embedded",
    gatewayManagedMode: true,
    sandboxPolicyEditing: false,
    servicePrincipalId: identifier("service-agent"),
    harnessAuth: { method: "runtime" },
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt: accountNamespace.createdAt,
  } satisfies Agent;
  const pagingRevision = {
    ...revision,
    id: identifier("rev"),
    namespaceId: accountNamespace.id,
    agentId: pagingAgent.id,
    configurationId: accountConfiguration.id,
    configurationGeneration: accountConfiguration.generation,
    servicePrincipalId: pagingAgent.servicePrincipalId,
    harnessAuth: pagingAgent.harnessAuth,
  } satisfies AgentRevision;

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(accountNamespace);
    await transaction.configurations.createConfiguration(accountConfiguration);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountNamespace.id), false);
    assert.deepEqual(await transaction.serviceAccounts.createServiceAccount(account), account);
    assert.equal(await transaction.namespaces.hasServiceAccounts(accountNamespace.id), true);
    // Model consumers bind to the issued Source, so revision paging is independent of the account.
    await transaction.agents.createAgent(pagingAgent);
    assertCreatedRevision(
      await transaction.revisions.createRevision(pagingRevision),
      pagingRevision,
    );
    const second = { ...pagingRevision, id: identifier("rev"), revision: 2 };
    assertCreatedRevision(await transaction.revisions.createRevision(second), second);

    for (const [id, namespaceId] of [
      [credential.sourceId, accountNamespace.id],
      [foreignSourceId, namespace.id],
    ] as const) {
      await transaction.credentialSources.createCredentialSource({
        id,
        namespaceId,
        name: `Issued account Source ${id}`,
        type: "static",
        ownerCapability: "token_service",
        tokenServiceInstanceId,
        config: { provider_preset: "codex-pat" },
        state: "ready",
        createdAt: accountNamespace.createdAt,
      });
    }
  });

  const update = (issued: ServiceAccountCredential) =>
    store.transact((transaction) =>
      transaction.serviceAccounts.updateCredential(accountNamespace.id, account.id, issued),
    );
  await assert.rejects(
    update({ ...credential, sourceId: foreignSourceId }),
    storeRefusal(
      "ScopeViolationError",
      "The managed ServiceAccount Source is invalid.",
      postgresOwnershipViolation,
    ),
    "An issued Source must belong to the exact account Namespace.",
  );
  await store.transact(async (transaction) => {
    await transaction.credentialSources.markCredentialSourceDeleting(namespace.id, foreignSourceId);
    await transaction.credentialSources.deleteCredentialSource(namespace.id, foreignSourceId);
  });

  for (const [description, invalidCredential] of [
    ["unsupported credential kind", { ...credential, kind: "bearer" }],
    ["invalid issued Source identity", { ...credential, sourceId: "../foreign" }],
    [
      "retired issued token Secret reference",
      { kind: "access_token", secretRef: { name: "retired-token", key: "token" } },
    ],
    [
      "invalid Secret name",
      { kind: "oauth_access_token", secretRef: { name: "../foreign", key: "valid" } },
    ],
    ...["../token", ".", ".."].map(
      (key) =>
        [
          "invalid Secret key",
          { kind: "oauth_access_token", secretRef: { name: "valid", key } },
        ] as const,
    ),
  ] as const) {
    await assert.rejects(
      // @ts-expect-error Unchecked callers can pass unsupported credential shapes.
      update(invalidCredential),
      storeRefusal(
        "ScopeViolationError",
        "The ServiceAccount credential reference is invalid.",
        postgresOwnershipViolation,
      ),
      description,
    );
  }

  // An aborted issuance must leave the account unissued and eligible for retry.
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
    account,
  );
  const issuedAccount = { ...account, credential };
  assert.deepEqual(await update(credential), issuedAccount);
  await store.read(async (state) => {
    const stored = await state.serviceAccounts.findServiceAccount(accountNamespace.id, account.id);
    assert.deepEqual(stored, issuedAccount);
    for (const value of [stored, stored.credential]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.equal(
      await state.serviceAccounts.findServiceAccount(namespace.id, account.id),
      undefined,
      "A ServiceAccount cannot be read from another Namespace.",
    );

    // Revision summary pages run newest first and omit full Configuration data.
    const page = (options: Parameters<AgentRevisionReadRepository["pageRevisionSummaries"]>[2]) =>
      state.revisions.pageRevisionSummaries(accountNamespace.id, pagingAgent.id, options);
    const numbers = (result: AgentRevisionSummaryPage) =>
      result.revisions.map(({ revision }) => revision);
    const first = await page({ limit: 1 });
    assert.deepEqual(numbers(first), [2]);
    assert.strictEqual(first.nextBefore, 2);
    const latest = first.revisions[0];
    assert.ok(latest);
    assert.equal(Object.hasOwn(latest, "configuration"), false);
    assert.deepEqual(latest.harness, pagingRevision.harness);
    const second = await page({ before: first.nextBefore, limit: 1 });
    assert.deepEqual([numbers(second), Object.hasOwn(second, "nextBefore")], [[1], false]);
    const whole = await page({ limit: 5 });
    assert.deepEqual([numbers(whole), Object.hasOwn(whole, "nextBefore")], [[2, 1], false]);
  });

  const accountOnlyNamespace = {
    id: identifier("ns"),
    name: "Account-only " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  } satisfies Namespace;
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
    storeRefusal(
      "ScopeViolationError",
      "A nonempty Namespace cannot be tombstoned.",
      postgresOwnershipViolation,
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

  const unmanagedAccount = {
    ...account,
    id: identifier("sa"),
    name: `Unmanaged account ${randomUUID()}`,
  };
  const serviceAccount = {
    ...unmanagedAccount,
    credential: {
      kind: "oauth_access_token",
      secretRef: { name: "oauth-reference", key: "access-token" },
    } satisfies ServiceAccountCredential,
  };
  await store.transact(async (transaction) => {
    // Later contract cases can select a new TokenService after this case's own Source is gone.
    assert.equal(
      await transaction.serviceAccounts.deleteServiceAccount(accountNamespace.id, account.id),
      true,
    );
    await transaction.credentialSources.markCredentialSourceDeleting(
      accountNamespace.id,
      credential.sourceId,
    );
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(
        accountNamespace.id,
        credential.sourceId,
      ),
      true,
    );
    await transaction.serviceAccounts.createServiceAccount(unmanagedAccount);
    assert.deepEqual(
      await transaction.serviceAccounts.updateCredential(
        accountNamespace.id,
        unmanagedAccount.id,
        serviceAccount.credential,
      ),
      serviceAccount,
    );
  });
  return { accountNamespace, serviceAccount };
}

async function verifyAgentDeletionAdmission(
  store: PlatformStateStore,
  { agent, audit }: Pick<PlatformStateSeed, "agent" | "audit">,
) {
  // Agent deletion is asynchronous, so the status transition is the boundary
  // that stops concurrent mutations from admitting work an in-flight teardown
  // has already enumerated. A dedicated Agent keeps the seeded one usable.
  const lifecycleAgent = {
    ...agent,
    id: identifier("agt"),
    name: `Lifecycle ${randomUUID()}`,
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    const created = await transaction.agents.createAgent(lifecycleAgent);
    assert.equal(created.status, "active", "a created Agent is active");

    // An absent Agent is reported as undefined rather than raising, so callers
    // cannot distinguish a missing Agent from a refused transition.
    assert.equal(
      await transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        identifier("agt"),
        "active",
        "deleting",
      ),
      undefined,
    );

    // A status the Agent does not currently hold does not match.
    assert.equal(
      await transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        lifecycleAgent.id,
        "deleting",
        "deleting",
      ),
      undefined,
    );

    const deleting = await transaction.agents.transitionAgentStatus(
      lifecycleAgent.namespaceId,
      lifecycleAgent.id,
      "active",
      "deleting",
    );
    assert.ok(deleting);
    assert.equal(deleting.status, "deleting");

    // The same call no longer matches, because the Agent has left active. A
    // caller that treats a repeated deletion request as success checks the
    // status first rather than relying on the transition, as deleteNamespace does.
    assert.equal(
      await transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        lifecycleAgent.id,
        "active",
        "deleting",
      ),
      undefined,
    );

    // Re-entering the state the Agent already holds is permitted, so a retry
    // that has already observed `deleting` converges instead of conflicting.
    const unchanged = await transaction.agents.transitionAgentStatus(
      lifecycleAgent.namespaceId,
      lifecycleAgent.id,
      "deleting",
      "deleting",
    );
    assert.ok(unchanged);
    assert.equal(unchanged.status, "deleting");
  });

  // Deleting is terminal: teardown removes the row, so nothing returns to active.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.transitionAgentStatus(
        lifecycleAgent.namespaceId,
        lifecycleAgent.id,
        "deleting",
        "active",
      ),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The Agent lifecycle transition is invalid.",
      postgresOwnershipViolation,
    ),
    "A deleting Agent cannot return to active.",
  );

  // A created Agent always lands active; a caller cannot seed one mid-deletion.
  await store.transact(async (transaction) => {
    const seeded = await transaction.agents.createAgent({
      ...agent,
      id: identifier("agt"),
      name: `Seeded deleting ${randomUUID()}`,
      servicePrincipalId: identifier("service-agent"),
      status: "deleting",
    });
    assert.equal(seeded.status, "active");
  });

  // Agent teardown work carries no revision, unlike revision reconciliation.
  // It must survive persistence and be read back as Agent work rather than
  // being mistaken for Namespace work, which is the other revision-less shape.
  const teardownOperation = {
    kind: "agent",
    action: "reconcile",
    namespaceId: lifecycleAgent.namespaceId,
    resourceId: lifecycleAgent.id,
    actorId: audit.actorId,
    target: "deleted",
  } satisfies PlatformOperation;
  await store.transact((transaction) => transaction.operations.append(teardownOperation));
  await store.transact(async (transaction) => {
    const queued = (await transaction.operations.list()).filter(
      (candidate) => candidate.resourceId === lifecycleAgent.id,
    );
    assert.equal(queued.length, 1, "exactly one teardown item is queued for the Agent");
    assert.deepEqual(queued[0], teardownOperation);
  });

  // Re-requesting teardown converges on the queued item instead of duplicating
  // it, so a retried deletion request cannot enqueue a second teardown.
  await store.transact((transaction) => transaction.operations.append(teardownOperation));
  await store.transact(async (transaction) => {
    assert.equal(
      (await transaction.operations.list()).filter(
        (candidate) => candidate.resourceId === lifecycleAgent.id,
      ).length,
      1,
    );
  });

  // Teardown cannot be queued against an Agent that does not exist in the
  // exact owning Namespace.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.operations.append({ ...teardownOperation, resourceId: identifier("agt") }),
    ),
    { name: "ScopeViolationError", message: "Agent work does not match its exact owner." },
    "teardown work for an absent Agent must be refused",
  );

  return lifecycleAgent;
}
