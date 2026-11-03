import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import type pg from "pg";
import type {
  Agent,
  AgentRevision,
  CredentialSource,
  Secret,
} from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import {
  databaseUrl,
  requiresPostgres,
  testPool,
  withPool,
} from "../helpers/postgres-database.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const options = { ...requiresPostgres, timeout: 30_000 };
async function fixture(t: TestContext) {
  await ensurePostgresAgentBootstrap(t, {
    label: "revision-owner",
    authSecret: "revision-owner-fixture-signing-secret",
  });
  const pool = testPool(t, { connectionString: databaseUrl });
  const store = new PostgresPlatformState(pool);
  const createdAt = new Date().toISOString();
  const ns = { id: id("ns"), name: id("namespace"), status: "ready" as const, createdAt };
  const config = {
    id: id("cfg"),
    namespaceId: ns.id,
    kind: "agent" as const,
    generation: 1,
    createdAt,
  };
  const secret: Secret = {
    id: id("sec"),
    namespaceId: ns.id,
    name: "synthetic-static-key",
    driverId: "fixture-secret",
    backendRef: {
      namespaceName: "fixture",
      name: "synthetic-static-key",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const sources: CredentialSource[] = ["first", "second"].map((label) => ({
    id: id("cs"),
    namespaceId: ns.id,
    name: label,
    type: "openai",
    driverId: "gateway-original",
    ownerCapability: "credential_gateway",
    config: {},
    secrets: { api_key: { kind: "secret", namespaceId: ns.id, id: secret.id } },
    state: "ready",
    createdAt,
  }));
  const listed = sources.map((source) => ({
    sourceId: source.id,
    sourceType: source.type,
    credentialGatewayId: source.driverId,
  }));
  const agent: Agent = {
    id: id("agt"),
    namespaceId: ns.id,
    name: "owner-test",
    configurationId: config.id,
    backendId: null,
    harnessAuth: { method: "credential_source", sourceId: sources[0]!.id },
    credentialSources: sources.map((source) => ({ sourceId: source.id })),
    executionMode: "embedded",
    gatewayManagedMode: true,
    servicePrincipalId: id("service-agent"),
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt,
  };
  const input: AgentRevision = {
    id: id("rev"),
    namespaceId: ns.id,
    agentId: agent.id,
    revision: 1,
    configurationId: config.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: { agents: { defaults: { model: "openai/gpt-fixture" } } },
    backendId: null,
    gatewayManagedMode: true,
    harnessAuth: { method: "credential_source", ...listed[0]!, loginMode: "api_key" },
    credentialSources: listed,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "fixture-compute", implementation: "fixture" },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt,
  };
  await store.transact(async (unit) => {
    if (!(await unit.installations.getInstallation())) {
      await unit.installations.createInstallation({
        id: id("ins"),
        name: "owner-test",
        createdAt,
      });
    }
    await unit.namespaces.createNamespace(ns);
    await unit.configurations.createConfiguration(config);
    await unit.secrets.createSecret(secret);
    for (const source of sources) {
      await unit.credentialSources.createCredentialSource(source);
    }
    await unit.agents.createAgent(agent);
  });
  const writer = () => {
    const name = id("writer");
    const pool = testPool(t, {
      connectionString: databaseUrl,
      application_name: name,
      max: 1,
      statement_timeout: 8000,
    });
    return { name, state: new PostgresPlatformState(pool) };
  };
  return { pool, store, ns, config, agent, sources, listed, input, writer };
}

// Observe a real server lock wait; time alone is not evidence that insertion reached it.
async function waitForLock(pool: pg.Pool, name: string): Promise<void> {
  await waitUntil(
    "the writer to reach the controlled lock",
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0",
          [name],
        )
      ).rowCount === 1,
    { timeoutMs: 5000, intervalMs: 10 },
  );
}

test("revision insertion owns its snapshot before a source lock wait", options, async (t) => {
  const { pool, store, ns, agent, sources, listed, input, writer } = await fixture(t);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = store.transact(async (unit) => {
    await unit.credentialSources.lockCredentialSource(ns.id, sources[0]!.id);
    held.resolve();
    await release.promise;
  });
  const w = writer();
  const expected = structuredClone(listed);
  let pending: Promise<Readonly<AgentRevision>> | undefined;
  try {
    await Promise.race([held.promise, blocker]);
    pending = w.state.transact((unit) => unit.revisions.createRevision(input));
    await waitForLock(pool, w.name);
    // Replace an entry rather than mutating the reference copied by the old validator.
    listed[1] = { ...listed[1]!, credentialGatewayId: "forged-owner" };
  } finally {
    release.resolve();
    await blocker;
  }
  const saved = await pending!;
  assert.deepEqual(saved.credentialSources, expected);
  assert.deepEqual(
    (await store.read((view) => view.revisions.findRevision(ns.id, agent.id, input.id)))
      ?.credentialSources,
    expected,
  );
});

test("reversed source lists commit in their original order", options, async (t) => {
  const { pool, store, ns, agent, input, writer } = await fixture(t);
  const ordered = [...input.credentialSources!].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  );
  const other = {
    ...agent,
    id: id("agt"),
    name: "other",
    servicePrincipalId: id("service-agent"),
    credentialSources: [...agent.credentialSources!].reverse(),
  };
  await store.transact((unit) => unit.agents.createAgent(other));
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = store.transact(async (unit) => {
    await unit.credentialSources.lockCredentialSource(ns.id, ordered[0]!.sourceId);
    held.resolve();
    await release.promise;
  });
  const pending: Promise<Readonly<AgentRevision>>[] = [];
  try {
    await Promise.race([held.promise, blocker]);
    for (const [owner, snapshots] of [
      [agent, input.credentialSources!],
      [other, [...input.credentialSources!].reverse()],
    ] as const) {
      const w = writer();
      pending.push(
        w.state.transact((unit) =>
          unit.revisions.createRevision({
            ...input,
            id: id("rev"),
            agentId: owner.id,
            servicePrincipalId: owner.servicePrincipalId,
            credentialSources: snapshots,
          }),
        ),
      );
      await waitForLock(pool, w.name);
    }
  } finally {
    release.resolve();
    await blocker;
  }
  const saved = await Promise.all(pending);
  assert.deepEqual(
    saved.map((revision) => revision.credentialSources),
    [input.credentialSources, [...input.credentialSources!].reverse()],
  );
});

test("direct insertion respects OCC Namespace Agent source lock order", options, async (t) => {
  const { pool, store, ns, agent, sources, input, writer } = await fixture(t);
  const held = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  // These are the real State calls used by deployAgentWithAuthorization. This
  // proves transaction ordering, not an HTTP deployment or a model turn.
  const admission = store.transact(async (unit) => {
    await unit.namespaces.lockNamespace(ns.id);
    await unit.agents.lockAgent(ns.id, agent.id);
    held.resolve();
    await proceed.promise;
    await unit.credentialSources.lockCredentialSource(ns.id, sources[0]!.id);
    return unit.revisions.createRevision({ ...input, id: id("rev"), revision: 2 });
  });
  const w = writer();
  let pending: Promise<Readonly<AgentRevision>> | undefined;
  try {
    await Promise.race([held.promise, admission]);
    pending = w.state.transact((unit) => unit.revisions.createRevision(input));
    await waitForLock(pool, w.name);
  } finally {
    proceed.resolve();
  }
  const saved = await Promise.all([admission, pending!]);
  assert.deepEqual(
    saved.map((revision) => revision.credentialSources),
    [input.credentialSources, input.credentialSources],
  );
});

test(
  "deleting source refuses waiting insertion and preserves archived bytes",
  options,
  async (t) => {
    const { pool, store, ns, config, agent, sources, input, writer } = await fixture(t);
    const original = await store.transact((unit) => unit.revisions.createRevision(input));
    const bytes = async (p: pg.Pool) =>
      (
        await p.query(
          "SELECT jsonb_send(admitted_spec) bytes FROM occ.agent_revisions WHERE id=$1",
          [input.id],
        )
      ).rows[0].bytes;
    const before = await bytes(pool);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deletion = store.transact(async (unit) => {
      assert.ok(await unit.credentialSources.markCredentialSourceDeleting(ns.id, sources[0]!.id));
      held.resolve();
      await release.promise;
    });
    const w = writer();
    let refused: Promise<void> | undefined;
    try {
      await Promise.race([held.promise, deletion]);
      refused = assert.rejects(
        w.state.transact((unit) =>
          unit.revisions.createRevision({ ...input, id: id("rev"), revision: 2 }),
        ),
        {
          name: "ScopeViolationError",
          message: "The AgentRevision references an unavailable credential source.",
        },
      );
      await waitForLock(pool, w.name);
    } finally {
      release.resolve();
      await deletion;
    }
    await refused;
    // Detach the draft through its supported writer before physical deletion. The
    // archived revision is inactive and has no queued work that retains the source.
    await store.transact(async (unit) => {
      await unit.agents.updateConfiguration(
        ns.id,
        agent.id,
        config.id,
        undefined,
        { method: "runtime" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
      );
      for (const source of sources) {
        assert.equal(await unit.credentialSources.deleteCredentialSource(ns.id, source.id), true);
      }
    });
    await withPool(databaseUrl, async (fresh: pg.Pool) => {
      assert.deepEqual(
        await new PostgresPlatformState(fresh).read((view) =>
          view.revisions.findRevision(ns.id, agent.id, input.id),
        ),
        original,
      );
      assert.deepEqual(await bytes(fresh), before);
    });
  },
);
