import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AdmittedRepositoryBinding } from "@openclaw-enterprise/contracts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { matchesRepositorySessionId } from "../../apps/controller/src/drivers/repo/access/client-contracts.ts";
import type { ControlResponse } from "../../apps/controller/src/drivers/repo/access/control-contracts.ts";
import type { SessionStatus } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import {
  PostgresPlatformState,
  type RepositorySessionRepository,
} from "../../packages/occ/src/index.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { startServiceProcessFixture } from "../fixtures/repository-credentials/service-process.ts";
import { controlRequest } from "../fixtures/repository-credentials/service.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

type AttemptInput = Parameters<RepositorySessionRepository["createAttempt"]>[0];

function assertUnavailable(reply: ControlResponse): void {
  assert.ok("error" in reply, "receipt authority must be unavailable");
  assert.deepEqual(reply, { error: "unavailable" });
}

export function registerBrokerReceiptShutdownCase(): void {
  test(
    "broker shutdown waits for receipts and loss of unconfirmed authority stays unknown",
    { ...requiresPostgres, timeout: 45_000 },
    async (t) => {
      for (const mode of ["delayed-commit", "unavailable", "abrupt-death"]) {
        await t.test(mode, async (context) => {
          const resources = createTestResourceScope(context, undefined);
          const pool = testPool(resources, { connectionString: databaseUrl, max: 4 });
          let listener: Awaited<ReturnType<typeof startRepositoryReceiptServer>> | undefined;
          resources.after(() => listener?.close());
          const namespaceId = `ns_${randomUUID()}`;
          const fixture = await startServiceProcessFixture(resources, {
            shutdownGraceMs: 100,
            namespaceId,
            // Leave capacity for a second admission while the first session is still open.
            ...(mode === "unavailable" ? { sessions: 2 } : {}),
          });
          const state = new PostgresPlatformState(pool);
          const binding: AdmittedRepositoryBinding = {
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
          const attempt = (admissionId: string): AttemptInput =>
            sessionAttempt(revision, {
              admissionId,
              repositoryRef: binding.repositoryRef,
              durationSeconds: fixture.input.durationSeconds,
              brokerProtocol: 3,
            });
          const admissionId = fixture.admissionId();
          await state.transact((unit) =>
            unit.repositorySessions.createAttempt(attempt(admissionId)),
          );

          listener = await startRepositoryReceiptServer({
            state,
            controlSocket: fixture.config.gateway.controlSocket,
            driverId: "repository-credentials",
            implementation: "github",
            backendId: "github-fixture",
          });
          const control = new UnixRepositoryCredentialControlClient({
            controlSocket: fixture.config.gateway.controlSocket,
          });
          await control.checkAdmissionReady(AbortSignal.timeout(2000));
          const opened = await fixture.open(admissionId, false, true);
          assert.ok("session" in opened, "initial admission must return a session");
          const session: unknown = opened.session;
          assert.ok(session && typeof session === "object" && "state" in session);
          assert.equal(session.state, "OPEN");
          assert.ok("sessionId" in session && typeof session.sessionId === "string");
          assert.ok(matchesRepositorySessionId(session.sessionId));
          const { sessionId } = session;
          assert.deepEqual(fixture.github.tokenState(), []);

          const readReceipt = (id: string) =>
            state.read((view) => view.repositorySessions.findBrokerReceipt(id));

          if (mode === "abrupt-death") {
            // The replacement cannot prove disposal from an active receipt after SIGKILL.
            await fixture.kill();
            await fixture.start();
            assert.equal((await readReceipt(admissionId))?.state, "active");
            assertUnavailable(await fixture.open(admissionId, true, true));
            assertUnavailable(await fixture.status(sessionId));
            assert.deepEqual(fixture.github.tokenState(), []);
            return;
          }

          if (mode === "unavailable") {
            // A closing attempt blocks its own revision. Use the next admitted revision
            // so the second request can open while the first receipt still needs disposal.
            const secondAdmissionId = fixture.admissionId();
            await state.transact(async ({ revisions, repositorySessions }) => {
              const closing = await repositorySessions.advanceAttempt({
                admissionId,
                expectedPhase: "opening",
                phase: "closing",
                sessionId,
                updatedAt: revision.createdAt,
              });
              assert.equal(closing?.phase, "closing");
              assert.equal(closing.sessionId, sessionId);
              const previous = await revisions.findRevision(
                namespaceId,
                revision.agentId,
                revision.id,
              );
              assert.ok(previous);
              const next = await revisions.createRevision({
                ...previous,
                id: `rev_${randomUUID()}`,
                revision: previous.revision + 1,
              });
              await repositorySessions.createAttempt({
                ...attempt(secondAdmissionId),
                revisionId: next.id,
              });
            });
            const second = await state.read((view) =>
              view.repositorySessions.findAttempt(secondAdmissionId),
            );
            assert.equal(second?.phase, "opening");
            assert.equal(second.sessionId, undefined);
            assert.equal(await readReceipt(secondAdmissionId), undefined);

            await listener.close();
            listener = undefined;
            // The capability remains reachable after journal loss. Admission must still fail closed.
            await control.checkAdmissionReady(AbortSignal.timeout(2000));
            // The operator client normalizes errors. Inspect the wire reply to detect a leaked bearer.
            const reply: unknown = await controlRequest(
              fixture.config.gateway.controlSocket,
              "POST",
              "/v1/sessions",
              { ...fixture.input, durableAdmission: true, preparedOnly: true },
              { "x-admission-id": secondAdmissionId },
            );
            assert.ok(reply && typeof reply === "object" && "status" in reply && "body" in reply);
            const { body } = reply;
            assert.equal(
              reply.status,
              503,
              "the admissible second request must fail after journal loss",
            );
            assert.ok(
              body && typeof body === "object" && !Object.hasOwn(body, "bearer"),
              "unavailable receipt authority must not return a session bearer",
            );
            assert.deepEqual(body, { error: "unavailable" });
            assert.equal(await readReceipt(secondAdmissionId), undefined);
            assert.deepEqual(fixture.github.tokenState(), []);
            await fixture.shutdown(1);
            assert.equal((await readReceipt(admissionId))?.state, "active");
            return;
          }

          // Hold the actual terminal write past the original shutdown grace. The broker must
          // outlive that grace to receive its durable acknowledgment.
          const lock = await pool.connect();
          let completed = false;
          let stopping: Promise<void>;
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
            await waitFor(
              "the original broker to attempt the terminal write",
              async () => {
                const result = await pool.query<{ blocked: unknown }>(
                  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%repository_broker_receipts%') AS blocked",
                );
                const blocked = result.rows[0]?.blocked;
                assert.ok(typeof blocked === "boolean", "the lock observation must be boolean");
                return blocked || undefined;
              },
              2000,
            );
            await delay(300);
            assert.equal(
              completed,
              false,
              "the broker must outlive the original grace while flushing",
            );
          } finally {
            try {
              await lock.query("ROLLBACK");
            } finally {
              lock.release();
            }
          }
          await stopping;
          const receipt = await readReceipt(admissionId);
          assert.equal(receipt?.state, "disposed");
          assert.equal(receipt.sessionId, sessionId);
          assert.equal(receipt.admissionId, admissionId);
          assert.equal(receipt.deadlineWallMs, fixture.input.deadlineWallMs);
          assert.equal(receipt.revoked, 0);
          assert.equal(receipt.expired, 0);
          assert.deepEqual(fixture.github.tokenState(), []);
          assert.deepEqual(fixture.github.trace, []);
          await fixture.start();
          const recovered = await fixture.open(admissionId, true, true);
          assert.ok("state" in recovered && !Object.hasOwn(recovered, "bearer"));
          assert.equal(recovered.state, "DISPOSED");
          assert.equal(recovered.sessionId, sessionId);
          assert.deepEqual(recovered.binding, binding.grant);
          assert.deepEqual(recovered.cleanup, {
            active: 0,
            pending: 0,
            revoked: 0,
            expired: 0,
            uncertain: 0,
            auxiliaryPending: false,
          } satisfies SessionStatus["cleanup"]);
          assert.deepEqual(recovered, await fixture.status(sessionId));
        });
      }
    },
  );
}
