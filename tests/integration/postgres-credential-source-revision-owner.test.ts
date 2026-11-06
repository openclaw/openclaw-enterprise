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
import {
  InMemoryPlatformState,
  type PlatformStateStore,
} from "../../packages/occ/src/state/platform-state.ts";
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
async function fixture(t: TestContext, sourceCount = 2) {
  await ensurePostgresAgentBootstrap(t, {
    label: "revision-owner",
    authSecret: "revision-owner-fixture-signing-secret",
  });
  const pool = testPool(t, { connectionString: databaseUrl });
  const store = new PostgresPlatformState(pool);
  const seeded = await seedSnapshotFixture(store, sourceCount);
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
  return { ...seeded, pool, writer };
}

async function seedSnapshotFixture(store: PlatformStateStore, sourceCount = 2) {
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
  const sources = Array.from(
    { length: sourceCount },
    (_, index) =>
      ({
        id: id("cs"),
        namespaceId: ns.id,
        name: `source-${index}`,
        type: "openai",
        driverId: "gateway-original",
        ownerCapability: "credential_gateway",
        config: {},
        secrets: { api_key: { kind: "secret", namespaceId: ns.id, id: secret.id } },
        state: "ready",
        createdAt,
      }) satisfies CredentialSource,
  );
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
  return { store, ns, config, agent, sources, listed, input, secret };
}

/** Synthetic reader fixture: public CREATE and deploy still emit Gateway ownership. */
async function addProxySnapshot(f: Awaited<ReturnType<typeof seedSnapshotFixture>>) {
  const sourceId = id("cs");
  const installation = await f.store.read((view) => view.installations.getInstallation());
  assert.ok(installation);
  const source: CredentialSource = {
    ...f.sources[0]!,
    id: sourceId,
    name: "proxy-reader",
    driverId: "proxy-reader",
    ownerCapability: "credential_proxy",
    egress: {
      key: {
        installationId: installation.id,
        namespaceId: f.ns.id,
        source: { id: sourceId, generation: 1 },
        backend: { id: "reader-backend", generation: 1 },
        provider: { id: "reader-openai", generation: 1 },
      },
      schemaVersion: 1,
      adoption: "live",
      materialRefId: "reader-material",
      secret: { kind: "secret", namespaceId: f.ns.id, id: f.secret.id },
      secretDriver: { id: f.secret.driverId, generation: 1 },
      sender: { id: "reader-sender", generation: 1 },
      resolver: { id: "reader-resolver", generation: 1 },
      retention: "none",
    },
  };
  await f.store.transact(async (unit) => {
    await unit.credentialSources.createCredentialSource(source);
    await unit.agents.updateConfiguration(
      f.ns.id,
      f.agent.id,
      f.config.id,
      undefined,
      { method: "credential_source", sourceId },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ sourceId }],
    );
  });
  const snapshot = { sourceId, sourceType: "openai" as const, credentialProxyId: source.driverId };
  const revision: AgentRevision = {
    ...f.input,
    id: id("rev"),
    revision: 2,
    harnessAuth: { method: "credential_source", ...snapshot, loginMode: "api_key" },
    credentialSources: [snapshot],
  };
  return { source, revision };
}

async function checkProxySnapshotReader(store: PlatformStateStore) {
  const f = await seedSnapshotFixture(store);
  const archived = await store.transact((unit) => unit.revisions.createRevision(f.input));
  const { source, revision } = await addProxySnapshot(f);
  const saved = await store.transact((unit) => unit.revisions.createRevision(revision));
  assert.deepEqual(saved.harnessAuth, revision.harnessAuth);
  const auth = revision.harnessAuth;
  for (const bad of [
    {
      method: "credential_source",
      sourceId: source.id,
      sourceType: "openai",
      loginMode: "api_key",
    },
    { ...auth, credentialGatewayId: "gateway-original" },
    { ...auth, credentialProxyId: "wrong-owner" },
    { ...auth, sourceType: "codex-pat" },
    { ...auth, loginMode: "codex_pat" },
    {
      method: "credential_source",
      sourceId: source.id,
      sourceType: "openai",
      loginMode: "api_key",
      credentialGatewayId: source.driverId,
    },
  ]) {
    await assert.rejects(
      store.transact((unit) =>
        unit.revisions.createRevision({
          ...revision,
          id: id("rev"),
          revision: 3,
          harnessAuth: bad as AgentRevision["harnessAuth"],
        }),
      ),
      { name: "ScopeViolationError" },
    );
  }
  // Detach the live draft before deleting both source owners. Archives must not consult them.
  await store.transact(async (unit) => {
    await unit.agents.updateConfiguration(
      f.ns.id,
      f.agent.id,
      f.config.id,
      undefined,
      { method: "runtime" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    for (const entry of [...f.sources, source]) {
      assert.equal(await unit.credentialSources.deleteCredentialSource(f.ns.id, entry.id), true);
    }
  });
  assert.deepEqual(
    await store.read((view) => view.revisions.findRevision(f.ns.id, f.agent.id, f.input.id)),
    archived,
  );
  assert.deepEqual(
    await store.read((view) => view.revisions.findRevision(f.ns.id, f.agent.id, revision.id)),
    saved,
  );
  await assert.rejects(
    store.transact((unit) =>
      unit.revisions.createRevision({ ...revision, id: id("rev"), revision: 3 }),
    ),
    { name: "ScopeViolationError" },
  );
  return { f, archived, saved };
}

test("synthetic Proxy Harness reader preserves exclusive owners and deleted-source archives in memory", async () => {
  await checkProxySnapshotReader(new InMemoryPlatformState());
});

test(
  "synthetic Proxy Harness reader preserves exclusive owners and deleted-source archives in PostgreSQL",
  options,
  async (t) => {
    await ensurePostgresAgentBootstrap(t, {
      label: "proxy-reader",
      authSecret: "proxy-reader-fixture-signing-secret",
    });
    const pool = testPool(t, { connectionString: databaseUrl });
    const { f, archived, saved } = await checkProxySnapshotReader(new PostgresPlatformState(pool));
    await withPool(databaseUrl, async (fresh: pg.Pool) => {
      for (const revision of [archived, saved]) {
        assert.deepEqual(
          await new PostgresPlatformState(fresh).read((view) =>
            view.revisions.findRevision(f.ns.id, f.agent.id, revision.id),
          ),
          revision,
        );
      }
    });
  },
);

test(
  "SQL enforces exclusive Proxy Harness ownership without rewriting Gateway archives",
  options,
  async (t) => {
    const f = await fixture(t);
    await f.store.transact((unit) => unit.revisions.createRevision(f.input));
    const bytes = async () =>
      (
        await f.pool.query(
          "SELECT jsonb_send(admitted_spec) AS bytes FROM occ.agent_revisions WHERE id=$1",
          [f.input.id],
        )
      ).rows[0].bytes;
    const before = await bytes();
    const { source, revision } = await addProxySnapshot(f);
    const insert = async (auth: unknown, listed: unknown = revision.credentialSources) =>
      f.pool.query(
        `INSERT INTO occ.agent_revisions (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
     SELECT $1, namespace_id, agent_id, 2, backend_id,
       jsonb_set(jsonb_set(admitted_spec, '{harness_auth}', $2::jsonb), '{credential_sources}', $3::jsonb), admitted_at
     FROM occ.agent_revisions WHERE id=$4 RETURNING id`,
        [id("rev"), JSON.stringify(auth), JSON.stringify(listed), f.input.id],
      );
    for (const auth of [
      { ...revision.harnessAuth, credentialGatewayId: "gateway-original" },
      {
        method: "credential_source",
        sourceId: source.id,
        sourceType: "openai",
        loginMode: "api_key",
      },
      { ...revision.harnessAuth, credentialProxyId: "wrong-proxy" },
      { ...revision.harnessAuth, sourceType: "codex-pat" },
      { ...revision.harnessAuth, loginMode: "codex_pat" },
      {
        method: "credential_source",
        sourceId: source.id,
        sourceType: "openai",
        loginMode: "api_key",
        credentialGatewayId: source.driverId,
      },
    ]) {
      await assert.rejects(insert(auth), { code: "23514" });
    }
    const inserted = await insert(revision.harnessAuth);
    await withPool(databaseUrl, async (fresh: pg.Pool) => {
      const read = await new PostgresPlatformState(fresh).read((view) =>
        view.revisions.findRevision(f.ns.id, f.agent.id, inserted.rows[0].id),
      );
      assert.deepEqual(read?.harnessAuth, revision.harnessAuth);
    });
    assert.deepEqual(await bytes(), before);
    // A syntactically valid archive cannot be inserted as fresh authority after withdrawal.
    await f.store.transact((unit) =>
      unit.credentialSources.markCredentialSourceDeleting(f.ns.id, source.id),
    );
    await assert.rejects(insert(revision.harnessAuth), { code: "23514" });
  },
);

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

test(
  "PostgreSQL accepts 64 credential sources per draft and revision and rejects a 65th",
  options,
  async (t) => {
    const { pool, store, ns, agent, sources, input, listed } = await fixture(t, 64);
    await store.transact((unit) => unit.revisions.createRevision(input));
    assert.deepEqual(
      (await store.read((view) => view.agents.findAgent(ns.id, agent.id)))?.credentialSources,
      agent.credentialSources,
    );
    assert.deepEqual(
      (await store.read((view) => view.revisions.findRevision(ns.id, agent.id, input.id)))
        ?.credentialSources,
      listed,
    );

    // Write as the application role without API validation. The database must reject
    // an otherwise valid additional source on both the draft and the immutable revision.
    const extra = { ...sources[0]!, id: id("cs"), name: "extra" };
    await store.transact((unit) => unit.credentialSources.createCredentialSource(extra));
    await assert.rejects(
      pool.query("UPDATE occ.agents SET credential_sources = $1::jsonb WHERE id = $2", [
        JSON.stringify([...agent.credentialSources!, { sourceId: extra.id }]),
        agent.id,
      ]),
      { code: "23514", constraint: "agents_credential_sources_valid" },
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
       SELECT $1, namespace_id, agent_id, revision_number + 1, backend_id,
         jsonb_set(admitted_spec, '{credential_sources}', $2::jsonb), admitted_at
       FROM occ.agent_revisions WHERE id = $3`,
        [id("rev"), JSON.stringify([...listed, { ...listed[0]!, sourceId: extra.id }]), input.id],
      ),
      { code: "23514", constraint: "agent_revisions_admitted_snapshot" },
    );
  },
);

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

// These direct app-role INSERTs isolate the database trigger from the State writer's
// own admission locks. The Namespace holder models unrelated non-key metadata work.
for (const shape of [
  "source-free absent",
  "invalid empty list",
  "Harness source",
  "listed source",
] as const) {
  test(`revision owner trigger Namespace locking: ${shape}`, options, async (t) => {
    const { pool, store, ns, input } = await fixture(t);
    await store.transact((unit) => unit.revisions.createRevision(input));
    const row = await pool.query("SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1", [
      input.id,
    ]);
    const admitted = row.rows[0].admitted_spec;
    const hasSource = shape === "Harness source" || shape === "listed source";
    if (shape !== "Harness source") {
      admitted.harness_auth = { method: "runtime" };
    }
    if (shape === "source-free absent" || shape === "Harness source") {
      delete admitted.credential_sources;
    } else if (shape === "invalid empty list") {
      admitted.credential_sources = [];
    }
    const insert = {
      text: `INSERT INTO occ.agent_revisions
        (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
        SELECT $1, namespace_id, agent_id, revision_number + 1, backend_id, $2::jsonb, admitted_at
        FROM occ.agent_revisions WHERE id=$3 RETURNING id`,
      values: [id("rev"), JSON.stringify(admitted), input.id],
    };
    const holder = await pool.connect();
    const writer = await pool.connect();
    try {
      await holder.query("BEGIN");
      const held = await holder.query(
        "SELECT id FROM occ.namespaces WHERE id=$1 FOR NO KEY UPDATE",
        [ns.id],
      );
      assert.deepEqual(held.rows, [{ id: ns.id }]);
      // The completed SELECT proves acquisition before INSERT starts. lock_timeout
      // bounds the negative observation without releasing the holder prematurely.
      await writer.query("SET lock_timeout = '500ms'");
      await writer.query("SET statement_timeout = '3000ms'");
      if (hasSource) {
        await assert.rejects(writer.query(insert), (error: unknown) => {
          const failure = error as { code?: string; where?: string };
          assert.equal(failure.code, "55P03");
          assert.match(failure.where ?? "", /check_revision_credential_source_owners/);
          t.diagnostic(`${shape}: owner trigger waited for the held Namespace lock (55P03)`);
          return true;
        });
        await holder.query("ROLLBACK");
        // Releasing the competing transaction permits the same valid owner INSERT.
        assert.equal((await writer.query(insert)).rowCount, 1);
      } else if (shape === "invalid empty list") {
        await assert.rejects(writer.query(insert), {
          code: "23514",
          constraint: "agent_revisions_admitted_snapshot",
        });
      } else {
        assert.equal((await writer.query(insert)).rowCount, 1);
        t.diagnostic(`${shape}: INSERT completed while Namespace NO KEY UPDATE remained held`);
      }
    } finally {
      await holder.query("ROLLBACK");
      await writer.query("RESET lock_timeout");
      await writer.query("RESET statement_timeout");
      holder.release();
      writer.release();
    }
  });
}
