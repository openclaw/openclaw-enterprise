import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { seedSessionRevision } from "../conformance/repository-sessions.contract.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

// The persisted OpenShell Git route (migration 0069, finding 2128) as the application role
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
  credentialState: "active",
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

    // The table holds no column that could carry a token, an App key or custody material,
    // and the application role can neither delete a route nor rewrite its identity.
    const { rows: columns } = await pool.query(
      `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'occ' AND table_name = 'openshell_git_routes' ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      columns.map((row) => row.column_name),
      [
        "revision_id",
        "namespace_id",
        "agent_id",
        "workspace",
        "sandbox",
        "binding_id",
        "fence",
        "worker_instance",
        "adopted_at",
        "updated_at",
        "provider_id",
        "profile_version",
        "provider_resource_version",
        "credential_state",
        "material_expires_at",
        "material_version",
        "preparation_attempt_id",
        "observed",
        "write_pending",
        "blocked",
        "retained_launch_hash",
        "detach_request_id",
        "detach_resource_version",
        "detached_epoch",
      ],
    );
    assert.ok(
      !columns.some((row) =>
        /token|secret|value|key|sealed|credential(?!_state)/.test(row.column_name),
      ),
    );
    const { rows: privileges } = await pool.query(
      `SELECT has_table_privilege('occ_app', 'occ.openshell_git_routes', 'DELETE') AS delete_rows,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'revision_id', 'UPDATE') AS move_revision,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'binding_id', 'UPDATE') AS move_binding,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'namespace_id', 'UPDATE') AS move_namespace,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'agent_id', 'UPDATE') AS move_agent,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'workspace', 'UPDATE') AS move_workspace,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'sandbox', 'UPDATE') AS move_sandbox,
        has_column_privilege('occ_app', 'occ.openshell_git_routes', 'fence', 'UPDATE') AS move_fence`,
    );
    assert.deepEqual(privileges, [
      {
        delete_rows: false,
        move_revision: false,
        move_binding: false,
        move_namespace: false,
        move_agent: false,
        move_workspace: false,
        move_sandbox: false,
        move_fence: true,
      },
    ]);

    assert.equal(await store.adopt(revision.id, workers[0]), undefined, "no route to adopt");
    await store.open(route, workers[0]);
    await assert.rejects(store.open(route, workers[0]), /duplicate key/);
    await assert.rejects(
      store.open({ ...route, revisionId: other.id, bindingId: "short" }, workers[0]),
      /binding_id_check/,
    );
    const bootstrapping = { credentialState: "bootstrap", expiresAt: "" };
    const generation = {
      providerId: "provider-id-one",
      profileVersion: "7",
      resourceVersion: "11",
    };
    // The bootstrap write pending, the opener's fence is 1; a replacement worker adopting the
    // route moves the fence, and the opener's writes answer false from then on.
    const adopted = await store.adopt(revision.id, workers[1]);
    assert.deepEqual(adopted, {
      ...route,
      fence: 2,
      generation: undefined,
      material: undefined,
      observed: undefined,
      writePending: "bootstrap",
      blocked: undefined,
    });
    const snapshot = {
      generation: { ...generation, ...bootstrapping },
      material: undefined,
      observed: undefined,
    };
    assert.equal(
      await store.record(revision.id, 1, snapshot),
      false,
      "a stale fence writes nothing",
    );
    assert.equal(await store.owns(revision.id, 1), false);
    assert.equal(await store.writing(revision.id, 1, "rotate"), false);
    assert.equal(await store.block(revision.id, 1, "unknown"), false);
    assert.equal(await store.owns(revision.id, 2), true);
    assert.equal(await store.record(revision.id, 2, snapshot), true);
    assert.deepEqual(await store.adopt(revision.id, workers[2]), {
      ...route,
      fence: 3,
      generation: { ...generation, ...bootstrapping },
      material: undefined,
      observed: undefined,
      writePending: undefined,
      blocked: undefined,
    });
    // A provider write in flight stays visible to the next worker with the facts before it.
    assert.equal(await store.writing(revision.id, 3, "rotate"), true);
    assert.equal((await store.adopt(revision.id, workers[0]))?.writePending, "rotate");
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const active = {
      generation: { ...generation, resourceVersion: "12", credentialState: "active", expiresAt },
      material: { materialVersion: randomUUID(), preparationAttemptId: randomUUID() },
      observed,
    };
    assert.equal(await store.record(revision.id, 4, active), true);
    const held = await store.adopt(revision.id, workers[1]);
    assert.deepEqual(held, {
      ...route,
      fence: 5,
      ...active,
      writePending: undefined,
      blocked: undefined,
    });
    // Only the known identity keys fit the observation; a material version is a uuid.
    await assert.rejects(
      store.record(revision.id, 5, { ...active, observed: { ...observed, token: "x" } }),
      /openshell_git_routes_observed_check/,
    );
    await assert.rejects(
      store.record(revision.id, 5, {
        ...active,
        material: { materialVersion: "version-one", preparationAttemptId: randomUUID() },
      }),
      /invalid input syntax for type uuid/,
    );
    await assert.rejects(
      store.record(revision.id, 5, {
        ...active,
        generation: { ...active.generation, resourceVersion: "rv-12" },
      }),
      /provider_resource_version_check/,
    );
    const { rows: stored } = await pool.query(
      "SELECT * FROM occ.openshell_git_routes WHERE revision_id = $1",
      [revision.id],
    );
    assert.equal(stored[0].worker_instance, workers[1]);
    assert.equal(JSON.stringify(stored).includes("token"), false);

    // The first tombstone stays: no later adoption moves the fence, no later block or
    // withdrawal changes the reason, and a stale or current fence writes nothing more.
    assert.equal(await store.block(revision.id, 5, "supervisor_replaced"), true);
    assert.equal(await store.block(revision.id, 5, "unknown"), false);
    assert.deepEqual(await store.adopt(revision.id, workers[2]), {
      ...held,
      writePending: undefined,
      blocked: "supervisor_replaced",
    });
    assert.equal(await store.owns(revision.id, 5), false);
    assert.equal(await store.record(revision.id, 5, active), false);
    await store.withdraw({ revisionId: revision.id });
    assert.equal((await store.adopt(revision.id, workers[2]))?.blocked, "supervisor_replaced");

    // Withdrawal of a revision or a whole Namespace tombstones its open routes, whoever
    // holds them.
    const second = {
      ...route,
      revisionId: other.id,
      namespaceId: other.namespaceId,
      agentId: other.agentId,
    };
    await store.open(second, workers[0]);
    await store.withdraw({ namespaceId: revision.namespaceId });
    assert.equal(
      (await store.adopt(other.id, workers[1]))?.blocked,
      undefined,
      "another Namespace",
    );
    await store.withdraw({ namespaceId: other.namespaceId });
    assert.deepEqual(await store.adopt(other.id, workers[1]), {
      ...second,
      fence: 2,
      generation: undefined,
      material: undefined,
      observed: undefined,
      writePending: undefined,
      blocked: "withdrawn",
    });
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
    const expire = (r = revision) => store.expire(r, workspace, sandbox);
    assert.equal(await expire(), undefined, "an unwitnessed bootstrap cannot produce retention");
    const snapshot = {
      retainedLaunchHash: launch,
      observed: { ...observed, executionId: id },
      generation: {
        credentialState: "active",
        expiresAt: new Date().toISOString(),
        providerId: observed.providerId,
        profileVersion: observed.profileVersion,
        resourceVersion: observed.providerResourceVersion,
      },
      material: { materialVersion: randomUUID(), preparationAttemptId: randomUUID() },
    };
    assert.equal(await store.record(id, 1, snapshot), true);
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
    assert.equal(await store.owns(id, 1), true);
    const frozen = await expire();
    assert.equal(frozen?.retainedLaunchHash, launch);
    assert.equal(await store.owns(id, 1), false);
    assert.equal(await store.record(id, 1, snapshot), false);
    assert.equal(await store.writing(id, 1, "rotate"), false);
    assert.equal((await store.adopt(id, randomUUID())).blocked, "repository_expired");
    const request = randomUUID();
    assert.equal(await store.beginDetach(id, launch, request, "13"), true);
    assert.equal(await store.beginDetach(id, launch, randomUUID(), "13"), false);
    assert.deepEqual((await expire()).detach, { requestId: request });
    assert.equal(await store.confirmDetached(id, launch, request, "epoch-two"), true);
    assert.equal(await store.confirmDetached(id, launch, request, "epoch-replaced"), false);
    assert.equal((await expire()).detach.epoch, "epoch-two");
    await store.withdraw({ revisionId: id });
    assert.equal(await expire(), undefined, "explicit stop supersedes a witnessed withdrawal");
    assert.equal(await store.confirmDetached(id, launch, request, "epoch-two"), false);
  },
);
