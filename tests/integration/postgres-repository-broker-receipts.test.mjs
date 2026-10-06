import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import {
  InMemoryPlatformState,
  PostgresPlatformState,
  DependencyUnavailableError,
} from "../../packages/occ/src/index.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { startServiceProcessFixture } from "../fixtures/repository-credentials/service-process.mjs";
import { run, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { appRoot, appExtension } from "../fixtures/repository-credentials/runtime.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

function useGateway(fixture, opened) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: fixture.listeners.address.port,
        path: "/repos/fixture/repository",
        ca: fixture.tls.ca,
        agent: false,
        headers: {
          host: "credentials.example.test",
          authorization: `Bearer ${opened.files.bearer}`,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve(incoming.statusCode));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test(
  "only the reserving broker generation fences its own reservation",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    t.after(() => pool.end());
    // The memory store refuses a fence of an open attempt itself; PostgreSQL's receipt trigger
    // refuses it (23514), which the store reports as an ownership or state violation.
    for (const [name, state, fenceRefusal] of [
      ["memory", new InMemoryPlatformState(), /The broker receipt transition is invalid/],
      [
        "postgres",
        new PostgresPlatformState(pool),
        /The resource violates its exact platform ownership or state/,
      ],
    ]) {
      await t.test(name, async () => {
        const generation = randomUUID();
        let revision;
        // Each attempt gets its own revision: one repository has one opening attempt.
        const reserve = async (phase) => {
          ({ revision } = await seedSessionRevision(state));
          const attempt = sessionAttempt(revision, { brokerProtocol: 1 });
          await state.transact(async (unit) => {
            await unit.repositorySessions.createAttempt(attempt);
            await unit.repositorySessions.createBrokerReceipt({
              admissionId: attempt.admissionId,
              state: "reserved",
              generation,
            });
            if (phase !== undefined) {
              await unit.repositorySessions.advanceAttempt({
                admissionId: attempt.admissionId,
                expectedPhase: "opening",
                phase,
                ...(phase === "open" ? { sessionId: `session-${randomUUID()}` } : {}),
                updatedAt: revision.createdAt,
              });
            }
          });
          return attempt.admissionId;
        };
        const fence = (admissionId, by = generation) =>
          state.transact((unit) =>
            unit.repositorySessions.fenceBrokerReceipt({ admissionId, generation: by }),
          );
        const reserved = await reserve();
        assert.equal(await fence(reserved, randomUUID()), undefined);
        assert.deepEqual(await fence(reserved), {
          admissionId: reserved,
          state: "fenced",
          generation,
        });
        // A fence is terminal: it cannot be fenced again or bound.
        assert.equal(await fence(reserved), undefined);
        assert.equal(
          await state.transact((unit) =>
            unit.repositorySessions.advanceBrokerReceipt({
              admissionId: reserved,
              expectedState: "reserved",
              generation,
              state: "active",
              sessionId: `session-${randomUUID()}`,
              deadlineWallMs: revision.repositoryCredentials.deadlineWallMs,
            }),
          ),
          undefined,
        );
        // A worker that already recorded the session keeps the reservation unfenced.
        const opened = await reserve("open");
        await assert.rejects(fence(opened), (error) => {
          assert.equal(error.name, "ScopeViolationError");
          assert.match(error.message, fenceRefusal);
          return true;
        });
        assert.equal(
          (await state.read((view) => view.repositorySessions.findBrokerReceipt(opened))).state,
          "reserved",
        );
        // A closing attempt without a session may still be fenced.
        const closing = await reserve("closing");
        assert.equal((await fence(closing)).state, "fenced");
      });
    }
    // Only a reservation may become fenced, and only a recovery fence starts that way.
    const { revision } = await seedSessionRevision(new PostgresPlatformState(pool));
    const attempt = sessionAttempt(revision, { brokerProtocol: 1 });
    await new PostgresPlatformState(pool).transact((unit) =>
      unit.repositorySessions.createAttempt(attempt),
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO occ.repository_broker_receipts (admission_id,state,generation) VALUES ($1,'fenced',$2)",
        [attempt.admissionId, randomUUID()],
      ),
      { code: "23514" },
    );
  },
);

test(
  "confirmed broker disposal survives service restart in PostgreSQL",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const namespaceId = `ns_${randomUUID()}`;
    const fixture = await startRegistryCredentialServiceFixture(t, {
      namespaceId,
      autoOpen: false,
      gateway: { listen: "127.0.0.1:0" },
    });
    const client = new UnixRepositoryCredentialControlClient({
      controlSocket: fixture.config.gateway.controlSocket,
    });
    const driver = new GitHubRepoDriver(
      {
        id: fixture.backendId,
        client,
        drivers: { repo: "repository-credentials" },
      },
      fixture.registry,
      { sessionDurationSeconds: 3600, publicCa: fixture.tls.ca },
    );
    const binding = driver.resolve({
      namespaceId,
      bindings: [{ repositoryRef: "repo-a", profile: "git-full" }],
    }).bindings[0];
    const deadlineWallMs = fixture.clock.wallNow() + 3_600_000;
    const { revision } = await seedSessionRevision(
      state,
      {
        driver: { id: driver.id, implementation: driver.implementation },
        deadlineWallMs,
        bindings: [binding],
      },
      { namespaceId },
    );
    const admissionId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    const attempt = sessionAttempt(revision, {
      repositoryRef: binding.repositoryRef,
      admissionId,
      durationSeconds: 3600,
      brokerProtocol: 1,
    });
    await state.transact((unit) => unit.repositorySessions.createAttempt(attempt));
    const receiptServer = await startRepositoryReceiptServer({
      state,
      controlSocket: fixture.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: fixture.backendId,
    });
    t.after(() => receiptServer.close());
    const signal = AbortSignal.timeout(30_000);
    const openInput = { namespaceId, admissionId, binding, durationSeconds: 3600, deadlineWallMs };
    const opened = await driver.open(openInput, signal);
    assert.equal(opened.kind, "created");
    const sessionId = opened.session.sessionId;
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "opening",
        phase: "open",
        sessionId,
        updatedAt: revision.createdAt,
      }),
    );
    assert.equal(
      (await state.read((view) => view.repositorySessions.findBrokerReceipt(admissionId))).state,
      "active",
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.repository_broker_receipts SET generation = $2 WHERE admission_id = $1",
        [admissionId, randomUUID()],
      ),
      { code: "42501" },
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.repository_broker_receipts SET state='fenced' WHERE admission_id = $1",
        [admissionId],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query("DELETE FROM occ.repository_broker_receipts WHERE admission_id = $1", [
        admissionId,
      ]),
      { code: "42501" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.repository_broker_receipts SET session_id=$2 WHERE admission_id=$1", [
        admissionId,
        `replacement-${randomUUID()}`,
      ]),
      { code: "23514" },
    );
    // A genuine provider request creates revocable authority; cleanup must finish
    // before the journal can publish the terminal observation.
    assert.equal(await useGateway(fixture, opened), 200);
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "open",
        phase: "closing",
        updatedAt: revision.createdAt,
      }),
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.repository_session_attempts SET phase='disposed' WHERE admission_id=$1",
        [admissionId],
      ),
      { code: "23514" },
    );
    await driver.close(sessionId, signal);
    let confirmed;
    for (let i = 0; i < 100; i++) {
      confirmed = await driver.status(sessionId, signal);
      if (confirmed?.state === "DISPOSED") {
        break;
      }
      await delay(20);
    }
    assert.equal(confirmed?.state, "DISPOSED");
    const beforeRestart = await state.read((view) =>
      view.repositorySessions.findBrokerReceipt(admissionId),
    );
    assert.equal(beforeRestart.state, "disposed");
    assert.equal(beforeRestart.sessionId, sessionId);
    assert.ok(beforeRestart.revoked > 0);
    const issued = fixture.repositories[0].github.issuesOfTokens.length;
    await fixture.restart();
    assert.deepEqual(await driver.status(sessionId, signal), confirmed);
    const recovered = await driver.open({ ...openInput, recoverOnly: true }, signal);
    assert.equal(recovered.kind, "recovered");
    assert.deepEqual(recovered.status, confirmed);
    // The supported operator's bound request uses the same durable protocol.
    const directory = await temporaryDirectory(t, "receipt-operator-");
    const requestFile = join(directory, "request.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        namespaceId,
        repositoryRef: binding.repositoryRef,
        profile: binding.profile,
        expectedBinding: binding.grant,
        durationSeconds: 3600,
        deadlineWallMs,
        recoverOnly: true,
      }),
      { mode: 0o600 },
    );
    const operator = join(
      appRoot,
      "drivers/repo/github/credentials/client",
      `operator.${appExtension}`,
    );
    const result = await run(process.execPath, [
      operator,
      "open",
      "--socket",
      fixture.config.gateway.controlSocket,
      "--request-json",
      requestFile,
      "--output",
      join(directory, "session"),
      "--admission-id",
      admissionId,
    ]);
    const operatorStatus = JSON.parse(result.stdout);
    assert.equal(operatorStatus.recovered, true);
    assert.equal(operatorStatus.state, "DISPOSED");
    assert.equal(operatorStatus.sessionId, sessionId);
    assert.equal(fixture.repositories[0].github.issuesOfTokens.length, issued);
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "closing",
        phase: "disposed",
        sessionId,
        updatedAt: revision.createdAt,
      }),
    );
    await assert.rejects(
      driver.open(
        {
          ...openInput,
          binding: { ...binding, grant: { ...binding.grant, grantId: "wrong" } },
          recoverOnly: true,
        },
        signal,
      ),
      DependencyUnavailableError,
    );

    // Graceful broker shutdown must join receipt writes after revoking authority,
    // even when no caller requests terminal status before the service exits.
    const shutdownId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    const shutdownInput = { ...openInput, admissionId: shutdownId };
    await state.transact((unit) =>
      unit.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          repositoryRef: binding.repositoryRef,
          admissionId: shutdownId,
          durationSeconds: 3600,
          brokerProtocol: 1,
        }),
      ),
    );
    const shutdownOpened = await driver.open(shutdownInput, signal);
    assert.equal(shutdownOpened.kind, "created");
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: shutdownId,
        expectedPhase: "opening",
        phase: "open",
        sessionId: shutdownOpened.session.sessionId,
        updatedAt: revision.createdAt,
      }),
    );
    assert.equal(await useGateway(fixture, shutdownOpened), 200);
    const lock = await pool.connect();
    let restartCompleted = false;
    let restarting;
    try {
      // Hold the real receipt row so the terminal write cannot commit while the
      // broker tries to exit; shutdown must wait for the durable acknowledgment.
      await lock.query("BEGIN");
      await lock.query(
        "SELECT admission_id FROM occ.repository_broker_receipts WHERE admission_id = $1 FOR UPDATE",
        [shutdownId],
      );
      restarting = fixture.restart().then(() => {
        restartCompleted = true;
      });
      void restarting.catch(() => {});
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await pool.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%repository_broker_receipts%') AS blocked",
        );
        if (result.rows[0].blocked) {
          blocked = true;
          break;
        }
        await delay(20);
      }
      assert.equal(blocked, true, "the terminal receipt write must reach PostgreSQL");
      assert.equal(restartCompleted, false, "broker shutdown must wait for receipt commit");
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    await restarting;
    const shutdownReceipt = await state.read((view) =>
      view.repositorySessions.findBrokerReceipt(shutdownId),
    );
    assert.equal(shutdownReceipt.state, "disposed");
    assert.equal(shutdownReceipt.sessionId, shutdownOpened.session.sessionId);
    assert.ok(shutdownReceipt.revoked > 0);
    assert.equal((await driver.status(shutdownOpened.session.sessionId, signal)).state, "DISPOSED");
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: shutdownId,
        expectedPhase: "open",
        phase: "closing",
        updatedAt: revision.createdAt,
      }),
    );
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: shutdownId,
        expectedPhase: "closing",
        phase: "disposed",
        sessionId: shutdownOpened.session.sessionId,
        updatedAt: revision.createdAt,
      }),
    );
    const issuedAfterShutdown = fixture.repositories[0].github.issuesOfTokens.length;

    // A recovery lookup that commits a fence first prevents a delayed open,
    // including after the service owner is replaced.
    const fencedId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    const fencedInput = { ...openInput, admissionId: fencedId };
    await state.transact((unit) =>
      unit.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          repositoryRef: binding.repositoryRef,
          admissionId: fencedId,
          durationSeconds: 3600,
          brokerProtocol: 1,
        }),
      ),
    );
    assert.deepEqual(await driver.open({ ...fencedInput, recoverOnly: true }, signal), {
      kind: "missing",
    });
    assert.deepEqual(await driver.open(fencedInput, signal), { kind: "missing" });
    assert.equal(
      (await state.read((view) => view.repositorySessions.findBrokerReceipt(fencedId))).state,
      "fenced",
    );
    await fixture.restart();
    assert.deepEqual(await driver.open(fencedInput, signal), { kind: "missing" });
    assert.equal(fixture.repositories[0].github.issuesOfTokens.length, issuedAfterShutdown);
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: fencedId,
        expectedPhase: "opening",
        phase: "invalidated",
        updatedAt: revision.createdAt,
      }),
    );

    // A persisted session identity with missing journal evidence is uncertain,
    // even when a recovery lookup races with the original broker.
    const knownId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    await state.transact((unit) =>
      unit.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          repositoryRef: binding.repositoryRef,
          admissionId: knownId,
          durationSeconds: 3600,
          brokerProtocol: 1,
        }),
      ),
    );
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: knownId,
        expectedPhase: "opening",
        phase: "open",
        sessionId: `known-${randomUUID()}`,
        updatedAt: revision.createdAt,
      }),
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO occ.repository_broker_receipts (admission_id,state) VALUES ($1,'fenced')",
        [knownId],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      driver.open({ ...openInput, admissionId: knownId, recoverOnly: true }, signal),
      DependencyUnavailableError,
    );
  },
);

test(
  "broker shutdown waits for receipts and loss of unconfirmed authority stays unknown",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => {
    for (const mode of ["delayed-commit", "unavailable", "abrupt-death"]) {
      await t.test(mode, async (context) => {
        const namespaceId = `ns_${randomUUID()}`;
        const fixture = await startServiceProcessFixture(context, {
          bound: true,
          shutdownGraceMs: 100,
          namespaceId,
          // A free slot lets the later admission open and then meet the lost journal.
          ...(mode === "unavailable" ? { sessions: 2 } : {}),
        });
        const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
        context.after(() => pool.end());
        const state = new PostgresPlatformState(pool);
        const binding = {
          repositoryRef: fixture.input.repositoryRef,
          profile: fixture.input.profile,
          backendId: "github-fixture",
          grant: fixture.input.expectedBinding,
        };
        const { revision } = await seedSessionRevision(
          state,
          {
            driver: { id: "repository-credentials", implementation: "github" },
            deadlineWallMs: fixture.input.deadlineWallMs,
            bindings: [binding],
          },
          { namespaceId },
        );
        const admissionId = fixture.admissionId();
        await state.transact((unit) =>
          unit.repositorySessions.createAttempt(
            sessionAttempt(revision, {
              admissionId,
              repositoryRef: binding.repositoryRef,
              durationSeconds: fixture.input.durationSeconds,
              brokerProtocol: 1,
            }),
          ),
        );
        const listener = await startRepositoryReceiptServer({
          state,
          controlSocket: fixture.config.gateway.controlSocket,
          driverId: "repository-credentials",
          implementation: "github",
          backendId: "github-fixture",
        });
        let listenerOpen = true;
        context.after(async () => {
          if (listenerOpen) {
            await listener.close();
          }
        });
        const control = new UnixRepositoryCredentialControlClient({
          controlSocket: fixture.config.gateway.controlSocket,
        });
        await control.checkAdmissionReady(AbortSignal.timeout(2000));
        const opened = await fixture.open(admissionId, false, true);
        assert.equal(opened.session.state, "OPEN");
        assert.equal((await fixture.request(opened)).status, 200);

        if (mode === "abrupt-death") {
          // Forced death loses the original broker's in-memory cleanup outcome.
          // Neither a restarted broker nor a durable active receipt proves disposal.
          await fixture.kill();
          await fixture.start();
          const receipt = await state.read((view) =>
            view.repositorySessions.findBrokerReceipt(admissionId),
          );
          assert.equal(receipt.state, "active");
          assert.deepEqual(await fixture.open(admissionId, true, true), { error: "unavailable" });
          assert.deepEqual(await fixture.status(opened.session.sessionId), {
            error: "unavailable",
          });
          assert.equal(fixture.github.tokenState()[0].revoked, false);
          return;
        }

        if (mode === "unavailable") {
          // No acknowledgment can be obtained after the worker listener is lost.
          await listener.close();
          listenerOpen = false;
          // Capability identifies the protocol, not current journal availability.
          // A later admission cannot return a bearer without a reservation.
          await control.checkAdmissionReady(AbortSignal.timeout(2000));
          assert.deepEqual(await fixture.open(fixture.admissionId(), false, true), {
            error: "unavailable",
          });
          assert.equal(fixture.github.tokenState().length, 1);
          await fixture.shutdown(1);
          const receipt = await state.read((view) =>
            view.repositorySessions.findBrokerReceipt(admissionId),
          );
          assert.equal(receipt.state, "active");
          return;
        }

        // A real row lock holds the terminal write past the original shutdown
        // grace; the broker must stay alive for a separate acknowledgment window.
        const lock = await pool.connect();
        let completed = false;
        let stopping;
        try {
          await lock.query("BEGIN");
          await lock.query(
            "SELECT admission_id FROM occ.repository_broker_receipts WHERE admission_id=$1 FOR UPDATE",
            [admissionId],
          );
          stopping = fixture.shutdown().then(() => {
            completed = true;
          });
          void stopping.catch(() => {});
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            const result = await pool.query(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%repository_broker_receipts%') AS blocked",
            );
            if (result.rows[0].blocked) {
              blocked = true;
              break;
            }
            await delay(20);
          }
          assert.equal(blocked, true, "the original broker must attempt the terminal write");
          await delay(300);
          assert.equal(
            completed,
            false,
            "the broker must outlive the original grace while flushing",
          );
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
        }
        await stopping;
        const receipt = await state.read((view) =>
          view.repositorySessions.findBrokerReceipt(admissionId),
        );
        assert.equal(receipt.state, "disposed");
        assert.equal(receipt.sessionId, opened.session.sessionId);
        assert.ok(receipt.revoked > 0);
      });
    }
  },
);
