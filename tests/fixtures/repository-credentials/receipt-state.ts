import type { TestContext } from "node:test";
import type { RepositoryRevisionState } from "@openclaw-enterprise/contracts";
import {
  InMemoryPlatformState,
  type RepositorySessionPhase,
} from "../../../packages/occ/src/index.ts";
import { startRepositoryReceiptServer } from "../../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import type { ServiceConfig } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { RepositorySessionCaseBuilders } from "../../conformance/repository-session-state-cases.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../../conformance/repository-sessions.contract.mjs";

const buildAttempt: RepositorySessionCaseBuilders["sessionAttempt"] = sessionAttempt;

interface ReceiptFixture {
  readonly namespaceId?: string | undefined;
  readonly backendId: string;
  readonly config: {
    readonly gateway: Pick<ServiceConfig["gateway"], "controlSocket">;
  };
}

// This uses the actual in-memory State adapter; PostgreSQL behavior is covered
// separately by the restricted-role broker receipt integration suite.
export async function startReceiptState(
  t: Pick<TestContext, "after">,
  fixture: ReceiptFixture,
  bindings: RepositoryRevisionState["bindings"],
  deadlineWallMs: RepositoryRevisionState["deadlineWallMs"],
) {
  const state = new InMemoryPlatformState();
  const driver = { id: "repository-credentials", implementation: "github" };
  const { revision } = await seedSessionRevision(
    state,
    { driver, deadlineWallMs, bindings },
    { namespaceId: fixture.namespaceId },
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
    prepare(admissionId: string, repositoryRef: string, durationSeconds: number) {
      return state.transact((unit) =>
        unit.repositorySessions.createAttempt(
          buildAttempt(revision, {
            admissionId,
            repositoryRef,
            durationSeconds,
            brokerProtocol: 3,
          }),
        ),
      );
    },
    advance(
      admissionId: string,
      expectedPhase: RepositorySessionPhase,
      phase: RepositorySessionPhase,
      sessionId?: string,
    ) {
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
