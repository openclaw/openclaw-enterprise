import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import type { ClientRequest } from "node:http";
import { dirname, join } from "node:path";
import type { TLSSocket } from "node:tls";
import { Worker } from "node:worker_threads";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { RepositoryReceiptClient } from "../../apps/controller/src/drivers/repo/credentials/receipt-client.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts";
import { sessionAttempt } from "../conformance/repository-sessions.contract.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import {
  controlRequest,
  createLoopbackServiceConfiguration,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { startServiceListeners } from "../fixtures/repository-credentials/service-resources.mjs";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { disposeBrokerSession, fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

for (const first of ["removal", "use"] as const) {
  test(
    `standing removal orders prepared material and request authorization (${first} first)`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, { standingApproval: true });
      const approval = f.approval!;
      await prepare(f);
      const signal = new AbortController().signal;
      const material = await f.owner.readOpenShellMaterial(f.revision.id, signal);
      assert.ok(material && !("absent" in material));
      const { preparationAttemptId, materialVersion } = material;

      const receipts = async () =>
        (
          await f.pool.query(
            "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY exchange_id",
            [f.admissionId],
          )
        ).rows.map((r) => r.exchange_id);
      const operations = () => {
        const q = { ...f.request(), operation: "upload-pack" as const };
        const result = Promise.all([
          f.owner.readOpenShellMaterial(f.revision.id, signal).then((m) => {
            if (!m || "absent" in m) {
              return m?.absent;
            }
            assert.ok(
              m.preparationAttemptId === preparationAttemptId &&
                m.materialVersion === materialVersion &&
                m.sessionId === material.sessionId &&
                m.value === material.value,
              "expected the same bounded material",
            );
            return "same material";
          }),
          f.owner.authorizeOpenShellRequest(q, { preparationAttemptId, materialVersion }, signal),
        ]).catch((error: unknown) => error); // assert the result after releasing the transaction barrier
        return { result, exchangeId: q.exchangeId };
      };
      const denied = ["withdrawn", "access_withdrawn"];

      // This pool has exactly one connection. Observe its actual lock waits and run the
      // removal owner's Namespace, Agent and generation-fenced State operations on it.
      const writers = testPool(t, { connectionString: databaseUrl, max: 1 });
      const state = new PostgresPlatformState(writers);
      const writer = (await writers.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const remove = (whenLocked?: () => Promise<void>) =>
        state.transact(async (u) => {
          const { namespaceId, agentId } = approval;
          assert.ok(await u.namespaces.lockNamespace(namespaceId, { includeDeleted: true }));
          assert.ok(await u.agents.lockAgent(namespaceId, agentId));
          await whenLocked?.();
          await u.repositorySessions.revokeStanding(approval, new Date().toISOString());
        });

      // Synchronize on PostgreSQL's lock graph, never on a guessed transaction duration.
      async function blocked(
        blockers: number[],
        count: number,
        waiter?: number,
      ): Promise<number[]> {
        const deadline = performance.now() + 2_000;
        for (;;) {
          const r = await f.pool.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
             AND pg_blocking_pids(pid) && $1::int[] AND ($2::int IS NULL OR pid=$2)`,
            [blockers, waiter],
          );
          if (r.rowCount === count) {
            return r.rows.map((row) => row.pid);
          }
          assert.ok(performance.now() < deadline, "did not observe the required lock order");
        }
      }

      assert.deepEqual(await receipts(), []);
      let expectedReceipts: string[] = [];
      if (first === "removal") {
        let pending: ReturnType<typeof operations>;
        await remove(async () => {
          pending = operations();
          await blocked([writer], 2);
        });
        assert.deepEqual(await pending!.result, denied, "both waiters must see committed removal");
      } else {
        // Pause both decisions at the material row. Removal must wait for these actual
        // readers; an already committed possible-use receipt must survive that removal.
        const holder = await f.pool.connect();
        let failed = true;
        try {
          await holder.query("BEGIN");
          const locked = await holder.query(
            "SELECT pg_backend_pid() AS pid FROM occ.prepared_github_families WHERE source_id=$1 FOR UPDATE",
            [f.familyId],
          );
          assert.equal(locked.rowCount, 1);
          const pending = operations();
          const readers = await blocked([locked.rows[0].pid], 2);
          const removal = remove();
          await blocked(readers, 1, writer);
          await holder.query("ROLLBACK");
          assert.deepEqual(await pending.result, ["same material", true]);
          await removal;
          expectedReceipts = [pending.exchangeId];
          failed = false;
        } finally {
          holder.release(failed);
        }
      }
      const saved = await state.read((v) =>
        v.repositorySessions.listStandingApprovals(approval.namespaceId, approval.agentId),
      );
      assert.ok(saved[0]?.revokedAt);
      assert.equal(saved[0].generation, approval.generation + 1);
      assert.deepEqual(await receipts(), expectedReceipts);
      // No cleanup or Git dispatch. The fixture token remains unexpired across this fresh
      // decision; any earlier possible use is left intact, never repeated as a control.
      assert.deepEqual(await operations().result, denied);
      assert.ok(Date.now() < Date.parse(material.expiresAt));
      assert.deepEqual(await receipts(), expectedReceipts, "no post-removal possible use");
      assert.equal(f.gh.issuesOfTokens.length, 1);
      assert.deepEqual(f.gh.errors, []);
    },
  );
}

test(
  "an admitted standing prepared broker uses an already-issued send permit and denies the next request",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    let useSocket = "";
    const fixtureOptions = {
      standingApproval: true,
      openBroker(input: { socketPath: string }) {
        useSocket = input.socketPath;
      },
    };
    const f = await fixture(resources, fixtureOptions);
    const approval = f.approval!;
    const { namespaceId, agentId } = f.revision;
    const revisionId = f.revision.id;
    const key = { namespaceId, agentId, revisionId };
    // Close the helper's synthetic first session. Its replacement opens and binds on the real control socket.
    await disposeBrokerSession(f);
    const executionId = randomUUID();
    const fingerprint = createHash("sha256").update(executionId).digest("hex");
    await f.state.transact((u) =>
      u.repositorySessions.recordStandingExecution(key, { executionId, fingerprint }),
    );
    const admissionId = Date.now() + "-" + randomUUID();
    const input = {
      namespaceId,
      repositoryRef: f.binding.repositoryRef,
      profile: f.binding.profile,
      durationSeconds: 3600,
      deadlineWallMs: f.deadlineWallMs,
      expectedBinding: f.binding.grant,
      preparedOnly: true as const,
    };
    await f.state.transact((u) =>
      u.repositorySessions.createAttempt(
        sessionAttempt(f.revision, {
          ...key,
          admissionId,
          durationSeconds: input.durationSeconds,
          brokerProtocol: 3,
        }),
      ),
    );
    const controlSocket = join(dirname(useSocket), "control.sock");
    const receipt = await startRepositoryReceiptServer({
      state: f.state,
      controlSocket,
      driverId: f.revision.repositoryCredentials.driver.id,
      implementation: "github",
      backendId: f.registry.backendId,
    });
    resources.after(() => receipt.close());
    let firstGitAuthorization = "";
    let lastGitAuthorization = "";
    let originRequests = 0;
    const originOptions = {
      tls: f.gh.tls,
      authorize(auth: string | undefined, boundary: "git") {
        if (!auth) {
          return false;
        }
        firstGitAuthorization ||= auth;
        lastGitAuthorization = auth;
        return f.gh.authorize(auth, boundary);
      },
      observeRequest() {
        originRequests++;
      },
    };
    const origin = await startGitSmartHttpFixture(t, originOptions);
    const gitOrigin = origin.origin;
    const base = await createLoopbackServiceConfiguration(resources);
    const config = { ...base, gateway: { ...base.gateway, controlSocket } };
    const clock = createSystemClock();
    const factory = createPreparedGitHubRegistryFactory({
      registry: f.registry,
      socketPath: useSocket,
      clock,
      gatewayOrigin: config.gateway.publicOrigin,
      gitOrigin,
      limits: config.limits,
    });
    const { listeners } = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls: f.gh.tls,
      upstreamOrigins: [gitOrigin],
      log: undefined,
      providerQueue: undefined,
    });
    const opened = await controlRequest(
      controlSocket,
      "POST",
      "/v1/sessions",
      { ...input, durableAdmission: true },
      { "x-admission-id": admissionId },
    );
    assert.equal(opened.status, 201);
    const sessionId = opened.body.session.sessionId;
    await f.state.transact(async (u) =>
      assert.ok(
        await u.repositorySessions.advanceAttempt({
          admissionId,
          expectedPhase: "opening",
          phase: "open",
          sessionId,
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
    const row = await f.state.read((v) => v.repositorySessions.findBrokerReceipt(admissionId));
    assert.ok(row?.state === "active" && row.sessionId === sessionId && row.generation);
    const decision = new RepositoryReceiptClient(controlSocket, row.generation);
    const authorize = () => decision.authorizeStanding(admissionId, sessionId, input);
    await authorize();
    const refusal = { message: "RECEIPT_UNAVAILABLE" };
    await assert.rejects(decision.authorizeStanding(admissionId, randomUUID(), input), refusal);
    await assert.rejects(
      decision.authorizeStanding(admissionId, sessionId, {
        ...input,
        expectedBinding: { ...input.expectedBinding, grantId: randomUUID() },
      }),
      refusal,
    );
    await assert.rejects(
      new RepositoryReceiptClient(controlSocket, randomUUID()).authorizeStanding(
        admissionId,
        sessionId,
        input,
      ),
      refusal,
    );
    const uses = async () =>
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
          [admissionId],
        )
      ).rows[0].n;
    const get = () =>
      gatewayRequest(
        { config, listeners, tls: f.gh.tls, opened: opened.body },
        "/fixture/repository.git/info/refs?service=git-upload-pack",
        {
          headers: {
            authorization:
              "Basic " + Buffer.from("gateway-session:" + opened.body.bearer).toString("base64"),
          },
        },
      );
    await prepare(f);
    assert.equal((await get()).status, 200);
    assert.equal(originRequests, 1);
    assert.equal(await uses(), 1);
    // Wait for client-side certificate verification, and hold the same JavaScript stack before
    // the sender can flush headers. The separate worker commits through the actual State owner.
    const shared = new SharedArrayBuffer(4);
    const outcome = new Int32Array(shared);
    const worker = new Worker(
      new URL("../fixtures/prepared-standing-withdraw-worker.ts", import.meta.url),
      { workerData: { approval, admissionId, shared } },
    );
    resources.after(() => worker.terminate());
    assert.deepEqual(await once(worker, "message"), ["ready"]);
    const workerExit = once(worker, "exit");
    let observedGate = 0;
    let verifiedBeforeWrite = false;
    let withdrawalCommittedBeforeWrite = false;
    const created = channel("http.client.request.created");
    const observe = (event: unknown) => {
      const { request } = event as { request: ClientRequest };
      request.once("socket", (socket: TLSSocket) => {
        socket.once("secureConnect", () => {
          if (socket.remotePort !== Number(new URL(gitOrigin).port)) {
            return;
          }
          observedGate++;
          verifiedBeforeWrite = socket.authorized && !request.headersSent && originRequests === 1;
          worker.postMessage("withdraw");
          Atomics.wait(outcome, 0, 0, 2500);
          withdrawalCommittedBeforeWrite = Atomics.load(outcome, 0) === 1 && !request.headersSent;
        });
      });
    };
    created.subscribe(observe);
    let pendingStatus;
    try {
      pendingStatus = (await get()).status;
    } finally {
      created.unsubscribe(observe);
    }
    assert.equal(observedGate, 1);
    assert.equal(verifiedBeforeWrite, true);
    assert.equal(withdrawalCommittedBeforeWrite, true);
    assert.deepEqual(await workerExit, [0]);
    assert.equal(pendingStatus, 200);
    await assert.rejects(authorize(), refusal);
    assert.equal(originRequests, 2);
    const freshStatus = (await get()).status;
    assert.equal(freshStatus, 503);
    assert.equal(originRequests, 2);
    assert.equal(await uses(), 2);
    assert.ok(
      firstGitAuthorization === lastGitAuthorization,
      "the same prepared token authenticates both requests",
    );
    const secret = Buffer.from(firstGitAuthorization.slice(6), "base64").toString().split(":")[1];
    const providerStatus = await f.providerStatus(secret);
    assert.equal(providerStatus, 200);
    assert.equal(f.gh.issuesOfTokens.length, 1);
    t.diagnostic(
      `standing admission=${opened.status}; verified TLS gates=${observedGate}; origin requests=${originRequests}; committed uses=${await uses()}; pending=${pendingStatus}; fresh=${freshStatus}; provider=${providerStatus}; issuances=${f.gh.issuesOfTokens.length}`,
    );
  },
);
