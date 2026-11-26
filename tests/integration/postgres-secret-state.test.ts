import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  Agent,
  AgentRevision,
  HarnessAuthBinding,
  Namespace,
  Secret,
  SecretBinding,
  SecretBindings,
  SecretReference,
  StaticCredentialSource,
} from "@openclaw-enterprise/contracts";
import type { Pool } from "pg";
import type { PlatformStateStore, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { SECRET_NAME_CONFLICT } from "../helpers/refusal-text.mjs";

type ConfigurationInput = Parameters<
  PlatformUnitOfWork["configurations"]["createConfiguration"]
>[0];
type AgentInput = Parameters<PlatformUnitOfWork["agents"]["createAgent"]>[0];

async function completeRevisionWork(pool: Pool, revisionId: string, reason: string) {
  const { PostgresWorkQueue } = await import("../../packages/occ/src/index.ts");
  const queue = new PostgresWorkQueue(pool);
  const claim = await queue.claim();
  assert.ok(claim, "expected queued revision work");
  assert.equal(claim.revisionId, revisionId);
  await queue.complete(claim, { code: reason });
}

function identifier(kind: string) {
  return `${kind}_${randomUUID()}`;
}

function shortName(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function resources() {
  const namespaceId = identifier("ns");
  const configurationId = identifier("cfg");
  const agentId = identifier("agt");
  const createdAt = new Date().toISOString();
  const namespace: Namespace = {
    id: namespaceId,
    name: `Secret state ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const configuration: ConfigurationInput = {
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const agent: AgentInput = {
    id: agentId,
    namespaceId,
    name: `Secret owner ${randomUUID()}`,
    configurationId,
    backendId: null,
    harnessAuth: null,
    executionMode: "dedicated",
    desiredRuntimeState: "stopped",
    status: "active",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    createdAt,
  };
  return { namespace, configuration, agent };
}

function secret(namespaceId: string, name = `model-key-${randomUUID()}`): Secret {
  return {
    id: identifier("sec"),
    namespaceId,
    name,
    driverId: "kubernetes-secret",
    backendRef: {
      namespaceName: shortName("ns"),
      name: `${shortName("agent")}.credentials`,
      key: "value",
      uid: randomUUID(),
    },
    createdAt: new Date().toISOString(),
  };
}

function bindingValue(storedSecret: Secret): SecretBinding & { readonly source: SecretReference } {
  return {
    source: {
      kind: "secret",
      namespaceId: storedSecret.namespaceId,
      id: storedSecret.id,
    },
    delivery: { type: "env" },
  };
}

function bindingFor(storedSecret: Secret, destination = "SERVICE_TOKEN"): SecretBindings {
  return {
    [destination]: bindingValue(storedSecret),
  };
}

function bindingsFor(storedSecret: Secret, destinations: readonly string[]): SecretBindings {
  return Object.fromEntries(
    destinations.map((destination) => [destination, bindingValue(storedSecret)]),
  );
}

function tooManyBindings(storedSecret: Secret) {
  return bindingsFor(
    storedSecret,
    Array.from({ length: 65 }, (_, index) => `MODEL_KEY_${index}`),
  );
}

function acceptedBindings(storedSecret: Secret) {
  return bindingsFor(storedSecret, ["SERVICE_TOKEN", "EXTERNAL_API_KEY"]);
}

function rejectedDestinationBindings(storedSecret: Secret): readonly SecretBindings[] {
  return [
    bindingFor(storedSecret, "CODEX_TOKEN"),
    bindingFor(storedSecret, "OPENAI_API_KEY"),
    bindingFor(storedSecret, "PATH"),
    tooManyBindings(storedSecret),
  ];
}

async function assertStateBindingDestinationGrammar(
  state: PlatformUnitOfWork,
  namespaceId: string,
  configuration: ConfigurationInput,
  storedSecret: Secret,
) {
  for (const bindings of rejectedDestinationBindings(storedSecret)) {
    await assert.rejects(
      state.configurations.advanceConfigurationGeneration(
        namespaceId,
        configuration.id,
        configuration.generation,
        bindings,
      ),
      { name: "ScopeViolationError" },
    );
  }

  const advanced = await state.configurations.advanceConfigurationGeneration(
    namespaceId,
    configuration.id,
    configuration.generation,
    acceptedBindings(storedSecret),
  );
  assert.ok(advanced, "the current Configuration generation must advance");
  assert.deepEqual(advanced.secretBindings, acceptedBindings(storedSecret));
  assert.equal(advanced.generation, configuration.generation + 1);
}

async function insertSqlConfiguration(pool: Pool, namespaceId: string, bindings: unknown) {
  await pool.query<Record<string, unknown>>(
    `INSERT INTO occ.configurations (id, namespace_id, kind, generation, secret_bindings, created_at)
     VALUES ($1, $2, 'agent', 1, $3::jsonb, now())`,
    [identifier("cfg"), namespaceId, JSON.stringify(bindings)],
  );
}

function revisionFor(
  agent: Agent,
  configuration: ConfigurationInput,
  storedSecret: Secret,
  revisionNumber: number,
) {
  return {
    id: identifier("rev"),
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    revision: revisionNumber,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    backendId: null,
    gatewayManagedMode: agent.gatewayManagedMode,
    harnessAuth: {
      method: "codex_pat",
      source: { kind: "secret", namespaceId: agent.namespaceId, id: storedSecret.id },
      secretDriverId: storedSecret.driverId,
    },
    configuration: { models: { providers: { codex: {} } } },
    harness: {
      id: "codex",
      version: "1.0.0",
      mode: agent.executionMode,
      overrides: {},
      configuration: {},
    },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: new Date().toISOString(),
    secretDriverId: "kubernetes-secret",
  } satisfies AgentRevision;
}

async function ensureInstallation(store: PlatformStateStore) {
  const existing = await store.read((state) => state.installations.getInstallation());
  if (existing !== undefined) {
    return existing;
  }
  return store.transact((state) =>
    state.installations.createInstallation({
      id: identifier("ins"),
      name: `Secret state ${randomUUID()}`,
      createdAt: new Date().toISOString(),
    }),
  );
}

async function gatewaySource(
  store: PlatformStateStore,
  pool: Pool,
  namespaceId: string,
): Promise<StaticCredentialSource> {
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM occ.token_service_instances LIMIT 1",
  );
  const instanceId =
    existing.rows[0]?.id ??
    (
      await store.transact((state) =>
        state.installations.selectTokenServiceInstance({
          id: randomUUID(),
          driverId: "state-test-token-service",
          storeIdentity: "state-test-store",
        }),
      )
    ).id;
  return {
    id: identifier("cs"),
    namespaceId,
    name: `Gateway Source ${randomUUID()}`,
    type: "static",
    config: {},
    ownerCapability: "token_service",
    tokenServiceInstanceId: instanceId,
    state: "ready",
    createdAt: new Date().toISOString(),
  };
}

function gatewayBindingFor(source: StaticCredentialSource): SecretBindings {
  return {
    GW_TOKEN: {
      source: { kind: "credential_source", namespaceId: source.namespaceId, id: source.id },
    },
  };
}

async function exerciseRepository(store: PlatformStateStore) {
  await ensureInstallation(store);
  const { namespace, configuration, agent: initialAgent } = resources();
  const storedSecret = secret(namespace.id);
  const siblingConfiguration = {
    ...configuration,
    id: identifier("cfg"),
    generation: 1,
  };
  const secondSharedSecret = secret(namespace.id);
  const siblingAgent = {
    ...initialAgent,
    id: identifier("agt"),
    name: `Sibling ${randomUUID()}`,
    servicePrincipalId: `service-agent-${randomUUID()}`,
    configurationId: siblingConfiguration.id,
  };

  const agent = await store.transact(async (state) => {
    await state.namespaces.createNamespace(namespace);
    assert.equal(await state.namespaces.hasSecrets(namespace.id), false);
    // Namespace-owned Secrets can be registered before any Agent exists.
    assert.deepEqual(await state.secrets.createSecret(storedSecret), storedSecret);
    assert.equal(await state.namespaces.hasSecrets(namespace.id), true);
    assert.deepEqual(await state.secrets.findSecret(namespace.id, storedSecret.id), storedSecret);
    assert.deepEqual(await state.secrets.listSecrets(namespace.id), [storedSecret]);
    assert.deepEqual(await state.secrets.lockSecret(namespace.id, storedSecret.id), storedSecret);
    await state.configurations.createConfiguration({
      ...configuration,
      secretBindings: acceptedBindings(storedSecret),
    });
    return state.agents.createAgent(initialAgent);
  });

  await store.transact(async (state) => {
    await assertStateBindingDestinationGrammar(state, namespace.id, configuration, storedSecret);
    assert.equal(await state.secrets.hasReferences(namespace.id, storedSecret.id), true);
  });

  await assert.rejects(
    store.transact((state) =>
      state.secrets.createSecret({
        ...secret(namespace.id, storedSecret.name),
        backendRef: { ...storedSecret.backendRef, uid: randomUUID() },
      }),
    ),
    {
      name: "ResourceStateConflictError",
      message: SECRET_NAME_CONFLICT,
    },
  );

  await store.transact(async (state) => {
    await state.secrets.createSecret(secondSharedSecret);
    await state.configurations.createConfiguration({
      ...siblingConfiguration,
      secretBindings: {
        MODEL_KEY: bindingValue(storedSecret),
        SECONDARY_MODEL_KEY: bindingValue(secondSharedSecret),
      },
    });
    await state.agents.createAgent(siblingAgent);
    assert.deepEqual(
      new Set((await state.secrets.listSecrets(namespace.id)).map((item) => item.id)),
      new Set([storedSecret.id, secondSharedSecret.id]),
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, secondSharedSecret.id), true);
  });

  const foreign = resources();
  const foreignSecret = secret(foreign.namespace.id);
  await store.transact(async (state) => {
    await state.namespaces.createNamespace(foreign.namespace);
    await state.secrets.createSecret(foreignSecret);
    assert.deepEqual(
      (await state.secrets.listSecrets(namespace.id))
        .map((item) => item.id)
        .includes(foreignSecret.id),
      false,
    );
  });
  // Secret IDs are unique, so lookups must still be scoped: a foreign ID is not found here.
  await store.transact(async (state) => {
    assert.equal(await state.secrets.findSecret(namespace.id, foreignSecret.id), undefined);
    assert.equal(await state.secrets.lockSecret(namespace.id, foreignSecret.id), undefined);
  });
  // A binding to a foreign Secret is refused, even when it claims this Namespace for it.
  const foreignBindings: readonly SecretBindings[] = [
    bindingFor(foreignSecret),
    { MODEL_KEY: { source: { kind: "secret", namespaceId: namespace.id, id: foreignSecret.id } } },
  ];
  for (const secretBindings of foreignBindings) {
    await assert.rejects(
      store.transact((state) =>
        state.configurations.createConfiguration({
          ...configuration,
          id: identifier("cfg"),
          secretBindings,
        }),
      ),
      { name: "ScopeViolationError" },
    );
  }

  const configurationBlockerSecret = secret(namespace.id);
  const configurationBlocker = {
    ...configuration,
    id: identifier("cfg"),
    generation: 1,
    secretBindings: bindingFor(configurationBlockerSecret),
  };
  await store.transact(async (state) => {
    await state.secrets.createSecret(configurationBlockerSecret);
    await state.configurations.createConfiguration(configurationBlocker);
    assert.equal(
      await state.secrets.hasReferences(namespace.id, configurationBlockerSecret.id),
      true,
    );
  });
  await assert.rejects(
    store.transact((state) =>
      state.secrets.deleteSecret(namespace.id, configurationBlockerSecret.id),
    ),
    { name: "ScopeViolationError" },
  );

  await store.transact(async (state) => {
    const cleared = await state.configurations.advanceConfigurationGeneration(
      namespace.id,
      configurationBlocker.id,
      configurationBlocker.generation,
      {},
    );
    assert.ok(cleared, "the current Configuration generation must advance");
    assert.equal(Object.hasOwn(cleared, "secretBindings"), false);
    assert.equal(
      await state.secrets.hasReferences(namespace.id, configurationBlockerSecret.id),
      false,
    );
    assert.equal(
      await state.secrets.deleteSecret(namespace.id, configurationBlockerSecret.id),
      true,
    );
  });

  // Service account token references must retain sources without ordinary environment bindings.
  const revisionSecret = secret(namespace.id);
  const activeSecret = secret(namespace.id);
  const activeRevisionId = await store.transact(async (state) => {
    await state.secrets.createSecret(revisionSecret);
    await state.secrets.createSecret(activeSecret);
    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "codex_pat",
      source: bindingValue(revisionSecret).source,
    });
    // The Agent's own Harness binding retains its Secret before any revision exists.
    assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), true);
    const snapshot = revisionFor(agent, { ...configuration, generation: 3 }, revisionSecret, 1);
    await assert.rejects(
      state.revisions.createRevision({
        ...snapshot,
        harnessAuth: { ...snapshot.harnessAuth, method: "api_key" },
      }),
      { name: "ScopeViolationError" },
    );
    const revision = await state.revisions.createRevision(snapshot);
    assert.equal(revision.harnessAuth.method, "codex_pat");
    await state.agents.updateConfiguration(
      namespace.id,
      agent.id,
      configuration.id,
      undefined,
      null,
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), false);
    await state.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: namespace.id,
      resourceId: revision.id,
      actorId: "principal-secret-state",
    });
    assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), true);

    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "codex_pat",
      source: bindingValue(activeSecret).source,
    });
    const activeRevision = await state.revisions.createRevision(
      revisionFor(agent, { ...configuration, generation: 3 }, activeSecret, 2),
    );
    await state.agents.compareAndSetActiveRevision(
      namespace.id,
      agent.id,
      undefined,
      activeRevision.id,
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, activeSecret.id), true);
    return activeRevision.id;
  });

  await assert.rejects(
    store.transact((state) => state.secrets.deleteSecret(namespace.id, activeSecret.id)),
    { name: "ScopeViolationError" },
  );

  await store.transact(async (state) => {
    await state.agents.updateConfiguration(namespace.id, agent.id, configuration.id, undefined, {
      method: "codex_pat",
      source: bindingValue(secondSharedSecret).source,
    });
    const replacementRevision = await state.revisions.createRevision(
      revisionFor(agent, { ...configuration, generation: 3 }, secondSharedSecret, 3),
    );
    await state.agents.compareAndSetActiveRevision(
      namespace.id,
      agent.id,
      activeRevisionId,
      replacementRevision.id,
    );
    assert.equal(await state.secrets.hasReferences(namespace.id, activeSecret.id), false);
    assert.equal(await state.secrets.deleteSecret(namespace.id, activeSecret.id), true);
  });

  await assert.rejects(
    store.transact((state) => state.secrets.deleteSecret(namespace.id, revisionSecret.id)),
    { name: "ScopeViolationError" },
  );

  return { namespace, agent, configuration, revisionSecret };
}

test("in-memory state persists Secret metadata and binding references without values", async () => {
  const { InMemoryPlatformState } = await import("../../packages/occ/src/state/platform-state.ts");
  await exerciseRepository(new InMemoryPlatformState());
});

test(
  "PostgreSQL PAT Secret bindings enforce exact ownership and reject retired auth methods",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await ensureInstallation(store);
    const { namespace, configuration, agent } = resources();
    const source = secret(namespace.id);
    const foreign = resources();
    const foreignSource = secret(foreign.namespace.id);
    const auth = {
      method: "codex_pat",
      source: bindingValue(source).source,
    } satisfies HarnessAuthBinding;
    await store.transact(async (state) => {
      await state.namespaces.createNamespace(namespace);
      await state.namespaces.createNamespace(foreign.namespace);
      await state.configurations.createConfiguration(configuration);
      await state.secrets.createSecret(source);
      await state.secrets.createSecret(foreignSource);
      await state.agents.createAgent({ ...agent, harnessAuth: auth });
    });
    const stored = await pool.query<Record<string, unknown>>(
      "SELECT harness_auth, harness_auth_secret_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.id, agent.id],
    );
    assert.deepEqual(stored.rows[0], { harness_auth: auth, harness_auth_secret_id: source.id });

    // Execute writes directly so application validation cannot conceal a missing
    // JSON constraint or the composite Namespace/Secret foreign key.
    const invalidBindings: readonly (readonly [binding: unknown, code: string])[] = [
      [{ ...auth, source: { ...auth.source, id: identifier("sec") } }, "23503"],
      [{ ...auth, source: { ...auth.source, id: foreignSource.id } }, "23503"],
      [{ ...auth, source: bindingValue(foreignSource).source }, "23514"],
      [{ ...auth, method: "oauth" }, "23514"],
      [{ method: "chatgpt_service_account", serviceAccountId: identifier("sa") }, "23514"],
      [{ ...auth, refreshToken: "must-not-be-stored-in-database" }, "23514"],
    ];
    for (const [binding, code] of invalidBindings) {
      await assert.rejects(
        pool.query("UPDATE occ.agents SET harness_auth = $1::jsonb WHERE id = $2", [
          JSON.stringify(binding),
          agent.id,
        ]),
        { code },
      );
    }
    await assert.rejects(
      pool.query("DELETE FROM occ.secrets WHERE namespace_id = $1 AND id = $2", [
        namespace.id,
        source.id,
      ]),
      { code: "23001", constraint: "agents_harness_auth_secret_owner" },
    );
  },
);

test(
  "PostgreSQL Source deletion waits for a published replacement to retire its predecessor",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await ensureInstallation(store);
    const { namespace, configuration, agent: draft } = resources();
    const harnessSecret = secret(namespace.id);
    const source = await gatewaySource(store, pool, namespace.id);
    const gatewayBindings = gatewayBindingFor(source);
    const { agent, first } = await store.transact(async (state) => {
      await state.namespaces.createNamespace(namespace);
      await state.secrets.createSecret(harnessSecret);
      await state.credentialSources.createCredentialSource(source);
      await state.configurations.createConfiguration({
        ...configuration,
        secretBindings: gatewayBindings,
      });
      const agent = await state.agents.createAgent({
        ...draft,
        harnessAuth: { method: "codex_pat", source: bindingValue(harnessSecret).source },
      });
      const first = await state.revisions.createRevision({
        ...revisionFor(agent, configuration, harnessSecret, 1),
        secretBindings: gatewayBindings,
        gatewayTokenServiceInstanceId: source.tokenServiceInstanceId,
      });
      await state.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: first.id,
        actorId: "principal-source-state",
      });
      await state.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, first.id);
      return { agent, first };
    });
    await completeRevisionWork(pool, first.id, "REVISION_ACTIVATED");
    // Publish a Source-free replacement while its reconcile still owes predecessor retirement.
    const second = await store.transact(async (state) => {
      const updated = await state.configurations.advanceConfigurationGeneration(
        namespace.id,
        configuration.id,
        1,
        {},
      );
      assert.ok(updated);
      const second = await state.revisions.createRevision(
        revisionFor(agent, updated, harnessSecret, 2),
      );
      await state.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: second.id,
        actorId: "principal-source-state",
      });
      await state.agents.compareAndSetActiveRevision(namespace.id, agent.id, first.id, second.id);
      assert.equal(
        await state.credentialSources.findBlockingReference(namespace.id, source.id),
        "reference",
      );
      return second;
    });
    // A superseded R2 can succeed without retiring R1. Publish R3 while its own retirement
    // is still pending; R2's success must not let the Source disappear.
    const third = await store.transact(async (state) => {
      const configuration = await state.configurations.findConfiguration(
        namespace.id,
        agent.configurationId,
      );
      assert.ok(configuration);
      const third = await state.revisions.createRevision(
        revisionFor(agent, configuration, harnessSecret, 3),
      );
      await state.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        namespaceId: namespace.id,
        resourceId: third.id,
        actorId: "principal-source-state",
      });
      await state.agents.compareAndSetActiveRevision(namespace.id, agent.id, second.id, third.id);
      return third;
    });
    await completeRevisionWork(pool, second.id, "REVISION_SUPERSEDED");
    await store.transact(async (state) => {
      assert.equal(
        await state.credentialSources.findBlockingReference(namespace.id, source.id),
        "reference",
      );
    });
    // Activation success is recorded after retirement. This proves the adapter predicate,
    // not physical Kubernetes cleanup.
    await completeRevisionWork(pool, third.id, "REVISION_ACTIVATED");
    await store.transact(async (state) => {
      assert.equal(
        await state.credentialSources.findBlockingReference(namespace.id, source.id),
        undefined,
      );
      assert.equal(
        await state.credentialSources.deleteCredentialSource(namespace.id, source.id),
        true,
      );
    });
  },
);

test(
  "PostgreSQL provisioning plans retain their Gateway Source until cancellation",
  requiresPostgres,
  async (context) => {
    const [
      { Pool },
      { PostgresPlatformState },
      { parseProvisioningPlan },
      { agentDefaults, claimProvisioningWork },
    ] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/agent-provisioning.ts"),
      import("./postgres-agent-provisioning-setup.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await ensureInstallation(store);
    const { namespace } = resources();
    const harnessSecret = secret(namespace.id);
    const source = await gatewaySource(store, pool, namespace.id);
    const workId = `agent-provisioning:${randomUUID().replaceAll("-", "")}`;
    const record = await store.transact(async (state) => {
      await state.namespaces.createNamespace(namespace);
      await state.secrets.createSecret(harnessSecret);
      await state.credentialSources.createCredentialSource(source);
      assert.equal(
        await state.credentialSources.findBlockingReference(namespace.id, source.id),
        undefined,
      );
      // No Agent or Configuration exists yet. The accepted plan alone selects this Source
      // for the Gateway; Harness authentication uses a separate Namespace Secret.
      const created = await state.provisioning.create({
        workId,
        namespaceId: namespace.id,
        actorId: "principal-source-state",
        requestId: `req_${randomUUID()}`,
        requestFingerprint: "0".repeat(64),
        plan: {
          name: `Provisioned Gateway ${randomUUID()}`,
          executionMode: "dedicated",
          configuration: {
            kind: "agent",
            values: { agents: { defaults: agentDefaults() } },
            secretBindings: gatewayBindingFor(source),
          },
          harnessAuth: { method: "api_key", source: bindingValue(harnessSecret).source },
          drivers: {
            compute: "compute-test",
            configuration: "configuration-test",
            iam: "native-iam",
          },
        },
      });
      return created.record;
    });
    parseProvisioningPlan(record);
    assert.equal(record.status, "queued");
    await assert.rejects(
      store.transact((state) =>
        state.credentialSources.deleteCredentialSource(namespace.id, source.id),
      ),
      { name: "ScopeViolationError" },
    );
    const claim = await claimProvisioningWork(pool, workId);
    await store.transact(async (state) => {
      const running = await state.provisioning.checkpoint(claim, {
        completedPhase: "admitted",
        status: "running",
      });
      assert.equal(running.status, "running");
      assert.equal(
        await state.credentialSources.findBlockingReference(namespace.id, source.id),
        "reference",
      );
      const cancelled = await state.provisioning.cancel(claim, {
        code: "PROVISIONING_CANCELLED",
        message: "Provisioning was cancelled before creating an Agent.",
      });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(
        await state.credentialSources.findBlockingReference(namespace.id, source.id),
        undefined,
      );
      assert.equal(
        await state.credentialSources.deleteCredentialSource(namespace.id, source.id),
        true,
      );
    });
  },
);

test(
  "PostgreSQL state persists Secret metadata and enforces binding dependencies",
  requiresPostgres,
  async (context) => {
    const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresPlatformState(pool);

    const { namespace, agent, configuration, revisionSecret } = await exerciseRepository(store);
    const storedAuth = await pool.query<Record<string, unknown>>(
      "SELECT harness_auth, harness_auth_secret_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.id, agent.id],
    );
    const authRow = storedAuth.rows[0];
    assert.ok(authRow, "the Agent must have a persisted Harness binding");
    const auth = authRow.harness_auth;
    assert.ok(auth && typeof auth === "object" && "source" in auth && "method" in auth);
    assert.equal(auth.method, "codex_pat");
    const source = auth.source;
    assert.ok(source && typeof source === "object" && "id" in source);
    assert.equal(typeof source.id, "string");
    assert.equal(authRow.harness_auth_secret_id, source.id);
    await assert.rejects(
      pool.query(
        "UPDATE occ.agents SET harness_auth = $3::jsonb WHERE namespace_id = $1 AND id = $2",
        [
          namespace.id,
          agent.id,
          JSON.stringify({
            method: "codex_pat",
            source: { kind: "secret", namespaceId: namespace.id, id: identifier("sec") },
          }),
        ],
      ),
      { code: "23503" },
    );
    const sqlSecret = secret(namespace.id, `sql-key-${randomUUID()}`);

    await store.transact((state) => state.secrets.createSecret(sqlSecret));
    for (const bindings of rejectedDestinationBindings(sqlSecret)) {
      await assert.rejects(insertSqlConfiguration(pool, namespace.id, bindings), { code: "23514" });
    }

    await insertSqlConfiguration(pool, namespace.id, acceptedBindings(sqlSecret));

    await assert.rejects(
      insertSqlConfiguration(pool, namespace.id, {
        INVALID: {
          source: { kind: "secret", namespaceId: namespace.id, id: sqlSecret.id },
          unexpected: true,
        },
      }),
      { code: "23514" },
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO occ.secrets
       (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
        backend_key, backend_uid, created_at)
       VALUES ($1, $2, $3, 'kubernetes-secret', 'valid-ns', 'valid.secret',
        'value', $4, now())`,
        [identifier("sec"), identifier("ns"), `bad-namespace-${randomUUID()}`, randomUUID()],
      ),
      { code: "23503" },
    );

    const principalId = `principal-${randomUUID()}`;
    const roleId = `role-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
     VALUES ($1, NULL, NULL, 'principal', 'postgres-secret-test', $2)`,
      [principalId, `subject-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, $2, $3, $4::jsonb)`,
      [
        roleId,
        namespace.id,
        `Secret operator ${randomUUID()}`,
        JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
      ],
    );
    await pool.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
     VALUES ($1, $2, $3, NULL, $4, 'secret', $5)`,
      [`binding-${randomUUID()}`, namespace.id, principalId, roleId, sqlSecret.id],
    );

    const other = resources();
    await store.transact(async (state) => {
      await state.namespaces.createNamespace(other.namespace);
      await state.configurations.createConfiguration(other.configuration);
      await state.agents.createAgent(other.agent);
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'operate', 'secret', $3, 'deny')`,
        [`restriction-${randomUUID()}`, other.namespace.id, sqlSecret.id],
      ),
      { code: "23514" },
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
       VALUES ($1, $2, $3, 99, $4::jsonb, now())`,
        [
          identifier("rev"),
          namespace.id,
          agent.id,
          JSON.stringify({
            configuration_id: configuration.id,
            configuration_kind: "agent",
            configuration_generation: 1,
            draft_spec: {},
            harness: {
              id: "openclaw",
              version: "1.0.0",
              mode: "embedded",
              overrides: {},
              configuration: {},
            },
            compute: { id: "compute-test", implementation: "deterministic-test" },
            secret_driver_id: "kubernetes-secret",
            secret_bindings: bindingFor(sqlSecret),
            harness_auth: { method: "runtime" },
            execution_admission: { version: 2, mode: "unprotected" },
            unexpected: true,
          }),
        ],
      ),
      { code: "23514", constraint: "agent_revisions_admitted_snapshot" },
    );

    const revisionWork = await pool.query<{ revision_id: string }>(
      `SELECT work.revision_id FROM occ.controller_work AS work
       JOIN occ.agent_revisions AS revision ON work.revision_id = revision.id
       WHERE work.namespace_id = $1
         AND revision.namespace_id = $1
         AND revision.admitted_spec #>> '{harness_auth,source,namespaceId}' = $1
         AND revision.admitted_spec #>> '{harness_auth,source,id}' = $2`,
      [namespace.id, revisionSecret.id],
    );
    assert.equal(revisionWork.rowCount, 1);
    await completeRevisionWork(pool, revisionWork.rows[0]!.revision_id, "REVISION_ACTIVATED");
    await store.transact(async (state) => {
      assert.equal(await state.secrets.hasReferences(namespace.id, revisionSecret.id), false);
      assert.equal(await state.secrets.deleteSecret(namespace.id, revisionSecret.id), true);
    });

    const columns = await pool.query<Record<string, unknown>>(
      `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'occ' AND table_name = 'secrets'
     ORDER BY column_name`,
    );
    assert.ok(columns.rows.length > 0, "the Secret column inventory must exist");
    for (const { column_name: columnName } of columns.rows) {
      assert.ok(typeof columnName === "string", "the Secret column name must be a string");
      assert.notEqual(columnName, "agent_id");
      assert.doesNotMatch(columnName, /value|bytes|material/i);
    }
  },
);
