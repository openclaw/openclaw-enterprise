import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentCredentialSourceBinding,
  AgentRevision,
  CredentialSource,
  CredentialSourceSnapshot,
  CredentialWithdrawal,
  HarnessAuthBinding,
  Namespace,
  Secret,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import type {
  ConfigurationOwnership,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/state/platform-state.ts";
import {
  assertCreatedRevision,
  identifier,
  postgresOwnershipViolation,
  storeRefusal,
} from "./platform-state-contract-fixture.ts";

type AgentDraftInput = Parameters<PlatformUnitOfWork["agents"]["createAgent"]>[0];

type CredentialSourceContractFixtures = {
  namespace: Pick<Namespace, "id">;
  harnessSecret: Pick<Secret, "id">;
  accountNamespace: Pick<Namespace, "id">;
  accountConfiguration: Pick<ConfigurationOwnership, "id">;
  accountAgent: Pick<Agent, "id">;
  revision: AgentRevision;
};

export async function verifyCredentialSourceContract(
  store: PlatformStateStore,
  {
    namespace,
    harnessSecret,
    accountNamespace,
    accountConfiguration,
    accountAgent,
    revision,
  }: CredentialSourceContractFixtures,
): Promise<void> {
  const sourceNamespace = {
    id: identifier("ns"),
    name: "Credential sources " + randomUUID(),
    status: "ready",
    createdAt: new Date().toISOString(),
  } satisfies Namespace;
  const sourceConfiguration = {
    id: identifier("cfg"),
    namespaceId: sourceNamespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  } satisfies ConfigurationOwnership;
  const sourceSecret = {
    id: identifier("sec"),
    namespaceId: sourceNamespace.id,
    name: "Gateway input " + randomUUID(),
    driverId: "secret-contract",
    backendRef: {
      namespaceName: "contract",
      name: "gateway-input",
      key: "value",
      uid: randomUUID(),
    },
    createdAt: new Date().toISOString(),
  } satisfies Secret;
  const source = {
    id: identifier("cs"),
    namespaceId: sourceNamespace.id,
    name: "OpenAI gateway " + randomUUID(),
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: {
      api_key: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id },
    },
    ownerCapability: "credential_gateway",
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt: new Date().toISOString(),
  } satisfies CredentialSource;
  const sourceBinding = {
    method: "credential_source",
    sourceId: source.id,
  } satisfies HarnessAuthBinding;
  const listedSnapshot = {
    sourceId: source.id,
    credentialGatewayId: source.driverId,
    sourceType: source.type,
  } satisfies CredentialSourceSnapshot;
  const sourceAgent = {
    id: identifier("agt"),
    namespaceId: sourceNamespace.id,
    name: "Credential source agent " + randomUUID(),
    configurationId: sourceConfiguration.id,
    backendId: null,
    harnessAuth: sourceBinding,
    // The list holds every bound source; harnessAuth names the listed Harness source.
    credentialSources: [{ sourceId: source.id }],
    executionMode: "embedded",
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt: new Date().toISOString(),
  } satisfies AgentDraftInput;
  const sourceRevision = {
    ...revision,
    id: identifier("rev"),
    namespaceId: sourceNamespace.id,
    agentId: sourceAgent.id,
    configurationId: sourceConfiguration.id,
    configurationGeneration: sourceConfiguration.generation,
    servicePrincipalId: sourceAgent.servicePrincipalId,
    harnessAuth: {
      ...sourceBinding,
      credentialGatewayId: source.driverId,
      sourceType: source.type,
      loginMode: "api_key",
    },
    credentialSources: [listedSnapshot] satisfies [CredentialSourceSnapshot],
  } satisfies AgentRevision;
  const sourceReferences = (transaction: PlatformUnitOfWork) =>
    transaction.credentialSources.hasReferences(sourceNamespace.id, source.id);

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(sourceNamespace);
    await transaction.configurations.createConfiguration(sourceConfiguration);
    await transaction.secrets.createSecret(sourceSecret);
    assert.equal(await transaction.namespaces.hasCredentialSources(sourceNamespace.id), false);
    assert.deepEqual(await transaction.credentialSources.createCredentialSource(source), source);
    assert.equal(await transaction.namespaces.hasCredentialSources(sourceNamespace.id), true);
    assert.deepEqual(
      await transaction.credentialSources.lockCredentialSource(sourceNamespace.id, source.id),
      source,
    );
  });

  await store.read(async (state) => {
    // Secret inputs round-trip as exact same-Namespace references, never values.
    assert.deepEqual(
      await state.credentialSources.findCredentialSource(sourceNamespace.id, source.id),
      source,
    );
    assert.deepEqual(await state.credentialSources.listCredentialSources(sourceNamespace.id), [
      source,
    ]);
    assert.equal(
      await state.credentialSources.findCredentialSource(namespace.id, source.id),
      undefined,
      "A credential source cannot be read from another Namespace.",
    );
    assert.deepEqual(await state.credentialSources.listCredentialSources(namespace.id), []);
  });

  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.createCredentialSource({ ...source, id: identifier("cs") }),
    ),
    {
      name: "ResourceStateConflictError",
      message:
        "A credential source with this name already exists in this Namespace. Choose a different name.",
    },
    "Credential source names must be unique within their Namespace.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.createCredentialSource({
        ...source,
        id: identifier("cs"),
        name: "Foreign input " + randomUUID(),
        secrets: {
          api_key: { kind: "secret", namespaceId: sourceNamespace.id, id: harnessSecret.id },
        },
      }),
    ),
    storeRefusal(
      "ScopeViolationError",
      "The credential source references an unavailable Secret.",
      postgresOwnershipViolation,
    ),
    "A credential source cannot use a Secret owned by another Namespace.",
  );

  // Names are Namespace-scoped; a source without Secret inputs is valid.
  const namesakeSource = {
    ...source,
    id: identifier("cs"),
    namespaceId: accountNamespace.id,
    config: {},
    secrets: {},
  };
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.credentialSources.createCredentialSource(namesakeSource),
      namesakeSource,
    );
  });

  // Registration is recorded before the gateway write: a registering source becomes ready
  // exactly once, may instead move to deleting, and never returns to registering.
  const registeringSource = {
    ...namesakeSource,
    id: identifier("cs"),
    name: "Registering gateway " + randomUUID(),
    state: "registering",
  } satisfies CredentialSource;
  const abandonedSource = {
    ...registeringSource,
    id: identifier("cs"),
    name: "Abandoned gateway " + randomUUID(),
  };
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(registeringSource);
    await transaction.credentialSources.createCredentialSource(abandonedSource);
    assert.deepEqual(
      await transaction.credentialSources.markCredentialSourceReady(
        accountNamespace.id,
        registeringSource.id,
      ),
      { ...registeringSource, state: "ready" },
    );
    assert.equal(
      await transaction.credentialSources.markCredentialSourceReady(
        accountNamespace.id,
        registeringSource.id,
      ),
      undefined,
    );
    assert.deepEqual(
      await transaction.credentialSources.markCredentialSourceDeleting(
        accountNamespace.id,
        abandonedSource.id,
      ),
      { ...abandonedSource, state: "deleting" },
    );
    assert.equal(
      await transaction.credentialSources.markCredentialSourceReady(
        accountNamespace.id,
        abandonedSource.id,
      ),
      undefined,
    );
    for (const { id } of [registeringSource, abandonedSource]) {
      assert.equal(
        await transaction.credentialSources.deleteCredentialSource(accountNamespace.id, id),
        true,
      );
    }
  });

  // A registered source keeps its Secret inputs; deleting one would strand the gateway copy.
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.secrets.hasReferences(sourceNamespace.id, sourceSecret.id),
      true,
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.secrets.deleteSecret(sourceNamespace.id, sourceSecret.id),
    ),
    { name: "ScopeViolationError", message: "The Secret is referenced by active platform state." },
    "A Secret used by a credential source cannot be deleted.",
  );

  // Exercise listed-only readiness and Proxy ownership without adding retained references
  // to the lifecycle fixture below. A successful insertion is rolled back deliberately.
  const probeRollback = new Error("rollback listed source checks");
  await assert.rejects(
    store.transact(async (transaction) => {
      const probeAgent = {
        ...sourceAgent,
        id: identifier("agt"),
        name: "Listed source probe",
        servicePrincipalId: identifier("service-agent"),
        harnessAuth: { method: "runtime" },
      } satisfies AgentDraftInput;
      await transaction.agents.createAgent(probeAgent);
      const probeRevision = {
        ...sourceRevision,
        id: identifier("rev"),
        agentId: probeAgent.id,
        servicePrincipalId: probeAgent.servicePrincipalId,
        harnessAuth: { method: "runtime" },
      } satisfies AgentRevision;
      const second = { ...source, id: identifier("cs"), name: "Second listed source" };
      await transaction.credentialSources.createCredentialSource(second);
      const pairAgent = {
        ...sourceAgent,
        id: identifier("agt"),
        name: "Two listed sources",
        servicePrincipalId: identifier("service-agent"),
        credentialSources: [{ sourceId: source.id }, { sourceId: second.id }],
      };
      await transaction.agents.createAgent(pairAgent);
      await assert.rejects(
        transaction.revisions.createRevision({
          ...sourceRevision,
          id: identifier("rev"),
          agentId: pairAgent.id,
          servicePrincipalId: pairAgent.servicePrincipalId,
          credentialSources: [
            listedSnapshot,
            { sourceId: second.id, sourceType: second.type, credentialProxyId: second.driverId },
          ],
        }),
        {
          name: "ScopeViolationError",
          message:
            "The AgentRevision credential source snapshot does not match its current owner or type.",
        },
      );
      await transaction.credentialSources.markCredentialSourceDeleting(
        sourceNamespace.id,
        source.id,
      );
      await assert.rejects(transaction.revisions.createRevision(probeRevision), {
        name: "ScopeViolationError",
        message: "The AgentRevision references an unavailable credential source.",
      });
      const installation = await transaction.installations.getInstallation();
      assert.ok(installation);
      const proxyId = identifier("cs");
      const proxy = {
        ...source,
        id: proxyId,
        name: "Listed proxy",
        ownerCapability: "credential_proxy",
        egress: {
          key: {
            installationId: installation.id,
            namespaceId: sourceNamespace.id,
            source: { id: proxyId, generation: 1 },
            backend: { id: "contract-backend", generation: 1 },
            provider: { id: source.driverId, generation: 1 },
          },
          schemaVersion: 1,
          adoption: "live",
          retention: "none",
          materialRefId: "contract-material",
          secret: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id },
          secretDriver: { id: sourceSecret.driverId, generation: 1 },
          sender: { id: "contract-sender", generation: 1 },
          resolver: { id: "contract-resolver", generation: 1 },
        },
      } satisfies CredentialSource;
      await transaction.credentialSources.createCredentialSource(proxy);
      const proxyAgent = {
        ...probeAgent,
        id: identifier("agt"),
        name: "Proxy listing",
        servicePrincipalId: identifier("service-agent"),
        credentialSources: [{ sourceId: proxyId }],
      };
      await transaction.agents.createAgent(proxyAgent);
      const proxyRevision = {
        ...probeRevision,
        agentId: proxyAgent.id,
        servicePrincipalId: proxyAgent.servicePrincipalId,
        credentialSources: [
          { sourceId: proxyId, sourceType: source.type, credentialProxyId: source.driverId },
        ],
      } satisfies AgentRevision;
      assertCreatedRevision(
        await transaction.revisions.createRevision(proxyRevision),
        proxyRevision,
      );
      const registering = {
        ...source,
        id: identifier("cs"),
        name: "Listed registering",
        state: "registering",
      } satisfies CredentialSource;
      await transaction.credentialSources.createCredentialSource(registering);
      const registeringAgent = {
        ...probeAgent,
        id: identifier("agt"),
        name: "Registering listing",
        servicePrincipalId: identifier("service-agent"),
        credentialSources: [{ sourceId: registering.id }],
      };
      await transaction.agents.createAgent(registeringAgent);
      await assert.rejects(
        transaction.revisions.createRevision({
          ...probeRevision,
          id: identifier("rev"),
          agentId: registeringAgent.id,
          servicePrincipalId: registeringAgent.servicePrincipalId,
          credentialSources: [{ ...listedSnapshot, sourceId: registering.id }],
        }),
        {
          name: "ScopeViolationError",
          message: "The AgentRevision references an unavailable credential source.",
        },
      );
      throw probeRollback;
    }),
    (error) => error === probeRollback,
  );

  await store.transact(async (transaction) => {
    assert.equal(await sourceReferences(transaction), false);
    await transaction.agents.createAgent(sourceAgent);
    // The Agent draft binding alone retains the source.
    assert.equal(await sourceReferences(transaction), true);
    // Each mismatch has one cause; capability changes retain the real Driver ID.
    for (const change of [
      {
        harnessAuth: { ...sourceRevision.harnessAuth, credentialGatewayId: "wrong-owner" },
        credentialSources: [{ ...listedSnapshot, credentialGatewayId: "wrong-owner" }],
      },
      { harnessAuth: { ...sourceRevision.harnessAuth, credentialGatewayId: "wrong-owner" } },
      { credentialSources: [{ ...listedSnapshot, credentialGatewayId: "wrong-owner" }] },
      { credentialSources: [{ ...listedSnapshot, sourceType: "other" }] },
      {
        credentialSources: [
          { sourceId: source.id, sourceType: source.type, credentialProxyId: source.driverId },
        ],
      },
    ] satisfies Partial<Pick<AgentRevision, "harnessAuth" | "credentialSources">>[]) {
      await assert.rejects(transaction.revisions.createRevision({ ...sourceRevision, ...change }), {
        name: "ScopeViolationError",
        message:
          "The AgentRevision credential source snapshot does not match its current owner or type.",
      });
    }
    // The refusal consumes neither the revision ID nor its number; retry correctly below.
    const mutableRevision = structuredClone(sourceRevision);
    const insertion = transaction.revisions.createRevision(mutableRevision);
    mutableRevision.credentialSources[0] = {
      ...mutableRevision.credentialSources[0],
      credentialGatewayId: "changed-after-entry",
    };
    assertCreatedRevision(await insertion, sourceRevision);
    await transaction.agents.updateConfiguration(
      sourceNamespace.id,
      sourceAgent.id,
      sourceConfiguration.id,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    // An inactive historical snapshot does not retain the source.
    assert.equal(await sourceReferences(transaction), false);
    await transaction.agents.compareAndSetActiveRevision(
      sourceNamespace.id,
      sourceAgent.id,
      undefined,
      sourceRevision.id,
    );
    assert.equal(await sourceReferences(transaction), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.deleteCredentialSource(sourceNamespace.id, source.id),
    ),
    {
      name: "ScopeViolationError",
      message: "The credential source is referenced by active platform state.",
    },
    "An active revision's credential source cannot be deleted.",
  );
  const blocking = (transaction: PlatformUnitOfWork) =>
    transaction.credentialSources.findBlockingReference(sourceNamespace.id, source.id);
  // Queued withdrawal work for a revision that held the source blocks deletion on its own, and
  // is reported as such so the refusal can say that only waiting helps. Rolled back.
  const rollback = new Error("roll back the withdrawal-only case");
  await assert.rejects(
    store.transact(async (transaction) => {
      await transaction.agents.compareAndClearActiveRevision(
        sourceNamespace.id,
        sourceAgent.id,
        sourceRevision.id,
      );
      await transaction.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        target: "credentials_withdrawn",
        operationId: "withdrawal-blocking-contract",
        namespaceId: sourceNamespace.id,
        resourceId: sourceRevision.id,
        actorId: "principal-platform-state-contract",
      });
      assert.equal(await blocking(transaction), "withdrawal_work");
      assert.equal(await sourceReferences(transaction), true);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await store.transact(async (transaction) => {
    await transaction.agents.compareAndClearActiveRevision(
      sourceNamespace.id,
      sourceAgent.id,
      sourceRevision.id,
    );
    assert.equal(await sourceReferences(transaction), false);
    assert.equal(await blocking(transaction), undefined);
    // A queued deployment will attach the source, so it must survive until that work settles.
    await transaction.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: sourceNamespace.id,
      resourceId: sourceRevision.id,
      actorId: "principal-platform-state-contract",
    });
    assert.equal(await sourceReferences(transaction), true);
    assert.equal(await blocking(transaction), "reference");
    assert.equal(
      await transaction.credentialSources.hasReferences(accountNamespace.id, source.id),
      false,
    );
  });

  // A withdrawal is keyed by revision and source: replays return the recorded request, and
  // revocation is recorded once.
  const withdrawal = {
    namespaceId: sourceNamespace.id,
    agentId: sourceAgent.id,
    revisionId: sourceRevision.id,
    credentialSourceId: source.id,
    state: "pending",
    requestedBy: "principal-platform-state-contract",
    requestedAt: new Date().toISOString(),
  } satisfies CredentialWithdrawal;
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.credentialSources.requestCredentialWithdrawal(withdrawal),
      withdrawal,
    );
    assert.deepEqual(
      await transaction.credentialSources.requestCredentialWithdrawal({
        ...withdrawal,
        requestedBy: "principal-platform-state-replay",
        requestedAt: new Date(Date.now() + 1000).toISOString(),
      }),
      withdrawal,
    );
    // Withdrawal work targets the revision without replacing its deployment work.
    await transaction.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      target: "credentials_withdrawn",
      operationId: "withdrawal-contract",
      namespaceId: sourceNamespace.id,
      resourceId: sourceRevision.id,
      actorId: "principal-platform-state-contract",
    });
  });
  await store.read(async (state) => {
    assert.deepEqual(
      await state.credentialSources.listCredentialWithdrawals(
        sourceNamespace.id,
        sourceRevision.id,
      ),
      [withdrawal],
    );
    const revisionWork = (await state.operations.list()).filter(
      (operation) =>
        operation.kind === "agent_revision" && operation.resourceId === sourceRevision.id,
    );
    assert.deepEqual(revisionWork.map(({ target }) => target ?? "deploy").sort(), [
      "credentials_withdrawn",
      "deploy",
    ]);
    const work = await state.operations.findWork(
      `agent_revision:${sourceRevision.id}:reconcile:credentials_withdrawn:withdrawal-contract`,
    );
    assert.ok(work);
    assert.equal(work.agentTarget, "credentials_withdrawn");
    assert.equal(work.revisionId, sourceRevision.id);
    const deployment = await state.operations.findWork(
      `agent_revision:${sourceRevision.id}:reconcile`,
    );
    assert.ok(deployment);
    assert.equal(deployment.agentTarget, undefined);
  });
  // A pending withdrawal can be reassigned to the operator whose replay queues its next attempt;
  // it keeps the first request's time.
  await store.transact(async (transaction) => {
    assert.deepEqual(
      await transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        "principal-platform-state-replay",
      ),
      { ...withdrawal, requestedBy: "principal-platform-state-replay" },
    );
    // The worker reads the stored requester, so the reassignment must persist.
    assert.deepEqual(
      await transaction.credentialSources.listCredentialWithdrawals(
        sourceNamespace.id,
        sourceRevision.id,
      ),
      [{ ...withdrawal, requestedBy: "principal-platform-state-replay" }],
    );
    // A blank requester is refused; the worker would have no principal to authorize. Pinned on
    // a pending withdrawal, the only kind the controller reassigns.
    await assert.rejects(
      transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        "",
      ),
      { name: "ScopeViolationError", message: "A credential withdrawal requester is missing." },
    );
    assert.deepEqual(
      await transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        withdrawal.requestedBy,
      ),
      withdrawal,
    );
  });
  const completedAt = new Date().toISOString();
  const attempted = {
    ...withdrawal,
    lastReason: "CREDENTIAL_WITHDRAWAL_PENDING",
    lastAttemptAt: completedAt,
  };
  await store.transact(async (transaction) => {
    // The worker's latest outcome is recorded on the pending withdrawal it explains.
    assert.deepEqual(
      await transaction.credentialSources.recordCredentialWithdrawalAttempt(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        { reason: "CREDENTIAL_WITHDRAWAL_PENDING", at: completedAt },
      ),
      attempted,
    );
    assert.deepEqual(
      await transaction.credentialSources.markCredentialWithdrawalRevoked(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        completedAt,
      ),
      { ...attempted, state: "revoked", completedAt },
    );
    assert.equal(
      await transaction.credentialSources.recordCredentialWithdrawalAttempt(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        { reason: "CREDENTIALS_WITHDRAWN", at: completedAt },
      ),
      undefined,
    );
    assert.equal(
      await transaction.credentialSources.markCredentialWithdrawalRevoked(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        completedAt,
      ),
      undefined,
    );
    // A revoked withdrawal keeps the requester whose authority revoked it.
    assert.equal(
      await transaction.credentialSources.reassignCredentialWithdrawal(
        sourceNamespace.id,
        sourceRevision.id,
        source.id,
        "principal-platform-state-replay",
      ),
      undefined,
    );
  });

  // An update may point the existing field at a replacement Secret, but never change fields.
  const replacementSecret = {
    ...sourceSecret,
    id: identifier("sec"),
    name: "Replacement model key " + randomUUID(),
    backendRef: { ...sourceSecret.backendRef, name: "replacement-model-key", uid: randomUUID() },
  };
  const replacementRef = {
    kind: "secret",
    namespaceId: sourceNamespace.id,
    id: replacementSecret.id,
  } satisfies SecretReference;
  await store.transact(async (transaction) => {
    await transaction.secrets.createSecret(replacementSecret);
    assert.deepEqual(
      await transaction.credentialSources.replaceCredentialSourceSecrets(
        sourceNamespace.id,
        source.id,
        { api_key: replacementRef },
      ),
      { ...source, secrets: { api_key: replacementRef } },
    );
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.replaceCredentialSourceSecrets(sourceNamespace.id, source.id, {
        other_key: replacementRef,
      }),
    ),
    { name: "ScopeViolationError", message: "Credential source Secret fields cannot change." },
    "A credential source update cannot change its Secret fields.",
  );
  // Restore the original reference so later cases keep their Secret dependency.
  await store.transact((transaction) =>
    transaction.credentialSources.replaceCredentialSourceSecrets(sourceNamespace.id, source.id, {
      api_key: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id },
    }),
  );

  // A non-model source binds through the Agent's credentialSources list. The draft and the
  // active revision each retain it, and a revision freezes exactly the draft's list.
  const tokenSource = {
    ...source,
    id: identifier("cs"),
    name: "Registry token " + randomUUID(),
    type: "bearer-token",
    config: { host: "registry.example.com", env_var: "REGISTRY_TOKEN" },
    secrets: { token: { kind: "secret", namespaceId: sourceNamespace.id, id: sourceSecret.id } },
  } satisfies CredentialSource;
  const toolAgent = {
    ...sourceAgent,
    id: identifier("agt"),
    name: "Credential source tool agent " + randomUUID(),
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: tokenSource.id }],
    servicePrincipalId: identifier("service-agent"),
  } satisfies AgentDraftInput;
  const toolRevision = {
    ...sourceRevision,
    id: identifier("rev"),
    agentId: toolAgent.id,
    servicePrincipalId: toolAgent.servicePrincipalId,
    harnessAuth: { method: "runtime" },
    credentialSources: [
      {
        sourceId: tokenSource.id,
        credentialGatewayId: tokenSource.driverId,
        sourceType: tokenSource.type,
      },
    ],
  } satisfies AgentRevision;
  const tokenReferences = (transaction: PlatformUnitOfWork) =>
    transaction.credentialSources.hasReferences(sourceNamespace.id, tokenSource.id);
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(tokenSource);
    await transaction.agents.createAgent(toolAgent);
    const saved = await transaction.agents.findAgent(sourceNamespace.id, toolAgent.id);
    assert.ok(saved);
    assert.deepEqual(saved.credentialSources, [{ sourceId: tokenSource.id }]);
    assert.equal(await tokenReferences(transaction), true);
  });
  // An untyped caller can supply undefined for the list. The store must still require
  // the snapshots for the Agent's bound sources.
  await assert.rejects(
    store.transact((transaction) =>
      Reflect.apply(transaction.revisions.createRevision, transaction.revisions, [
        { ...toolRevision, credentialSources: undefined },
      ]),
    ),
    { name: "ScopeViolationError", message: "The AgentRevision belongs to an unavailable Agent." },
    "A revision must freeze the Agent's non-model sources.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.deleteCredentialSource(sourceNamespace.id, tokenSource.id),
    ),
    {
      name: "ScopeViolationError",
      message: "The credential source is referenced by active platform state.",
    },
    "An Agent draft's non-model source cannot be deleted.",
  );
  await store.transact(async (transaction) => {
    assertCreatedRevision(await transaction.revisions.createRevision(toolRevision), toolRevision);
    await transaction.agents.compareAndSetActiveRevision(
      sourceNamespace.id,
      toolAgent.id,
      undefined,
      toolRevision.id,
    );
    // An empty list removes the draft binding; the active revision still retains the source.
    const cleared = await transaction.agents.updateConfiguration(
      sourceNamespace.id,
      toolAgent.id,
      sourceConfiguration.id,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    assert.ok(cleared);
    assert.equal(cleared.credentialSources, undefined);
    assert.equal(await tokenReferences(transaction), true);
    await transaction.agents.compareAndClearActiveRevision(
      sourceNamespace.id,
      toolAgent.id,
      toolRevision.id,
    );
    assert.equal(await tokenReferences(transaction), false);
    // Queued work for a revision that froze the source will attach it.
    await transaction.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: sourceNamespace.id,
      resourceId: toolRevision.id,
      actorId: "principal-platform-state-contract",
    });
    assert.equal(await tokenReferences(transaction), true);
  });

  // The store keeps a draft's list exact: every entry names a source in the Agent's Namespace,
  // and a credential-source Harness binding names a listed one.
  const secondToken = {
    ...tokenSource,
    id: identifier("cs"),
    name: "Second token " + randomUUID(),
  };
  const missingSourceId = identifier("cs");
  const listedAgent = {
    ...toolAgent,
    id: identifier("agt"),
    name: "Credential source listed agent " + randomUUID(),
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact((transaction) =>
    transaction.credentialSources.createCredentialSource(secondToken),
  );
  for (const [agent, why] of [
    [
      { ...listedAgent, credentialSources: [{ sourceId: missingSourceId }] },
      "A draft cannot list a missing source.",
    ],
    [
      {
        ...listedAgent,
        harnessAuth: sourceBinding,
        credentialSources: [{ sourceId: tokenSource.id }],
      },
      "A draft's Harness source must be listed.",
    ],
  ] satisfies [AgentDraftInput, string][]) {
    await assert.rejects(
      store.transact((transaction) => transaction.agents.createAgent(agent)),
      { name: "ScopeViolationError" },
      why,
    );
  }
  const updateList = (
    credentialSources?: readonly AgentCredentialSourceBinding[],
    harnessAuth?: HarnessAuthBinding,
  ) =>
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        sourceNamespace.id,
        listedAgent.id,
        sourceConfiguration.id,
        undefined,
        harnessAuth,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        credentialSources,
      ),
    );
  await store.transact((transaction) => transaction.agents.createAgent(listedAgent));
  await assert.rejects(
    updateList([{ sourceId: missingSourceId }]),
    { name: "ScopeViolationError" },
    "An update cannot list a missing source.",
  );
  // An update that leaves the list out keeps it.
  const retainedList = await updateList(undefined, { method: "runtime" });
  assert.ok(retainedList);
  assert.deepEqual(retainedList.credentialSources, [{ sourceId: tokenSource.id }]);
  const orderedList = await updateList([
    { sourceId: secondToken.id },
    { sourceId: tokenSource.id },
  ]);
  assert.ok(orderedList);
  assert.deepEqual(orderedList.credentialSources, [
    { sourceId: secondToken.id },
    { sourceId: tokenSource.id },
  ]);

  // A revision freezes exactly the draft's list, in order, as well-formed snapshots.
  const snapshot = (sourceId: string) =>
    ({
      sourceId,
      credentialGatewayId: (sourceId === secondToken.id ? secondToken : tokenSource).driverId,
      sourceType: tokenSource.type,
    }) satisfies CredentialSourceSnapshot;
  const listedRevision = {
    ...toolRevision,
    id: identifier("rev"),
    agentId: listedAgent.id,
    servicePrincipalId: listedAgent.servicePrincipalId,
    credentialSources: [snapshot(secondToken.id), snapshot(tokenSource.id)],
  };
  // Storage also validates the closed snapshot shape when an untyped caller adds a field.
  const snapshotWithExtraField = { ...snapshot(secondToken.id), driverId: "elsewhere" };
  for (const [credentialSources, why] of [
    [[snapshot(tokenSource.id), snapshot(secondToken.id)], "out of order"],
    [[...listedRevision.credentialSources, snapshot(missingSourceId)], "with an extra source"],
    [[snapshotWithExtraField, snapshot(tokenSource.id)], "with an extra field"],
    [
      [{ ...snapshot(secondToken.id), credentialGatewayId: "" }, snapshot(tokenSource.id)],
      "without a gateway",
    ],
  ] satisfies [CredentialSourceSnapshot[], string][]) {
    await assert.rejects(
      store.transact((transaction) =>
        transaction.revisions.createRevision({ ...listedRevision, credentialSources }),
      ),
      { name: "ScopeViolationError" },
      `A revision cannot freeze the draft's sources ${why}.`,
    );
  }
  await store.transact(async (transaction) => {
    assertCreatedRevision(
      await transaction.revisions.createRevision(listedRevision),
      listedRevision,
    );
  });
  // A draft without sources freezes none: an empty snapshot list is not a valid form of that.
  const unlistedAgent = {
    ...listedAgent,
    id: identifier("agt"),
    name: "Credential source unlisted agent " + randomUUID(),
    credentialSources: undefined,
    servicePrincipalId: identifier("service-agent"),
  };
  // The same untyped caller can create a draft with no bindings. That draft still cannot
  // admit a revision with an explicitly empty snapshot list.
  await store.transact((transaction) =>
    Reflect.apply(transaction.agents.createAgent, transaction.agents, [unlistedAgent]),
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.revisions.createRevision({
        ...listedRevision,
        id: identifier("rev"),
        agentId: unlistedAgent.id,
        servicePrincipalId: unlistedAgent.servicePrincipalId,
        credentialSources: [],
      }),
    ),
    { name: "ScopeViolationError" },
    "A revision cannot freeze an empty source list.",
  );

  // An update that leaves harnessAuth out keeps the stored binding without checking it again;
  // only a supplied binding must be available. Here the bound source is already deleting.
  const staleSource = {
    ...source,
    id: identifier("cs"),
    name: "Stale Harness source " + randomUUID(),
  };
  const staleBinding = {
    method: "credential_source",
    sourceId: staleSource.id,
  } satisfies HarnessAuthBinding;
  const staleAgent = {
    ...sourceAgent,
    id: identifier("agt"),
    name: "Stale Harness source agent " + randomUUID(),
    harnessAuth: staleBinding,
    credentialSources: [{ sourceId: staleSource.id }],
    servicePrincipalId: identifier("service-agent"),
  };
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(staleSource);
    await transaction.agents.createAgent(staleAgent);
    const deleting = await transaction.credentialSources.markCredentialSourceDeleting(
      sourceNamespace.id,
      staleSource.id,
    );
    assert.ok(deleting);
    assert.equal(deleting.state, "deleting");
  });
  const kept = await store.transact((transaction) =>
    transaction.agents.updateConfiguration(
      sourceNamespace.id,
      staleAgent.id,
      sourceConfiguration.id,
      "dedicated",
    ),
  );
  assert.ok(kept);
  assert.deepEqual(
    {
      executionMode: kept.executionMode,
      harnessAuth: kept.harnessAuth,
      credentialSources: kept.credentialSources,
    },
    {
      executionMode: "dedicated",
      harnessAuth: staleBinding,
      credentialSources: staleAgent.credentialSources,
    },
    "Omitting harnessAuth keeps the stored binding without checking it again.",
  );
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        sourceNamespace.id,
        staleAgent.id,
        sourceConfiguration.id,
        undefined,
        staleBinding,
      ),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable credential source.",
    },
    "Supplying the same binding again checks it.",
  );
  const detached = await store.transact((transaction) =>
    transaction.agents.updateConfiguration(
      sourceNamespace.id,
      staleAgent.id,
      sourceConfiguration.id,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    ),
  );
  assert.ok(detached);
  assert.deepEqual(
    { harnessAuth: detached.harnessAuth, credentialSources: detached.credentialSources },
    { harnessAuth: null, credentialSources: undefined },
  );

  // Deletion is two-phase: a deleting source stays recorded and blocks Namespace
  // teardown, but new bindings refuse it.
  await store.transact(async (transaction) => {
    const deleting = await transaction.credentialSources.markCredentialSourceDeleting(
      accountNamespace.id,
      namesakeSource.id,
    );
    assert.deepEqual(deleting, { ...namesakeSource, state: "deleting" });
    assert.equal(
      await transaction.credentialSources.markCredentialSourceDeleting(
        accountNamespace.id,
        namesakeSource.id,
      ),
      undefined,
    );
    assert.equal(await transaction.namespaces.hasCredentialSources(accountNamespace.id), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.updateConfiguration(
        accountNamespace.id,
        accountAgent.id,
        accountConfiguration.id,
        undefined,
        { method: "credential_source", sourceId: namesakeSource.id },
      ),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable credential source.",
    },
    "A deleting credential source cannot be newly bound.",
  );
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(
        accountNamespace.id,
        namesakeSource.id,
      ),
      true,
    );
    assert.equal(
      await transaction.credentialSources.findCredentialSource(
        accountNamespace.id,
        namesakeSource.id,
      ),
      undefined,
    );
    assert.equal(await transaction.namespaces.hasCredentialSources(accountNamespace.id), false);
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(
        accountNamespace.id,
        namesakeSource.id,
      ),
      false,
    );
  });

  // External auth snapshots retain a source reference and login mode, never workload metadata.
  const externalSource = {
    ...source,
    id: identifier("cs"),
    name: "External ChatGPT " + randomUUID(),
    type: "chatgpt",
    config: {},
    secrets: {},
  };
  const externalAgent = {
    ...sourceAgent,
    id: identifier("agt"),
    name: "External ChatGPT agent " + randomUUID(),
    servicePrincipalId: identifier("service-agent"),
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: externalSource.id },
    credentialSources: [{ sourceId: externalSource.id }],
  } satisfies AgentDraftInput;
  const externalRevision = {
    ...sourceRevision,
    id: identifier("rev"),
    agentId: externalAgent.id,
    servicePrincipalId: externalAgent.servicePrincipalId,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    sandboxDriverId: "sandbox-contract",
    credentialSources: [
      {
        sourceId: externalSource.id,
        credentialGatewayId: externalSource.driverId,
        sourceType: externalSource.type,
      },
    ],
    harnessAuth: {
      ...externalAgent.harnessAuth,
      credentialGatewayId: externalSource.driverId,
      sourceType: externalSource.type,
      loginMode: "chatgptAuthTokens",
    },
  } satisfies AgentRevision;
  await store.transact(async (transaction) => {
    await transaction.credentialSources.createCredentialSource(externalSource);
    await transaction.agents.createAgent(externalAgent);
    assertCreatedRevision(
      await transaction.revisions.createRevision(externalRevision),
      externalRevision,
    );
  });
  assert.deepEqual(
    await store.read((state) =>
      state.revisions.findRevision(sourceNamespace.id, externalAgent.id, externalRevision.id),
    ),
    externalRevision,
  );
}
