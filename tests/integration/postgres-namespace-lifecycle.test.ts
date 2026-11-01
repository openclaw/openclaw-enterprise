import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { ensureInstallation } from "../helpers/postgres-backend-state.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

test(
  "Namespace creation atomically reserves a never-attempted lifecycle",
  { ...requiresPostgres, timeout: 15_000 },
  async (context) => {
    const pool = testPool(context, { connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "Namespace lifecycle persistence");
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Namespace lifecycle ${randomUUID()}`,
      status: "provisioning" as const,
      createdAt: new Date().toISOString(),
    };
    await state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // The API can cancel before any ensure claim. Its row must already distinguish
    // no effects dispatched from legacy state or a lost preparation response.
    const journal = await pool.query(
      "SELECT lifecycle_id, revision, data, compute_driver_id, compute_implementation FROM occ.namespace_lifecycle WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(journal.rowCount, 1);
    assert.match(journal.rows[0].lifecycle_id, /^[0-9a-f-]{36}$/u);
    assert.equal(journal.rows[0].revision, 0);
    assert.deepEqual(journal.rows[0].data, {});
    assert.equal(journal.rows[0].compute_driver_id, null);
    assert.equal(journal.rows[0].compute_implementation, null);

    const rolledBack = { ...namespace, id: `ns_${randomUUID()}`, name: `Rollback ${randomUUID()}` };
    await assert.rejects(
      state.transact(async (unit) => {
        await unit.namespaces.createNamespace(rolledBack);
        throw new Error("abort Namespace creation");
      }),
      /abort Namespace creation/,
    );
    const absent = await pool.query(
      "SELECT (SELECT count(*) FROM occ.namespaces WHERE id = $1) AS namespaces, (SELECT count(*) FROM occ.namespace_lifecycle WHERE namespace_id = $1) AS lifecycles",
      [rolledBack.id],
    );
    assert.deepEqual(absent.rows, [{ namespaces: "0", lifecycles: "0" }]);
  },
);

test(
  "Namespace lifecycle checkpoints preserve identity and reject stale revisions after restart",
  { ...requiresPostgres, timeout: 15_000 },
  async (context) => {
    const pool = testPool(context, { connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "Namespace lifecycle checkpoints");
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Namespace checkpoint ${randomUUID()}`,
      status: "provisioning" as const,
      createdAt: new Date().toISOString(),
    };
    const initial = await state.transact(async (unit) => {
      await unit.namespaces.createNamespace(namespace);
      return unit.namespaces.findLifecycle(namespace.id);
    });
    assert.ok(initial);
    const compute = { id: "compute", implementation: "occ/kubernetes" };
    const bound = await state.transact((unit) =>
      unit.namespaces.bindLifecycle(namespace.id, initial.lifecycleId, compute),
    );
    assert.equal(bound?.revision, 0);
    const attempted = { stage: "attempted", operationId: randomUUID() };
    const saved = await state.transact((unit) =>
      unit.namespaces.checkpointLifecycle(namespace.id, initial.lifecycleId, 0, attempted),
    );
    assert.equal(saved?.revision, 1);

    // A new State instance reads the committed intent, including an operation whose
    // response its previous caller might never have received. A stale revision cannot replace it.
    const restarted = new PostgresPlatformState(pool);
    const recovered = await restarted.transact((unit) =>
      unit.namespaces.findLifecycle(namespace.id),
    );
    assert.deepEqual(recovered, saved);
    assert.equal(
      await restarted.transact((unit) =>
        unit.namespaces.checkpointLifecycle(namespace.id, initial.lifecycleId, 0, {
          stage: "complete",
        }),
      ),
      undefined,
    );
    assert.equal(
      await restarted.transact((unit) =>
        unit.namespaces.bindLifecycle(namespace.id, initial.lifecycleId, {
          ...compute,
          id: "replacement",
        }),
      ),
      undefined,
    );
    assert.equal(
      await restarted.transact((unit) =>
        unit.namespaces.checkpointLifecycle(namespace.id, randomUUID(), 1, { stage: "complete" }),
      ),
      undefined,
    );
    assert.deepEqual(
      await restarted.transact((unit) => unit.namespaces.findLifecycle(namespace.id)),
      saved,
    );

    // Enforce the durable boundary in PostgreSQL, even if another application caller
    // bypasses the repository. The application role cannot fabricate or erase a lifecycle.
    for (const statement of [
      "DELETE FROM occ.namespace_lifecycle WHERE namespace_id = $1",
      "UPDATE occ.namespace_lifecycle SET lifecycle_id = gen_random_uuid() WHERE namespace_id = $1",
      "INSERT INTO occ.namespace_lifecycle(namespace_id) VALUES ($1)",
    ]) {
      await assert.rejects(pool.query(statement, [namespace.id]), { code: "42501" });
    }
    for (const [statement, code] of [
      [
        "UPDATE occ.namespace_lifecycle SET compute_driver_id = 'replacement' WHERE namespace_id = $1",
        "23514",
      ],
      [
        "UPDATE occ.namespace_lifecycle SET revision = revision + 2 WHERE namespace_id = $1",
        "23514",
      ],
      [
        "UPDATE occ.namespace_lifecycle SET revision = revision + 1, data = '[]'::jsonb WHERE namespace_id = $1",
        "23514",
      ],
      [
        "UPDATE occ.namespace_lifecycle SET revision = revision + 1, data = jsonb_build_object('data', repeat('x', 65536)) WHERE namespace_id = $1",
        "23514",
      ],
    ] as const) {
      await assert.rejects(pool.query(statement, [namespace.id]), { code });
    }
    assert.deepEqual(
      await restarted.transact((unit) => unit.namespaces.findLifecycle(namespace.id)),
      saved,
    );
  },
);

test(
  "Namespace lifecycle checkpoints reject a worker after database lease takeover",
  { ...requiresPostgres, timeout: 15_000 },
  async (context) => {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { PostgresWorkQueue },
      { authorizedPrincipal },
      { expireWorkLease },
      { waitFor },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
      import("../helpers/postgres-backend-state.mjs"),
      import("../helpers/postgres-worker-revision-support.mjs"),
      import("../helpers/wait-for.mjs"),
    ]);
    const pool = testPool(context, { connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "Namespace lifecycle lease fence");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
    assert.ok(actor);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Namespace lease ${randomUUID()}`,
      status: "provisioning" as const,
      createdAt: new Date().toISOString(),
    };
    const key = `namespace:${namespace.id}:reconcile:ready`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.createNamespace(namespace);
      await queue.enqueue({
        idempotencyKey: key,
        namespaceId: namespace.id,
        namespaceTarget: "ready",
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    const prepared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<{ checkpoint: boolean; read: boolean }>();
    const development = createDevelopmentComputeDriver();
    const events: Readonly<Record<string, unknown>>[] = [];
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: databaseUrl, max: 8 }),

      pollIntervalMs: 20,
      leaseDurationMs: 120_000,
      maxAttempts: 5,
      computeDriver: {
        ...development,
        capability: "compute" as const,
        async stopRevision() {},
        async ensureNamespace(
          candidate: import("../../packages/contracts/src/index.ts").Namespace,
          lifecycle: import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext,
        ) {
          if (candidate.id !== namespace.id) {
            return development.ensureNamespace(candidate);
          }
          // This fixture pauses a real worker at the contract callback boundary. It
          // proves PostgreSQL claim fencing, not external Compute/provider effects.
          const initial = await lifecycle.read();
          await lifecycle.checkpoint(initial.revision, { stage: "attempted" });
          prepared.resolve();
          await release.promise;
          const checkpoint = await lifecycle
            .checkpoint(initial.revision + 1, { stage: "complete" })
            .then(
              () => false,
              () => true,
            );
          const read = await lifecycle.read().then(
            () => false,
            () => true,
          );
          rejected.resolve({ checkpoint, read });
          return development.ensureNamespace(candidate);
        },
      },
      emit(event) {
        events.push(event);
      },
    });
    context.after(async () => {
      release.resolve();
      await worker.stop();
    });
    await worker.start();
    await prepared.promise;
    const before = await state.transact((unit) => unit.namespaces.findLifecycle(namespace.id));
    assert.equal(before?.revision, 1);
    assert.deepEqual(before?.data, { stage: "attempted" });
    const lease = await pool.query(
      "SELECT extract(epoch FROM (lease_expires_at - clock_timestamp()))::double precision AS seconds FROM occ.controller_work WHERE idempotency_key=$1",
      [key],
    );
    assert.ok(
      lease.rows[0].seconds > 110 && lease.rows[0].seconds <= 120,
      "journal callback retains the configured long lease",
    );
    const original = await pool.query(
      "SELECT claim_token FROM occ.controller_work WHERE idempotency_key = $1",
      [key],
    );
    // Expire the actual database lease and let the real queue assign a new token.
    // Aborting a local signal alone would not prove this authority boundary.
    await expireWorkLease(pool, { key, claimToken: original.rows[0].claim_token });
    const queue = new PostgresWorkQueue(pool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    assert.ok((await queue.recoverStale()).recovered >= 1);
    // The disposable database can retain other test work. Schedule only this
    // fixture's recovered row first; the real queue must assign its new claim.
    await pool.query(
      "UPDATE occ.controller_work SET available_at = to_timestamp(0) WHERE idempotency_key=$1 AND state='queued'",
      [key],
    );
    const takeover = await queue.claim();
    assert.ok(takeover);
    assert.equal(takeover.idempotencyKey, key);
    assert.notEqual(takeover.claimToken, original.rows[0].claim_token);
    release.resolve();
    assert.deepEqual(await rejected.promise, { checkpoint: true, read: true });
    await waitFor("stale Namespace worker claim loss", async () =>
      events.find((event) => event.event === "worker.error" && event.code === "CLAIM_LOST"),
    );
    assert.deepEqual(
      await state.transact((unit) => unit.namespaces.findLifecycle(namespace.id)),
      before,
    );
    const current = await pool.query(
      "SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key = $1",
      [key],
    );
    assert.deepEqual(current.rows, [{ state: "claimed", claim_token: takeover.claimToken }]);
    await queue.complete(takeover);
  },
);

test(
  "Namespace checkpoint and worker finalization share work-before-Namespace lock order",
  { ...requiresPostgres, timeout: 15_000 },
  async (context) => {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { authorizedPrincipal },
      { waitFor },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../helpers/postgres-backend-state.mjs"),
      import("../helpers/wait-for.mjs"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "Namespace lifecycle lock order");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
    assert.ok(actor);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Namespace locks ${randomUUID()}`,
      status: "provisioning" as const,
      createdAt: new Date().toISOString(),
    };
    const key = `namespace:${namespace.id}:reconcile:ready`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.createNamespace(namespace);
      await queue.enqueue({
        idempotencyKey: key,
        namespaceId: namespace.id,
        namespaceTarget: "ready",
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    const entered =
      Promise.withResolvers<
        import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext
      >();
    const releaseCompute = Promise.withResolvers<void>();
    const development = createDevelopmentComputeDriver();
    const applicationName = `namespace-locks-${randomUUID()}`;
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: databaseUrl, max: 8, application_name: applicationName }),

      pollIntervalMs: 20,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      emit() {},
      computeDriver: {
        ...development,
        capability: "compute" as const,
        async stopRevision() {},
        async ensureNamespace(
          candidate: import("../../packages/contracts/src/index.ts").Namespace,
          lifecycle: import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext,
        ) {
          if (candidate.id === namespace.id) {
            entered.resolve(lifecycle);
            await releaseCompute.promise;
          }
          return development.ensureNamespace(candidate);
        },
      },
    });
    const blocker = await pool.connect();
    let blocked = false;
    context.after(async () => {
      releaseCompute.resolve();
      if (blocked) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await worker.stop();
      await pool.end();
    });
    await worker.start();
    const lifecycle = await entered.promise;
    await blocker.query("BEGIN");
    blocked = true;
    await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespace.id]);
    // The contract callback and real finalizer overlap behind an actual PostgreSQL
    // Namespace lock. Reversing either owner's work/Namespace order deadlocks here.
    const checkpoint = lifecycle.checkpoint(0, { stage: "attempted" });
    await waitFor("checkpoint waiting for Namespace lock", async () => {
      const waiting = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM occ.namespaces%'",
        [applicationName],
      );
      return waiting.rowCount ? true : undefined;
    });
    releaseCompute.resolve();
    await waitFor("finalization waiting for work lock", async () => {
      const waiting = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%UPDATE occ.controller_work%'",
        [applicationName],
      );
      return waiting.rowCount ? true : undefined;
    });
    await blocker.query("COMMIT");
    blocked = false;
    assert.equal((await checkpoint).revision, 1);
    await waitFor("Namespace finalization after concurrent checkpoint", async () => {
      const current = await state.read((view) => view.namespaces.findNamespace(namespace.id));
      return current?.status === "ready" ? true : undefined;
    });
    const audits = await pool.query(
      "SELECT actor_id, details FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.namespaces.lifecycle.checkpoint' ORDER BY occurred_at,id",
      [namespace.id],
    );
    assert.equal(audits.rowCount, 2);
    for (const row of audits.rows) {
      assert.equal(row.actor_id, actor.id);
      assert.equal(row.details.lifecycleId, lifecycle.lifecycleId);
      assert.equal(row.details.workId, key);
      assert.equal(row.details.computeDriverId, development.id);
      assert.equal(row.details.computeImplementation, development.implementation);
      assert.equal(row.details.target, "ready");
      assert.equal(Object.hasOwn(row.details, "data"), false);
      assert.equal(Object.hasOwn(row.details, "namespaceReady"), false);
    }
    assert.deepEqual(
      audits.rows.map((row) => [row.details.operation, row.details.revision]),
      [
        ["bind", 0],
        ["checkpoint", 1],
      ],
    );
  },
);

test(
  "Namespace checkpoint audit failure rolls back the journal and permits an exact retry",
  {
    ...requiresPostgres,
    skip:
      requiresPostgres.skip ||
      (!process.env.OPENCLAW_ENTERPRISE_CI_STATE &&
        "Requires the native CI runner's owned disposable PostgreSQL fixture."),
    timeout: 15_000,
  },
  async (context) => {
    const [
      { Pool },
      { readFile },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { authorizedPrincipal },
    ] = await Promise.all([
      import("pg"),
      import("node:fs/promises"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../helpers/postgres-backend-state.mjs"),
    ]);
    assert.ok(databaseUrl);
    const application = new URL(databaseUrl);
    const ownership = JSON.parse(await readFile(process.env.OPENCLAW_ENTERPRISE_CI_STATE!, "utf8"));
    assert.equal(
      ownership.repositoryRoot,
      new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
    );
    assert.equal(ownership.prefix, process.env.OPENCLAW_ENTERPRISE_CI_PREFIX);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(application.hostname));
    assert.equal(application.username, "occ_app");
    assert.equal(application.password, "occ-app-local");
    const database = ownership.resources.find(
      (resource: { kind: string; name: string }) =>
        resource.kind === "postgres-database" && resource.name === application.pathname.slice(1),
    );
    assert.ok(database);
    assert.equal(database.owner, ownership.prefix);
    assert.equal(database.status, "ready");
    assert.equal(database.port, Number(application.port));
    const server = ownership.resources.find(
      (resource: { kind: string; name: string }) =>
        resource.kind === "compose-postgres" && resource.name === database.composeProject,
    );
    assert.equal(server?.owner, ownership.prefix);
    assert.equal(server?.port, database.port);
    // Inject a real database audit-write refusal only inside this recorded disposable
    // fixture. The application still runs with occ_app; DDL uses the migrator role.
    const migration = new URL(application);
    migration.username = "occ_migrator";
    migration.password = "occ-migrator-local";
    const migrator = new Pool({ connectionString: migration.toString(), max: 1 });
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "Namespace journal audit rollback");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
    assert.ok(actor);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Namespace audit ${randomUUID()}`,
      status: "provisioning" as const,
      createdAt: new Date().toISOString(),
    };
    const key = `namespace:${namespace.id}:reconcile:ready`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.createNamespace(namespace);
      await queue.enqueue({
        idempotencyKey: key,
        namespaceId: namespace.id,
        namespaceTarget: "ready",
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    const functionName = `test_lifecycle_audit_${randomUUID().replaceAll("-", "")}`;
    let faultInstalled = false;
    const entered =
      Promise.withResolvers<
        import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext
      >();
    const release = Promise.withResolvers<void>();
    const development = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: databaseUrl, max: 8 }),

      pollIntervalMs: 20,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      emit() {},
      computeDriver: {
        ...development,
        capability: "compute" as const,
        async stopRevision() {},
        async ensureNamespace(
          candidate: import("../../packages/contracts/src/index.ts").Namespace,
          lifecycle: import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext,
        ) {
          if (candidate.id === namespace.id) {
            entered.resolve(lifecycle);
            await release.promise;
          }
          return development.ensureNamespace(candidate);
        },
      },
    });
    const removeFault = async () => {
      if (faultInstalled) {
        await migrator.query(
          `DROP TRIGGER ${functionName} ON occ.audit_events; DROP FUNCTION occ.${functionName}()`,
        );
        faultInstalled = false;
      }
    };
    context.after(async () => {
      release.resolve();
      await worker.stop();
      await removeFault();
      await migrator.end();
      await pool.end();
    });
    await migrator.query(
      `CREATE FUNCTION occ.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.namespace_id=TG_ARGV[0] AND NEW.action='openclaw.namespaces.lifecycle.checkpoint' AND NEW.details->>'operation'='checkpoint' THEN RAISE EXCEPTION 'test audit write refused' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${functionName} BEFORE INSERT ON occ.audit_events FOR EACH ROW EXECUTE FUNCTION occ.${functionName}('${namespace.id}')`,
    );
    faultInstalled = true;
    await worker.start();
    const lifecycle = await entered.promise;
    const before = await lifecycle.read();
    await assert.rejects(
      lifecycle.checkpoint(before.revision, { stage: "attempted" }),
      /exact platform ownership or state/,
    );
    assert.deepEqual(await lifecycle.read(), before);
    assert.equal(
      (
        await pool.query(
          "SELECT id FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.namespaces.lifecycle.checkpoint' AND details->>'operation'='checkpoint'",
          [namespace.id],
        )
      ).rowCount,
      0,
    );
    await removeFault();
    assert.equal(
      (await lifecycle.checkpoint(before.revision, { stage: "attempted" })).revision,
      before.revision + 1,
    );
    const audit = await pool.query(
      "SELECT actor_id,details FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.namespaces.lifecycle.checkpoint' AND details->>'operation'='checkpoint'",
      [namespace.id],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_id, actor.id);
    assert.equal(audit.rows[0].details.revision, 1);
    assert.equal(Object.hasOwn(audit.rows[0].details, "data"), false);
  },
);

test(
  "Namespace checkpoint with a lost real COMMIT reply is recovered from durable state",
  { ...requiresPostgres, timeout: 15_000 },
  async (context) => {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { authorizedPrincipal },
      { commitAckProxy },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
      import("../helpers/postgres-backend-state.mjs"),
      import("../fixtures/postgres-commit-ack-proxy.mjs"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const state = new PostgresPlatformState(pool);
    await ensureInstallation(state, "Namespace lost checkpoint reply");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [["create", "namespace"]]);
    assert.ok(actor);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Namespace commit ${randomUUID()}`,
      status: "provisioning" as const,
      createdAt: new Date().toISOString(),
    };
    const key = `namespace:${namespace.id}:reconcile:ready`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.createNamespace(namespace);
      await queue.enqueue({
        idempotencyKey: key,
        namespaceId: namespace.id,
        namespaceTarget: "ready",
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    const proxy = await commitAckProxy(databaseUrl);
    const entered =
      Promise.withResolvers<
        import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext
      >();
    const release = Promise.withResolvers<void>();
    const development = createDevelopmentComputeDriver();
    const worker = createControllerWorker({
      pool: new Pool({ connectionString: proxy.url, max: 8 }),
      pollIntervalMs: 20,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      emit() {},
      computeDriver: {
        ...development,
        capability: "compute" as const,
        async stopRevision() {},
        async ensureNamespace(
          candidate: import("../../packages/contracts/src/index.ts").Namespace,
          lifecycle: import("../../packages/contracts/src/index.ts").NamespaceLifecycleContext,
        ) {
          if (candidate.id === namespace.id) {
            entered.resolve(lifecycle);
            await release.promise;
          }
          return development.ensureNamespace(candidate);
        },
      },
    });
    context.after(async () => {
      release.resolve();
      await worker.stop();
      await proxy.close();
      await pool.end();
    });
    await worker.start();
    const lifecycle = await entered.promise;
    const initial = await lifecycle.read();
    const intent = { stage: "attempted", operationId: randomUUID() };
    // The existing TCP proxy consumes PostgreSQL's actual COMMIT completion and
    // closes the socket. This is a lost database response, not a patched State result.
    proxy.arm();
    await assert.rejects(lifecycle.checkpoint(initial.revision, intent), {
      name: "PostgresCommitOutcomeUnknownError",
    });
    assert.equal(proxy.observedCommit, true);
    const committed = await state.transact((unit) => unit.namespaces.findLifecycle(namespace.id));
    assert.equal(committed?.revision, initial.revision + 1);
    assert.deepEqual(committed?.data, intent);
    const recovered = await lifecycle.read();
    assert.deepEqual(recovered, { revision: initial.revision + 1, data: intent });
    assert.deepEqual(Object.keys(recovered).sort(), ["data", "revision"]);
    const audit = await pool.query(
      "SELECT actor_id,details FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.namespaces.lifecycle.checkpoint' AND details->>'operation'='checkpoint'",
      [namespace.id],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_id, actor.id);
    assert.equal(audit.rows[0].details.revision, committed?.revision);
  },
);
