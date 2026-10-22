import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import {
  type OpenShellGitRouteSnapshot,
  PostgresOpenShellGitRouteStore,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { CredentialDeliveries, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { seedSessionRevision } from "../conformance/repository-sessions.contract.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

// The persisted OpenShell Git route (migration 0062) as the application role
// writes it: identity and custody facts only, one holder named by a fence, a pending write
// and a tombstone that outlive the worker. The runtime's use of it is covered by
// tests/conformance/openshell-git-runtime.test.mjs with the in-memory store.
const observed = {
  workspace: "team-workspace",
  sandbox: "git-execution",
  sandboxId: "sandbox-id-one",
  executionId: "rev-one",
  provider: "oce-git-0123456789abcdef0123456789abcdef",
  providerId: "provider-id-one",
  providerResourceVersion: "12",
  profileVersion: "7",
  credentialState: "active" as const,
  attachmentEpoch: "epoch-one",
  providerEnvRevision: "3",
  configRevision: "1",
  policyHash: "policy-one",
  supervisorSessionId: "session-one",
  processInstanceId: "process-one",
  networkInstanceId: "network-one",
};

test(
  "OpenShell Git routes persist identity and custody facts under one fenced holder",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const { revision } = await seedSessionRevision(state);
    const { revision: other } = await seedSessionRevision(state);
    const store = new PostgresOpenShellGitRouteStore(pool);
    const route = {
      revisionId: revision.id,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      workspace: "team-workspace",
      sandbox: "git-execution",
      bindingId: "b".repeat(32),
    };
    const workers = [randomUUID(), randomUUID(), randomUUID()];

    // The common owner preserves immutable identity and restricts mutation to delivery state.
    const { rows: privileges } = await pool.query(
      `SELECT has_table_privilege('occ_app', 'occ.credential_deliveries', 'DELETE') AS delete_rows,
        has_column_privilege('occ_app', 'occ.credential_deliveries', 'revision_id', 'UPDATE') AS move_revision,
        has_column_privilege('occ_app', 'occ.credential_deliveries', 'binding_id', 'UPDATE') AS move_binding,
        has_column_privilege('occ_app', 'occ.credential_deliveries', 'namespace_id', 'UPDATE') AS move_namespace,
        has_column_privilege('occ_app', 'occ.credential_deliveries', 'agent_id', 'UPDATE') AS move_agent,
        has_column_privilege('occ_app', 'occ.credential_deliveries', 'target', 'UPDATE') AS move_target,
        has_column_privilege('occ_app', 'occ.credential_deliveries', 'fence', 'UPDATE') AS move_fence`,
    );
    assert.deepEqual(privileges, [
      {
        delete_rows: false,
        move_revision: false,
        move_binding: false,
        move_namespace: false,
        move_agent: false,
        move_target: false,
        move_fence: true,
      },
    ]);

    assert.equal(await store.adopt(revision.id, workers[0]!), undefined, "no route to adopt");
    await assert.rejects(
      store.open({ ...route, agentId: other.agentId }, workers[0]!),
      { code: "23503" },
      "a live revision does not permit another Agent owner",
    );
    await store.open(route, workers[0]!);
    await assert.rejects(store.open(route, workers[0]!), /duplicate key/);
    // A competing bootstrap must not create a second identity for the same recipient.
    await assert.rejects(
      store.open({ ...route, bindingId: "c".repeat(32) }, workers[1]!),
      /credential_deliveries_revision_id_target_key/,
    );
    await assert.rejects(
      store.open({ ...route, revisionId: other.id, bindingId: "short" }, workers[0]!),
      /Invalid OpenShell binding/,
    );
    const bootstrapping = { credentialState: "bootstrap" as const, expiresAt: "" };
    const generation = {
      providerId: "provider-id-one",
      profileVersion: "7",
      resourceVersion: "11",
    };
    const snapshot: OpenShellGitRouteSnapshot = {
      generation: { ...generation, ...bootstrapping },
      material: undefined,
      observed: undefined,
    };
    assert.equal(await store.record(revision.id, 1, snapshot), true);
    // Once bootstrap is settled, replacement can adopt its immutable observation.
    const adopted = await store.adopt(revision.id, workers[1]!);
    assert.deepEqual(adopted, {
      ...route,
      fence: 2,
      ...snapshot,
      writePending: undefined,
      blocked: undefined,
    });
    assert.equal(
      await store.record(revision.id, 1, snapshot),
      false,
      "a stale fence writes nothing",
    );
    assert.equal(await store.owns(revision.id, 1), false);
    assert.equal(await store.writing(revision.id, 1, "rotate"), undefined);
    assert.equal(await store.block(revision.id, 1, "unknown"), false);
    assert.equal(await store.owns(revision.id, 2), true);
    assert.equal(await store.record(revision.id, 2, snapshot), true);
    assert.deepEqual(await store.adopt(revision.id, workers[2]!), {
      ...route,
      fence: 3,
      generation: { ...generation, ...bootstrapping },
      material: undefined,
      observed: undefined,
      writePending: undefined,
      blocked: undefined,
    });
    // A provider write in flight stays visible to the next worker with the facts before it.
    const candidate = { materialVersion: randomUUID(), preparationAttemptId: randomUUID() };
    assert.equal(
      await store.writing(revision.id, 3, "rotate"),
      undefined,
      "rotation cannot reserve an absent material target",
    );
    assert.equal(await store.writing(revision.id, 3, "rotate", candidate), 4);
    assert.equal(await store.writing(revision.id, 4, "rotate", candidate), undefined);
    const { rows: pending } = await pool.query(
      "SELECT target_material_version, target_preparation_attempt_id FROM occ.credential_deliveries WHERE revision_id=$1",
      [revision.id],
    );
    assert.deepEqual(pending, [
      {
        target_material_version: candidate.materialVersion,
        target_preparation_attempt_id: candidate.preparationAttemptId,
      },
    ]);
    assert.equal(await store.owns(revision.id, 4), true);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const active: OpenShellGitRouteSnapshot = {
      generation: { ...generation, resourceVersion: "12", credentialState: "active", expiresAt },
      material: { materialVersion: randomUUID(), preparationAttemptId: randomUUID() },
      observed,
    };
    assert.equal(
      await store.record(revision.id, 4, active),
      false,
      "C cannot substitute for the pending B operation",
    );
    assert.equal(
      await store.writing(revision.id, 4, "rotate", active.material),
      undefined,
      "uncertain B consumes the installation opportunity",
    );
    assert.equal(
      await store.record(revision.id, 4, {
        ...active,
        material: {
          ...candidate,
          materialVersion: active.material!.materialVersion,
        },
      }),
      false,
      "the original attempt with a different version is also refused",
    );
    const installedB = { ...active, material: candidate };
    assert.equal(await store.record(revision.id, 4, installedB), true);
    assert.equal((await store.adopt(revision.id, workers[0]!))?.fence, 5);
    const held = await store.adopt(revision.id, workers[1]!);
    assert.deepEqual(held, {
      ...route,
      fence: 6,
      ...installedB,
      writePending: undefined,
      blocked: undefined,
    });
    // Only the known identity keys fit the observation; a material version is a uuid.
    await assert.rejects(
      store.record(revision.id, 6, {
        ...active,
        observed: Object.assign({}, observed, { token: "x" }),
      }),
      /Invalid OpenShell delivery observation/,
    );
    await assert.rejects(
      store.record(revision.id, 6, {
        ...active,
        material: { materialVersion: "version-one", preparationAttemptId: randomUUID() },
      }),
      /invalid input syntax for type uuid/,
    );
    await assert.rejects(
      store.record(revision.id, 6, {
        ...active,
        generation: { ...active.generation, resourceVersion: "rv-12" },
      }),
      /Invalid OpenShell provider generation/,
    );
    const { rows: stored } = await pool.query(
      "SELECT * FROM occ.credential_deliveries WHERE revision_id = $1",
      [revision.id],
    );
    assert.equal(stored[0].worker_instance, workers[1]!);
    assert.equal(JSON.stringify(stored).includes("token"), false);

    // The first tombstone stays: no later adoption moves the fence, no later block or
    // withdrawal changes the reason, and a stale or current fence writes nothing more.
    assert.equal(await store.block(revision.id, 6, "supervisor_replaced"), true);
    assert.equal(await store.block(revision.id, 6, "unknown"), false);
    assert.deepEqual(await store.adopt(revision.id, workers[2]!), {
      ...held,
      writePending: undefined,
      blocked: "supervisor_replaced",
    });
    assert.equal(await store.owns(revision.id, 6), false);
    assert.equal(await store.record(revision.id, 6, active), false);
    await store.withdraw({ revisionId: revision.id });
    assert.equal((await store.adopt(revision.id, workers[2]!))?.blocked, "supervisor_replaced");

    // Withdrawal of a revision or a whole Namespace tombstones its open routes, whoever
    // holds them.
    const second = {
      ...route,
      revisionId: other.id,
      namespaceId: other.namespaceId,
      agentId: other.agentId,
    };
    await store.open(second, workers[0]!);
    await store.withdraw({ namespaceId: revision.namespaceId });
    assert.equal(
      (await store.adopt(other.id, workers[1]!))?.blocked,
      undefined,
      "another Namespace",
    );
    await store.withdraw({ namespaceId: other.namespaceId });
    assert.deepEqual(await store.adopt(other.id, workers[1]!), {
      ...second,
      fence: 2,
      generation: undefined,
      material: undefined,
      observed: undefined,
      writePending: "bootstrap",
      blocked: "withdrawn",
    });

    // A different binding on the same execution must not make a retired Git holder appear current.
    const otherBinding = "d".repeat(32);
    const pendingMaterialVersion = randomUUID();
    const pendingPreparationAttempt = randomUUID();
    await pool.query(
      `INSERT INTO occ.credential_deliveries
         (revision_id,live_revision_id,binding_id,namespace_id,agent_id,target,worker_instance,settlement,write_pending,target_material_version,target_preparation_attempt_id)
       VALUES ($1,$1,$2,$3,$4,$5::jsonb,$6,'snapshot','rotate',$7,$8)`,
      [
        other.id,
        otherBinding,
        other.namespaceId,
        other.agentId,
        JSON.stringify({
          transport: "other/v1",
          workspace: second.workspace,
          sandbox: second.sandbox,
        }),
        workers[0],
        pendingMaterialVersion,
        pendingPreparationAttempt,
      ],
    );
    await assert.rejects(store.owns(other.id, 1), /one binding per execution/);
    await assert.rejects(
      store.beginDetach(other.id, "a".repeat(64), randomUUID(), "1"),
      /one binding per execution/,
    );
    // Namespace Git withdrawal cannot erase another delivery owner's uncertain write.
    await store.withdraw({ namespaceId: other.namespaceId });
    const { rows: foreign } = await pool.query(
      `SELECT blocked,write_pending,target_material_version,target_preparation_attempt_id
       FROM occ.credential_deliveries WHERE revision_id=$1 AND binding_id=$2`,
      [other.id, otherBinding],
    );
    assert.deepEqual(foreign, [
      {
        blocked: null,
        write_pending: "rotate",
        target_material_version: pendingMaterialVersion,
        target_preparation_attempt_id: pendingPreparationAttempt,
      },
    ]);
  },
);

test(
  "Git expiry permanently fences earlier route holders and grants only one conditional send",
  {
    ...requiresPostgres,
    timeout: 60_000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const { repositoryCredentials } =
      await import("../fixtures/repository-credentials/session-state.mjs");
    // The worker and supplier tests exercise crossing the deadline. This is the store's
    // completed-deadline input; the binding remains attached to its live, desired-running Agent.
    const { revision } = await seedSessionRevision(
      state,
      repositoryCredentials({ deadlineWallMs: Date.now() - 1 }),
    );
    const { id, namespaceId, agentId } = revision;
    await state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespaceId, agentId, undefined, id),
    );
    const store = new PostgresOpenShellGitRouteStore(pool);
    const { workspace, sandbox } = observed;
    await store.open(
      { revisionId: id, namespaceId, agentId, workspace, sandbox, bindingId: "x".repeat(32) },
      randomUUID(),
    );
    const launch = "a".repeat(64);
    const expire = (r = revision) =>
      store.expire(r as unknown as AgentRevision, workspace, sandbox);
    assert.equal(await expire(), undefined, "an unwitnessed bootstrap cannot produce retention");
    const snapshot: OpenShellGitRouteSnapshot = {
      retainedLaunchHash: launch,
      observed: { ...observed, executionId: id },
      generation: {
        credentialState: "active" as const,
        expiresAt: new Date().toISOString(),
        providerId: observed.providerId,
        profileVersion: observed.profileVersion,
        resourceVersion: observed.providerResourceVersion,
      },
      material: { materialVersion: randomUUID(), preparationAttemptId: randomUUID() },
    };
    // Bootstrap installs no material. The real rotation path reserves the exact token first.
    assert.equal(
      await store.record(id, 1, {
        generation: { ...snapshot.generation, credentialState: "bootstrap", expiresAt: "" },
        material: undefined,
        observed: undefined,
      }),
      true,
    );
    assert.equal(await store.writing(id, 1, "rotate", snapshot.material), 2);
    assert.equal(await store.record(id, 2, snapshot), true);
    assert.equal(
      await expire({
        ...revision,
        repositoryCredentials: {
          ...revision.repositoryCredentials,
          deadlineWallMs: Date.now() + 60_000,
        },
      }),
      undefined,
      "a worker cannot substitute another deadline",
    );
    assert.equal(await store.owns(id, 2), true);
    const frozen = await expire();
    assert.equal(frozen?.retainedLaunchHash, launch);
    assert.equal(await store.owns(id, 2), false);
    assert.equal(await store.record(id, 2, snapshot), false);
    assert.equal(await store.writing(id, 2, "rotate"), undefined);
    assert.equal((await store.adopt(id, randomUUID()))?.blocked, "repository_expired");
    const request = randomUUID();
    assert.equal(await store.beginDetach(id, launch, request, "13"), true);
    assert.equal(await store.beginDetach(id, launch, randomUUID(), "13"), false);
    assert.deepEqual((await expire())?.detach, { requestId: request });
    assert.equal(await store.confirmDetached(id, launch, request, "epoch-two"), true);
    assert.equal(await store.confirmDetached(id, launch, request, "epoch-replaced"), false);
    assert.equal((await expire())?.detach?.epoch, "epoch-two");
    await store.withdraw({ revisionId: id });
    assert.equal(await expire(), undefined, "explicit stop supersedes a witnessed withdrawal");
    assert.equal(await store.confirmDetached(id, launch, request, "epoch-two"), true);
  },
);

test(
  "delivery obligations survive Agent cleanup without reopening use",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    const { revision } = await seedSessionRevision(state);
    const { id: revisionId, namespaceId, agentId } = revision;
    const key = { revisionId, namespaceId, agentId, bindingId: "cleanup-receipt" };
    const target = { transport: "receipt-test", recipient: "isolated-recipient" };
    const material = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
    const client = await pool.connect();
    t.after(async () => {
      client.release();
      await pool.end();
    });
    const deliveries = new CredentialDeliveries(client);
    const fence = await deliveries.observe(key, target, randomUUID());
    assert.equal(fence, 1);
    const operation = await deliveries.beginInstall(key, fence!, target, material);
    assert.equal(operation, 2);
    await deliveries.withdraw([key], "withdrawn");

    await deleteAgent(state, client, revision);
    const read = async () =>
      (
        await client.query(
          `SELECT live_revision_id,blocked,write_pending,target_material_version,operation_fence
     FROM occ.credential_deliveries WHERE revision_id=$1 AND binding_id=$2`,
          [revisionId, key.bindingId],
        )
      ).rows[0];
    const retained = await read();
    assert.equal(retained.live_revision_id, null);
    assert.equal(retained.blocked, "withdrawn");
    assert.equal(retained.write_pending, "rotate");
    assert.equal(retained.target_material_version, material.materialVersion);
    assert.equal(await deliveries.beginInstall(key, operation!, target, material), undefined);
    assert.equal(
      await deliveries.confirmInstall(key, operation!, target, {
        ...material,
        materialVersion: randomUUID(),
      }),
      undefined,
    );
    assert.equal(await deliveries.confirmInstall(key, operation!, target, material), operation);
    await assert.rejects(
      client.query(
        `INSERT INTO occ.credential_deliveries
       (revision_id,binding_id,namespace_id,agent_id,target,worker_instance,settlement)
       VALUES ($1,'new-binding',$2,$3,'{}', $4,'snapshot')`,
        [revisionId, namespaceId, agentId, randomUUID()],
      ),
      { code: "23514" },
      "deleted execution cannot gain a new detached delivery",
    );
    await assert.rejects(
      client.query(
        "UPDATE occ.credential_deliveries SET live_revision_id=$1 WHERE revision_id=$1",
        [revisionId],
      ),
      { code: "42501" },
      "application cannot revive a retained dependency",
    );
    await assert.rejects(
      deliveries.open({ ...key, bindingId: "new-live-binding" }, {}, randomUUID()),
      { code: "23503" },
      "deleted owner cannot be registered as live",
    );
    const settled = await read();
    assert.equal(settled.operation_fence, retained.operation_fence);
    assert.equal(settled.write_pending, null);
    assert.equal(settled.live_revision_id, null);
    assert.equal(settled.blocked, "withdrawn");
    assert.equal(
      await deliveries.beginInstall(key, operation!, target, {
        preparationAttemptId: randomUUID(),
        materialVersion: randomUUID(),
      }),
      undefined,
    );
  },
);

for (const operation of ["bootstrap", "rotate"] as const) {
  test(
    `a replacement lease cannot settle or replay an uncertain ${operation} installation`,
    requiresPostgres,
    async (t) => {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      t.after(() => pool.end());
      const state = new PostgresPlatformState(pool);
      const { revision } = await seedSessionRevision(state);
      const store = new PostgresOpenShellGitRouteStore(pool);
      const key = {
        revisionId: revision.id,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        bindingId: "u".repeat(32),
        workspace: observed.workspace,
        sandbox: observed.sandbox,
      };
      await store.open(key, randomUUID());
      const generation = {
        credentialState: "bootstrap" as const,
        expiresAt: "",
        providerId: observed.providerId,
        resourceVersion: "11",
        profileVersion: observed.profileVersion,
      };
      const b = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
      if (operation === "rotate") {
        assert.equal(
          await store.record(revision.id, 1, {
            generation,
            observed: undefined,
            material: undefined,
          }),
          true,
        );
        assert.equal(await store.writing(revision.id, 1, "rotate", b), 2);
      }
      const pending = (
        await pool.query(
          "SELECT operation_fence FROM occ.credential_deliveries WHERE revision_id=$1",
          [revision.id],
        )
      ).rows[0];
      const replacement = await store.adopt(revision.id, randomUUID());
      assert.equal(replacement?.writePending, operation);
      const fence = replacement!.fence;
      const unchanged = { generation, observed: undefined, material: undefined };
      assert.equal(
        await store.record(revision.id, fence, unchanged),
        false,
        "replacement cannot clear even a material-free bootstrap",
      );
      assert.equal(
        await store.cancelWriting(revision.id, fence),
        false,
        "replacement cannot assert the original worker sent nothing",
      );
      const active = {
        generation: {
          ...generation,
          credentialState: "active" as const,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          resourceVersion: "12",
        },
        observed,
      };
      const c = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
      assert.equal(await store.record(revision.id, fence, { ...active, material: c }), false);
      // The OpenShell receipt has no independent operation witness. Even matching B
      // under a new lease remains unknown; the registered Driver uses confirmInstall.
      assert.equal(await store.record(revision.id, fence, { ...active, material: b }), false);
      assert.equal(await store.record(revision.id, 1, { ...active, material: b }), false);
      assert.equal(await store.writing(revision.id, fence, "rotate", b), undefined);
      await store.withdraw({ revisionId: revision.id });
      const retained = (
        await pool.query(
          "SELECT operation_fence,target_preparation_attempt_id,target_material_version,write_pending,blocked FROM occ.credential_deliveries WHERE revision_id=$1",
          [revision.id],
        )
      ).rows[0];
      assert.deepEqual(retained, {
        ...pending,
        target_preparation_attempt_id: operation === "rotate" ? b.preparationAttemptId : null,
        target_material_version: operation === "rotate" ? b.materialVersion : null,
        write_pending: operation,
        blocked: "withdrawn",
      });
    },
  );
}

async function deleteAgent(
  state: PostgresPlatformState,
  client: pg.PoolClient,
  revision: Awaited<ReturnType<typeof seedSessionRevision>>["revision"],
) {
  const { namespaceId, agentId } = revision;
  // The runtime is stopped. Admit and claim this Agent's deletion as the worker
  // would, then exercise the real database finalizer and its cascade actions.
  await state.transact(async (unit) => {
    await unit.agents.transitionAgentDesiredRuntimeState(
      namespaceId,
      agentId,
      "running",
      "stopped",
    );
    await unit.agents.transitionAgentStatus(namespaceId, agentId, "active", "deleting");
    await unit.operations.append({
      kind: "agent",
      action: "reconcile",
      target: "deleted",
      namespaceId,
      resourceId: agentId,
      actorId: revision.servicePrincipalId,
    });
  });
  const work = `agent:${agentId}:reconcile:deleted`;
  const claim = randomUUID();
  const claimed = await client.query(
    `UPDATE occ.controller_work SET state='claimed',claim_token=$2,attempt_count=attempt_count+1,
    lease_expires_at=clock_timestamp()+interval '1 minute'
   WHERE idempotency_key=$1 AND state='queued'`,
    [work, claim],
  );
  assert.equal(claimed.rowCount, 1);
  const removed = await client.query("SELECT occ.finalize_agent_deletion($1,$2,$3,$4) AS removed", [
    namespaceId,
    agentId,
    work,
    claim,
  ]);
  assert.equal(removed.rows[0].removed, true);
}

test(
  "settlement policy and operation identity cannot be substituted",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    t.after(async () => {
      client.release();
      await pool.end();
    });
    const state = new PostgresPlatformState(pool);
    const { revision } = await seedSessionRevision(state);
    const key = {
      revisionId: revision.id,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      bindingId: "witness",
    };
    const target = { recipient: "independently-observed" };
    const deliveries = new CredentialDeliveries(client);
    assert.equal(await deliveries.observe(key, target, randomUUID()), 1);
    const b = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
    const c = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
    const first = await deliveries.beginInstall(key, 1, target, b);
    assert.equal(first, 2);
    assert.equal(
      await deliveries.record(key, first!, { desired: {}, observed: target, material: b }),
      false,
    );
    assert.equal(await deliveries.cancelWriting(key, first!), false);
    await assert.rejects(
      client.query(
        "UPDATE occ.credential_deliveries SET settlement='snapshot' WHERE revision_id=$1",
        [revision.id],
      ),
      { code: "42501" },
      "the selected settlement policy is immutable to the application",
    );
    assert.equal(await deliveries.confirmInstall(key, first!, target, b), first);
    assert.equal(
      await deliveries.writing(key, first!, "rotate", c),
      undefined,
      "witness deliveries cannot enter the snapshot writer",
    );
    const second = await deliveries.beginInstall(key, first!, target, c);
    assert.equal(second, 3);
    assert.equal(await deliveries.confirmInstall(key, second!, target, c), second);
    // Reusing B's identity later must not make the original B confirmation current.
    const third = await deliveries.beginInstall(key, second!, target, b);
    assert.equal(third, 4);
    assert.equal(await deliveries.confirmInstall(key, first!, target, b), undefined);
    assert.equal(await deliveries.confirmInstall(key, third!, target, b), third);

    const snapshotKey = { ...key, bindingId: "snapshot" };
    await deliveries.open(snapshotKey, {}, randomUUID());
    await assert.rejects(
      client.query(
        "UPDATE occ.credential_deliveries SET write_pending='rotate' WHERE revision_id=$1 AND binding_id=$2",
        [snapshotKey.revisionId, snapshotKey.bindingId],
      ),
      { code: "23514" },
      "the database also rejects a rotation without a target",
    );
    assert.equal(await deliveries.observe(snapshotKey, {}, randomUUID()), undefined);
    assert.equal(await deliveries.record(snapshotKey, 1, { desired: {} }), true);
    const original = await deliveries.writing(snapshotKey, 1, "rotate", b);
    assert.equal(original, 2);
    assert.equal(
      await deliveries.confirmInstall(snapshotKey, original!, {}, b),
      undefined,
      "snapshot delivery cannot impersonate an independent witness",
    );
    assert.equal(await deliveries.cancelWriting(snapshotKey, original!), true);
    const next = await deliveries.writing(snapshotKey, original!, "rotate", b);
    assert.equal(next, 3, "every reservation has a distinct operation, even under the same worker");
    assert.equal(await deliveries.cancelWriting(snapshotKey, original!), false);
    assert.equal(
      await deliveries.record(snapshotKey, original!, { desired: {}, material: b }),
      false,
    );
    assert.equal(await deliveries.record(snapshotKey, next!, { desired: {}, material: b }), true);
  },
);

test(
  "retained OpenShell detach settles after deletion without authorizing another apply",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    t.after(async () => {
      client.release();
      await pool.end();
    });
    const state = new PostgresPlatformState(pool);
    const { repositoryCredentials } =
      await import("../fixtures/repository-credentials/session-state.mjs");
    const { revision } = await seedSessionRevision(
      state,
      repositoryCredentials({ deadlineWallMs: Date.now() - 1 }),
    );
    const { id, namespaceId, agentId } = revision;
    await state.transact((u) =>
      u.agents.compareAndSetActiveRevision(namespaceId, agentId, undefined, id),
    );
    const routes = new PostgresOpenShellGitRouteStore(pool);
    await routes.open(
      {
        revisionId: id,
        namespaceId,
        agentId,
        bindingId: "r".repeat(32),
        workspace: observed.workspace,
        sandbox: observed.sandbox,
      },
      randomUUID(),
    );
    const generation = {
      providerId: observed.providerId,
      profileVersion: observed.profileVersion,
      resourceVersion: observed.providerResourceVersion,
      credentialState: "bootstrap" as const,
      expiresAt: "",
    };
    assert.equal(
      await routes.record(id, 1, { generation, material: undefined, observed: undefined }),
      true,
    );
    const material = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
    const fence = await routes.writing(id, 1, "rotate", material);
    assert.equal(fence, 2);
    const recipient = { ...observed, executionId: id };
    const launch = "a".repeat(64);
    assert.equal(
      await routes.record(id, fence!, {
        generation: {
          ...generation,
          credentialState: "active",
          expiresAt: new Date().toISOString(),
        },
        observed: recipient,
        material,
        retainedLaunchHash: launch,
      }),
      true,
    );
    assert.ok(
      await routes.expire(
        revision as unknown as AgentRevision,
        observed.workspace,
        observed.sandbox,
      ),
    );
    const request = randomUUID();
    assert.equal(await routes.beginDetach(id, launch, request, "12"), true);
    await deleteAgent(state, client, revision);
    assert.equal(await routes.owns(id, fence!), false);
    assert.equal(await routes.adopt(id, randomUUID()), undefined);
    assert.equal(await routes.standing(revision as unknown as AgentRevision), undefined);
    assert.equal(await routes.beginDetach(id, launch, randomUUID(), "12"), false);
    assert.equal(await routes.confirmDetached(id, launch, randomUUID(), "epoch-two"), false);
    assert.equal(await routes.confirmDetached(id, "b".repeat(64), request, "epoch-two"), false);
    // Same names with a changed recipient do not settle the original retained obligation.
    await client.query("UPDATE occ.credential_deliveries SET observed=$2 WHERE revision_id=$1", [
      id,
      JSON.stringify({ ...recipient, sandboxId: "replacement" }),
    ]);
    assert.equal(await routes.confirmDetached(id, launch, request, "epoch-two"), false);
    await client.query("UPDATE occ.credential_deliveries SET observed=$2 WHERE revision_id=$1", [
      id,
      JSON.stringify(recipient),
    ]);
    assert.equal(await routes.confirmDetached(id, launch, request, "epoch-two"), true);
    assert.equal(await routes.confirmDetached(id, launch, request, "another-epoch"), false);
    assert.equal(await routes.beginDetach(id, launch, request, "12"), false);
    const { rows } = await client.query(
      `SELECT r.live_revision_id,r.fence,r.blocked,d.request_id,d.observed_generation
     FROM occ.credential_deliveries r JOIN occ.credential_delivery_reductions d USING (revision_id,binding_id)
     WHERE r.revision_id=$1`,
      [id],
    );
    assert.deepEqual(rows, [
      {
        live_revision_id: null,
        fence: String(fence),
        blocked: "repository_expired",
        request_id: request,
        observed_generation: "epoch-two",
      },
    ]);
  },
);
