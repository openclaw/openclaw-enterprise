import { InMemoryPlatformState } from "../../../packages/occ/src/index.ts";
import { startRepositoryReceiptServer } from "../../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../../conformance/repository-sessions.contract.mjs";

// This uses the actual in-memory State adapter; PostgreSQL behavior is covered
// separately by the restricted-role broker receipt integration suite.
export async function startReceiptState(t, fixture, bindings, deadlineWallMs) {
  const state = new InMemoryPlatformState();
  const driver = { id: "repository-credentials", implementation: "github" };
  const { revision } = await seedSessionRevision(
    state,
    { driver, deadlineWallMs, bindings },
    {
      namespaceId: fixture.namespaceId,
    },
  );
  const listener = await startRepositoryReceiptServer({
    state,
    controlSocket: fixture.config.gateway.controlSocket,
    driverId: driver.id,
    implementation: driver.implementation,
    backendId: fixture.backendId,
  });
  t.after(() => listener.close());
  return {
    state,
    revision,
    prepare(admissionId, repositoryRef, durationSeconds) {
      return state.transact((unit) =>
        unit.repositorySessions.createAttempt(
          sessionAttempt(revision, {
            admissionId,
            repositoryRef,
            durationSeconds,
            brokerProtocol: 3,
          }),
        ),
      );
    },
    advance(admissionId, expectedPhase, phase, sessionId) {
      return state.transact((unit) =>
        unit.repositorySessions.advanceAttempt({
          admissionId,
          expectedPhase,
          phase,
          ...(sessionId === undefined ? {} : { sessionId }),
          updatedAt: revision.createdAt,
        }),
      );
    },
  };
}
