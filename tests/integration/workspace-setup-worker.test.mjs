import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/workspace-defaults.mjs";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  authorizedPrincipal,
  createBackendWorkerDrivers,
  databaseUrl,
  ensureInstallation,
  requiresPostgres,
  waitFor,
} from "../helpers/postgres-backend-state.mjs";

// Real OCC admission, PostgreSQL persistence/queue, IAM, and production worker.
// Compute is the established deterministic fixture; native file application is
// proved by the runtime suites, not by these boundary observations.
async function setup(t) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  let worker;
  t.after(async () => {
    if (worker === undefined) {
      await workerPool.end();
    } else {
      await worker.stop();
    }
    await pool.end();
  });
  const installation = await ensureInstallation(state, "workspace-setup-worker");
  const actor = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["create", "configuration"],
    ["create", "agent"],
    ["deploy", "agent"],
  ]);
  assert.ok(actor);
  const namespace = await state.transact((unit) =>
    unit.namespaces.createNamespace({
      id: `ns_${randomUUID()}`,
      name: `workspace-worker-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    }),
  );
  const compute = createDevelopmentComputeDriver();
  const drivers = createBackendWorkerDrivers(compute, []);
  const controller = new OpenClawController(installation, { state });
  for (const driver of [
    compute,
    drivers.configurationDriver,
    drivers.secretDriver,
    drivers.createIAMDriver(state),
  ]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const configuration = await controller.createConfiguration(actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("codex", "gpt-5.6-sol"),
  });
  return {
    pool,
    state,
    namespace,
    compute,
    async agent(files) {
      return controller.createAgent(actor.id, {
        namespaceId: namespace.id,
        name: `workspace-agent-${randomUUID()}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "runtime" },
        initialWorkspaceFiles: files,
        workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
      });
    },
    async deploy(agent) {
      return controller.deployAgent(
        actor.id,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedHarness,
      );
    },
    readSetup(agent) {
      return state.read((view) => view.workspaceSetups.find(namespace.id, agent.id));
    },
    async work(revision, expected = "succeeded") {
      return waitFor(`workspace revision ${revision.id} to become ${expected}`, async () => {
        const { rows } = await pool.query(
          "SELECT state, attempt_count, reason_code FROM occ.controller_work WHERE revision_id = $1",
          [revision.id],
        );
        return rows[0]?.state === expected ? rows[0] : undefined;
      });
    },
    async activeRevision(agent) {
      return (await state.read((view) => view.agents.findAgent(namespace.id, agent.id)))
        ?.activeRevisionId;
    },
    start(computeDriver) {
      worker = createControllerWorker({
        pool: workerPool,
        mode: "production",
        drivers: { ...drivers, computeDriver },
        pollIntervalMs: 15,
        leaseDurationMs: 30_000,
        maxAttempts: 3,
      });
      return worker.start();
    },
  };
}

test(
  "worker retains exact-Agent workspace input through activation failure and purges it only after success",
  requiresPostgres,
  async (t) => {
    const fixture = await setup(t);
    const files = { "AGENTS.md": "# Private initial instructions\n", "USER.md": "" };
    const agent = await fixture.agent(files);
    const sibling = await fixture.agent({ "AGENTS.md": "# Sibling instructions\n" });
    const initial = await fixture.readSetup(agent);
    const siblingSetup = await fixture.readSetup(sibling);
    assert.deepEqual(initial.files, files);
    assert.equal(initial.completed, false);
    const first = await fixture.deploy(agent);
    const deliveries = [];
    let failed = false;
    let activations = 0;
    await fixture.start({
      ...fixture.compute,
      supportsWorkspaceSetup: true,
      activationOrder: "beforeCommit",
      async preflight() {},
      async prepareRevision(revision, context) {
        deliveries.push({
          revisionId: revision.id,
          setup: structuredClone(context.workspaceSetup),
        });
        assert.equal(context.workspaceSetup.namespaceId, fixture.namespace.id);
        assert.equal(context.workspaceSetup.agentId, agent.id);
        assert.equal(Object.hasOwn(revision, "workspaceSetup"), false);
        assert.equal(Object.hasOwn(revision, "initialWorkspaceFiles"), false);
        return fixture.compute.prepareRevision(revision);
      },
      async activateRevision(revision) {
        activations++;
        if (revision.id === first.id) {
          assert.deepEqual(await fixture.readSetup(agent), initial);
          assert.equal(await fixture.activeRevision(agent), undefined);
          if (!failed) {
            failed = true;
            throw new Error("Fixture activation is not ready");
          }
        }
      },
    });
    const firstWork = await fixture.work(first);
    assert.equal(firstWork.attempt_count, 2);
    assert.equal(activations, 2);
    assert.equal(await fixture.activeRevision(agent), first.id);
    const { files: removedFiles, ...identity } = initial;
    assert.deepEqual(removedFiles, files);
    const completed = { ...identity, completed: true };
    assert.deepEqual(await fixture.readSetup(agent), completed);
    assert.deepEqual(await fixture.readSetup(sibling), siblingSetup);
    assert.deepEqual(deliveries, [
      { revisionId: first.id, setup: initial },
      { revisionId: first.id, setup: initial },
    ]);

    const replacement = await fixture.deploy(agent);
    await fixture.work(replacement);
    assert.equal(await fixture.activeRevision(agent), replacement.id);
    assert.deepEqual(deliveries.at(-1), { revisionId: replacement.id, setup: completed });
    assert.deepEqual(await fixture.readSetup(agent), completed);
    assert.deepEqual(await fixture.readSetup(sibling), siblingSetup);
  },
);

test(
  "worker rejects unsupported workspace setup before Compute preparation and retains pending files",
  requiresPostgres,
  async (t) => {
    const fixture = await setup(t);
    const agent = await fixture.agent({ "SOUL.md": "# Pending setup\n" });
    const initial = await fixture.readSetup(agent);
    const revision = await fixture.deploy(agent);
    let preparations = 0;
    await fixture.start({
      ...fixture.compute,
      async preflight() {},
      async prepareRevision(candidate) {
        preparations++;
        return fixture.compute.prepareRevision(candidate);
      },
    });
    const work = await fixture.work(revision, "failed_permanent");
    assert.equal(work.reason_code, "WORKSPACE_SETUP_UNSUPPORTED");
    assert.equal(preparations, 0);
    assert.equal(await fixture.activeRevision(agent), undefined);
    assert.deepEqual(await fixture.readSetup(agent), initial);
  },
);
