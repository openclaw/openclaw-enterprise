import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:https";
import { request as controlRequest } from "node:http";
import test from "node:test";
import { PostgresPlatformState, DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { RepositoryReceiptClient } from "../../apps/controller/src/drivers/repo/access/receipt-client.ts";
import { servePrivateRepositoryRequest } from "../../apps/controller/src/backends/repository-credentials/private-request-server.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { run, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { appRoot, appExtension } from "../fixtures/repository-credentials/runtime.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { registerBrokerReceiptFencingCase } from "./postgres-repository-broker-receipt-fencing-cases.ts";
import { registerBrokerReceiptShutdownCase } from "./postgres-repository-broker-receipt-shutdown-cases.ts";

function requestGitDiscovery(fixture, opened) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: fixture.listeners.address.port,
        path: `/${fixture.repositories[0].repository}.git/info/refs?service=git-upload-pack`,
        ca: fixture.tls.ca,
        agent: false,
        headers: {
          host: "credentials.example.test",
          authorization: `Basic ${Buffer.from(`gateway-session:${opened.files.bearer}`).toString("base64")}`,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode,
            contentType: incoming.headers["content-type"],
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

registerBrokerReceiptFencingCase();

test(
  "confirmed broker disposal survives service restart in PostgreSQL",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const resources = createTestResourceScope(t);
    const pool = testPool(resources, { connectionString: databaseUrl, max: 4 });
    let receiptServer;
    resources.after(() => receiptServer?.close());
    let preparedOwner;
    resources.after(() => preparedOwner?.close());
    const state = new PostgresPlatformState(pool);
    const namespaceId = `ns_${randomUUID()}`;
    const fixture = await startRegistryCredentialServiceFixture(resources, {
      namespaceId,
      autoOpen: false,
      gateway: { listen: "127.0.0.1:0" },
    });
    const client = new UnixRepositoryCredentialControlClient({
      controlSocket: fixture.config.gateway.controlSocket,
    });
    const backend = { id: fixture.backendId, client, drivers: { repo: "repository-credentials" } };
    const driver = new GitHubNativeRepositorySender(backend, { publicCa: fixture.tls.ca });
    const policy = new GitHubRepositoryPolicy(
      { driverId: backend.drivers.repo, backendId: backend.id },
      fixture.registry,
      {
        sessionDurationSeconds: 3600,
      },
    );
    const binding = policy.resolve({
      namespaceId,
      bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
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
      brokerProtocol: 3,
    });
    await state.transact((unit) => unit.repositorySessions.createAttempt(attempt));
    receiptServer = await startRepositoryReceiptServer({
      state,
      controlSocket: fixture.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: fixture.backendId,
    });
    // A controlled owner supplies already-prepared material. The real sender
    // must use it for Git without acquiring issuance or retirement authority.
    const repository = fixture.repositories[0];
    const preparedMaterial = randomUUID();
    repository.github.acceptStatic(preparedMaterial);
    const permittedSessions = new Set();
    const uses = [];
    preparedOwner = await servePrivateRepositoryRequest(
      fixture.config.gateway.controlSocket,
      "prepared-git-use",
      async (input) => {
        if (
          !permittedSessions.has(input.sessionId) ||
          input.operation !== "advertise-upload-pack"
        ) {
          throw new Error("unexpected prepared use");
        }
        uses.push(input.sessionId);
        return {
          exchangeId: input.exchangeId,
          preparationAttemptId: "prepared-fixture",
          materialVersion: "fixture-version",
          value: preparedMaterial,
          sendStartBy: new Date(fixture.clock.wallNow() + 4000).toISOString(),
        };
      },
    );
    const signal = AbortSignal.timeout(30_000);
    const openInput = {
      namespaceId,
      admissionId,
      binding,
      durationSeconds: 3600,
      deadlineWallMs,
      preparedOnly: true,
    };
    const opened = await driver.open(openInput, signal);
    assert.equal(opened.kind, "created");
    const sessionId = opened.session.sessionId;
    permittedSessions.add(sessionId);
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
    const discovery = await requestGitDiscovery(fixture, opened);
    assert.equal(discovery.status, 200);
    assert.equal(discovery.contentType, "application/x-git-upload-pack-advertisement");
    assert.ok(
      discovery.body.includes(`${await repository.git.ref("refs/heads/main")} refs/heads/main`),
    );
    assert.deepEqual(uses, [sessionId]);
    assert.equal(repository.github.tokenState()[0].uses, 1);
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
    const disposals = [];
    const stopObserving = fixture.service.observeDisposal((status) => disposals.push(status));
    t.after(stopObserving);
    // Lose the close response body at the real control socket. Recovery must use
    // the durable observation, without needing the caller to receive the result.
    await new Promise((resolve, reject) => {
      const outgoing = controlRequest(
        {
          socketPath: fixture.config.gateway.controlSocket,
          path: `/v1/sessions/${sessionId}/close`,
          method: "POST",
          agent: false,
          signal,
          headers: { host: "localhost", "content-length": 0, connection: "close" },
        },
        (incoming) => {
          incoming.destroy();
          resolve();
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    const confirmed = await waitFor(
      "the broker to confirm disposal after the lost close response",
      async () => {
        const status = await driver.status(sessionId, signal);
        return status?.state === "DISPOSED" ? status : undefined;
      },
      2000,
    );
    assert.equal(confirmed?.state, "DISPOSED");
    const beforeRestart = await state.read((view) =>
      view.repositorySessions.findBrokerReceipt(admissionId),
    );
    assert.equal(beforeRestart.state, "disposed");
    assert.equal(beforeRestart.sessionId, sessionId);
    assert.equal(beforeRestart.admissionId, admissionId);
    assert.equal(beforeRestart.deadlineWallMs, deadlineWallMs);
    assert.equal(beforeRestart.revoked, 0);
    assert.equal(beforeRestart.expired, 0);
    assert.equal((await requestGitDiscovery(fixture, opened)).status, 401);
    assert.equal(repository.github.tokenState()[0].revoked, false);
    assert.deepEqual(await driver.close(sessionId, signal), confirmed);
    assert.deepEqual(
      await state.read((view) => view.repositorySessions.findBrokerReceipt(admissionId)),
      beforeRestart,
    );
    await fixture.restart();
    assert.equal(
      disposals.length,
      1,
      "repeated close and shutdown must publish disposal exactly once",
    );
    assert.equal(disposals[0].sessionId, sessionId);
    stopObserving();
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
        preparedOnly: true,
      }),
      { mode: 0o600 },
    );
    const operator = join(appRoot, "drivers/repo/github/access/client", `operator.${appExtension}`);
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

    // Graceful broker shutdown must join receipt writes after closing the sender,
    // even when no caller requests terminal status before the service exits.
    const shutdownId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    const shutdownInput = { ...openInput, admissionId: shutdownId };
    await state.transact((unit) =>
      unit.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          repositoryRef: binding.repositoryRef,
          admissionId: shutdownId,
          durationSeconds: 3600,
          brokerProtocol: 3,
        }),
      ),
    );
    const shutdownOpened = await driver.open(shutdownInput, signal);
    assert.equal(shutdownOpened.kind, "created");
    permittedSessions.add(shutdownOpened.session.sessionId);
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: shutdownId,
        expectedPhase: "opening",
        phase: "open",
        sessionId: shutdownOpened.session.sessionId,
        updatedAt: revision.createdAt,
      }),
    );
    assert.equal((await requestGitDiscovery(fixture, shutdownOpened)).status, 200);
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
      const blocked = await waitFor(
        "the terminal receipt write to reach PostgreSQL",
        async () => {
          const result = await pool.query(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%repository_broker_receipts%') AS blocked",
          );
          return result.rows[0].blocked ? true : undefined;
        },
        2000,
      );
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
    assert.equal(shutdownReceipt.admissionId, shutdownId);
    assert.equal(shutdownReceipt.deadlineWallMs, deadlineWallMs);
    assert.equal(shutdownReceipt.revoked, 0);
    assert.equal(shutdownReceipt.expired, 0);
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
          brokerProtocol: 3,
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
    assert.deepEqual(uses, [sessionId, shutdownOpened.session.sessionId]);
    assert.equal(repository.git.trace.length, 2);
    assert.equal(repository.github.tokenState()[0].uses, 2);
    assert.equal(repository.github.tokenState()[0].revoked, false);
    assert.equal(repository.github.issuesOfTokens.length, 0);
    assert.deepEqual(repository.github.trace, []);
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: fencedId,
        expectedPhase: "opening",
        phase: "invalidated",
        updatedAt: revision.createdAt,
      }),
    );

    // A registered old v1 owner reports its own observations directly. This is
    // receipt-protocol evidence, not new provider issuance by the prepared sender.
    // Distinct positive counts catch accidental normalization of historical data.
    const oldAdmissionId = `${fixture.clock.wallNow()}-${randomUUID()}`;
    const oldGeneration = randomUUID();
    const oldOwner = new RepositoryReceiptClient(
      fixture.config.gateway.controlSocket,
      oldGeneration,
    );
    const oldInput = {
      namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
      expectedBinding: binding.grant,
      durationSeconds: 3600,
      deadlineWallMs,
    };
    const oldSessionId = `old-${randomUUID()}`;
    const oldDisposed = {
      sessionId: oldSessionId,
      state: "DISPOSED",
      deadlineWallMs,
      binding: binding.grant,
      activeUses: 0,
      cleanup: {
        active: 0,
        pending: 0,
        revoked: 2,
        expired: 1,
        uncertain: 0,
        auxiliaryPending: false,
      },
    };
    // This v1 reservation and binding predate the cutover; no new v1 admission is opened.
    await state.transact(async (unit) => {
      await unit.repositorySessions.createAttempt(
        sessionAttempt(revision, {
          repositoryRef: binding.repositoryRef,
          admissionId: oldAdmissionId,
          durationSeconds: 3600,
          brokerProtocol: 1,
        }),
      );
      await unit.repositorySessions.createBrokerReceipt({
        admissionId: oldAdmissionId,
        state: "reserved",
        generation: oldGeneration,
      });
      assert.ok(
        await unit.repositorySessions.advanceBrokerReceipt({
          admissionId: oldAdmissionId,
          expectedState: "reserved",
          generation: oldGeneration,
          state: "active",
          sessionId: oldSessionId,
          deadlineWallMs,
        }),
      );
    });
    const foreignOwner = new RepositoryReceiptClient(
      fixture.config.gateway.controlSocket,
      randomUUID(),
    );
    await assert.rejects(
      foreignOwner.dispose(oldAdmissionId, oldInput, oldDisposed),
      /RECEIPT_UNAVAILABLE/,
    );
    await oldOwner.dispose(oldAdmissionId, oldInput, oldDisposed);
    // An exact replay is harmless; changed observations cannot overwrite disposal.
    await oldOwner.dispose(oldAdmissionId, oldInput, oldDisposed);
    await assert.rejects(
      oldOwner.dispose(oldAdmissionId, oldInput, {
        ...oldDisposed,
        cleanup: { ...oldDisposed.cleanup, revoked: 0 },
      }),
      /RECEIPT_UNAVAILABLE/,
    );
    await fixture.restart();
    assert.deepEqual(await client.status(oldSessionId, signal), oldDisposed);
    assert.deepEqual(await oldOwner.admission(oldAdmissionId, oldInput, true), {
      kind: "disposed",
      status: oldDisposed,
    });
    assert.deepEqual(
      await state.read((view) => view.repositorySessions.findBrokerReceipt(oldAdmissionId)),
      {
        admissionId: oldAdmissionId,
        state: "disposed",
        generation: oldGeneration,
        sessionId: oldSessionId,
        deadlineWallMs,
        revoked: 2,
        expired: 1,
      },
    );
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: oldAdmissionId,
        expectedPhase: "opening",
        phase: "closing",
        sessionId: oldSessionId,
        updatedAt: revision.createdAt,
      }),
    );
    await state.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: oldAdmissionId,
        expectedPhase: "closing",
        phase: "disposed",
        sessionId: oldSessionId,
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
    await assert.rejects(oldOwner.admission(knownId, oldInput, true), /RECEIPT_UNAVAILABLE/);
  },
);

registerBrokerReceiptShutdownCase();
